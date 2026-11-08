/**
 * Explorable runtime (07 §7.1, §14; design §3.5): progressive enhancement of the static figure. The
 * animation is driven by a fake requestAnimationFrame so every frame is explicit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderDocument } from '../../../src/main/document';
import { fixtureDocument } from '../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../fixtures/documents/runtime';
import { loadGolden, loadRuntime, type Runtime, type TestWindow } from './dom';

let rt: Runtime;
beforeAll(async () => {
  rt = await loadRuntime();
});

interface Frames {
  queue: Map<number, FrameRequestCallback>;
  requested: number;
  /** Runs every queued frame at time `t`. */
  run(t: number): void;
}

/** Replaces rAF with a manual queue; `reduce` answers the reduced-motion media query. */
function prepare(win: TestWindow, reduce = false): Frames {
  const f: Frames = {
    queue: new Map(),
    requested: 0,
    run(t) {
      const cbs = [...f.queue.values()];
      f.queue.clear();
      for (const cb of cbs) cb(t);
    },
  };
  let id = 0;
  win.requestAnimationFrame = (cb) => {
    f.requested++;
    f.queue.set(++id, cb);
    return id;
  };
  win.cancelAnimationFrame = (n) => {
    f.queue.delete(n);
  };
  const mm = win.matchMedia.bind(win);
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    value: (q: string) => (q.includes('reduced-motion') ? { ...mm(q), matches: reduce } : mm(q)),
  });
  return f;
}

function figure(doc: Document, kind: string): HTMLElement {
  const fig = doc.querySelector<HTMLElement>(`figure.explorable[data-kind="${kind}"]`);
  if (!fig) throw new Error(`no ${kind} figure`);
  return fig;
}

const parts = (fig: HTMLElement) => {
  const q = <T extends Element>(s: string): T => {
    const e = fig.querySelector<T>(s);
    if (!e) throw new Error(s);
    return e;
  };
  const btn = (name: string): HTMLButtonElement => {
    const b = Array.from(fig.querySelectorAll('button')).find((x) => x.textContent === name);
    if (!b) throw new Error(name);
    return b;
  };
  return {
    input: q<HTMLInputElement>('input[type="range"]'),
    status: q<HTMLElement>('.explorable-status'),
    ball: q<SVGCircleElement>('.explorable-ball'),
    btn,
  };
};

/** Plays frames 1 s apart until the loop stops asking for frames (bounded). */
function playOut(f: Frames): number {
  let t = 0;
  for (let n = 0; n < 1000 && f.queue.size > 0; n++) f.run((t += 1000));
  return t;
}

