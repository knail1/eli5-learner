import { abortError, classifyNetError, TransportError } from './errors';

/**
 * One GET with manual redirects (05 §4.2). Production: Electron `net.request` on the in-memory
 * `eli5-fetch` session (electron.ts). Tests: `nodeTransport` (node-transport.ts) over the fixture server.
 *
 * Contract: `onRedirect` is awaited for every hop; `false` stops with RedirectStopped. Network
 * failures reject with TransportError, cancellation with an AbortError. Header names are lowercase.
 */
export interface RedirectHop {
  statusCode: number;
  redirectUrl: string; // absolute
}

export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  onRedirect: (hop: RedirectHop) => Promise<boolean>;
}

export interface TransportResponse {
  url: string; // after followed redirects
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export interface HttpTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

export class RedirectStopped extends Error {
  constructor() {
    super('redirect stopped');
    this.name = 'RedirectStopped';
  }
}

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function errorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  if (typeof cause?.code === 'string') return cause.code;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : e instanceof Error ? e.message : 'unknown';
}

/** Normalizes any client error: AbortError when the signal fired, else TransportError. */
export function toTransportError(e: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return abortError();
  if (e instanceof TransportError) return e;
  const code = errorCode(e);
  return new TransportError(classifyNetError(code), code);
}
