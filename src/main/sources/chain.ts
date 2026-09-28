/**
 * Resolver chain (03 §4): bounded-concurrency resolution in input order, lane routing for URLs,
 * error mapping to SkippedSource, dedupe, job totals and final ids. Never prompts or waits on the
 * user; anything that needs the user becomes a skip.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotAvailableInEdition } from '../editions';
import { ORG_SOURCE_DETAIL, skip } from './reasons';
import { normalizeUrl, refForUrl } from './url';
import type {
  LaneRoute,
  ResolveContext,
  ResolveOutcome,
  ResolvedSource,
  SkippedSource,
  SourceInput,
  SourceResolver,
} from './types';

/** Label for an input before any resolver has run (03 §2 `ref` rules). */
export function inputRef(input: SourceInput): string {
  switch (input.kind) {
    case 'file':
      return path.basename(input.path) || input.path;
    case 'url':
      return refForUrl(input.url);
    case 'text':
    case 'image':
      return input.preview || (input.kind === 'image' ? 'Pasted image' : 'Pasted text');
  }
}

const one = (s: SkippedSource): ResolveOutcome => ({ resolved: [], skipped: [s] });

function isNotAvailable(err: unknown): boolean {
  return (
    err instanceof NotAvailableInEdition ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'E_NOT_AVAILABLE_IN_EDITION')
  );
}

class ResolveTimeout extends Error {
  constructor() {
    super('resolve timed out');
    this.name = 'ResolveTimeout';
  }
}

/**
 * Run fn with a per-source deadline and the job signal (03 §4 step 2.4). The resolver gets a child
 * signal that aborts on either; the race also stops waiting for a resolver that ignores it.
 */
async function withTimeout<T>(ms: number, parent: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => {
      ctl.abort(parent.reason);
      reject(parent.reason instanceof Error ? parent.reason : new DOMException('Aborted', 'AbortError'));
    };
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const e = new ResolveTimeout();
      ctl.abort(e);
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) parent.removeEventListener('abort', onAbort);
  }
}

interface Routed {
  input: SourceInput;
  route?: LaneRoute;
}

/** 03 §4 step 2.2: URL normalization, file:// rewrite and lane routing. */
function routeInput(input: SourceInput, ctx: ResolveContext): Routed | SkippedSource {
  if (input.kind !== 'url') return { input };
  const raw = input.url.trim();
  // Enterprise only: bare identifiers (e.g. ticket keys) may be claimed before normalization (§7.1 step 6).
  const bare = ctx.lanes.routeBare(raw);
  if (bare) return { input: { ...input, url: bare.url.href }, route: bare.route };
  const norm = normalizeUrl(raw);
  if (!norm.ok) return skip(refForUrl(raw), norm.code);
  if (norm.url.protocol === 'file:') {
    try {
      return { input: { id: input.id, kind: 'file', origin: input.origin, path: fileURLToPath(norm.url) } };
    } catch {
      return skip(refForUrl(raw), 'not-a-url');
    }
  }
  return { input: { ...input, url: norm.url.href }, route: ctx.lanes.route(norm.url) };
}

function candidatesFor(routed: Routed, resolvers: readonly SourceResolver[]): SourceResolver[] {
  const kind = routed.input.kind;
  return resolvers.filter((r) => {
    if (!r.handles.includes(kind)) return false;
    const route = routed.route;
    if (!route) return true;
    return route.resolverId !== undefined ? r.id === route.resolverId : r.lane === route.lane;
  });
}

/** Run one resolver under the per-source deadline, mapping every failure to a skip (03 §4 step 2.4-2.5). */
async function attempt(chosen: SourceResolver, input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
  try {
    const out = await withTimeout(ctx.limits.perSourceTimeoutMs, ctx.signal, (signal) =>
      chosen.resolve(input, { ...ctx, signal }),
    );
    if (out.resolved.length === 0 && out.skipped.length === 0) {
      // Invariant (03 §4): every input yields a record.
      return one(skip(inputRef(input), ctx.signal.aborted ? 'cancelled' : 'read-error'));
    }
    return out;
  } catch (err) {
    const r = inputRef(input);
    const fields = { jobId: ctx.jobId, sourceKind: input.kind, kind: (err as Error | null)?.name ?? 'Error' };
    if (isNotAvailable(err)) {
      const e = err as NotAvailableInEdition;
      ctx.log('sources.chain.not-available', {
        ...fields,
        code: 'not-available-in-edition',
        hookId: e.hookId,
        capability: e.capability,
      });
      return one(skip(r, 'not-available-in-edition'));
    }
    if (ctx.signal.aborted) return one(skip(r, 'cancelled'));
    if (err instanceof ResolveTimeout) {
      ctx.log('sources.chain.timeout', { ...fields, code: 'timeout' });
      return one(
        input.kind === 'url' ? skip(r, 'timeout') : { ref: r, code: 'timeout', reason: 'Took too long to read.' },
      );
    }
    // Unexpected: generic reason text; details only in the local log (03 §4 step 2.5).
    ctx.log('sources.chain.resolver-error', { ...fields, code: 'read-error', step: chosen.id });
    return one(skip(r, 'read-error'));
  }
}

