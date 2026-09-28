import { describe, expect, it, vi } from 'vitest';
import { createElectronViewerPort } from '../../../../../src/main/document';
import { req, sec, setup } from './harness';

/** Viewer refresh and scroll (08 §2 item 4, §7.4). */

describe('reload and scroll-to (08 §7.4)', () => {
  it('reloads the viewer showing the document and scrolls once that load finishes', async () => {
    const s = await setup();
    s.viewer.load(); // the initial open: loadSeq 1
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(s.viewer.reloads).toBe(1);
    expect(s.events.scroll).toEqual([]);
    s.viewer.start();
    expect(s.events.scroll).toEqual([]);
    const busyBefore = s.events.busy.length;
    s.viewer.finish();
    expect(s.events.scroll).toEqual([{ sectionId: sec(s.model, 0, 0), tabKey: 'indepth', flash: true, loadSeq: 2 }]);
    // Busy state follows the scroll (08 §7.4 step 4).
    expect(s.events.busy.length).toBe(busyBefore + 1);
    s.viewer.load();
    expect(s.events.scroll).toHaveLength(1);
  });

  it('does not reload when the viewer shows another document', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    s.viewer.load('other-doc');
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(s.viewer.reloads).toBe(0);
    expect(s.events.updated).toHaveLength(1);
  });

  it('coalesces updates that land before the reload starts; the latest target wins', async () => {
    const s = await setup();
    s.ir.notifyUpdated({ slug: s.slug, sectionId: sec(s.model, 0, 0), tabKey: 'indepth' });
    s.ir.notifyUpdated({ slug: s.slug, tabKey: 'eli5' });
    expect(s.viewer.reloads).toBe(1);
    s.viewer.load();
    expect(s.events.scroll).toEqual([{ tabKey: 'eli5', flash: true, loadSeq: 1 }]);
  });

  it('reloads again when an update lands while a reload is loading', async () => {
    const s = await setup();
    s.ir.notifyUpdated({ slug: s.slug, sectionId: sec(s.model, 0, 0), tabKey: 'indepth' });
    s.viewer.start();
    s.ir.notifyUpdated({ slug: s.slug, sectionId: sec(s.model, 0, 1), tabKey: 'indepth' });
    expect(s.viewer.reloads).toBe(1);
    s.viewer.finish();
    expect(s.viewer.reloads).toBe(2);
    expect(s.events.scroll).toEqual([]);
    s.viewer.load();
    expect(s.events.scroll).toEqual([{ sectionId: sec(s.model, 0, 1), tabKey: 'indepth', flash: true, loadSeq: 2 }]);
  });

  it('a failed reload does not wedge later updates; the next one reloads and scrolls', async () => {
    const s = await setup();
    s.ir.notifyUpdated({ slug: s.slug, sectionId: sec(s.model, 0, 0), tabKey: 'indepth' });
    s.viewer.start();
    s.viewer.fail();
    s.ir.notifyUpdated({ slug: s.slug, tabKey: 'eli5' });
    expect(s.viewer.reloads).toBe(2);
    s.viewer.load();
    expect(s.events.scroll).toEqual([{ tabKey: 'eli5', flash: true, loadSeq: 2 }]);
  });

  it('a reload that fails before it starts does not wedge later updates either', async () => {
    const s = await setup();
    s.ir.notifyUpdated({ slug: s.slug, tabKey: 'eli5' });
    s.viewer.fail();
    s.ir.notifyUpdated({ slug: s.slug, tabKey: 'indepth' });
    expect(s.viewer.reloads).toBe(2);
  });

  it('drops the scroll when the user opened another document before the reload finished', async () => {
    const s = await setup();
    s.ir.notifyUpdated({ slug: s.slug, tabKey: 'eli5' });
    s.viewer.load('other-doc');
    expect(s.events.scroll).toEqual([]);
    s.viewer.load(s.slug);
    expect(s.events.scroll).toEqual([]);
  });
});

/** Minimal WebContents double: an event emitter with a URL. */
function fakeWebContents(url: string) {
  const handlers = new Map<string, Set<(...a: never[]) => void>>();
  return {
    url,
    destroyed: false,
    reload: vi.fn(),
    getURL() {
      return this.url;
    },
    isDestroyed() {
      return this.destroyed;
    },
    on(ev: string, fn: (...a: never[]) => void) {
      let set = handlers.get(ev);
      if (!set) handlers.set(ev, (set = new Set()));
      set.add(fn);
      return this;
    },
    fire(ev: string, ...args: unknown[]) {
      for (const fn of handlers.get(ev) ?? []) (fn as (...a: unknown[]) => void)(...args);
    },
  };
}

describe('createElectronViewerPort (08 §2 item 4)', () => {
  it('reads the slug from the eli5doc:// URL and forwards load events once attached', () => {
    const wc = fakeWebContents('eli5doc://doc/example-widgets/index.html#tab=eli5');
    const holder: { wc?: typeof wc } = {};
    const port = createElectronViewerPort(() => holder.wc);
    expect(port.currentSlug()).toBeNull();
    const starts = vi.fn();
    const finishes = vi.fn();
    const fails = vi.fn();
    port.onLoadStart(starts);
    port.onLoadFinish(finishes);
    port.onLoadFail(fails);
    holder.wc = wc;
    port.attach();
    port.attach(); // idempotent
    expect(port.currentSlug()).toBe('example-widgets');
    wc.fire('did-start-loading');
    wc.fire('did-finish-load');
    expect(starts).toHaveBeenCalledTimes(1);
    expect(finishes).toHaveBeenCalledTimes(1);
    // did-fail-load(event, errorCode, errorDescription, validatedURL, isMainFrame): main frame only.
    wc.fire('did-fail-load', {}, -2, 'failed', 'eli5doc://doc/example-widgets/index.html', false);
    expect(fails).not.toHaveBeenCalled();
    wc.fire('did-fail-load', {}, -2, 'failed', 'eli5doc://doc/example-widgets/index.html', true);
    expect(fails).toHaveBeenCalledTimes(1);
    port.reload();
    expect(wc.reload).toHaveBeenCalledTimes(1);
    wc.url = 'https://example.test/';
    expect(port.currentSlug()).toBeNull();
    wc.destroyed = true;
    port.reload();
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });
});
