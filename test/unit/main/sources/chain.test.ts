import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { NotAvailableInEdition } from '../../../../src/main/editions/errors';
import { resolveAll } from '../../../../src/main/sources/chain';
import { ClipboardResolver } from '../../../../src/main/sources/clipboard';
import { FileResolver } from '../../../../src/main/sources/file';
import { buildLaneRouter } from '../../../../src/main/sources/lanes';
import { McpResolverStub } from '../../../../src/main/sources/mcp.stub';
import { TicketResolverStub } from '../../../../src/main/sources/ticket.stub';
import {
  DEFAULT_RESOLVE_LIMITS,
  type LaneRule,
  type ResolveContext,
  type ResolvedSource,
  type SourceInput,
  type SourceResolver,
} from '../../../../src/main/sources/types';
import { UrlResolver } from '../../../../src/main/sources/url';
import * as fx from './fixtures';
import { fakeCtx } from './helpers';

const publicChain = (): SourceResolver[] => [
  new TicketResolverStub(),
  new McpResolverStub(),
  new UrlResolver(),
  new FileResolver(),
  new ClipboardResolver(),
];

let n = 0;
const url = (u: string): SourceInput => ({
  id: `in-${(++n).toString(16).padStart(8, '0')}`,
  kind: 'url',
  origin: 'url-field',
  url: u,
});
const file = (p: string): SourceInput => ({
  id: `in-${(++n).toString(16).padStart(8, '0')}`,
  kind: 'file',
  origin: 'drop',
  path: p,
});

function src(over: Partial<ResolvedSource> & Pick<ResolvedSource, 'ref'>): ResolvedSource {
  return {
    id: '',
    inputId: 'in-x',
    location: over.ref,
    lane: 'local',
    resolverId: 'fake',
    format: 'text',
    mediaType: 'text/plain',
    payload: { kind: 'text', text: over.ref },
    sizeBytes: 10,
    sha256: `sha-${over.ref}`,
    notes: [],
    ...over,
  };
}

/** Fake url-kind resolver on the web lane whose behavior is scripted per URL. */
function scripted(
  script: (input: Extract<SourceInput, { kind: 'url' }>, ctx: ResolveContext) => Promise<ResolvedSource[]>,
  over: Partial<SourceResolver> = {},
): SourceResolver {
  return {
    id: 'url',
    handles: ['url'],
    lane: 'web',
    canResolve: (i) => i.kind === 'url',
    resolve: async (i, ctx) => ({ resolved: i.kind === 'url' ? await script(i, ctx) : [], skipped: [] }),
    ...over,
  };
}

const article = (ref: string, location = ref, size = 10): ResolvedSource =>
  src({ ref, location, lane: 'web', sizeBytes: size, sha256: `sha-${location}` });

describe('resolveAll: ordering and concurrency (03 §4 step 2)', () => {
  it('preserves input order with at most `concurrency` in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = scripted(async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later inputs finish first.
      await new Promise((res) => setTimeout(res, 40 - Number(i.url.slice(-1)) * 5));
      inFlight--;
      return [article(i.url)];
    });
    const inputs = Array.from({ length: 7 }, (_, k) => url(`https://example.com/p${k}`));
    const out = await resolveAll(inputs, fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, concurrency: 3 } }), [r]);
    expect(peak).toBe(3);
    expect(out.resolved.map((s) => s.ref)).toEqual(inputs.map((i) => (i.kind === 'url' ? i.url : '')));
    expect(out.resolved.map((s) => s.id)).toEqual([
      'src-00',
      'src-01',
      'src-02',
      'src-03',
      'src-04',
      'src-05',
      'src-06',
    ]);
  });

  it('reports each settled input through onInputSettled (06 §5.2 step 3 progress)', async () => {
    const r = scripted(async (i) => [article(i.url)]);
    const inputs = [url('https://example.com/a'), url('not a url'), url('https://example.com/b')];
    const settled: number[] = [];
    await resolveAll(inputs, fakeCtx({ onInputSettled: (i) => settled.push(i) }), [r]);
    expect([...settled].sort()).toEqual([0, 1, 2]);
  });

  it('empty input list -> empty outcome', async () => {
    expect(await resolveAll([], fakeCtx(), publicChain())).toEqual({ resolved: [], skipped: [] });
  });
});

