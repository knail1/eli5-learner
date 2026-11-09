/**
 * The parent side of animation frames (07 §7.1, §14): only `{type:'eli5-anim-height', h}` from one
 * of the document's own frames is accepted (clamped), and each frame is sent the theme on boot, on
 * load and on every theme change. The frame side runs in real browsers (test/crossbrowser).
 */
import { describe, expect, it, vi } from 'vitest';
import { loadGolden, loadRuntime } from './dom';

const SRC = '../../../src/doc-runtime/';

interface AnimationModule {
  frameHeight(data: unknown): number | undefined;
  MIN_FRAME_HEIGHT: number;
  MAX_FRAME_HEIGHT: number;
}

const load = async (): Promise<AnimationModule> =>
  (await import(/* @vite-ignore */ `${SRC}animation`)) as AnimationModule;

describe('frameHeight (the one message shape a frame may send)', () => {
  it('accepts exactly {type, h} with a finite number and clamps it', async () => {
    const m = await load();
    expect(m.frameHeight({ type: 'eli5-anim-height', h: 300.4 })).toBe(300);
    expect(m.frameHeight({ type: 'eli5-anim-height', h: 1 })).toBe(m.MIN_FRAME_HEIGHT);
    expect(m.frameHeight({ type: 'eli5-anim-height', h: 1e9 })).toBe(m.MAX_FRAME_HEIGHT);
    for (const bad of [
      null,
      'eli5-anim-height',
      [1],
      { type: 'eli5-anim-height', h: '300' },
      { type: 'eli5-anim-height', h: Number.NaN },
      { type: 'eli5-anim-height', h: Infinity },
      { type: 'eli5-anim-height', h: 300, href: 'https://x.example' },
      { type: 'eli5-open', h: 300 },
    ])
      expect(m.frameHeight(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('initAnimations (booted on the showcase golden)', () => {
  async function booted() {
    const rt = await loadRuntime();
    const l = loadGolden('showcase');
    const frame = l.doc.querySelector<HTMLIFrameElement>('figure.animation iframe');
    if (!frame?.contentWindow) throw new Error('showcase has no animation frame');
    const sent = vi.spyOn(frame.contentWindow, 'postMessage');
    rt.boot(l.win, l.doc);
    return { ...l, frame, sent, fig: frame.closest('figure') as HTMLElement };
  }

  const message = (win: Window, data: unknown, source: unknown): void => {
    const e = new (win as Window & typeof globalThis).MessageEvent('message', { data });
    Object.defineProperty(e, 'source', { value: source });
    win.dispatchEvent(e);
  };

  it('sends the theme on boot and on every change, and nothing else', async () => {
    const { doc, sent } = await booted();
    expect(sent).toHaveBeenCalledWith({ type: 'eli5-anim-theme', theme: 'light' }, '*');
    sent.mockClear();
    doc.documentElement.setAttribute('data-theme', 'dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.mock.calls).toEqual([[{ type: 'eli5-anim-theme', theme: 'dark' }, '*']]);
  });

  it('follows a system light/dark switch when the document has no explicit theme (audit round 4)', async () => {
    const { doc, sent, setWide } = await booted();
    expect(doc.documentElement.getAttribute('data-theme')).toBe('auto');
    sent.mockClear();
    // The fake matchMedia flips every query at once, (prefers-color-scheme: dark) included.
    setWide(true);
    expect(sent.mock.calls).toContainEqual([{ type: 'eli5-anim-theme', theme: 'dark' }, '*']);
    sent.mockClear();
    setWide(false);
    expect(sent.mock.calls).toContainEqual([{ type: 'eli5-anim-theme', theme: 'light' }, '*']);
  });

  it('a height from the frame reveals it; anything else, or from anyone else, is ignored', async () => {
    const { win, frame, fig } = await booted();
    const stage = frame.parentElement as HTMLElement;
    message(win, { type: 'eli5-anim-height', h: 320 }, win); // not a frame
    message(win, { type: 'eli5-anim-height', h: 320, x: 1 }, frame.contentWindow); // wrong shape
    expect(fig.classList.contains('anim-live')).toBe(false);
    expect(stage.style.height).toBe('');
    message(win, { type: 'eli5-anim-height', h: 320 }, frame.contentWindow);
    expect(fig.classList.contains('anim-live')).toBe(true);
    expect(stage.style.height).toBe('320px');
    message(win, { type: 'eli5-anim-height', h: 99999 }, frame.contentWindow);
    expect(stage.style.height).toBe('800px');
  });
});
