/// <reference types="electron-vite/node" />
import createReadabilityWorker from './readability.worker?nodeWorker';
import { ReadabilityPool } from './readability';

/**
 * Production pool (05 §5.2 "Build and packaging"): electron-vite emits the worker as its own chunk
 * and resolves its path in dev and inside app.asar. Imported only by electron.ts, never by tests.
 */
export function createThreadPool(): ReadabilityPool {
  return new ReadabilityPool({ createWorker: () => createReadabilityWorker({}) });
}