describe('resolveAll: dedupe (03 §4 step 4)', () => {
  it('same file dropped twice and inside a dropped folder -> one source with a duplicate note', async () => {
    const dir = await fx.tmpDir();
    const a = await fx.put(dir, 'Folder/notes.md', fx.TEXT_BODY);
    await fx.put(dir, 'Folder/other.md', '# other\n');
    const out = await resolveAll([file(a), file(a), file(path.join(dir, 'Folder'))], fakeCtx(), publicChain());
    expect(out.skipped).toEqual([]);
    expect(out.resolved.map((s) => s.ref)).toEqual(['notes.md', 'other.md']);
    expect(out.resolved[0]?.notes).toEqual(['duplicate of notes.md']);
  });

  it('same URL with different fragments -> one source; ref keeps the first', async () => {
    const r = scripted(async (i) => [article(i.url, i.url.replace(/#.*$/, ''))]);
    const out = await resolveAll(
      [url('https://example.com/a#one'), url('https://example.com/a#two'), url('https://example.com/b')],
      fakeCtx(),
      [r],
    );
    expect(out.resolved.map((s) => s.ref)).toEqual(['https://example.com/a#one', 'https://example.com/b']);
    expect(out.resolved[0]?.notes).toEqual(['duplicate of https://example.com/a#two']);
  });
});

describe('resolveAll: job totals (03 §4 step 5)', () => {
  it('sources beyond maxSourcesPerJob become limit-exceeded skips', async () => {
    const r = scripted(async (i) => [article(i.url)]);
    const out = await resolveAll(
      [url('https://e.test/1'), url('https://e.test/2'), url('https://e.test/3')],
      fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, maxSourcesPerJob: 2 } }),
      [r],
    );
    expect(out.resolved.map((s) => s.id)).toEqual(['src-00', 'src-01']);
    expect(out.skipped).toEqual([
      {
        ref: 'https://e.test/3',
        code: 'limit-exceeded',
        reason: 'Too many sources in one job; this one was not used.',
      },
    ]);
  });

  it('once maxTotalBytes would be exceeded, every further source is skipped (even small ones)', async () => {
    const sizes: Record<string, number> = { 'https://e.test/1': 60, 'https://e.test/2': 50, 'https://e.test/3': 1 };
    const r = scripted(async (i) => [article(i.url, i.url, sizes[i.url] ?? 0)]);
    const out = await resolveAll(
      Object.keys(sizes).map(url),
      fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, maxTotalBytes: 100 } }),
      [r],
    );
    expect(out.resolved.map((s) => s.ref)).toEqual(['https://e.test/1']);
    expect(out.skipped.map((s) => [s.ref, s.code])).toEqual([
      ['https://e.test/2', 'limit-exceeded'],
      ['https://e.test/3', 'limit-exceeded'],
    ]);
  });
});

describe('resolveAll: error mapping (03 §4 step 2.5)', () => {
  it('NotAvailableInEdition -> not-available-in-edition; unexpected throw -> generic read-error', async () => {
    const log = vi.fn();
    const r = scripted(async (i) => {
      if (i.url.endsWith('/stub')) throw new NotAvailableInEdition('source:x', 'HOOK-SRC-01', 'public');
      throw new Error('internal detail /Users/someone/secret.txt');
    });
    const out = await resolveAll([url('https://e.test/stub'), url('https://e.test/boom')], fakeCtx({ log }), [r]);
    expect(out.skipped).toEqual([
      { ref: 'https://e.test/stub', code: 'not-available-in-edition', reason: 'Requires the enterprise edition.' },
      { ref: 'https://e.test/boom', code: 'read-error', reason: 'Could not be read.' },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret.txt');
    expect(log).toHaveBeenCalledWith('sources.chain.not-available', expect.objectContaining({ hookId: 'HOOK-SRC-01' }));
  });

  it('per-source timeout -> timeout skip, and the resolver signal is aborted', async () => {
    let seen: AbortSignal | undefined;
    const r = scripted((_i, ctx) => {
      seen = ctx.signal;
      return new Promise(() => {}); // never settles
    });
    const out = await resolveAll(
      [url('https://e.test/slow')],
      fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, perSourceTimeoutMs: 30 } }),
      [r],
    );
    expect(out.skipped).toEqual([{ ref: 'https://e.test/slow', code: 'timeout', reason: 'fetch timed out' }]);
    expect(seen?.aborted).toBe(true);
  });

  it('job cancellation: in-flight aborted, remaining inputs recorded as cancelled', async () => {
    const ctl = new AbortController();
    const r = scripted(
      (_i, ctx) =>
        new Promise((_res, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => ctl.abort(), 5);
        }),
    );
    const out = await resolveAll(
      [url('https://e.test/1'), url('https://e.test/2'), url('https://e.test/3')],
      fakeCtx({ signal: ctl.signal, limits: { ...DEFAULT_RESOLVE_LIMITS, concurrency: 1 } }),
      [r],
    );
    expect(out.resolved).toEqual([]);
    expect(out.skipped.map((s) => s.code)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(out.skipped[0]?.reason).toBe('Job was cancelled.');
  });

  it('an already-aborted signal resolves nothing', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const resolve = vi.fn();
    const out = await resolveAll([url('https://e.test/1')], fakeCtx({ signal: ctl.signal }), [scripted(resolve)]);
    expect(resolve).not.toHaveBeenCalled();
    expect(out.skipped[0]?.code).toBe('cancelled');
  });

  it('a resolver returning no records yields a read-error (every input yields a record)', async () => {
    const out = await resolveAll([url('https://e.test/1')], fakeCtx(), [scripted(async () => [])]);
    expect(out.skipped[0]?.code).toBe('read-error');
  });

  it('no resolver claims the input -> unsupported-type', async () => {
    const out = await resolveAll([url('https://e.test/1')], fakeCtx(), [new FileResolver()]);
    expect(out.skipped[0]).toMatchObject({ code: 'unsupported-type' });
  });
});

