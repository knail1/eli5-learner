/**
 * Cell F (13 §10.1): the shipped loadOverlay (01 §6.5 step 5) in an enterprise build, with the
 * fixture overlay bundled as `@eli5/overlay`. Vitest leaves `__ELI5_EDITION__` as a global, so
 * stubbing it selects the enterprise branch. Covers overlay loading, registry replacement,
 * EditionInfo.overlayLoaded and the UI features toggle; the error paths prevent startup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, type Settings } from '../../../../src/main/config';
import { OVERLAY_API_VERSION, Registry, type EditionOverlay } from '../../../../src/main/editions';
import { loadOverlay } from '../../../../src/main/editions/load-overlay';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import { FakeProvider } from '../../../../src/main/llm/testing';
import fixture, { FIXTURE_OVERLAY_NAME, FixtureAuthBroker, FixtureMcpClient } from '../../../fixtures/overlay-fake';

const bundled = vi.hoisted(() => ({ overlay: null as unknown }));

vi.mock('@eli5/overlay', () => ({
  get default() {
    return bundled.overlay;
  },
}));
vi.mock('@eli5/public/config', () => import('../../../../src/main/config'));
vi.mock('@eli5/public/editions', () => import('../../../../src/main/editions'));
vi.mock('@eli5/public/llm', () => import('../../../../src/main/llm'));
vi.mock('@eli5/public/llm/testing', () => import('../../../../src/main/llm/testing'));
vi.mock('@eli5/public/publish', () => import('../../../../src/main/publish'));
vi.mock('@eli5/public/sources', () => import('../../../../src/main/sources'));

const bedrock: Settings = { ...DEFAULTS, llm: { ...DEFAULTS.llm, provider: 'bedrock' } };

/** Bootstrap order (01 §6.3): public capabilities, then the overlay, then freeze. */
function enterpriseRegistry(): Registry {
  const reg = new Registry({ edition: 'enterprise', getSettings: () => bedrock });
  registerPublicCapabilities(reg);
  return reg;
}

const isStub = (x: unknown) => typeof x === 'object' && x !== null && (x as { stub?: unknown }).stub === true;

describe('loadOverlay, enterprise edition (01 §6.5)', () => {
  beforeEach(() => {
    vi.stubGlobal('__ELI5_EDITION__', 'enterprise');
    bundled.overlay = fixture;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    bundled.overlay = null;
  });

  it('registers the fixture overlay: stubs replaced, overlayLoaded, name and UI features on', async () => {
    const reg = enterpriseRegistry();
    const before = reg.info();
    expect(before).toMatchObject({ overlayLoaded: false, uiFeatures: [], authAvailable: false });
    expect(isStub(reg.auth())).toBe(true);

    await loadOverlay(reg);
    reg.freeze();

    const info = reg.info();
    expect(info).toMatchObject({
      edition: 'enterprise',
      overlayLoaded: true,
      overlayName: FIXTURE_OVERLAY_NAME,
      uiFeatures: ['publish.drive', 'publish.git', 'auth.signIn'],
      authAvailable: true,
    });
    expect(info.llmProviders.find((p) => p.id === 'bedrock')?.available).toBe(true);
    expect(Object.fromEntries(info.publishers.map((p) => [p.id, p.available]))).toMatchObject({
      drive: true,
      git: true,
    });
    expect(reg.llm()).toBeInstanceOf(FakeProvider);
    expect(reg.auth()).toBeInstanceOf(FixtureAuthBroker);
    expect(reg.mcp()).toBeInstanceOf(FixtureMcpClient);
    expect(isStub(reg.resolvers().find((r) => r.id === 'mcp'))).toBe(false);
    expect(isStub(reg.publisher('drive')) || isStub(reg.publisher('git'))).toBe(false);
  });

  it('throws when the enterprise build bundled no overlay', async () => {
    bundled.overlay = null;
    const reg = enterpriseRegistry();
    await expect(loadOverlay(reg)).rejects.toThrow('Enterprise build without overlay');
    expect(reg.info().overlayLoaded).toBe(false);
  });

  it('throws on an overlay API version mismatch before registering anything', async () => {
    const register = vi.fn();
    const stale: EditionOverlay = { apiVersion: OVERLAY_API_VERSION + 1, name: 'Stale', register };
    bundled.overlay = stale;
    const reg = enterpriseRegistry();
    await expect(loadOverlay(reg)).rejects.toThrow(`Overlay API ${OVERLAY_API_VERSION + 1} != ${OVERLAY_API_VERSION}`);
    expect(register).not.toHaveBeenCalled();
    expect(reg.info()).toMatchObject({ overlayLoaded: false, uiFeatures: [] });
    expect(reg.info().overlayName).toBeUndefined();
  });

  it('names the overlay before register() runs', async () => {
    const seen: (string | undefined)[] = [];
    const probe: EditionOverlay = {
      apiVersion: OVERLAY_API_VERSION,
      name: 'Probe overlay',
      register: (r) => void seen.push((r as Registry).info().overlayName),
    };
    bundled.overlay = probe;
    await loadOverlay(enterpriseRegistry());
    expect(seen).toEqual(['Probe overlay']);
  });

  it('is a no-op in the public edition even with an overlay bundled', async () => {
    vi.stubGlobal('__ELI5_EDITION__', 'public');
    const reg = enterpriseRegistry();
    await loadOverlay(reg);
    expect(reg.info()).toMatchObject({ overlayLoaded: false, uiFeatures: [] });
  });
});
