import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Settings } from '../../../../src/main/config';
import {
  NotAvailableInEdition,
  OVERLAY_API_VERSION,
  Registry,
  type EditionOverlay,
} from '../../../../src/main/editions';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import type { SourceResolver } from '../../../../src/main/sources';

const publicRegistry = (settings: Settings = DEFAULTS): Registry => {
  const reg = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(reg);
  return reg;
};

const resolver = (id: string): SourceResolver =>
  ({
    id,
    handles: ['url'],
    lane: 'web',
    canResolve: () => false,
    resolve: async () => ({ resolved: [], skipped: [] }),
  }) as unknown as SourceResolver;

describe('registerPublicCapabilities (01 §6.3)', () => {
  it('fills every policy slot so lookups never return null', () => {
    const reg = publicRegistry();
    expect(reg.missingSlots()).toEqual([]);
    expect(reg.auth().status().state).toBe('unavailable');
    expect(reg.laneRouter().routeBare('ABC-123')).toBeNull();
    expect(reg.mcp()).toBeUndefined();
    expect(reg.loginSignatures()).toEqual([]);
  });

  it('reports the public edition info', () => {
    const info = publicRegistry().info();
    expect(info).toMatchObject({ edition: 'public', overlayLoaded: false, uiFeatures: [], authAvailable: false });
    expect(info.llmProviders.find((p) => p.id === 'bedrock')?.available).toBe(false);
    expect(Object.fromEntries(info.publishers.map((p) => [p.id, p.available]))).toEqual({
      local: true,
      drive: false,
      git: false,
    });
  });

  it('orders default resolvers ticket, mcp by priority', () => {
    expect(
      publicRegistry()
        .resolvers()
        .map((r) => r.id),
    ).toEqual(['ticket', 'mcp']);
  });

  it('stubs raise NotAvailableInEdition with their hook ids', async () => {
    const reg = publicRegistry({ ...DEFAULTS, llm: { ...DEFAULTS.llm, provider: 'bedrock' } });
    await expect(reg.llm().generate({} as never)).rejects.toMatchObject({ hookId: 'HOOK-LLM-01' });
    const drive = reg.publisher('drive');
    await expect(drive.publish({} as never)).rejects.toBeInstanceOf(NotAvailableInEdition);
    await expect(reg.publisher('git').publish({} as never)).rejects.toMatchObject({ hookId: 'HOOK-PUB-03' });
    expect(() => reg.auth().signIn()).toThrow(NotAvailableInEdition);
  });
});

describe('Registry rules (01 §6.2)', () => {
  it('replaces on register and keeps the replaced id priority', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    reg.registerSourceResolver(resolver('file'));
    reg.registerSourceResolver(resolver('url'));
    reg.registerSourceResolver(resolver('mcp'));
    reg.registerSourceResolver(resolver('ticket'));
    reg.registerSourceResolver(resolver('clipboard'));
    reg.registerSourceResolver(resolver('overlay-docs'));
    expect(reg.resolvers().map((r) => r.id)).toEqual(['ticket', 'mcp', 'overlay-docs', 'url', 'file', 'clipboard']);
    const replacement = resolver('mcp');
    reg.registerSourceResolver(replacement);
    expect(reg.resolvers()[1]).toBe(replacement);
  });

  it('freeze() blocks later registration', () => {
    const reg = publicRegistry();
    reg.freeze();
    expect(reg.frozen).toBe(true);
    expect(() => reg.enableUiFeatures(['publish.drive'])).toThrow(/frozen/);
    expect(() => reg.registerLLMProvider('claude', () => reg.llm())).toThrow(/frozen/);
  });

  it('allows only one settings extension', () => {
    const reg = publicRegistry();
    reg.registerSettingsExtension({ id: 'a' });
    expect(() => reg.registerSettingsExtension({ id: 'b' })).toThrow();
  });

  it('an unknown llm provider id is NotAvailableInEdition', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    expect(() => reg.llm()).toThrow(NotAvailableInEdition);
  });
});

describe('overlay registration (01 §6.5, fixture overlay contract)', () => {
  it('an overlay can replace stubs and enable UI features before freeze', async () => {
    const reg = publicRegistry();
    const overlay: EditionOverlay = {
      apiVersion: OVERLAY_API_VERSION,
      name: 'Fixture',
      register(r) {
        const local = r.publisher('local');
        r.registerPublisher('drive', () => ({ ...local, id: 'drive', kind: 'drive' }) as typeof local);
        r.enableUiFeatures(['publish.drive']);
      },
    };
    reg.setOverlayName(overlay.name);
    await overlay.register(reg);
    reg.freeze();
    const info = reg.info();
    expect(info).toMatchObject({ overlayLoaded: true, overlayName: 'Fixture', uiFeatures: ['publish.drive'] });
    expect(info.publishers.find((p) => p.id === 'drive')?.available).toBe(true);
  });
});
