import { useState, useRef, useCallback, useEffect } from 'react';
import type { ModelStats, OptimizeSettings, WorkerMessage, WorkerStatus, LogEntry, ProgressStage } from './types';

// Хук для отслеживания размера экрана
function useWindowSize() {
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1200,
  });

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return windowSize;
}

export default function App() {
  const { width } = useWindowSize();
  const isMobile = width < 1024; // Если экран меньше 1024px (планшеты и телефоны)

  const [fileName, setFileName] = useState<string | null>(null);
  const [statsBefore, setStatsBefore] = useState<ModelStats | null>(null);
  const [statsAfter, setStatsAfter] = useState<ModelStats | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<WorkerStatus>('idle');
  const [currentStage, setCurrentStage] = useState<ProgressStage | 'idle' | 'done'>('idle');
  const [settings, setSettings] = useState<OptimizeSettings>({ ratio: 0.5, compression: 'meshopt' });
  
  const workerRef = useRef<Worker | null>(null);
  const originalBufferRef = useRef<ArrayBuffer | null>(null);
  const optimizedBufferRef = useRef<ArrayBuffer | null>(null);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [...prev, { id: Date.now() + Math.random(), ts: Date.now(), level, message }]);
  }, []);

  const initWorker = () => {
    if (workerRef.current) return;
    const worker = new Worker(new URL('./optimize.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'log': addLog(msg.level, msg.message); break;
        case 'progress': setCurrentStage(msg.stage); break;
        case 'analyzed': setStatsBefore(msg.stats); setStatus('idle'); break;
        case 'optimized':
          optimizedBufferRef.current = msg.buffer;
          setStatsAfter(msg.stats);
          setStatus('done');
          setCurrentStage('done');
          break;
        case 'error': addLog('error', msg.message); setStatus('error'); break;
      }
    };
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.glb')) {
      addLog('error', 'Пожалуйста, перетащите валидный .glb файл');
      return;
    }
    processFile(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const processFile = (file: File) => {
    initWorker();
    setFileName(file.name);
    setStatsBefore(null);
    setStatsAfter(null);
    setStatus('analyzing');
    addLog('info', `Загрузка ${file.name}...`);

    const reader = new FileReader();
    reader.onload = (event) => {
      const buffer = event.target?.result as ArrayBuffer;
      originalBufferRef.current = buffer.slice(0); 
      
      workerRef.current?.postMessage({ type: 'reset' });
      const analyzeBuffer = buffer.slice(0);
      workerRef.current?.postMessage({ type: 'analyze', buffer: analyzeBuffer }, [analyzeBuffer]); 
    };
    reader.readAsArrayBuffer(file);
  };

  const handleOptimize = () => {
    if (!originalBufferRef.current) return;
    setStatus('optimizing');
    setCurrentStage('weld');
    addLog('info', `Запуск конвейера (${settings.compression})...`);
    const bufferCopy = originalBufferRef.current.slice(0);
    workerRef.current?.postMessage({ type: 'optimize', buffer: bufferCopy, settings }, [bufferCopy]);
  };

  const handleDownloadGlb = () => {
    if (!optimizedBufferRef.current) return;
    const blob = new Blob([optimizedBufferRef.current], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName?.replace('.glb', '_optimized.glb') || 'model_optimized.glb';
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetAll = () => {
    setFileName(null);
    setStatsBefore(null);
    setStatsAfter(null);
    setStatus('idle');
    setCurrentStage('idle');
    originalBufferRef.current = null;
    optimizedBufferRef.current = null;
    setLogs([]);
  };

  const StageIcon = ({ stage, label, icon }: { stage: string, label: string, icon: string }) => {
    const isActive = currentStage === stage;
    const isDone = currentStage === 'done' || 
      ['weld', 'simplify', 'compress', 'export'].indexOf(currentStage) > ['weld', 'simplify', 'compress', 'export'].indexOf(stage);
    
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: isMobile ? '60px' : '110px' }}>
        <div style={{ 
          width: isMobile ? '40px' : '56px', height: isMobile ? '40px' : '56px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '12px',
          backgroundColor: isDone ? '#10b981' : isActive ? '#3b82f6' : '#f1f5f9',
          color: isDone || isActive ? 'white' : '#94a3b8',
          fontSize: isMobile ? '14px' : '20px', fontWeight: 'bold',
          transition: 'all 0.3s', boxShadow: isActive ? '0 0 0 4px #dbeafe' : 'none'
        }}>
          {isDone ? '✓' : icon}
        </div>
        <span style={{ fontSize: isMobile ? '10px' : '13px', fontWeight: 'bold', color: isActive ? '#3b82f6' : isDone ? '#10b981' : '#94a3b8', textAlign: 'center' }}>
          {label.split(' ')[0]}
        </span>
      </div>
    );
  };

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: isMobile ? 'column' : 'row', // На мобильных колонки идут друг под другом
      height: isMobile ? 'auto' : '100vh', // На мобильных высота авто (появляется скролл)
      minHeight: '100vh',
      fontFamily: 'Inter, sans-serif', 
      backgroundColor: '#f8fafc',
      overflowX: 'hidden'
    }}>
      
      {/* ЛЕВАЯ ПАНЕЛЬ (Настройки) */}
      <div style={{ 
        width: isMobile ? '100%' : '340px', 
        backgroundColor: 'white', 
        borderRight: isMobile ? 'none' : '1px solid #e2e8f0',
        borderBottom: isMobile ? '1px solid #e2e8f0' : 'none',
        display: 'flex', flexDirection: 'column', padding: '24px', zIndex: 10 
      }}>
        <h1 style={{ fontSize: '20px', fontWeight: '800', color: '#1e293b', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: '#3b82f6', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>G</div>
          glTF Optimizer
        </h1>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', flex: 1 }}>
          
          {fileName && (
            <div style={{ backgroundColor: '#f1f5f9', padding: '16px', borderRadius: '12px' }}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px', textTransform: 'uppercase', fontWeight: 'bold' }}>Текущий файл</div>
              <div style={{ fontSize: '14px', fontWeight: '600', color: '#334155', wordBreak: 'break-all' }}>{fileName}</div>
            </div>
          )}

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px', color: '#475569', fontWeight: '600' }}>
              <span>Упрощение сетки</span>
              <span style={{ color: '#3b82f6', backgroundColor: '#eff6ff', padding: '2px 8px', borderRadius: '6px' }}>{(settings.ratio * 100).toFixed(0)}%</span>
            </div>
            <input type="range" min="10" max="100" value={settings.ratio * 100} 
              onChange={(e) => setSettings({...settings, ratio: parseInt(e.target.value) / 100})}
              disabled={status === 'optimizing' || status === 'analyzing'}
              style={{ width: '100%', accentColor: '#3b82f6', height: '20px', cursor: (status === 'optimizing' || status === 'analyzing') ? 'not-allowed' : 'pointer' }} />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '14px', color: '#475569', fontWeight: '600', marginBottom: '12px' }}>Метод сжатия</label>
            <select value={settings.compression} onChange={(e) => setSettings({...settings, compression: e.target.value as any})}
              disabled={status === 'optimizing' || status === 'analyzing'}
              style={{ width: '100%', padding: '12px', backgroundColor: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '10px', fontSize: '16px', outline: 'none', cursor: (status === 'optimizing' || status === 'analyzing') ? 'not-allowed' : 'pointer', color: '#1e293b' }}>
              <option value="none">Без сжатия (Откроется везде)</option>
              <option value="meshopt">Meshopt (Безопасный)</option>
              <option value="draco">Draco (Максимальный)</option>
            </select>
          </div>

          <button onClick={handleOptimize} disabled={!fileName || status === 'optimizing' || status === 'analyzing'}
            style={{ width: '100%', padding: '16px', backgroundColor: status === 'optimizing' || status === 'analyzing' || !fileName ? '#cbd5e1' : '#3b82f6', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: status === 'optimizing' || status === 'analyzing' || !fileName ? 'not-allowed' : 'pointer', transition: 'all 0.2s', fontSize: '16px' }}>
            {status === 'optimizing' ? 'Оптимизация...' : status === 'analyzing' ? 'Анализ файла...' : 'Запустить оптимизацию'}
          </button>

          {status === 'done' && (
             <button onClick={resetAll} style={{ width: '100%', padding: '12px', backgroundColor: 'transparent', color: '#64748b', border: '1px solid #cbd5e1', borderRadius: '10px', fontWeight: '600', cursor: 'pointer', fontSize: '14px' }}>
               Загрузить другую модель
             </button>
          )}
        </div>
      </div>

      {/* ЦЕНТР (Рабочая область) */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: isMobile ? '20px' : '40px', minHeight: isMobile ? '400px' : 'auto' }} onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop}>
        
        {!fileName ? (
          <label style={{ textAlign: 'center', backgroundColor: 'white', padding: isMobile ? '30px 20px' : '60px 80px', borderRadius: '24px', boxShadow: '0 20px 40px rgba(0,0,0,0.03)', border: '2px dashed #cbd5e1', width: '100%', maxWidth: '600px', cursor: 'pointer', display: 'block' }}>
            <input type="file" accept=".glb" onChange={handleFileChange} style={{ display: 'none' }} />
            <div style={{ width: '80px', height: '80px', backgroundColor: '#eff6ff', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px auto', color: '#3b82f6' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </div>
            <h2 style={{ fontSize: isMobile ? '20px' : '24px', fontWeight: '800', color: '#1e293b', margin: '0 0 12px 0' }}>Начните работу</h2>
            <p style={{ color: '#64748b', fontSize: isMobile ? '14px' : '16px', margin: 0 }}>Нажмите сюда или перетащите .glb файл</p>
          </label>
        ) : (
          <div style={{ backgroundColor: 'white', padding: isMobile ? '20px' : '48px', borderRadius: '24px', boxShadow: '0 20px 40px rgba(0,0,0,0.03)', border: '1px solid #e2e8f0', width: '100%', maxWidth: '800px' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', marginBottom: isMobile ? '30px' : '48px' }}>
              <div style={{ position: 'absolute', top: isMobile ? '20px' : '28px', left: '10%', right: '10%', height: '3px', backgroundColor: '#f1f5f9', zIndex: 0 }} />
              <div style={{ zIndex: 1 }}><StageIcon stage="weld" label="Weld (Слияние)" icon="1" /></div>
              <div style={{ zIndex: 1 }}><StageIcon stage="simplify" label="Simplify (Упрощение)" icon="2" /></div>
              <div style={{ zIndex: 1 }}><StageIcon stage="compress" label="Compress (Сжатие)" icon="3" /></div>
              <div style={{ zIndex: 1 }}><StageIcon stage="export" label="Export (Экспорт)" icon="4" /></div>
            </div>

            {status === 'analyzing' && <div style={{ textAlign: 'center', color: '#64748b', fontSize: '15px', padding: '20px' }}>Анализ...</div>}
            {status === 'idle' && statsBefore && <div style={{ textAlign: 'center', color: '#1d4ed8', fontSize: '15px', backgroundColor: '#eff6ff', padding: '20px', borderRadius: '12px', fontWeight: '500' }}>Настройте параметры и нажмите «Запустить»</div>}
            {status === 'optimizing' && <div style={{ textAlign: 'center', color: '#64748b', fontSize: '15px', padding: '20px' }}>Идет обработка...</div>}
            {status === 'error' && <div style={{ textAlign: 'center', color: '#dc2626', fontSize: '15px', backgroundColor: '#fef2f2', padding: '20px', borderRadius: '12px' }}>Ошибка. Проверьте логи.</div>}

            {status === 'done' && statsBefore && statsAfter && (
              <div>
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '16px', marginBottom: '24px' }}>
                  <div style={{ flex: 1, padding: '20px', backgroundColor: '#f8fafc', borderRadius: '16px', border: '1px solid #e2e8f0', textAlign: isMobile ? 'center' : 'left' }}>
                    <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '8px' }}>Исходная модель</div>
                    <div style={{ fontSize: '24px', fontWeight: '800', color: '#334155', marginBottom: '4px' }}>{statsBefore.triangles.toLocaleString()} <span style={{fontSize: '12px', fontWeight: '500', color: '#64748b'}}>tri</span></div>
                    <div style={{ fontSize: '16px', color: '#64748b', fontWeight: '500' }}>{(statsBefore.bytes / 1024 / 1024).toFixed(2)} MB</div>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981', fontSize: '24px', transform: isMobile ? 'rotate(90deg)' : 'none' }}>➜</div>
                  
                  <div style={{ flex: 1, padding: '20px', backgroundColor: '#ecfdf5', borderRadius: '16px', border: '2px solid #10b981', textAlign: isMobile ? 'center' : 'left' }}>
                    <div style={{ fontSize: '12px', color: '#059669', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '8px' }}>Оптимизировано</div>
                    <div style={{ fontSize: '24px', fontWeight: '800', color: '#065f46', marginBottom: '4px' }}>{statsAfter.triangles.toLocaleString()} <span style={{fontSize: '12px', fontWeight: '500', color: '#047857'}}>tri</span></div>
                    <div style={{ fontSize: '16px', color: '#047857', fontWeight: 'bold' }}>{(statsAfter.bytes / 1024 / 1024).toFixed(2)} MB</div>
                  </div>
                </div>

                <button onClick={handleDownloadGlb}
                  style={{ width: '100%', padding: '18px', backgroundColor: '#10b981', color: 'white', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer', fontSize: '16px', boxShadow: '0 8px 20px rgba(16, 185, 129, 0.3)' }}>
                  Скачать GLB
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ПРАВАЯ ПАНЕЛЬ (Логи) */}
      <div style={{ 
        width: isMobile ? '100%' : '340px', 
        height: isMobile ? '300px' : 'auto', // На мобильных логи фиксированной высоты
        backgroundColor: 'white', 
        borderLeft: isMobile ? 'none' : '1px solid #e2e8f0',
        borderTop: isMobile ? '1px solid #e2e8f0' : 'none',
        display: 'flex', flexDirection: 'column', zIndex: 10 
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f8fafc' }}>
          <span style={{ fontSize: '13px', fontWeight: '800', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Логи</span>
          <button onClick={() => setLogs([])} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '13px', cursor: 'pointer', fontWeight: 'bold' }}>Очистить</button>
        </div>
        <div style={{ flex: 1, padding: '16px 20px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {logs.length === 0 && <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>Ожидание...</div>}
          {logs.map((log) => (
            <div key={log.id} style={{ 
              padding: '8px 12px', borderRadius: '6px', lineHeight: '1.4',
              backgroundColor: log.level === 'error' ? '#fef2f2' : log.level === 'warn' ? '#fffbeb' : '#f8fafc',
              color: log.level === 'error' ? '#dc2626' : log.level === 'warn' ? '#d97706' : '#475569',
              borderLeft: `3px solid ${log.level === 'error' ? '#ef4444' : log.level === 'warn' ? '#f59e0b' : '#cbd5e1'}`
            }}>
              <span style={{ color: '#94a3b8', marginRight: '6px', fontSize: '10px' }}>[{new Date(log.ts).toLocaleTimeString()}]</span>
              {log.message}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}