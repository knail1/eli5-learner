import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { registerPublicCapabilities } = await import('../../../../src/main/editions/public');
const { setup } = await import('./harness');

/** `eli5:sources:classify-text` (11 §5.4, §10) and `eli5:library:reveal-root` (11 §7). */

describe('eli5:sources:classify-text (11 §5.4)', () => {
  it('public build: http(s) URLs are url, everything else is invalid (HOOK-SRC-02, HOOK-SRC-03)', async () => {
    const h = await setup();
    registerPublicCapabilities(h.registry);
    expect(await h.call(IPC.sources.classifyText, { text: ' https://example.com/a ' })).toEqual({
      ok: true,
      value: { kind: 'url', label: 'https://example.com/a' },
    });
    for (const text of ['ABC-123', 'ftp://example.com', 'example.com', 'javascript:alert(1)']) {
      expect(await h.call(IPC.sources.classifyText, { text })).toEqual({
        ok: true,
        value: { kind: 'invalid', label: text },
      });
    }
  });

  it('a lane router that accepts a bare identifier makes it a bare chip', async () => {
    const h = await setup();
    registerPublicCapabilities(h.registry);
    const route = { lane: 'mcp', noWebFallback: true } as never;
    vi.spyOn(h.registry, 'laneRouter').mockReturnValue({
      route: () => route,
      routeBare: (t: string) => (t === 'ABC-123' ? { url: new URL('https://tickets.example/ABC-123'), route } : null),
    });
    expect(await h.call(IPC.sources.classifyText, { text: 'ABC-123' })).toEqual({
      ok: true,
      value: { kind: 'bare', label: 'ABC-123' },
    });
  });

  it('rejects empty and oversized text, and the viewer', async () => {
    const h = await setup();
    registerPublicCapabilities(h.registry);
    for (const bad of [undefined, { text: '' }, { text: '   ' }, { text: 'x'.repeat(2049) }]) {
      expect(await h.call(IPC.sources.classifyText, bad)).toMatchObject({
        ok: false,
        error: { code: 'E_BAD_REQUEST' },
      });
    }
    expect(await h.call(IPC.sources.classifyText, { text: 'https://e.com' }, 'viewer')).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
  });
});

describe('eli5:library:reveal-root (11 §7 Library)', () => {
  it('reveals the Library root in Finder; no payload; app only', async () => {
    const h = await setup();
    expect(await h.call(IPC.library.revealRoot)).toEqual({ ok: true, value: undefined });
    expect(h.rootRevealed.count).toBe(1);
    expect(await h.call(IPC.library.revealRoot, { path: '/etc' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
    expect(await h.call(IPC.library.revealRoot, undefined, 'viewer')).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
    expect(h.rootRevealed.count).toBe(1);
  });
});
