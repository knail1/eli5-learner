import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * cassetteFetch (13 §6.3, 02 §16): replays recorded provider HTTP exchanges through the SDKs'
 * injectable `fetch`, so provider tests cover SDK wiring with no network. Test-only; never imported
 * by app code. Cassettes are JSON; streamed bodies are replayed event by event. Besides raw `sse`
 * events, a cassette may give a compact `claudeMessage` / `openaiCompletion` that is expanded into
 * the vendor's streaming event sequence.
 */

export interface CassetteSseEvent {
  event?: string;
  /** Serialized with JSON.stringify unless it is a string (e.g. "[DONE]"). */
  data: unknown;
}

export interface ClaudeMessageSpec {
  id?: string;
  model: string;
  content: (
    { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown } | { type: 'thinking' }
  )[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

export interface OpenAICompletionSpec {
  model: string;
  content?: string;
  refusal?: string;
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
}

export interface CassetteResponse {
  status: number;
  headers?: Record<string, string>;
  /** JSON body (non-streaming responses and errors). */
  body?: unknown;
  sse?: CassetteSseEvent[];
  claudeMessage?: ClaudeMessageSpec;
  openaiCompletion?: OpenAICompletionSpec;
  /** Stop sending after the events and hang until the request is aborted (idle-timeout tests). */
  stall?: boolean;
}

export interface CassetteInteraction {
  request: {
    method?: string;
    path: string;
    /** Deep subset the JSON request body must contain (arrays compared index by index). */
    match?: unknown;
    /** normalizedBodyHash of the full request body. */
    bodyHash?: string;
  };
  response: CassetteResponse;
  /** Serve for every matching request instead of once. */
  repeat?: boolean;
}

export interface Cassette {
  name: string;
  interactions: CassetteInteraction[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CassetteTransport {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  unmatched: string[];
  /** Throws if any request went unmatched or a non-repeat interaction was never used. */
  assertDone(): void;
}

export function loadCassette(path: string): Cassette {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as Cassette;
}

// ---- body normalization (model name and max_tokens kept, whitespace normalized) ----

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
  );
}

export function normalizedBodyHash(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest('hex')
    .slice(0, 16);
}

/** First path where `actual` does not contain `pattern`, or null. */
export function subsetMismatch(pattern: unknown, actual: unknown, at = '$'): string | null {
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return `${at}: expected array`;
    if (actual.length !== pattern.length) return `${at}: expected ${pattern.length} items, got ${actual.length}`;
    for (let i = 0; i < pattern.length; i++) {
      const m = subsetMismatch(pattern[i], actual[i], `${at}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (typeof pattern === 'object' && pattern !== null) {
    if (typeof actual !== 'object' || actual === null) return `${at}: expected object`;
    for (const [k, v] of Object.entries(pattern)) {
      const m = subsetMismatch(v, (actual as Record<string, unknown>)[k], `${at}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return Object.is(pattern, actual)
    ? null
    : `${at}: expected ${JSON.stringify(pattern)}, got ${JSON.stringify(actual)}`;
}

// ---- compact specs -> vendor SSE ----

function pieces(s: string): string[] {
  if (s.length < 2) return [s];
  const mid = Math.ceil(s.length / 2);
  return [s.slice(0, mid), s.slice(mid)];
}

export function claudeSse(m: ClaudeMessageSpec): CassetteSseEvent[] {
  const ev = (event: string, data: Record<string, unknown>): CassetteSseEvent => ({
    event,
    data: { type: event, ...data },
  });
  const out: CassetteSseEvent[] = [
    ev('message_start', {
      message: {
        id: m.id ?? 'msg_cassette',
        type: 'message',
        role: 'assistant',
        model: m.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: m.usage.input_tokens,
          output_tokens: 1,
          cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: 0,
        },
      },
    }),
  ];
  m.content.forEach((b, index) => {
    if (b.type === 'thinking') {
      out.push(ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
      out.push(ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } }));
    } else if (b.type === 'text') {
      out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }));
      for (const p of pieces(b.text))
        out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: p } }));
    } else {
      out.push(
        ev('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: `toolu_${index}`, name: b.name, input: {} },
        }),
      );
      for (const p of pieces(JSON.stringify(b.input))) {
        out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: p } }));
      }
    }
    out.push(ev('content_block_stop', { index }));
  });
  out.push(
    ev('message_delta', {
      delta: { stop_reason: m.stop_reason, stop_sequence: null },
      usage: { output_tokens: m.usage.output_tokens },
    }),
  );
  out.push(ev('message_stop', {}));
  return out;
}

