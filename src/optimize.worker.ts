import {
  WebIO,
  Document,
  Primitive,
  Logger,
} from '@gltf-transform/core';
import {
  KHRDracoMeshCompression,
  ALL_EXTENSIONS,
} from '@gltf-transform/extensions';
import { weld, dedup, simplify, draco, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import * as draco3d from 'draco3d';

import type {
  WorkerRequest,
  WorkerMessage,
  ModelStats,
  OptimizeSettings,
  LogLevel,
  ProgressStage,
} from './types';

let cachedDocument: Document | null = null;
let io: WebIO | null = null;
let cachedDracoDecoder: any = null;
let cachedDracoEncoder: any = null;

// Асинхронная инициализация WebIO с регистрацией Meshopt и Draco
async function getIO(): Promise<WebIO> {
  if (!io) {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    
    // 1. Загружаем и кэшируем Draco Decoder (для чтения файлов)
    if (!cachedDracoDecoder) {
      const resDec = await fetch('https://cdn.jsdelivr.net/npm/draco3d@1.5.7/draco_decoder.wasm');
      const wasmDec = await resDec.arrayBuffer();
      cachedDracoDecoder = await draco3d.createDecoderModule({ wasmBinary: wasmDec });
    }

    // 2. Загружаем и кэшируем Draco Encoder (для записи файлов)
    if (!cachedDracoEncoder) {
      const resEnc = await fetch('https://cdn.jsdelivr.net/npm/draco3d@1.5.7/draco_encoder.wasm');
      const wasmEnc = await resEnc.arrayBuffer();
      cachedDracoEncoder = await draco3d.createEncoderModule({ wasmBinary: wasmEnc });
    }

    // 3. Создаем WebIO и регистрируем ВСЕ зависимости
    io = new WebIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'meshopt.encoder': MeshoptEncoder,
        'meshopt.decoder': MeshoptDecoder,
        'draco3d.decoder': cachedDracoDecoder,
        'draco3d.encoder': cachedDracoEncoder, 
      });
  }
  return io;
}

function log(level: LogLevel, message: string): void {
  const msg: WorkerMessage = { type: 'log', level, message, ts: Date.now() };
  (self as unknown as Worker).postMessage(msg);
}

function progress(stage: ProgressStage, value: number): void {
  const msg: WorkerMessage = { type: 'progress', stage, value };
  (self as unknown as Worker).postMessage(msg);
}

function sendError(message: string, stack?: string): void {
  const msg: WorkerMessage = { type: 'error', message, stack };
  (self as unknown as Worker).postMessage(msg);
}

function countTriangles(prim: Primitive): number {
  const indices = prim.getIndices();
  if (indices) return indices.getCount();
  const position = prim.getAttribute('POSITION');
  return position ? position.getCount() : 0;
}

function countVertices(prim: Primitive): number {
  const position = prim.getAttribute('POSITION');
  return position ? position.getCount() : 0;
}

