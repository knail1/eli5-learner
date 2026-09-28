/**
 * Edition matrix cell P-stub (13 §10.1): in the public build every registered stub throws
 * NotAvailableInEdition with its hook id and makes no network call (net-guard is active),
 * EditionInfo shows the stubs unavailable, and no UI feature is enabled.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Settings } from '../../../../src/main/config';
import { NotAvailableInEdition, Registry } from '../../../../src/main/editions';
import { loadOverlay } from '../../../../src/main/editions/load-overlay';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import type { ResolveContext } from '../../../../src/main/sources';

const bedrock: Settings = { ...DEFAULTS, llm: { ...DEFAULTS.llm, provider: 'bedrock' } };

function publicRegistry(): Registry {
  const reg = new Registry({ edition: 'public', getSettings: () => bedrock });
  registerPublicCapabilities(reg);
  return reg;
}

const isStub = (x: unknown) => typeof x === 'object' && x !== null && (x as { stub?: unknown }).stub === true;

/** Runs a stub call whether it throws synchronously or rejects. */
const failure = (fn: () => unknown): Promise<unknown> =>
  Promise.resolve()
    .then(fn)
    .then(
      () => undefined,
      (e: unknown) => e,
    );

async function expectNotAvailable(fn: () => unknown, capability: string, hookId: string): Promise<void> {
  const e = await failure(fn);
  expect(e, `${capability} must throw`).toBeInstanceOf(NotAvailableInEdition);
  expect(e).toMatchObject({ capability, hookId, code: 'E_NOT_AVAILABLE_IN_EDITION' });
}

const ctx = { edition: 'public', signal: new AbortController().signal } as unknown as ResolveContext;
const urlInput = { id: 'in-1', kind: 'url', origin: 'url-field', url: 'https://example.com/' } as const;

describe('cell P-stub (13 §10.1)', () => {
  it('the public registry holds exactly the documented stubs', () => {
    const reg = publicRegistry();
    const info = reg.info();
    expect(info.llmProviders.filter((p) => !p.available).map((p) => p.id)).toEqual(['bedrock']);
    expect(info.publishers.filter((p) => !p.available).map((p) => p.id)).toEqual(['drive', 'git']);
    expect(
      reg
        .resolvers()
        .filter(isStub)
        .map((r) => r.id),
    ).toEqual(['ticket', 'mcp']);
    expect(reg.extractors().filter(isStub)).toEqual([]);
    expect(isStub(reg.auth())).toBe(true);
  });

  it('bedrock throws HOOK-LLM-01 from every call; testConnection reports instead of throwing', async () => {
    const p = publicRegistry().llm();
    const req = { taskId: 'summary', system: '', messages: [], maxOutputTokens: 1 } as const;
    await expectNotAvailable(() => p.generate({ ...req, messages: [] }), 'llm:bedrock', 'HOOK-LLM-01');
    await expectNotAvailable(() => p.generateWithImages({ ...req, messages: [] }), 'llm:bedrock', 'HOOK-LLM-01');
    await expectNotAvailable(() => p.countTokens?.({ system: '', messages: [] }), 'llm:bedrock', 'HOOK-LLM-01');
    const stream = p.stream?.({ ...req, messages: [] });
    expect(stream).toBeDefined();
    await expectNotAvailable(() => stream?.[Symbol.asyncIterator]().next(), 'llm:bedrock', 'HOOK-LLM-01');
    const check = await p.testConnection();
    expect(check.ok).toBe(false);
  });

  it('the MCP and ticket resolvers never claim input and throw HOOK-SRC-01/02', async () => {
    const reg = publicRegistry();
    const byId = (id: string) => reg.resolvers().find((r) => r.id === id)!;
    for (const id of ['mcp', 'ticket']) expect(byId(id).canResolve(urlInput, ctx)).toBe(false);
    await expectNotAvailable(() => byId('mcp').resolve(urlInput, ctx), 'source:mcp', 'HOOK-SRC-01');
    await expectNotAvailable(() => byId('ticket').resolve(urlInput, ctx), 'source:ticket', 'HOOK-SRC-02');
  });

  it('the drive and git publishers describe themselves unavailable and throw HOOK-PUB-01/03', async () => {
    const reg = publicRegistry();
    for (const [id, hook] of [
      ['drive', 'HOOK-PUB-01'],
      ['git', 'HOOK-PUB-03'],
    ] as const) {
      const p = reg.publisher(id);
      const t = await p.describe('widgets', DEFAULTS);
      expect(t).toMatchObject({ id, available: false });
      expect(t.unavailableReason).not.toMatch(/HOOK-/);
      await expectNotAvailable(() => p.publish({} as never), `publisher:${id}`, hook);
    }
  });

  it('the auth broker reports unavailable and throws HOOK-AUTH-01 on sign-in and sign-out', async () => {
    const auth = publicRegistry().auth();
    expect(auth.status().state).toBe('unavailable');
    await expectNotAvailable(() => auth.signIn(), 'auth', 'HOOK-AUTH-01');
    await expectNotAvailable(() => auth.signOut(), 'auth', 'HOOK-AUTH-01');
  });

  it('EditionInfo: public, no overlay, stubs unavailable, no UI features, even after loadOverlay', async () => {
    const reg = publicRegistry();
    await loadOverlay(reg);
    reg.freeze();
    const info = reg.info();
    expect(info).toMatchObject({ edition: 'public', overlayLoaded: false, uiFeatures: [], authAvailable: false });
    expect(info.overlayName).toBeUndefined();
    expect(Object.fromEntries(info.publishers.map((p) => [p.id, p.available]))).toEqual({
      local: true,
      drive: false,
      git: false,
    });
    expect(info.llmProviders.find((p) => p.id === 'bedrock')?.available).toBe(false);
    expect(reg.mcp()).toBeUndefined();
  });
});
