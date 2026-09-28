/**
 * Messages between main (ExtractWorkerHost) and the extract worker (04 §10.4). Everything is
 * structured-cloned; only `path` crosses for file payloads and the worker reads the file itself.
 */
import type { ResolvedSource } from '../sources';
import type { BudgetState } from './images';
import type { ExtractLimits, ExtractResult, ImageBlock, ImageNormalizer, PdfPageRenderer } from './types';

export type RenderResult = Awaited<ReturnType<PdfPageRenderer>>;
export type NormalizeResult = Awaited<ReturnType<ImageNormalizer>>;

export type HostToWorker =
  | { type: 'extract'; reqId: number; source: ResolvedSource; limits: ExtractLimits; budget: BudgetState }
  | { type: 'cancel'; reqId: number }
  | { type: 'render-result'; callId: number; result: RenderResult | { error: string } }
  | { type: 'normalize-result'; callId: number; result: NormalizeResult | { error: string } };

export type WorkerToHost =
  | { type: 'ready' }
  | { type: 'result'; reqId: number; result: ExtractResult; budget: BudgetState }
  | {
      type: 'render';
      reqId: number;
      callId: number;
      pdf: Uint8Array;
      pages: number[];
      targetLongEdgePx: number;
    }
  | {
      type: 'normalize';
      reqId: number;
      callId: number;
      bytes: Uint8Array;
      mediaType: string;
      origin: ImageBlock['origin'];
    }
  /** Debug log line; codes and counts only, never content. */
  | { type: 'log'; reqId: number; msg: string };

export function isWorkerMessage(m: unknown): m is WorkerToHost {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

export function isHostMessage(m: unknown): m is HostToWorker {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
