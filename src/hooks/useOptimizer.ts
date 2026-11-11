import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  WorkerMessage,
  WorkerStatus,
  ModelStats,
  ProgressStage,
  LogLevel,
  LogEntry,
  OptimizeSettings,
} from '@/types';

interface WorkerState {
  status: WorkerStatus;
  analyzed: boolean;
  beforeStats: ModelStats | null;
  afterStats: ModelStats | null;
  optimizedBuffer: ArrayBuffer | null;
  appearanceError: number;
  progressStage: ProgressStage | null;
  progressValue: number;
  logs: LogEntry[];
  errorMessage: string | null;
}

type WorkerAction =
  | { type: 'ANALYZE_START' }
  | { type: 'OPTIMIZE_START' }
  | { type: 'ANALYZED'; stats: ModelStats }
  | {
      type: 'OPTIMIZED';
      stats: ModelStats;
      buffer: ArrayBuffer;
      appearanceError: number;
    }
  | { type: 'PROGRESS'; stage: ProgressStage; value: number }
  | { type: 'LOG'; entry: LogEntry }
  | { type: 'ERROR'; message: string }
  | { type: 'CLEAR_LOGS' }
  | { type: 'RESET_RESULTS' };

const initialState: WorkerState = {
  status: 'idle',
  analyzed: false,
  beforeStats: null,
  afterStats: null,
  optimizedBuffer: null,
  appearanceError: 0,
  progressStage: null,
  progressValue: 0,
  logs: [],
  errorMessage: null,
};

let logIdCounter = 0;

function reducer(state: WorkerState, action: WorkerAction): WorkerState {
  switch (action.type) {
    case 'ANALYZE_START':
      return {
        ...state,
        status: 'analyzing',
        analyzed: false,
        beforeStats: null,
        afterStats: null,
        optimizedBuffer: null,
        appearanceError: 0,
        progressStage: null,
        errorMessage: null,
      };
    case 'OPTIMIZE_START':
      return {
        ...state,
        status: 'optimizing',
        afterStats: null,
        optimizedBuffer: null,
        appearanceError: 0,
        progressStage: null,
        progressValue: 0,
        errorMessage: null,
      };
    case 'ANALYZED':
      return {
        ...state,
        status: 'idle',
        analyzed: true,
        beforeStats: action.stats,
      };
    case 'OPTIMIZED':
      return {
        ...state,
        status: 'done',
        afterStats: action.stats,
        optimizedBuffer: action.buffer,
        appearanceError: action.appearanceError,
        progressStage: null,
      };
    case 'PROGRESS':
      return {
        ...state,
        progressStage: action.stage,
        progressValue: action.value,
      };
    case 'LOG':
      return { ...state, logs: [...state.logs, action.entry].slice(-500) };
    case 'ERROR':
      return { ...state, status: 'error', errorMessage: action.message };
    case 'CLEAR_LOGS':
      return { ...state, logs: [] };
    case 'RESET_RESULTS':
      return {
        ...state,
        afterStats: null,
        optimizedBuffer: null,
        appearanceError: 0,
        progressStage: null,
        progressValue: 0,
      };
    default:
      return state;
  }
}

export function useOptimizer() {
  const workerRef = useRef<Worker | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const worker = new Worker(new URL('../optimize.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    const onMessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'log':
          dispatch({
            type: 'LOG',
            entry: { id: ++logIdCounter, ts: msg.ts, level: msg.level, message: msg.message },
          });
          break;
        case 'progress':
          dispatch({ type: 'PROGRESS', stage: msg.stage, value: msg.value });
          break;
        case 'analyzed':
          dispatch({ type: 'ANALYZED', stats: msg.stats });
          break;
        case 'optimized':
          dispatch({
            type: 'OPTIMIZED',
            stats: msg.stats,
            buffer: msg.buffer,
            appearanceError: msg.appearanceError,
          });
          break;
        case 'error':
          dispatch({ type: 'ERROR', message: msg.message });
          break;
      }
    };

    const onError = (e: ErrorEvent) => {
      dispatch({ type: 'ERROR', message: e.message || 'Unknown worker error' });
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    return () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
    };
  }, []);

  const analyze = useCallback((buffer: ArrayBuffer) => {
    if (!workerRef.current) return;
    const transfer = buffer.slice(0);
    dispatch({ type: 'ANALYZE_START' });
    workerRef.current.postMessage({ type: 'analyze', buffer: transfer }, [transfer]);
  }, []);

  const optimize = useCallback((buffer: ArrayBuffer, settings: OptimizeSettings) => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: 'reset' });
    dispatch({ type: 'OPTIMIZE_START' });
    const transfer = buffer.slice(0);
    workerRef.current.postMessage(
      { type: 'optimize', buffer: transfer, settings },
      [transfer],
    );
  }, []);

  const clearLogs = useCallback(() => {
    dispatch({ type: 'CLEAR_LOGS' });
  }, []);

  const resetResults = useCallback(() => {
    dispatch({ type: 'RESET_RESULTS' });
  }, []);

  const log = useCallback((level: LogLevel, message: string) => {
    dispatch({
      type: 'LOG',
      entry: { id: ++logIdCounter, ts: Date.now(), level, message },
    });
  }, []);

  return {
    state,
    analyze,
    optimize,
    clearLogs,
    resetResults,
    log,
  };
}
