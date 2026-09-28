import { describe, expect, it } from 'vitest';
import { buildLaneRouter, compileHostGlob } from '../../../../src/main/sources/lanes';
import type { LaneRule } from '../../../../src/main/sources/types';

const u = (s: string) => new URL(s);

describe('buildLaneRouter: no rules (public)', () => {
  const r = buildLaneRouter([]);

  it('routes every http(s) URL to the web lane', () => {
    for (const s of ['https://example.com/a', 'http://tickets.example.internal/browse/ABC-1']) {
      expect(r.route(u(s))).toEqual({ lane: 'web', noWebFallback: false });
    }
  });

  it('routeBare returns null', () => {
    expect(r.routeBare('ABC-123')).toBeNull();
  });

  it('returns a fresh object each call', () => {
    const a = r.route(u('https://a.test/'));
    a.lane = 'mcp';
    expect(r.route(u('https://a.test/')).lane).toBe('web');
  });
});

describe('buildLaneRouter: synthetic rules', () => {
  const rules: LaneRule[] = [
    {
      id: 'tickets',
      match: { hostGlob: 'tickets.example.internal', pathPrefix: '/browse/' },
      route: { lane: 'mcp', resolverId: 'ticket', noWebFallback: true },
    },
    { id: 'org', match: { hostGlob: '*.example.internal' }, route: { lane: 'mcp', noWebFallback: true } },
    {
      id: 'docs-pattern',
      match: { pattern: '^https://docs\\.corp\\.test/.+\\?id=\\d+$' },
      route: { lane: 'mcp', noWebFallback: false },
    },
  ];
  const r = buildLaneRouter(rules);

  it('first match wins and carries ruleId', () => {
    expect(r.route(u('https://tickets.example.internal/browse/ABC-1'))).toEqual({
      lane: 'mcp',
      resolverId: 'ticket',
      noWebFallback: true,
      ruleId: 'tickets',
    });
  });

  it('requires all present match fields (host + pathPrefix)', () => {
    expect(r.route(u('https://tickets.example.internal/other')).ruleId).toBe('org');
  });

  it('host glob matches subdomains (any depth) but not the apex, case-insensitively', () => {
    expect(r.route(u('https://WIKI.Example.Internal/x')).ruleId).toBe('org');
    expect(r.route(u('https://a.b.example.internal/')).ruleId).toBe('org');
    expect(r.route(u('https://example.internal/'))).toEqual({ lane: 'web', noWebFallback: false });
    expect(r.route(u('https://evil-example.internal/')).ruleId).toBeUndefined();
    expect(r.route(u('https://example.internal.evil.test/')).ruleId).toBeUndefined();
  });

  it('pattern tests the full URL', () => {
    expect(r.route(u('https://docs.corp.test/page?id=42')).ruleId).toBe('docs-pattern');
    expect(r.route(u('https://docs.corp.test/page?id=x')).lane).toBe('web');
  });

  it('no match falls back to the web lane', () => {
    expect(r.route(u('https://example.com/'))).toEqual({ lane: 'web', noWebFallback: false });
  });

  it('rejects empty matches and invalid patterns at build time', () => {
    expect(() => buildLaneRouter([{ id: 'x', match: {}, route: { lane: 'mcp', noWebFallback: true } }])).toThrow(
      /empty match/,
    );
    expect(() =>
      buildLaneRouter([{ id: 'y', match: { pattern: '(' }, route: { lane: 'mcp', noWebFallback: true } }]),
    ).toThrow(/invalid pattern/);
  });
});

describe('compileHostGlob', () => {
  it('escapes regex metacharacters and anchors', () => {
    const re = compileHostGlob('a.b');
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false);
    expect(re.test('xa.b')).toBe(false);
  });
});
