/**
 * Fixture MCP lane (HOOK-SRC-01/03/05 mechanism only): an in-process McpClient serving synthetic
 * fixture text, the resolver that uses it, and the lane rule that routes the fixture host to it.
 * No transport, no credentials (03 §10.1 rules 1-3).
 */
import { createHash } from 'node:crypto';
import type {
  AuthBroker,
  LaneRule,
  McpClient,
  McpError,
  McpState,
  ResolveContext,
  ResolveOutcome,
  ResolvedSource,
  SourceInput,
  SourceResolver,
} from '@eli5/public/sources';
import { mapMcpErrorKind, skip } from '@eli5/public/sources';

/** Reserved `.test` host, so nothing here can ever reach a real system. */
export const FIXTURE_DOCS_HOST = 'docs.example.test';

export const FIXTURE_LANE_RULES: LaneRule[] = [
  {
    id: 'fixture-docs',
    match: { hostGlob: FIXTURE_DOCS_HOST },
    route: { lane: 'mcp', resolverId: 'mcp', noWebFallback: true },
  },
];

/** Synthetic pages by path; the error rows exercise the McpError -> SkipCode mapping. */
const PAGES: Record<string, { title: string; markdown: string } | McpError['kind']> = {
  '/guides/widgets': {
    title: 'Widget supply guide',
    markdown: [
      '# Widget supply guide',
      '',
      'Example Widgets Inc. plans widget supply each quarter from a demand forecast.',
      '',
      '- Safety stock covers two weeks of demand.',
      '- Suppliers confirm capacity one month ahead.',
      '',
    ].join('\n'),
  },
  '/restricted/plan': 'forbidden',
  '/expired/session': 'auth-expired',
};

export interface FetchDocumentResult {
  title: string;
  markdown: string;
  permalink: string;
}

class FixtureMcpError extends Error implements McpError {
  constructor(readonly kind: McpError['kind']) {
    super(`fixture MCP ${kind}`);
    this.name = 'McpError';
  }
}

const aborted = () => new FixtureMcpError('timeout');

export class FixtureMcpClient implements McpClient {
  readonly serverUrl = `https://mcp.example.test/`;
  /** Every tool call, for assertions. */
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private readonly latencyMs: number;

  constructor(opts: { latencyMs?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
  }

  state(): McpState {
    return 'connected';
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    this.calls.push({ name, args });
    if (opts.signal.aborted) throw aborted();
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.latencyMs);
        opts.signal.addEventListener('abort', () => (clearTimeout(t), reject(aborted())), { once: true });
      });
    }
    if (name !== 'fetch_document') throw new FixtureMcpError('tool-error');
    let url: URL;
    try {
      url = new URL(String(args.url));
    } catch {
      throw new FixtureMcpError('not-found');
    }
    const page = url.hostname === FIXTURE_DOCS_HOST ? PAGES[url.pathname] : undefined;
    if (page === undefined) throw new FixtureMcpError('not-found');
    if (typeof page === 'string') throw new FixtureMcpError(page);
    const result: FetchDocumentResult = { ...page, permalink: `${url.origin}${url.pathname}?v=1` };
    return result as T;
  }

  onStateChange(_listener: (s: McpState) => void): () => void {
    return () => {};
  }

  async close(): Promise<void> {}
}

const isMcpError = (e: unknown): e is McpError =>
  e instanceof Error && typeof (e as { kind?: unknown }).kind === 'string';

/** MCP-brokered resolver (03 §10.1 required behavior 1-5), serving fixture text. */
export class FixtureMcpResolver implements SourceResolver {
  readonly id = 'mcp';
  readonly handles = ['url'] as const;
  readonly lane = 'mcp' as const;

  constructor(
    private readonly auth: AuthBroker & { expire?: () => void },
    private readonly client: McpClient,
  ) {}

  canResolve(input: SourceInput, ctx: ResolveContext): boolean {
    if (input.kind !== 'url') return false;
    try {
      return ctx.lanes.route(new URL(input.url)).lane === 'mcp';
    } catch {
      return false;
    }
  }

  async resolve(input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
    const ref = input.kind === 'url' ? input.url : input.id;
    if (input.kind !== 'url') return { resolved: [], skipped: [skip(ref, 'unsupported-type')] };
    if (ctx.signal.aborted) return { resolved: [], skipped: [skip(ref, 'cancelled')] };
    // Rule 2: never start a sign-in from a job.
    if (this.auth.status().state !== 'signed-in') return { resolved: [], skipped: [skip(ref, 'sign-in-required')] };
    try {
      const doc = await (ctx.mcp ?? this.client).callTool<FetchDocumentResult>(
        'fetch_document',
        { url: input.url },
        { signal: ctx.signal, timeoutMs: ctx.limits.perSourceTimeoutMs },
      );
      const text = doc.markdown;
      const source: ResolvedSource = {
        id: '',
        inputId: input.id,
        ref: doc.title,
        location: doc.permalink,
        lane: this.lane,
        resolverId: this.id,
        format: 'markdown',
        mediaType: 'text/markdown',
        title: doc.title,
        payload: { kind: 'text', text },
        sizeBytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
        notes: [],
      };
      return { resolved: [source], skipped: [] };
    } catch (err) {
      if (ctx.signal.aborted) return { resolved: [], skipped: [skip(ref, 'cancelled')] };
      if (!isMcpError(err)) return { resolved: [], skipped: [skip(ref, 'fetch-failed')] };
      // Rule 4: an expired session also moves the broker to `expired`.
      if (err.kind === 'auth-expired') this.auth.expire?.();
      return { resolved: [], skipped: [skip(ref, mapMcpErrorKind(err.kind))] };
    }
  }
}
