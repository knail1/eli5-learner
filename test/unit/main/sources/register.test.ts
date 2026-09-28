import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import { registerPublic } from '../../../../src/main/sources/register';
import { defaultStagingPolicy } from '../../../../src/main/sources/staging';
import type { SourceResolver } from '../../../../src/main/sources/types';

function fakeResolver(id: string): SourceResolver {
  return {
    id,
    handles: ['url'],
    lane: 'web',
    canResolve: () => true,
    resolve: () => Promise.resolve({ resolved: [], skipped: [] }),
  };
}

describe('registerPublic', () => {
  const make = () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    return reg;
  };

  it('registers the unavailable auth broker', () => {
    const reg = make();
    expect(reg.auth().status().state).toBe('unavailable');
    expect(reg.info().authAvailable).toBe(false);
  });

  it('registers resolvers in 01 §6.2 priority order: ticket 40, mcp 30, url 20, file 10, clipboard 10', () => {
    expect(
      make()
        .resolvers()
        .map((r) => r.id),
    ).toEqual(['ticket', 'mcp', 'url', 'file', 'clipboard']);
  });

  it('marks only the mcp and ticket resolvers as stubs', () => {
    const stubs = make()
      .resolvers()
      .filter((r) => (r as { stub?: boolean }).stub === true)
      .map((r) => r.id);
    expect(stubs).toEqual(['ticket', 'mcp']);
  });

  it('orders with later M1 resolvers by default priority', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    reg.registerSourceResolver(fakeResolver('file'));
    reg.registerSourceResolver(fakeResolver('url'));
    registerPublic(reg);
    reg.registerSourceResolver(fakeResolver('clipboard'));
    reg.registerSourceResolver(fakeResolver('overlay-x'));
    expect(reg.resolvers().map((r) => r.id)).toEqual(['ticket', 'mcp', 'overlay-x', 'url', 'file', 'clipboard']);
  });

  it('installs the lane router factory with empty rules', () => {
    const reg = make();
    expect(reg.laneRules()).toEqual([]);
    const router = reg.laneRouter();
    expect(router.route(new URL('https://anything.example.internal/x'))).toEqual({ lane: 'web', noWebFallback: false });
    expect(router.routeBare('ABC-1')).toBeNull();
  });

  it('router factory picks up overlay rules registered later', () => {
    const reg = make();
    reg.registerLaneRules([
      { id: 'org', match: { hostGlob: '*.corp.test' }, route: { lane: 'mcp', noWebFallback: true } },
    ]);
    expect(reg.laneRouter().route(new URL('https://wiki.corp.test/')).lane).toBe('mcp');
  });

  it('registers the default staging policy', () => {
    const reg = make();
    expect(reg.stagingPolicy()).toBe(defaultStagingPolicy);
    expect(reg.missingSlots()).not.toContain('auth');
    expect(reg.missingSlots()).not.toContain('stagingPolicy');
    expect(reg.missingSlots()).not.toContain('laneRouter');
  });
});

describe('defaultStagingPolicy', () => {
  it('stages under <userData>/jobs/<jobId> with 06 §9.5 retention', () => {
    expect(defaultStagingPolicy.stagingDir('/u', 'j1')).toBe('/u/jobs/j1');
    const src = { lane: 'web' as const, resolverId: 'url', location: 'https://x.test/' };
    expect(defaultStagingPolicy.mayStageToDisk(src)).toBe(true);
    expect(defaultStagingPolicy.retention(src)).toBe('default');
    expect(defaultStagingPolicy.persistedLocation(src)).toBe('https://x.test/');
    expect(defaultStagingPolicy.documentLabel([src])).toBeNull();
    expect(defaultStagingPolicy.secureDelete).toBe(false);
  });
});