function computeStats(doc: Document, bytes: number): ModelStats {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  let triangles = 0;
  let vertices = 0;
  let drawCalls = 0;
  let hasMorphTargets = false;

  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      triangles += countTriangles(prim);
      vertices += countVertices(prim);
      drawCalls += 1;
      if (prim.listTargets().length > 0) hasMorphTargets = true;
    }
  }

  return {
    bytes,
    triangles,
    vertices,
    meshes: meshes.length,
    drawCalls,
    hasAnimation: root.listAnimations().length > 0,
    hasMorphTargets,
    materials: root.listMaterials().length,
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function analyze(buffer: ArrayBuffer): Promise<void> {
  try {
    log('info', `Parsing GLB (${formatBytes(buffer.byteLength)})...`);
    const doc = await (await getIO()).readBinary(new Uint8Array(buffer));
    cachedDocument = doc;
    const stats = computeStats(doc, buffer.byteLength);
    log('info', `Analysis complete: ${formatNumber(stats.triangles)} triangles, ${formatNumber(stats.vertices)} vertices, ${stats.meshes} meshes, ${stats.drawCalls} draw calls.`);
    if (stats.hasAnimation) log('warn', 'Model contains animation data. Draco compression will drop animation.');
    if (stats.hasMorphTargets) log('warn', 'Model contains morph targets. Draco compression will drop morph targets.');
    const msg: WorkerMessage = { type: 'analyzed', stats };
    (self as unknown as Worker).postMessage(msg);
  } catch (e) {
    const err = e as Error;
    log('error', `Analysis failed: ${err.message}`);
    sendError(`Analysis failed: ${err.message}`, err.stack);
  }
}

async function optimize(buffer: ArrayBuffer, settings: OptimizeSettings): Promise<void> {
  try {
    log('info', `Starting optimization (ratio=${(settings.ratio * 100).toFixed(0)}%, compression=${settings.compression})...`);

    let doc = cachedDocument;
    if (!doc) {
      log('info', 'No cached document; re-parsing GLB...');
      doc = await (await getIO()).readBinary(new Uint8Array(buffer));
    }
    cachedDocument = null;

    const beforeStats = computeStats(doc, buffer.byteLength);

    // Шаг 1: Weld (индексация)
    progress('weld', 0);
    log('info', 'weld: ensuring indexed geometry...');
    const beforeWeldVerts = beforeStats.vertices;
    await doc.transform(weld({}));
    const afterWeldStats = computeStats(doc, buffer.byteLength);
    log('info', `weld: ${formatNumber(beforeWeldVerts)} → ${formatNumber(afterWeldStats.vertices)} vertices`);
    progress('weld', 100);

    // Шаг 2: Simplify (упрощение)
    let appearanceError = 0;
    if (settings.ratio < 1.0) {
      progress('simplify', 0);
      log('info', `simplify: targeting ${(settings.ratio * 100).toFixed(0)}% of vertices...`);
      await MeshoptSimplifier.ready;
      const beforeSimplifyTris = afterWeldStats.triangles;
      const errorCaptureLogger = new Logger(Logger.Verbosity.DEBUG);
      const origDebug = errorCaptureLogger.debug.bind(errorCaptureLogger);
      let capturedError = 0;
      errorCaptureLogger.debug = (text: string): void => {
        const m = text.match(/error:\s*([0-9.]+)/);
        if (m) capturedError = Math.max(capturedError, parseFloat(m[1]));
        origDebug(text);
      };
      doc.setLogger(errorCaptureLogger);
      await doc.transform(
        simplify({
          simplifier: MeshoptSimplifier,
          ratio: settings.ratio,
          error: 0.001,
          lockBorder: true,
        }),
      );
      doc.setLogger(new Logger(Logger.Verbosity.INFO));
      appearanceError = capturedError;
      const afterSimplifyStats = computeStats(doc, buffer.byteLength);
      log('info', `simplify: ${formatNumber(beforeSimplifyTris)} → ${formatNumber(afterSimplifyStats.triangles)} triangles (appearance error: ${appearanceError.toFixed(4)})`);
      progress('simplify', 100);
    } else {
      log('info', 'simplify: skipped (ratio = 100%)');
      progress('simplify', 100);
    }

    // Шаг 3: Compression (Сжатие)
    progress('compress', 0);
    if (settings.compression === 'draco') {
      log('info', 'draco: applying compression...');
      // Энкодер уже загружен и зарегистрирован в WebIO!
      await doc.transform(
        draco({
          method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
          encodeSpeed: 5,
          decodeSpeed: 5,
          quantizePosition: 14,
          quantizeNormal: 10,
          quantizeTexcoord: 12,
          quantizeColor: 8,
          quantizeGeneric: 12,
        })
      );
      log('info', 'draco: compression applied');
    } else if (settings.compression === 'meshopt') {
      log('info', 'meshopt: preparing encoder...');
      await MeshoptEncoder.ready;
      await doc.transform(
        dedup(),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' })
      );
      log('info', 'meshopt: compression applied');
    } else {
      log('info', 'compress: skipped (none)');
    }

    await doc.transform(prune());
    progress('compress', 100);

    // Шаг 4: Export (Экспорт)
    progress('export', 0);
    log('info', 'export: serializing GLB...');
    const output = await (await getIO()).writeBinary(doc);
    const outBuffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
    const afterStats = computeStats(doc, outBuffer.byteLength);
    log('info', `export: ${formatBytes(beforeStats.bytes)} → ${formatBytes(afterStats.bytes)}`);
    progress('export', 100);

    const msg: WorkerMessage = {
      type: 'optimized',
      buffer: outBuffer,
      stats: afterStats,
      appearanceError,
    };
    (self as unknown as Worker).postMessage(msg, [outBuffer]);
    log('info', 'Optimization complete.');
  } catch (e) {
    const err = e as Error;
    log('error', `Optimization failed: ${err.message}`);
    sendError(`Optimization failed: ${err.message}`, err.stack);
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === 'reset') {
    cachedDocument = null;
    log('info', 'Worker state reset.');
    return;
  }
  if (req.type === 'analyze') {
    await analyze(req.buffer);
    return;
  }
  if (req.type === 'optimize') {
    await optimize(req.buffer, req.settings);
    return;
  }
};