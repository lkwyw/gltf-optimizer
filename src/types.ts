export type CompressionMethod = 'draco' | 'meshopt' | 'none';

export interface ModelStats {
  bytes: number;
  triangles: number;
  vertices: number;
  meshes: number;
  drawCalls: number;
  hasAnimation: boolean;
  hasMorphTargets: boolean;
  materials: number;
}

export interface OptimizeSettings {
  ratio: number;
  compression: CompressionMethod;
}

export interface OptimizeRequest {
  type: 'optimize';
  buffer: ArrayBuffer;
  settings: OptimizeSettings;
}

export interface AnalyzeRequest {
  type: 'analyze';
  buffer: ArrayBuffer;
}

export interface ResetRequest {
  type: 'reset';
}

export type WorkerRequest = OptimizeRequest | AnalyzeRequest | ResetRequest;

export type LogLevel = 'info' | 'warn' | 'error';

export type ProgressStage = 'weld' | 'simplify' | 'compress' | 'export';

export type WorkerMessage =
  | { type: 'log'; level: LogLevel; message: string; ts: number }
  | { type: 'progress'; stage: ProgressStage; value: number }
  | { type: 'analyzed'; stats: ModelStats }
  | {
      type: 'optimized';
      buffer: ArrayBuffer;
      stats: ModelStats;
      appearanceError: number;
    }
  | { type: 'error'; message: string; stack?: string };

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  message: string;
}

export type WorkerStatus = 'idle' | 'analyzing' | 'optimizing' | 'done' | 'error';

export interface ReportJson {
  tool: string;
  version: string;
  timestamp: string;
  fileName: string;
  before: ModelStats;
  after: ModelStats;
  settings: OptimizeSettings;
  savings: { bytesPercent: number; trianglesPercent: number };
  warnings: string[];
}
