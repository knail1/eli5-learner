/**
 * utilityProcess entry for the extract worker (04 §10.4). Bundled as its own main-build input and
 * forked by ExtractWorkerHost with `execArgv: ['--max-old-space-size=1024']`. No Electron window APIs.
 */
import { setPdfWorkerSrc } from './pdf';
import { runWorker } from './worker-runtime';
import type { WorkerToHost } from './worker-protocol';

interface ParentPort {
  postMessage(msg: unknown): void;
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort) {
  // The host passes the copied pdf.worker.mjs location for packaged builds (04 §6).
  const workerSrc = process.env.ELI5_PDFJS_WORKER_SRC;
  if (workerSrc) setPdfWorkerSrc(workerSrc);
  runWorker({
    postMessage: (msg: WorkerToHost) => parentPort.postMessage(msg),
    onMessage: (cb) => parentPort.on('message', (e) => cb(e.data)),
  });
}