describe('explorable runtime (07 §7.1)', () => {
  it('adds labelled controls after the static picture and a polite status', () => {
    const { win, doc } = loadGolden('showcase');
    prepare(win);
    rt.boot(win, doc);
    const fig = figure(doc, 'gradient-descent');
    const { input, status } = parts(fig);
    expect(fig.classList.contains('explorable--live')).toBe(true);
    expect(fig.querySelector('svg.explorable-svg + .explorable-controls')).not.toBeNull();
    expect(fig.querySelector('.explorable-controls')?.hasAttribute('data-eli5-noact')).toBe(true);
    expect(doc.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Learning rate');
    expect(input.getAttribute('aria-valuetext')).toBe('learning rate 0.1');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Learning rate 0.1. Press Play or Step.');
    // The static picture stays.
    expect(fig.querySelectorAll('.explorable-run')).toHaveLength(3);
    const mh = parts(figure(doc, 'metropolis-walk'));
    expect(mh.input.getAttribute('aria-valuetext')).toBe('step size 1');
  });

  it('the slider is log-mapped and updates aria-valuetext and the status', () => {
    const { win, doc } = loadGolden('showcase');
    prepare(win);
    rt.boot(win, doc);
    const { input, status } = parts(figure(doc, 'gradient-descent'));
    input.value = '0';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    expect(input.getAttribute('aria-valuetext')).toBe('learning rate 0.001');
    expect(status.textContent).toContain('0.001');
    input.value = '500';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    // Geometric mean of 0.001 and 2.
    expect(input.getAttribute('aria-valuetext')).toBe('learning rate 0.04472');
  });

  it('plays with requestAnimationFrame and stops on its own when a run diverges', () => {
    const { win, doc } = loadGolden('showcase');
    const f = prepare(win);
    rt.boot(win, doc);
    const p = parts(figure(doc, 'gradient-descent'));
    p.btn('1.5').click();
    expect(p.btn('1.5').getAttribute('aria-pressed')).toBe('true');
    p.btn('Play').click();
    expect(p.btn('Pause').getAttribute('aria-pressed')).toBe('true');
    expect(f.queue.size).toBe(1);
    f.run(0);
    f.run(150);
    expect(Number(p.ball.getAttribute('cx'))).toBeGreaterThan(0);
    playOut(f);
    expect(f.queue.size).toBe(0); // the loop ended
    expect(p.status.textContent).toBe('lr 1.5: diverges after 12 steps');
    expect(p.btn('Play').textContent).toBe('Play');
    expect((p.btn('Step') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Step and Reset move one step at a time without animation frames', () => {
    const { win, doc } = loadGolden('showcase');
    const f = prepare(win);
    rt.boot(win, doc);
    const p = parts(figure(doc, 'gradient-descent'));
    p.btn('Step').click();
    p.btn('Step').click();
    expect(p.status.textContent).toBe('Step 2 of 37, learning rate 0.1');
    p.btn('Reset').click();
    expect(p.status.textContent).toBe('Learning rate 0.1. Press Play or Step.');
    expect(f.requested).toBe(0);
  });

  it('pauses when the page is hidden and when the tab changes', () => {
    const { win, doc } = loadGolden('showcase');
    const f = prepare(win);
    const h = rt.boot(win, doc);
    const p = parts(figure(doc, 'metropolis-walk'));
    p.btn('Play').click();
    expect(f.queue.size).toBe(1);
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'hidden' });
    doc.dispatchEvent(new win.Event('visibilitychange'));
    expect(f.queue.size).toBe(0);
    expect(p.btn('Play').getAttribute('aria-pressed')).toBe('false');
    // The status no longer says it is playing.
    expect(p.status.textContent).not.toContain('Playing');
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' });
    p.btn('Play').click();
    expect(f.queue.size).toBe(1);
    h.tabs?.activateTab('eli5');
    expect(f.queue.size).toBe(0);
  });

  it('with reduced motion never runs an animation loop: Play shows the whole run at once', () => {
    const { win, doc } = loadGolden('showcase');
    const f = prepare(win, true);
    rt.boot(win, doc);
    const p = parts(figure(doc, 'gradient-descent'));
    expect(p.status.textContent).toBe('lr 0.1: converges in 37 steps');
    p.btn('1.5').click();
    expect(p.status.textContent).toBe('lr 1.5: diverges after 12 steps');
    p.btn('Play').click();
    p.btn('Step').click();
    expect(p.status.textContent).toBe('Step 1 of 12, learning rate 1.5');
    expect(f.requested).toBe(0);
  });

  it('leaves the static picture alone when data-params is broken', () => {
    const { win, doc } = loadGolden('showcase');
    prepare(win);
    const fig = figure(doc, 'gradient-descent');
    fig.setAttribute('data-params', '{"kind":"gradient-descent","surface":"bowl"');
    const other = figure(doc, 'metropolis-walk');
    other.setAttribute('data-params', JSON.stringify({ kind: 'shell', cmd: 'rm' }));
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      rt.boot(win, doc);
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual([]);
    expect(doc.querySelector('.explorable-controls')).toBeNull();
    expect(fig.querySelector('svg.explorable-svg')).not.toBeNull();
  });

  it('model text stays text: an injected <img onerror> title never becomes an element', () => {
    const show = fixtureDocument('showcase');
    const model = structuredClone(show.model);
    const block = model.tabs[0]?.sections.flatMap((s) => s.blocks).find((b) => b.type === 'explorable');
    if (block?.type !== 'explorable') throw new Error('fixture');
    block.title = '<img src=x onerror="window.__pwned=1">';
    block.caption = '<img src=y onerror="window.__pwned=2">';
    const html = renderDocument(model, show.assets, { runtime: STUB_RUNTIME, theme: show.theme });
    const dom = new JSDOM(html, { url: 'https://example.test/doc/index.html', pretendToBeVisual: true });
    const win = dom.window as unknown as TestWindow;
    Object.defineProperty(win, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    prepare(win);
    rt.boot(win, win.document);
    const fig = figure(win.document, 'gradient-descent');
    expect(fig.querySelector('img')).toBeNull();
    expect(fig.querySelector('h3')?.textContent).toBe(block.title);
    expect(fig.querySelector('svg title')?.textContent).toBe(block.title);
    expect(fig.querySelector('.explorable-controls')).not.toBeNull();
    expect((win as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('explorable runtime source (design §3.5 forbidden list)', () => {
  it('uses no timers, workers, storage, network, postMessage, eli5Doc or innerHTML', () => {
    const src = readFileSync(join(process.cwd(), 'src/doc-runtime/explorable.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(
      /setTimeout|setInterval|Worker|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|postMessage|eli5Doc|innerHTML|outerHTML|insertAdjacentHTML/,
    );
  });
});
