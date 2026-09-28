// Document <-> host message envelope (08 §4.2). v1 carries these as contextBridge arguments; the
// envelope is versioned so a future <iframe> host can carry the same messages over postMessage.

export type DocMessageType = 'act' | 'close-tab' | 'open-external' | 'scroll-to' | 'section-busy';

export interface DocBridgeMessage<T extends DocMessageType = DocMessageType, P = unknown> {
  /** postMessage receivers ignore anything else. */
  source: 'eli5-doc';
  v: 1;
  type: T;
  payload: P;
}

const TYPES: readonly string[] = ['act', 'close-tab', 'open-external', 'scroll-to', 'section-busy'];

export function docMessage<T extends DocMessageType, P>(type: T, payload: P): DocBridgeMessage<T, P> {
  return { source: 'eli5-doc', v: 1, type, payload };
}

/**
 * Envelope check only. A postMessage host must also check the exact event.origin, that
 * event.source is the frame's contentWindow, and a per-load nonce it issued (08 §4.2).
 */
export function isDocMessage(v: unknown): v is DocBridgeMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<DocBridgeMessage>;
  return m.source === 'eli5-doc' && m.v === 1 && typeof m.type === 'string' && TYPES.includes(m.type);
}