describe('resolveAll: URL handling and lane routing (03 §4 step 2.2, §8)', () => {
  it('invalid URLs and schemes are skipped before any resolver runs', async () => {
    const resolve = vi.fn();
    const out = await resolveAll([url('ABC-123'), url('mailto:a@example.com')], fakeCtx(), [scripted(resolve)]);
    expect(out.skipped).toEqual([
      { ref: 'ABC-123', code: 'not-a-url', reason: 'Not a valid web address.' },
      {
        ref: 'mailto:a@example.com',
        code: 'unsupported-scheme',
        reason: 'Only web addresses (http or https) are supported.',
      },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('userinfo is stripped from chain-built refs (timeout, cancelled, invalid)', async () => {
    const slow = scripted(() => new Promise(() => {}));
    const out = await resolveAll(
      [url('https://u:s3cret@e.test/slow'), url('https://u:s3cret@exa mple.test/')],
      fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, perSourceTimeoutMs: 30 } }),
      [slow],
    );
    expect(out.skipped.map((s) => [s.ref, s.code])).toEqual([
      ['https://e.test/slow', 'timeout'],
      ['https://exa mple.test/', 'not-a-url'],
    ]);
    expect(JSON.stringify(out)).not.toContain('s3cret');
  });

  it('file:// URLs are rewritten to file inputs', async () => {
    const dir = await fx.tmpDir();
    const p = await fx.put(dir, 'notes.md', fx.TEXT_BODY);
    const out = await resolveAll([url(pathToFileURL(p).href)], fakeCtx(), publicChain());
    expect(out.resolved[0]).toMatchObject({ resolverId: 'file', ref: 'notes.md', format: 'markdown' });
  });

  it('public build: every URL takes the web lane; stubs are never selected', async () => {
    const fetchUrl = vi.fn(() =>
      Promise.resolve({ kind: 'skipped' as const, code: 'login-required' as const, reason: 'page required login' }),
    );
    const out = await resolveAll(
      [url('https://tickets.example.internal/browse/ABC-1')],
      fakeCtx({ fetchUrl }),
      publicChain(),
    );
    expect(fetchUrl).toHaveBeenCalledOnce();
    expect(out.skipped).toEqual([
      { ref: 'https://tickets.example.internal/browse/ABC-1', code: 'login-required', reason: 'page required login' },
    ]);
  });

  const orgRules: LaneRule[] = [
    {
      id: 'tickets',
      match: { hostGlob: 'tickets.example.internal' },
      route: { lane: 'mcp', resolverId: 'ticket', noWebFallback: true },
    },
    { id: 'org', match: { hostGlob: '*.example.internal' }, route: { lane: 'mcp', noWebFallback: true } },
  ];

  it('an organization route in the public edition is skipped and never fetched on the web lane', async () => {
    const fetchUrl = vi.fn();
    const out = await resolveAll(
      [url('https://wiki.example.internal/page'), url('https://tickets.example.internal/browse/ABC-1')],
      fakeCtx({ fetchUrl, lanes: buildLaneRouter(orgRules) }),
      publicChain(),
    );
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(out.skipped.map((s) => s.code)).toEqual(['not-available-in-edition', 'not-available-in-edition']);
    expect(out.skipped[0]?.reason).toContain('Organization source; requires the enterprise edition');
  });

  it('enterprise: an mcp-lane URL goes to the mcp-lane resolver; resolverId forces a specific one', async () => {
    const calls: string[] = [];
    const fake = (id: string): SourceResolver => ({
      id,
      handles: ['url'],
      lane: 'mcp',
      // A ticket resolver declines non-ticket URLs, so the org route falls to the next mcp-lane resolver.
      canResolve: (i) => id !== 'ticket' || (i.kind === 'url' && i.url.includes('/browse/')),
      resolve: async (i) => {
        calls.push(id);
        return { resolved: [src({ ref: i.kind === 'url' ? i.url : '', lane: 'mcp', resolverId: id })], skipped: [] };
      },
    });
    const web = scripted(async () => {
      throw new Error('web lane must not be used');
    });
    const out = await resolveAll(
      [url('https://tickets.example.internal/browse/ABC-1'), url('https://wiki.example.internal/page')],
      fakeCtx({
        edition: 'enterprise',
        lanes: buildLaneRouter(orgRules),
        limits: { ...DEFAULT_RESOLVE_LIMITS, concurrency: 1 },
      }),
      [fake('ticket'), fake('mcp'), web],
    );
    expect(calls).toEqual(['ticket', 'mcp']);
    expect(out.resolved.map((s) => s.resolverId)).toEqual(['ticket', 'mcp']);
  });

  it('enterprise with only the stubs: the stub NotAvailableInEdition becomes a skip, no web fallback', async () => {
    const fetchUrl = vi.fn();
    // The public stub never claims; this one is made to claim so the throw path is exercised.
    const claiming = new McpResolverStub();
    claiming.canResolve = () => true;
    const out = await resolveAll(
      [url('https://wiki.example.internal/page')],
      fakeCtx({ edition: 'enterprise', fetchUrl, lanes: buildLaneRouter(orgRules) }),
      [claiming, new UrlResolver()],
    );
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(out.skipped[0]?.code).toBe('not-available-in-edition');
  });

  it('enterprise with non-claiming stubs only: org route -> not-available-in-edition, not unsupported-type', async () => {
    const fetchUrl = vi.fn();
    const out = await resolveAll(
      [url('https://wiki.example.internal/page')],
      fakeCtx({ edition: 'enterprise', fetchUrl, lanes: buildLaneRouter(orgRules) }),
      publicChain(),
    );
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(out.skipped[0]?.code).toBe('not-available-in-edition');
  });

  describe('mcp routes with noWebFallback: false (03 §8 steps 3-4)', () => {
    const soft: LaneRule[] = [
      { id: 'soft', match: { hostGlob: '*.example.org' }, route: { lane: 'mcp', noWebFallback: false } },
    ];
    const web = (): SourceResolver => scripted(async (i) => [{ ...article(i.url, i.url), resolverId: 'url' }]);
    const mcp = (behavior: 'skip' | 'throw' | 'ok'): SourceResolver => ({
      id: 'mcp',
      handles: ['url'],
      lane: 'mcp',
      canResolve: () => true,
      resolve: async (i) => {
        if (behavior === 'throw') throw new Error('mcp down');
        if (behavior === 'skip')
          return { resolved: [], skipped: [{ ref: 'x', code: 'sign-in-required', reason: 'r' }] };
        return { resolved: [src({ ref: i.kind === 'url' ? i.url : '', lane: 'mcp', resolverId: 'mcp' })], skipped: [] };
      },
    });
    const u = 'https://docs.example.org/page';

    it('public edition (no mcp resolver): falls back to the web lane', async () => {
      const out = await resolveAll([url(u)], fakeCtx({ lanes: buildLaneRouter(soft) }), [new McpResolverStub(), web()]);
      expect(out.skipped).toEqual([]);
      expect(out.resolved.map((s) => [s.resolverId, s.lane])).toEqual([['url', 'web']]);
    });

    it('enterprise, no mcp resolver claims: falls back to the web lane', async () => {
      const out = await resolveAll([url(u)], fakeCtx({ edition: 'enterprise', lanes: buildLaneRouter(soft) }), [
        new McpResolverStub(),
        web(),
      ]);
      expect(out.resolved.map((s) => s.resolverId)).toEqual(['url']);
    });

    it.each(['skip', 'throw'] as const)('enterprise, mcp resolver fails (%s): retried on the web lane', async (b) => {
      const out = await resolveAll([url(u)], fakeCtx({ edition: 'enterprise', lanes: buildLaneRouter(soft) }), [
        mcp(b),
        web(),
      ]);
      expect(out.skipped).toEqual([]);
      expect(out.resolved.map((s) => s.resolverId)).toEqual(['url']);
    });

    it('enterprise, mcp resolver succeeds: the web lane is not used', async () => {
      const w = vi.fn();
      const out = await resolveAll([url(u)], fakeCtx({ edition: 'enterprise', lanes: buildLaneRouter(soft) }), [
        mcp('ok'),
        scripted(w),
      ]);
      expect(w).not.toHaveBeenCalled();
      expect(out.resolved.map((s) => s.resolverId)).toEqual(['mcp']);
    });

    it('when the web fallback also fails, the mcp failure is reported', async () => {
      const failing = scripted(async () => {
        throw new Error('web down');
      });
      const out = await resolveAll([url(u)], fakeCtx({ edition: 'enterprise', lanes: buildLaneRouter(soft) }), [
        mcp('skip'),
        failing,
      ]);
      expect(out.skipped.map((s) => s.code)).toEqual(['sign-in-required']);
    });

    it('noWebFallback: true still never reaches the web lane when the mcp resolver fails', async () => {
      const hard: LaneRule[] = [{ ...soft[0]!, route: { lane: 'mcp', noWebFallback: true } }];
      const w = vi.fn();
      const out = await resolveAll([url(u)], fakeCtx({ edition: 'enterprise', lanes: buildLaneRouter(hard) }), [
        mcp('throw'),
        scripted(w),
      ]);
      expect(w).not.toHaveBeenCalled();
      expect(out.skipped.map((s) => s.code)).toEqual(['read-error']);
    });
  });

  it('routeBare claims bare identifiers before normalization (enterprise router)', async () => {
    const seen: string[] = [];
    const lanes = {
      route: () => ({ lane: 'web' as const, noWebFallback: false }),
      routeBare: (t: string) =>
        /^[A-Z]+-\d+$/.test(t)
          ? {
              url: new URL(`https://tickets.example.internal/browse/${t}`),
              route: { lane: 'mcp' as const, resolverId: 'ticket', noWebFallback: true },
            }
          : null,
    };
    const ticket: SourceResolver = {
      id: 'ticket',
      handles: ['url'],
      lane: 'mcp',
      canResolve: () => true,
      resolve: async (i) => {
        seen.push(i.kind === 'url' ? i.url : '');
        return { resolved: [src({ ref: 'ABC-1', lane: 'mcp' })], skipped: [] };
      },
    };
    const out = await resolveAll([url('ABC-1')], fakeCtx({ edition: 'enterprise', lanes }), [ticket]);
    expect(seen).toEqual(['https://tickets.example.internal/browse/ABC-1']);
    expect(out.resolved).toHaveLength(1);
  });
});

describe('resolveAll: mixed public chain end to end (fakes only)', () => {
  it('file, pasted text, URL article and an unsupported file keep input order', async () => {
    const dir = await fx.tmpDir();
    const staging = path.join(dir, 'jobs', 'job-1');
    const md = await fx.put(dir, 'plan.md', '# Plan\n- one\n');
    const rtf = await fx.put(dir, 'memo.rtf', fx.rtf());
    const pasted = await fx.put(staging, 'inputs/1-pasted-1.txt', 'Example Widgets Inc. pasted notes');
    const inputs: SourceInput[] = [
      file(md),
      {
        id: 'in-0000aaaa',
        kind: 'text',
        origin: 'paste',
        stagedPath: pasted,
        markup: 'plain',
        preview: 'Pasted text: Example…',
      },
      url('https://example.com/post'),
      file(rtf),
    ];
    const fetchUrl = vi.fn(() =>
      Promise.resolve({
        kind: 'article' as const,
        content: {
          requestedUrl: 'https://example.com/post',
          finalUrl: 'https://example.com/post',
          title: 'Post',
          byline: null,
          siteName: null,
          lang: null,
          publishedTime: null,
          excerpt: null,
          contentHtml: '<p>Example</p>',
          textLength: 7,
          via: 'http' as const,
          imageUrls: [],
        },
      }),
    );
    const out = await resolveAll(inputs, fakeCtx({ stagingDir: staging, fetchUrl }), publicChain());
    expect(out.resolved.map((s) => [s.id, s.resolverId, s.format])).toEqual([
      ['src-00', 'file', 'markdown'],
      ['src-01', 'clipboard', 'text'],
      ['src-02', 'url', 'html'],
    ]);
    expect(out.skipped).toEqual([
      { ref: 'memo.rtf', code: 'unsupported-type', reason: 'Unsupported file type: RTF; save as .docx or plain text.' },
    ]);
  });
});
