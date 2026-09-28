/**
 * The extract worker's message loop (04 §10.4), independent of Electron so it can be unit-tested
 * with a fake port. worker.ts binds it to `process.parentPort` in the utilityProcess.
 * Render and normalize requests round-trip through main; the worker never touches window APIs.
 */
import { extractSource } from './extract-source';
import { JobImageBudget } from './images';
import type { ExtractContext, Extractor, ImageNormalizer, PdfPageRenderer } from './types';
import {
  isHostMessage,
  type HostToWorker,
  type NormalizeResult,
  type RenderResult,
  type WorkerToHost,
} from './worker-protocol';

export interface WorkerPort {
  postMessage(msg: WorkerToHost): void;
  onMessage(cb: (msg: unknown) => void): void;
}

export function runWorker(port: WorkerPort, extractors?: readonly Extractor[]): void {
  let nextCall = 1;
  const pending = new Map<number, (r: unknown) => void>();
  const controllers = new Map<number, AbortController>();

  const call = <T>(msg: (callId: number) => WorkerToHost, signal: AbortSignal): Promise<T> => {
    const callId = nextCall++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        pending.delete(callId);
        reject(new Error('aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(callId, (r) => {
        signal.removeEventListener('abort', onAbort);
        const err = (r as { error?: unknown } | null)?.error;
        if (typeof err === 'string' && !Array.isArray(r)) reject(new Error(err));
        else resolve(r as T);
      });
      port.postMessage(msg(callId));
    });
  };

  async function handleExtract(m: Extract<HostToWorker, { type: 'extract' }>): Promise<void> {
    const ac = new AbortController();
    controllers.set(m.reqId, ac);
    const budget = JobImageBudget.fromState(m.budget);
    const renderPdfPages: PdfPageRenderer = (pdf, pages, opts) =>
      call<RenderResult>(
        (callId) => ({ type: 'render', reqId: m.reqId, callId, pdf, pages, targetLongEdgePx: opts.targetLongEdgePx }),
        opts.signal,
      );
    const normalizeImage: ImageNormalizer = (bytes, mediaType, opts) =>
      call<NormalizeResult>(
        (callId) => ({ type: 'normalize', reqId: m.reqId, callId, bytes, mediaType, origin: opts.origin }),
        opts.signal,
      );
    const ctx: ExtractContext = {
      signal: ac.signal,
      limits: m.limits,
      imageBudget: budget,
      renderPdfPages,
      normalizeImage,
      log: (msg) => port.postMessage({ type: 'log', reqId: m.reqId, msg }),
    };
    try {
      const result = await extractSource(m.source, ctx, extractors);
      port.postMessage({ type: 'result', reqId: m.reqId, result, budget: budget.snapshot() });
    } finally {
      controllers.delete(m.reqId);
    }
  }

  port.onMessage((raw) => {
    if (!isHostMessage(raw)) return;
    switch (raw.type) {
      case 'extract':
        void handleExtract(raw);
        break;
      case 'cancel':
        controllers.get(raw.reqId)?.abort();
        break;
      case 'render-result':
      case 'normalize-result': {
        const resolve = pending.get(raw.callId);
        pending.delete(raw.callId);
        resolve?.(raw.result);
        break;
      }
    }
  });
  port.postMessage({ type: 'ready' });
}
