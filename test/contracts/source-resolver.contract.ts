/**
 * SourceResolver contract suite (13 §10.2). Public and private resolvers run identical assertions:
 * canResolve is pure; every input yields a ResolvedSource or a SkippedSource {ref, reason, code};
 * the abort signal is honored within 1 s; no credential material appears in the outcome (outside
 * the user's own payload content) or in log calls.
 */
import { describe, expect, it } from 'vitest';
import {
  buildLaneRouter,
  DEFAULT_RESOLVE_LIMITS,
  IMAGE_FORMATS,
  SKIP_REASONS,
  type ResolveContext,
  type ResolveOutcome,
  type SourceInput,
  type SourceResolver,
} from '../../src/main/sources';
import type { FetchContext, FetchOutcome } from '../../src/main/fetch';

export interface ResolverContractCase {
  name: string;
  /** Creates whatever the input needs (files, staged pastes) and returns it with ctx overrides. */
  setup: () => Promise<{ input: SourceInput; ctx?: Partial<ResolveContext> }>;
  /** What the outcome must contain. Default 'either'. */
  expect?: 'resolved' | 'skipped' | 'either';
}

const SOURCE_FORMATS = new Set<string>([
  'pptx',
  'docx',
  'xlsx',
  'pdf',
  'markdown',
  'text',
  'csv',
  'html',
  ...IMAGE_FORMATS,
]);

/** Token-shaped strings (13 §10.2). Built from parts so this file holds no literal secrets. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  new RegExp(['sk', '-', '[A-Za-z0-9_-]{20,}'].join('')),
  new RegExp(['gh', '[pousr]_', '[A-Za-z0-9]{20,}'].join('')),
  new RegExp(['AK', 'IA', '[0-9A-Z]{16}'].join('')),
  new RegExp(['xox', '[abprs]-', '[A-Za-z0-9-]{10,}'].join('')),
  new RegExp(['Bear', 'er\\s+', '[A-Za-z0-9._~+/-]{20,}'].join(''), 'i'),
  new RegExp(['ey', 'J[A-Za-z0-9_-]{10,}\\.', '[A-Za-z0-9_-]{10,}\\.'].join('')),
];

export function findCredentialLike(text: string): string | null {
  for (const re of CREDENTIAL_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Default fetch fake: never touches the network and settles only when the signal aborts. */
function hangingFetch(_url: string, fctx: FetchContext): Promise<FetchOutcome> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
    if (fctx.signal.aborted) fail();
    else fctx.signal.addEventListener('abort', fail, { once: true });
  });
}

function baseCtx(logs: unknown[][], over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    jobId: 'job-contract',
    edition: 'public',
    stagingDir: '/nonexistent/eli5-contract/jobs/job-contract',
    signal: new AbortController().signal,
    limits: { ...DEFAULT_RESOLVE_LIMITS },
    fetchUrl: hangingFetch,
    lanes: buildLaneRouter([]),
    log: (...args: unknown[]) => void logs.push(args),
    ...over,
  };
}

/** Outcome without payload bodies: user content may legitimately contain anything. */
function scrubPayloads(out: ResolveOutcome): unknown {
  return {
    resolved: out.resolved.map(({ payload, ...rest }) => ({ ...rest, payloadKind: payload.kind })),
    skipped: out.skipped,
  };
}

function settlesWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'timeout'> {
  return Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms)),
  ]);
}

export function describeSourceResolverContract(
  name: string,
  make: () => Promise<SourceResolver>,
  cases: ResolverContractCase[],
): void {
  describe(`SourceResolver contract: ${name}`, () => {
    it('has a stable id, a lane and a non-empty handles list', async () => {
      const r = await make();
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThan(0);
      expect(['local', 'web', 'mcp']).toContain(r.lane);
      expect(r.handles.length).toBeGreaterThan(0);
    });

    for (const c of cases) {
      describe(c.name, () => {
        it('canResolve is pure: synchronous, deterministic, does not mutate the input', async () => {
          const r = await make();
          const { input, ctx } = await c.setup();
          const logs: unknown[][] = [];
          const full = baseCtx(logs, ctx);
          const before = JSON.stringify(input);
          const a = r.canResolve(input, full);
          const b = r.canResolve(input, full);
          expect(typeof a).toBe('boolean');
          expect(b).toBe(a);
          expect(JSON.stringify(input)).toBe(before);
          expect(logs).toEqual([]);
        });

        it('yields ResolvedSource or SkippedSource {ref, reason, code} records', async () => {
          const r = await make();
          const { input, ctx } = await c.setup();
          const logs: unknown[][] = [];
          const out = await r.resolve(input, baseCtx(logs, ctx));
          expect(out.resolved.length + out.skipped.length).toBeGreaterThan(0);
          if (c.expect === 'resolved') expect(out.resolved.length).toBeGreaterThan(0);
          if (c.expect === 'skipped') expect(out.resolved).toEqual([]);
          for (const s of out.resolved) {
            expect(s.inputId).toBe(input.id);
            expect(s.resolverId).toBe(r.id);
            expect(s.lane).toBe(r.lane);
            expect(s.ref.length).toBeGreaterThan(0);
            expect(s.location.length).toBeGreaterThan(0);
            expect(SOURCE_FORMATS.has(s.format)).toBe(true);
            expect(s.mediaType).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
            expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(Number.isInteger(s.sizeBytes) && s.sizeBytes > 0).toBe(true);
            expect(Array.isArray(s.notes)).toBe(true);
            expect(['path', 'text', 'html']).toContain(s.payload.kind);
          }
          for (const s of out.skipped) {
            expect(s.ref.length).toBeGreaterThan(0);
            expect(s.reason.trim().length).toBeGreaterThan(0);
            expect(Object.keys(SKIP_REASONS)).toContain(s.code);
          }
        });

        it('honors an already-aborted signal within 1 s', async () => {
          const r = await make();
          const { input, ctx } = await c.setup();
          const ctl = new AbortController();
          ctl.abort();
          const verdict = await settlesWithin(r.resolve(input, baseCtx([], { ...ctx, signal: ctl.signal })), 1000);
          expect(verdict).toBe('settled');
        });

        it('honors an abort during resolution within 1 s', async () => {
          const r = await make();
          const { input, ctx } = await c.setup();
          const ctl = new AbortController();
          const p = r.resolve(input, baseCtx([], { ...ctx, signal: ctl.signal }));
          setTimeout(() => ctl.abort(), 5);
          expect(await settlesWithin(p, 1000)).toBe('settled');
        });

        it('exposes no credential material in the outcome or logs', async () => {
          const r = await make();
          const { input, ctx } = await c.setup();
          const logs: unknown[][] = [];
          const out = await r.resolve(input, baseCtx(logs, ctx)).catch(() => ({ resolved: [], skipped: [] }));
          expect(findCredentialLike(JSON.stringify(scrubPayloads(out)))).toBeNull();
          expect(findCredentialLike(JSON.stringify(logs))).toBeNull();
        });
      });
    }
  });
}