async function resolveOne(
  original: SourceInput,
  ctx: ResolveContext,
  resolvers: readonly SourceResolver[],
): Promise<ResolveOutcome> {
  const ref = inputRef(original);
  if (ctx.signal.aborted) return one(skip(ref, 'cancelled'));

  const routed = routeInput(original, ctx);
  if (!('input' in routed)) return one(routed);
  const { input, route } = routed;
  const orgRoute = route?.lane === 'mcp';
  const candidates = candidatesFor(routed, resolvers);

  // 03 §8 steps 3-4: an organization route falls back to the web lane only when its rule allows it
  // (noWebFallback: false); otherwise candidates stay restricted to the routed lane or resolver id.
  const webFallback =
    orgRoute && !route.noWebFallback
      ? candidatesFor({ input, route: { lane: 'web', noWebFallback: false } }, resolvers).find((r) =>
          r.canResolve(input, ctx),
        )
      : undefined;
  const chosen = orgRoute && ctx.edition === 'public' ? undefined : candidates.find((r) => r.canResolve(input, ctx));
  if (!chosen && webFallback) {
    ctx.log('sources.chain.web-fallback', { jobId: ctx.jobId, sourceKind: 'url', reason: 'no-mcp-resolver' });
    return attempt(webFallback, input, ctx);
  }
  if (!chosen && orgRoute) {
    ctx.log('sources.chain.org-route', { jobId: ctx.jobId, code: 'not-available-in-edition', sourceKind: 'url' });
    return one(skip(inputRef(input), 'not-available-in-edition', ORG_SOURCE_DETAIL));
  }
  if (!chosen) return one(skip(inputRef(input), 'unsupported-type'));

  const out = await attempt(chosen, input, ctx);
  if (!webFallback || out.resolved.length > 0 || ctx.signal.aborted) return out;
  // The MCP lane failed for a route that permits it: retry once on the web lane. If that also
  // fails, the MCP failure is the more useful reason and is the one reported.
  ctx.log('sources.chain.web-fallback', { jobId: ctx.jobId, sourceKind: 'url', reason: 'mcp-failed' });
  const retry = await attempt(webFallback, input, ctx);
  return retry.resolved.length > 0 || ctx.signal.aborted ? retry : out;
}

/** Dedupe key (03 §4 step 4): sha256 for local content, URL without fragment for web/mcp. */
function dedupeKey(src: ResolvedSource): string {
  if (src.lane === 'local') return `sha:${src.sha256}`;
  const n = normalizeUrl(src.location);
  return `url:${n.ok ? n.key : src.location}`;
}

/**
 * resolveAll (03 §4). `resolvers` is the registry's chain order (`registry.resolvers()`).
 * Final order equals input order; at most `limits.concurrency` inputs are in flight.
 */
export async function resolveAll(
  inputs: readonly SourceInput[],
  ctx: ResolveContext,
  resolvers: readonly SourceResolver[],
): Promise<ResolveOutcome> {
  const results: ResolveOutcome[] = new Array<ResolveOutcome>(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const i = next++;
      const input = inputs[i]!;
      results[i] = ctx.signal.aborted
        ? one(skip(inputRef(input), 'cancelled'))
        : await resolveOne(input, ctx, resolvers);
    }
  };
  const width = Math.max(1, Math.min(Math.floor(ctx.limits.concurrency) || 1, inputs.length));
  await Promise.all(Array.from({ length: width }, () => worker()));

  // Steps 3-5: flatten in input order, dedupe, enforce job totals.
  const resolved: ResolvedSource[] = [];
  const skipped: SkippedSource[] = [];
  const kept = new Map<string, ResolvedSource>();
  let totalBytes = 0;
  let overLimit = false;
  for (const out of results) {
    for (const src of out.resolved) {
      const key = dedupeKey(src);
      const first = kept.get(key);
      if (first) {
        const note = `duplicate of ${src.ref}`;
        if (!first.notes.includes(note)) first.notes.push(note);
        continue;
      }
      if (
        overLimit ||
        resolved.length + 1 > ctx.limits.maxSourcesPerJob ||
        totalBytes + src.sizeBytes > ctx.limits.maxTotalBytes
      ) {
        overLimit = true;
        skipped.push(skip(src.ref, 'limit-exceeded'));
        continue;
      }
      const copy = { ...src, notes: [...src.notes] };
      kept.set(key, copy);
      totalBytes += src.sizeBytes;
      resolved.push(copy);
    }
    skipped.push(...out.skipped);
  }

  // Step 6: ids in final order.
  resolved.forEach((src, i) => {
    src.id = `src-${String(i).padStart(2, '0')}`;
  });
  return { resolved, skipped };
}
