/**
 * Scroll-to (08 §7.4 steps 5-6) with an anchor (08 Ask): landing on an answer box centres, flashes
 * and focuses it and opens its question; a missing anchor falls back to the section.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, loadGolden, loadRuntime, type Runtime } from './dom';

let rt: Runtime;
beforeAll(async () => {
  rt = await loadRuntime();
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const bridge = fakeBridge();
  const { win, doc } = loadGolden('asked', { bridge });
  const scrolls: { el: Element; opts: unknown }[] = [];
  Object.defineProperty(win.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: Element, opts: unknown) {
      scrolls.push({ el: this, opts });
    },
  });
  const h = rt.boot(win, doc);
  const send = bridge.scrollCb;
  if (!send) throw new Error('runtime did not subscribe to scroll-to');
  return { win, doc, h, send, scrolls };
}

describe('scroll-to an answer box (08 Ask)', () => {
  it('centres, flashes and focuses the box and opens its question', () => {
    const { doc, h, send, scrolls } = setup();
    const box = doc.querySelector<HTMLElement>('#tab-eli5 aside.qa');
    const section = box?.closest('section');
    if (!box || !section) throw new Error('fixture');
    expect(box.querySelector<HTMLDetailsElement>('details.qa-q')?.open).toBe(false);
    send({ sectionId: section.id, tabKey: 'eli5', anchorId: box.id, flash: true, loadSeq: 1 });
    expect(h.tabs?.active()).toBe('eli5');
    vi.advanceTimersByTime(50);
    expect(scrolls.at(-1)).toEqual({ el: box, opts: { block: 'center' } });
    expect(box.classList.contains('eli5-flash')).toBe(true);
    expect(section.classList.contains('eli5-flash')).toBe(false);
    expect(box.querySelector<HTMLDetailsElement>('details.qa-q')?.open).toBe(true);
    expect(doc.activeElement).toBe(box);
    expect(box.tabIndex).toBe(-1);
    vi.advanceTimersByTime(1600);
    expect(box.classList.contains('eli5-flash')).toBe(false);
  });

  it('finds the tab from the anchor alone', () => {
    const { doc, h, send } = setup();
    const box = doc.querySelector<HTMLElement>('#tab-eli5 aside.qa');
    if (!box) throw new Error('fixture');
    send({ anchorId: box.id, flash: false, loadSeq: 1 });
    expect(h.tabs?.active()).toBe('eli5');
    vi.advanceTimersByTime(50);
    expect(box.classList.contains('eli5-flash')).toBe(false);
    expect(doc.activeElement).toBe(box);
  });

  it('falls back to the section when the anchor is missing or in another tab', () => {
    const { doc, h, send, scrolls } = setup();
    const section = doc.querySelector<HTMLElement>('#tab-eli5 > section');
    const other = doc.querySelector<HTMLElement>('#tab-indepth aside.qa');
    if (!section || !other) throw new Error('fixture');
    for (const anchorId of ['q-00000000', other.id]) {
      send({ sectionId: section.id, anchorId, flash: true, loadSeq: 1 });
      expect(h.tabs?.active()).toBe('eli5');
      vi.advanceTimersByTime(50);
      expect(scrolls.at(-1)).toEqual({ el: section, opts: { block: 'start' } });
      expect(section.classList.contains('eli5-flash')).toBe(true);
      expect(other.classList.contains('eli5-flash')).toBe(false);
      expect(doc.activeElement).toBe(section.querySelector('h2'));
      vi.advanceTimersByTime(1600);
    }
  });
});
