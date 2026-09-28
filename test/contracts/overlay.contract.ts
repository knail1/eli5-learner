/**
 * EditionOverlay contract suite (13 §10.2). The overlay registers into a registry that already
 * holds the public capabilities (01 §6.3 steps 2-3); afterwards no stub remains for anything it
 * claims, every UI feature it enables has a working capability behind it (HOOK-UI-01), and the
 * registry freezes.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Settings } from '../../src/main/config';
import { OVERLAY_API_VERSION, Registry, type EditionOverlay, type UiFeature } from '../../src/main/editions';
import { registerPublicCapabilities } from '../../src/main/editions/public';

export interface OverlayClaims {
  llm: Set<string>;
  publishers: Set<string>;
  resolvers: Set<string>;
  extractors: Set<string>;
  auth: boolean;
  mcp: boolean;
  uiFeatures: Set<UiFeature>;
}

const isStub = (x: unknown): boolean => typeof x === 'object' && x !== null && (x as { stub?: unknown }).stub === true;

/** Wraps a Registry so every register* call the overlay makes is recorded as a claim. */
export function recordClaims(reg: Registry): { registry: Registry; claims: OverlayClaims } {
  const claims: OverlayClaims = {
    llm: new Set(),
    publishers: new Set(),
    resolvers: new Set(),
    extractors: new Set(),
    auth: false,
    mcp: false,
    uiFeatures: new Set(),
  };
  const record: Record<string, (args: unknown[]) => void> = {
    registerLLMProvider: (a) => void claims.llm.add(String(a[0])),
    registerPublisher: (a) => void claims.publishers.add(String(a[0])),
    registerSourceResolver: (a) => void claims.resolvers.add((a[0] as { id: string }).id),
    registerExtractor: (a) => void claims.extractors.add((a[0] as { id: string }).id),
    registerAuth: () => void (claims.auth = true),
    registerMcpClient: () => void (claims.mcp = true),
    enableUiFeatures: (a) => (a[0] as UiFeature[]).forEach((f) => claims.uiFeatures.add(f)),
  };
  const registry = new Proxy(reg, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      const rec = typeof prop === 'string' ? record[prop] : undefined;
      return (...args: unknown[]) => {
        rec?.(args);
        return fn.apply(target, args);
      };
    },
  });
  return { registry, claims };
}

/** Public registry for the enterprise edition, as bootstrap builds it before step 3. */
export function enterpriseRegistry(settings: () => Settings = () => DEFAULTS): Registry {
  const reg = new Registry({ edition: 'enterprise', getSettings: settings });
  registerPublicCapabilities(reg);
  return reg;
}

/** loadOverlay (01 §6.5) minus the build-time import: version gate, name, register. */
export async function applyOverlay(overlay: EditionOverlay, reg: Registry): Promise<OverlayClaims> {
  if (overlay.apiVersion !== OVERLAY_API_VERSION) {
    throw new Error(`Overlay API ${overlay.apiVersion} != ${OVERLAY_API_VERSION}`);
  }
  const { registry, claims } = recordClaims(reg);
  reg.setOverlayName(overlay.name);
  await overlay.register(registry);
  return claims;
}

function withinMs<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`register() took longer than ${ms} ms`)), ms)),
  ]);
}

export function describeOverlayContract(overlay: EditionOverlay): void {
  describe(`EditionOverlay contract: ${overlay.name}`, () => {
    it('declares the current overlay API version and a display name', () => {
      expect(overlay.apiVersion).toBe(OVERLAY_API_VERSION);
      expect(overlay.name.trim().length).toBeGreaterThan(0);
    });

    it('register() completes within 5 s and marks the overlay loaded', async () => {
      const reg = enterpriseRegistry();
      await withinMs(applyOverlay(overlay, reg), 5000);
      const info = reg.info();
      expect(info).toMatchObject({ edition: 'enterprise', overlayLoaded: true, overlayName: overlay.name });
      expect(reg.missingSlots()).toEqual([]);
    });

    it('leaves no stub behind for any capability it claims', async () => {
      const reg = enterpriseRegistry();
      const claims = await applyOverlay(overlay, reg);
      const info = reg.info();
      for (const id of claims.llm) {
        expect(info.llmProviders.find((p) => p.id === id)?.available, `llm:${id}`).toBe(true);
      }
      for (const id of claims.publishers) {
        expect(info.publishers.find((p) => p.id === id)?.available, `publisher:${id}`).toBe(true);
        expect(isStub(reg.publisher(id)), `publisher:${id}`).toBe(false);
      }
      for (const id of claims.resolvers) {
        const r = reg.resolvers().find((x) => x.id === id);
        expect(r, `resolver:${id}`).toBeDefined();
        expect(isStub(r), `resolver:${id}`).toBe(false);
      }
      for (const id of claims.extractors) {
        expect(isStub(reg.extractors().find((x) => x.id === id)), `extractor:${id}`).toBe(false);
      }
      if (claims.auth) {
        expect(isStub(reg.auth())).toBe(false);
        expect(info.authAvailable).toBe(true);
      }
      if (claims.mcp) expect(reg.mcp()).toBeDefined();
    });

    it('every enabled UI feature has a working capability behind it (HOOK-UI-01)', async () => {
      const reg = enterpriseRegistry();
      const claims = await applyOverlay(overlay, reg);
      const info = reg.info();
      expect(new Set(info.uiFeatures)).toEqual(claims.uiFeatures);
      const available = (id: string) => info.publishers.find((p) => p.id === id)?.available === true;
      for (const f of claims.uiFeatures) {
        if (f === 'publish.drive') expect(available('drive'), f).toBe(true);
        if (f === 'publish.git') expect(available('git'), f).toBe(true);
        if (f === 'auth.signIn') expect(info.authAvailable, f).toBe(true);
      }
    });

    it('freeze() succeeds afterwards and blocks later registration', async () => {
      const reg = enterpriseRegistry();
      await applyOverlay(overlay, reg);
      expect(() => reg.freeze()).not.toThrow();
      expect(reg.frozen).toBe(true);
      expect(() => reg.enableUiFeatures([])).toThrow(/frozen/);
      expect(reg.info().overlayLoaded).toBe(true);
    });
  });
}
