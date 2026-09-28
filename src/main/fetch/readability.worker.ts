import { parentPort } from 'node:worker_threads';
import { runReadability, type ReadabilityJob } from './readability-core';

/** Readability worker entry (05 §5.2). No Electron imports; bundled as its own chunk via ?nodeWorker. */

interface JobMessage {
  id: number;
  job: ReadabilityJob;
}

parentPort?.on('message', (msg: JobMessage) => {
  try {
    parentPort?.postMessage({ id: msg.id, ok: true, result: runReadability(msg.job) });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.name : 'Error' });
  }
});
