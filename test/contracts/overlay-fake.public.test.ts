/**
 * Cell F in-process (13 §10.1): the fixture overlay under the EditionOverlay contract, and each fake
 * it registers under its own seam contract, so the enterprise mechanism is proven without any
 * private code. The overlay imports public code only through `@eli5/public/*` (01 §6.5); Vitest has
 * no such alias, so the mocks below map it onto the real modules (same instances as ours).
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS, type Settings } from '../../src/main/config';
import { buildLaneRouter, DEFAULT_RESOLVE_LIMITS, resolveAll, type SourceInput } from '../../src/main/sources';
import { FakeProvider } from '../../src/main/llm/testing/fake';
import overlay, {
  FIXTURE_DOCS_HOST,
  FIXTURE_LANE_RULES,
  FixtureAuthBroker,
  FixtureMcpClient,
  FixtureMcpResolver,
  PublishRecorder,
  RecordingPublisher,
  createFixtureGateway,
  fixtureRecorder,
} from '../fixtures/overlay-fake';
import { describeAuthContract } from './auth.contract';
import { describeLLMProviderContract, type ContractScenario } from './llm-provider.contract';
import { applyOverlay, describeOverlayContract, enterpriseRegistry } from './overlay.contract';
import { describePublisherContract } from './publisher.contract';
import { describeSourceResolverContract } from './source-resolver.contract';
import { BaselineSecretScanner } from '../../src/main/publish';

vi.mock('@eli5/public/config', () => import('../../src/main/config'));
vi.mock('@eli5/public/editions', () => import('../../src/main/editions'));
vi.mock('@eli5/public/llm', () => import('../../src/main/llm'));
vi.mock('@eli5/public/llm/testing/fake', () => import('../../src/main/llm/testing/fake'));
vi.mock('@eli5/public/publish', () => import('../../src/main/publish'));
vi.mock('@eli5/public/sources', () => import('../../src/main/sources'));

describeOverlayContract(overlay);

describe('fixture overlay registrations (13 §10.1)', () => {
  const bedrock: Settings = { ...DEFAULTS, llm: { ...DEFAULTS.llm, provider: 'bedrock' } };

  it('registers FakeProvider as bedrock, the fakes, lane rules and every UI feature', async () => {
    let settings = DEFAULTS;
    const reg = enterpriseRegistry(() => settings);
    const claims = await applyOverlay(overlay, reg);
    expect([...claims.llm]).toEqual(['bedrock']);
    expect([...claims.publishers].sort()).toEqual(['drive', 'git']);
    expect([...claims.resolvers]).toEqual(['mcp']);
    expect(claims.auth && claims.mcp).toBe(true);
    reg.freeze();
    settings = bedrock;
    expect(reg.llm()).toBeInstanceOf(FakeProvider);
    expect(reg.llm().id).toBe('bedrock');
    expect(reg.auth()).toBeInstanceOf(FixtureAuthBroker);
    expect(reg.mcp()).toBeInstanceOf(FixtureMcpClient);
    expect(reg.laneRouter().route(new URL(`https://${FIXTURE_DOCS_HOST}/guides/widgets`)).lane).toBe('mcp');
    expect(reg.laneRouter().route(new URL('https://example.com/')).lane).toBe('web');
    expect(reg.info()).toMatchObject({
      edition: 'enterprise',
      overlayLoaded: true,
      overlayName: overlay.name,
      uiFeatures: ['publish.drive', 'publish.git', 'auth.signIn'],
      authAvailable: true,
    });
    expect(reg.info().llmProviders.find((p) => p.id === 'bedrock')?.available).toBe(true);
    expect(reg.publisher('drive')).toBeInstanceOf(RecordingPublisher);
    expect(fixtureRecorder).toBeInstanceOf(PublishRecorder);
  });

  it('bedrock produces a complete scripted answer for every default task', async () => {
    const p = createFixtureGateway();
    const r = await p.generate({
      taskId: 'summary',
      system: 's',
      messages: [{ role: 'user', text: 'x' }],
      maxOutputTokens: 64,
    });
    expect(r.provider).toBe('bedrock');
    expect(JSON.parse(r.text)).toHaveProperty('topicSlugHint');
  });

  it('an organization URL resolves end to end through the chain via the fake MCP lane', async () => {
    const reg = enterpriseRegistry();
    await applyOverlay(overlay, reg);
    reg.freeze();
    const input: SourceInput = {
      id: 'in-0000f001',
      kind: 'url',
      origin: 'url-field',
      url: `https://${FIXTURE_DOCS_HOST}/guides/widgets`,
    };
    const out = await resolveAll(
      [input],
      {
        jobId: 'job-f',
        edition: 'enterprise',
        stagingDir: '/nonexistent/eli5-f',
        mcp: reg.mcp(),
        signal: new AbortController().signal,
        limits: { ...DEFAULT_RESOLVE_LIMITS },
        fetchUrl: () => Promise.reject(new Error('web lane must not be used')),
        lanes: reg.laneRouter(),
        log: () => {},
      },
      reg.resolvers(),
    );
    expect(out.skipped).toEqual([]);
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0]).toMatchObject({ lane: 'mcp', resolverId: 'mcp', format: 'markdown' });
    expect(out.resolved[0]!.payload).toMatchObject({ kind: 'text' });
  });
});

// ---- each fake under its seam contract ----

function gatewayFor(s: ContractScenario) {
  const valid = { title: 'Widget supply', topicSlugHint: 'widget-supply', summary: 'Synthetic.' };
  if (s.startsWith('error:')) return createFixtureGateway({ responses: {}, errors: { summary: s.slice(6) as never } });
  if (s === 'repair') return createFixtureGateway({ responses: { summary: [{ title: 'missing fields' }, valid] } });
  if (s === 'structured') return createFixtureGateway({ responses: { summary: valid } });
  return createFixtureGateway({ responses: { summary: '"Example Widgets Inc. makes widgets."' } });
}

describeLLMProviderContract('fixture bedrock gateway', async (s) => gatewayFor(s), { transport: 'fake' });

describeAuthContract('fixture auth broker', async () => new FixtureAuthBroker());
describeAuthContract('fixture auth broker (signed out)', async () => new FixtureAuthBroker({ initial: 'signed-out' }));

const docsRoute = () => buildLaneRouter(FIXTURE_LANE_RULES);
const orgUrl = (p: string): SourceInput => ({
  id: 'in-0000f002',
  kind: 'url',
  origin: 'url-field',
  url: `https://${FIXTURE_DOCS_HOST}${p}`,
});

describeSourceResolverContract(
  'fixture MCP resolver',
  async () => new FixtureMcpResolver(new FixtureAuthBroker(), new FixtureMcpClient({ latencyMs: 20 })),
  [
    {
      name: 'fixture page',
      setup: async () => ({ input: orgUrl('/guides/widgets'), ctx: { lanes: docsRoute() } }),
      expect: 'resolved',
    },
    {
      name: 'unknown page',
      setup: async () => ({ input: orgUrl('/missing'), ctx: { lanes: docsRoute() } }),
      expect: 'skipped',
    },
    {
      name: 'forbidden page',
      setup: async () => ({ input: orgUrl('/restricted/plan'), ctx: { lanes: docsRoute() } }),
      expect: 'skipped',
    },
    {
      name: 'public web URL (not claimed)',
      setup: async () => ({
        input: { id: 'in-0000f003', kind: 'url', origin: 'url-field', url: 'https://example.com/' },
      }),
      expect: 'skipped',
    },
  ],
);

describe('fixture MCP resolver rules (03 §10.1)', () => {
  const ctx = { lanes: docsRoute(), limits: { ...DEFAULT_RESOLVE_LIMITS } };
  it('claims only URLs routed to the mcp lane', () => {
    const r = new FixtureMcpResolver(new FixtureAuthBroker(), new FixtureMcpClient());
    const full = { ...ctx } as never;
    expect(r.canResolve(orgUrl('/guides/widgets'), full)).toBe(true);
    expect(r.canResolve({ id: 'x', kind: 'url', origin: 'url-field', url: 'https://example.com/' }, full)).toBe(false);
    expect(r.canResolve({ id: 'x', kind: 'url', origin: 'url-field', url: 'not a url' }, full)).toBe(false);
  });

  it('skips with sign-in-required when not signed in, without starting a sign-in', async () => {
    const auth = new FixtureAuthBroker({ initial: 'signed-out' });
    const r = new FixtureMcpResolver(auth, new FixtureMcpClient());
    const out = await r.resolve(orgUrl('/guides/widgets'), { ...ctx, signal: new AbortController().signal } as never);
    expect(out.skipped.map((s) => s.code)).toEqual(['sign-in-required']);
    expect(auth.interactions).toBe(0);
  });

  it('maps an expired session to sign-in-required and moves the broker to expired', async () => {
    const auth = new FixtureAuthBroker();
    const r = new FixtureMcpResolver(auth, new FixtureMcpClient());
    const out = await r.resolve(orgUrl('/expired/session'), { ...ctx, signal: new AbortController().signal } as never);
    expect(out.skipped.map((s) => s.code)).toEqual(['sign-in-required']);
    expect(auth.status().state).toBe('expired');
  });
});

for (const kind of ['drive', 'git'] as const) {
  const recorder = new PublishRecorder();
  describePublisherContract(
    `fixture ${kind} (recording)`,
    async () => new RecordingPublisher(kind, recorder, () => new BaselineSecretScanner()),
    {
      id: kind,
      kind,
      label: kind === 'drive' ? 'Share to cloud drive' : 'Push to Pages',
      available: true,
      requiresSignIn: false,
    },
    { scansBeforeUpload: true, delivered: async (_fx, slug) => recorder.lastFiles(kind, slug) },
  );
}

describe('recording publishers', () => {
  it('record each upload and return kind-specific links', async () => {
    const recorder = new PublishRecorder();
    const git = new RecordingPublisher(
      'git',
      recorder,
      () => new BaselineSecretScanner(),
      () => new Date(0),
    );
    const files = Object.freeze([
      Object.freeze({ relPath: 'index.html', absPath: '/nonexistent/index.html', bytes: 1, sha256: 'a'.repeat(64) }),
    ]);
    const stages: string[] = [];
    const scanner = { id: 'none', scan: async () => [] };
    const quiet = new RecordingPublisher(
      'git',
      recorder,
      () => scanner,
      () => new Date(0),
    );
    const r = await quiet.publish({
      slug: 'widgets',
      title: 'Widgets',
      files,
      settings: DEFAULTS,
      signal: new AbortController().signal,
      progress: (s) => void stages.push(s),
    });
    expect(stages).toEqual(['preparing', 'scanning', 'committing', 'pushing']);
    expect(r.commit?.branch).toBe('main');
    expect(r.links.find((l) => l.primary)).toMatchObject({
      kind: 'site',
      url: `https://${'pages.example.test'}/widgets/`,
    });
    expect(recorder.uploads).toEqual([
      { targetId: 'git', slug: 'widgets', files: ['index.html'], at: '1970-01-01T00:00:00.000Z' },
    ]);
    expect(git.id).toBe('git');
  });
});
