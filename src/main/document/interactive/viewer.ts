// Viewer refresh and scroll (08 §2 item 4, §7.4): loadSeq, coalesced reloads, scroll-to timing.
import type { DocUpdatedEvent, ScrollToEvent } from '../../../preload/contract';
import type { Unsub, ViewerPort } from './types';

interface PendingReload {
  slug: string;
  target: DocUpdatedEvent;
  /** 'requested': reload() called, not started yet; 'loading': started, carries `seq`. */
  phase: 'requested' | 'loading';
  seq: number;
  /** Another update landed while loading: reload once more before scrolling. */
  again: boolean;
}

/**
 * Keeps `viewerState.loadSeq` and turns `eli5:doc:updated` into one reload plus one scroll-to for
 * the document in the viewer (08 §7.4 steps 2-4). `afterLoad` runs after every did-finish-load,
 * after any scroll-to, so busy state follows (08 §8.3).
 */
export class ViewerRefresh {
  private loadSeq = 0;
  private pending: PendingReload | undefined;
  private readonly unsubs: Unsub[];

  constructor(
    private readonly viewer: ViewerPort,
    private readonly out: { scrollTo(e: ScrollToEvent): void; afterLoad(): void },
  ) {
    this.unsubs = [viewer.onLoadStart(() => this.started()), viewer.onLoadFinish(() => this.finished())];
  }

  /** 08 §7.4 steps 2-4. */
  updated(e: DocUpdatedEvent): void {
    if (this.viewer.currentSlug() !== e.slug) return;
    const p = this.pending;
    if (p && p.slug === e.slug) {
      p.target = e;
      if (p.phase === 'loading') p.again = true;
      return;
    }
    this.pending = { slug: e.slug, target: e, phase: 'requested', seq: 0, again: false };
    this.viewer.reload();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }

  private started(): void {
    this.loadSeq++;
    const p = this.pending;
    if (!p) return;
    p.phase = 'loading';
    p.seq = this.loadSeq;
  }

  private finished(): void {
    const p = this.pending;
    if (p && p.phase === 'loading') {
      if (this.viewer.currentSlug() !== p.slug) {
        // The user opened another document before the reload finished.
        this.pending = undefined;
      } else if (p.again) {
        p.again = false;
        p.phase = 'requested';
        this.viewer.reload();
      } else {
        this.pending = undefined;
        this.out.scrollTo({
          ...(p.target.sectionId ? { sectionId: p.target.sectionId } : {}),
          ...(p.target.tabKey ? { tabKey: p.target.tabKey } : {}),
          flash: true,
          loadSeq: p.seq,
        });
      }
    }
    this.out.afterLoad();
  }
}

/** The part of Electron's WebContents the viewer port uses. */
export interface ViewerWebContents {
  getURL(): string;
  isDestroyed(): boolean;
  reload(): void;
  on(event: 'did-start-loading', listener: () => void): unknown;
  on(event: 'did-finish-load', listener: () => void): unknown;
}

/** Slug of an `eli5doc://doc/<slug>/index.html` URL, or null. */
export function viewerSlugOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'eli5doc:' || u.hostname !== 'doc') return null;
    const m = /^\/([^/]+)\//.exec(u.pathname);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * ViewerPort over the viewer WebContents, which the shell creates after IPC is wired. Bootstrap
 * calls `attach()` once the main window exists; every use attaches lazily too (idempotent).
 */
export function createElectronViewerPort(get: () => ViewerWebContents | undefined): ViewerPort & { attach(): void } {
  const starts = new Set<() => void>();
  const finishes = new Set<() => void>();
  const attached = new WeakSet<object>();
  const live = (): ViewerWebContents | undefined => {
    const wc = get();
    return wc && !wc.isDestroyed() ? wc : undefined;
  };
  const attach = (): void => {
    const wc = live();
    if (!wc || attached.has(wc)) return;
    attached.add(wc);
    wc.on('did-start-loading', () => {
      for (const cb of [...starts]) cb();
    });
    wc.on('did-finish-load', () => {
      for (const cb of [...finishes]) cb();
    });
  };
  return {
    attach,
    currentSlug() {
      attach();
      const wc = live();
      return wc ? viewerSlugOf(wc.getURL()) : null;
    },
    reload() {
      attach();
      live()?.reload();
    },
    onLoadStart(cb) {
      attach();
      starts.add(cb);
      return () => starts.delete(cb);
    },
    onLoadFinish(cb) {
      attach();
      finishes.add(cb);
      return () => finishes.delete(cb);
    },
  };
}