export function openaiSse(c: OpenAICompletionSpec): CassetteSseEvent[] {
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null,
    extra: Record<string, unknown> = {},
  ): CassetteSseEvent => ({
    data: {
      id: 'chatcmpl-cassette',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: c.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...extra,
    },
  });
  const out: CassetteSseEvent[] = [chunk({ role: 'assistant', content: '' }, null)];
  for (const p of c.content ? pieces(c.content) : []) out.push(chunk({ content: p }, null));
  if (c.refusal) out.push(chunk({ refusal: c.refusal }, null));
  out.push(chunk({}, c.finish_reason));
  out.push({
    data: {
      id: 'chatcmpl-cassette',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: c.model,
      choices: [],
      usage: {
        prompt_tokens: c.usage.prompt_tokens,
        completion_tokens: c.usage.completion_tokens,
        total_tokens: c.usage.prompt_tokens + c.usage.completion_tokens,
        prompt_tokens_details: { cached_tokens: c.usage.cached_tokens ?? 0 },
      },
    },
  });
  out.push({ data: '[DONE]' });
  return out;
}

function encodeEvent(e: CassetteSseEvent): string {
  const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
  return `${e.event ? `event: ${e.event}\n` : ''}data: ${data}\n\n`;
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function makeResponse(r: CassetteResponse, signal: AbortSignal | undefined): Response {
  const events =
    r.sse ??
    (r.claudeMessage ? claudeSse(r.claudeMessage) : r.openaiCompletion ? openaiSse(r.openaiCompletion) : undefined);
  if (!events) {
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const e = events[i++];
      if (e) return ctrl.enqueue(enc.encode(encodeEvent(e)));
      if (!r.stall) return ctrl.close();
      return new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      }).catch((err: unknown) => ctrl.error(err));
    },
  });
  return new Response(body, { status: r.status, headers: { 'content-type': 'text/event-stream', ...r.headers } });
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

export function cassetteFetch(cassette: Cassette | string): CassetteTransport {
  const c = typeof cassette === 'string' ? loadCassette(cassette) : cassette;
  const used = new Set<number>();
  const requests: RecordedRequest[] = [];
  const unmatched: string[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown = raw;
    try {
      body = raw === undefined ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      /* keep raw */
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    requests.push({ method, path: url.pathname, headers: headersToRecord(init?.headers), body });
    const reasons: string[] = [];
    for (const [idx, it] of c.interactions.entries()) {
      if (used.has(idx) && !it.repeat) continue;
      if ((it.request.method ?? 'POST').toUpperCase() !== method || it.request.path !== url.pathname) continue;
      const mis =
        it.request.bodyHash !== undefined && normalizedBodyHash(body) !== it.request.bodyHash
          ? 'body hash differs'
          : it.request.match !== undefined
            ? subsetMismatch(it.request.match, body)
            : null;
      if (mis) {
        reasons.push(`#${idx}: ${mis}`);
        continue;
      }
      used.add(idx);
      return makeResponse(it.response, signal);
    }
    const msg = `Cassette "${c.name}": no interaction for ${method} ${url.pathname}. Nearest: ${reasons[0] ?? 'none with this path'}`;
    unmatched.push(msg);
    throw new Error(msg);
  };

  return {
    fetch: impl as typeof fetch,
    requests,
    unmatched,
    assertDone() {
      if (unmatched.length) throw new Error(unmatched.join('\n'));
      const unused = c.interactions.flatMap((it, i) => (used.has(i) || it.repeat ? [] : [i]));
      if (unused.length) throw new Error(`Cassette "${c.name}": unused interactions ${unused.join(', ')}`);
    },
  };
}
