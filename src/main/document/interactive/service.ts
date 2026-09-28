// Section actions service (08 §6.1, §7.2, §8): request checks, in-flight busy keys, tab close, and
// the events IPC forwards (`eli5:doc:updated`, `scroll-to`, `section-busy`).
import { readFile } from 'node:fs/promises';
import type {
  CloseTabRequest,
  DocHistoryChangedEvent,
  DocHistoryState,
  DocUpdatedEvent,
  MenuAction,
  ScrollToEvent,
  SectionActionRequest,
  SectionBusyEvent,
  SectionId,
} from '../../../preload/contract';
import type { DocHistory, SectionActions } from '../../ipc';
import { LibraryError } from '../../library';
import type { SectionRunner } from '../../pipeline';
import { DocumentFormatError } from '../errors';
import { MAX_SECTION_ELI5_TABS, removeTab, sectionIdsOfTab } from '../mutate';
import { parseDocument } from '../parse';
import { renderDocument } from '../render';
import { tabKeyOfSectionId } from '../section-id';
import type { ParsedDocument, SectionJobPayload } from '../types';
import { sectionHash } from './hash';
import { RateLimiter } from './rate-limit';
import { createSectionRunner } from './regenerate';
import {
  SectionActionError,
  changeLabel,
  failureNotice,
  mirrorTabs,
  type InteractiveDeps,
  type InteractiveJobs,
  type ResolvedDeps,
  type Unsub,
} from './types';
import { ViewerRefresh } from './viewer';

/** Inline notice texts for refused requests (08 §9). */
export const NOTICES = {
  busy: 'This section is already being updated',
  rateLimited: 'Too many requests; wait a moment',
  noApiKey: 'Add an API key in Settings',
  tooManyTabs: 'Close a section ELI5 tab before adding another',
  notEditable: "This document can't be edited",
  docGone: 'This document no longer exists',
  sectionGone: 'This section changed. Reload and try again',
  tabBusy: 'Wait for the update in this tab to finish',
  historyBusy: 'Wait for the section update to finish',
  nothingToUndo: 'Nothing to undo',
  nothingToRedo: 'Nothing to redo',
} as const;

export interface InteractiveReading {
  /** IpcServices.sectionActions (src/main/ipc/doc.ts). */
  readonly actions: SectionActions;
  /** PipelineDeps.sectionRunner (06 §8.2). */
  readonly runner: SectionRunner;
  /** IpcServices.docHistory: one-level undo/redo, refused while a section is busy (08 §6.7). */
  readonly history: DocHistory;
  /** Subscribes to the queue and rebuilds busy keys from non-terminal section jobs (08 §8.1). */
  attachJobs(jobs: InteractiveJobs): void;
  /** Emits `eli5:doc:updated` and refreshes the viewer when it shows that document (08 §7.4). */
  notifyUpdated(e: DocUpdatedEvent): void;
  /** Reload + scroll only, for an update another module already pushed (a merge accept, 09 §10.6 step 12). */
  refreshViewer(e: DocUpdatedEvent): void;
  dispose(): void;
}

interface Inflight {
  slug: string;
  sectionId: SectionId;
  action: MenuAction;
  jobId?: string;
}

const busyKey = (slug: string, sectionId: string): string => `${slug}#${sectionId}`;
const refuse = (code: SectionActionError['code'], message: string): never => {
  throw new SectionActionError(code, message);
};

class Emitter<T> {
  private readonly subs = new Set<(e: T) => void>();
  on(cb: (e: T) => void): Unsub {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(e: T): void {
    for (const cb of [...this.subs]) cb(e);
  }
}

export function createInteractiveReading(input: InteractiveDeps): InteractiveReading {
  const d: ResolvedDeps = {
    ...input,
    clock: input.clock ?? { now: () => new Date() },
    readFile: input.readFile ?? ((p) => readFile(p, 'utf8')),
  };
  const inflight = new Map<string, Inflight>();
  const updated = new Emitter<DocUpdatedEvent>();
  const scroll = new Emitter<ScrollToEvent>();
  const busy = new Emitter<SectionBusyEvent>();
  const historyChanged = new Emitter<DocHistoryChangedEvent>();
  const limiter = new RateLimiter({
    ...(d.rateLimit ?? {}),
    now: () => d.clock.now().getTime(),
  });
  /** Last status seen per section job, to tell a user retry (failed -> queued) from a new job. */
  const lastStatus = new Map<string, string>();
  const retried = new Set<string>();
  /** Retries queued while another action held their section; their run fails fast (08 §8.1). */
  const blocked = new Set<string>();
  let jobs: InteractiveJobs | undefined;
  let unsubJobs: Unsub | undefined;

  // ---- one-level undo/redo (08 §6.7, 09 §4.1) ----
  const busyFor = (slug: string): boolean => [...inflight.values()].some((f) => f.slug === slug);
  const historyState = async (slug: string): Promise<DocHistoryState> => {
    if (!d.library.hasSlug(slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
    return { ...(await d.library.history(slug)), busy: busyFor(slug) };
  };
  /** Serialized, so the last event for a slug always carries its latest state. */
  let historyChain: Promise<void> = Promise.resolve();
  const pushHistory = (slug: string): void => {
    historyChain = historyChain.then(async () => {
      if (!d.library.hasSlug(slug)) return;
      try {
        historyChanged.emit({ slug, state: await historyState(slug) });
      } catch {
        // A document that vanished or cannot be read has no history to show.
      }
    });
  };
  const unsubLibrary = d.library.on('changed', (e) => {
    for (const slug of e.slugs) pushHistory(slug);
  });

  /** 08 §8.3: the full busy list for the document in the viewer. */
  const broadcast = (slug: string, notices: SectionBusyEvent['notices'] = []): void => {
    pushHistory(slug);
    if (d.viewer.currentSlug() !== slug) return;
    const list = [...inflight.values()]
      .filter((f) => f.slug === slug)
      .map((f) => ({ sectionId: f.sectionId, action: f.action }));
    busy.emit({ busy: list, ...(notices.length ? { notices } : {}) });
  };
  const refresh = new ViewerRefresh(d.viewer, {
    scrollTo: (e) => scroll.emit(e),
    afterLoad: () => {
      const slug = d.viewer.currentSlug();
      if (slug) broadcast(slug);
    },
  });

  const notifyUpdated = (e: DocUpdatedEvent): void => {
    updated.emit(e);
    refresh.updated(e);
  };

  /** Frees the key only when this job holds it; a request's jobless reservation never matches. */
  const release = (p: SectionJobPayload, jobId: string): boolean => {
    const key = busyKey(p.slug, p.sectionId);
    if (inflight.get(key)?.jobId !== jobId) return false;
    inflight.delete(key);
    return true;
  };

  /**
   * A queued job takes its key. `adopt`: a new job's own request reservation (no jobId yet) becomes
   * this job's. A retry never adopts: a reservation or key of another action stays theirs (08 §8.1).
   */
  const track = (p: SectionJobPayload, jobId: string, adopt: boolean): boolean => {
    const key = busyKey(p.slug, p.sectionId);
    const cur = inflight.get(key);
    if (cur) {
      if (adopt) cur.jobId ??= jobId;
      return false;
    }
    inflight.set(key, { slug: p.slug, sectionId: p.sectionId, action: p.action, jobId });
    return true;
  };

  const onJobChanged = (s: { id: string; kind: string; status: string }): void => {
    if (s.kind !== 'section' || !jobs) return;
    const job = jobs.get(s.id);
    const p = job?.section;
    if (!job || !p) return;
    const prev = lastStatus.get(s.id);
    if (s.status === 'done') lastStatus.delete(s.id);
    else lastStatus.set(s.id, s.status);
    const retry = prev === 'failed' && s.status === 'queued';
    if (retry) retried.add(s.id);
    if (s.status === 'done' || s.status === 'failed') {
      blocked.delete(s.id);
      const released = release(p, s.id);
      const code = s.status === 'failed' ? job.failure?.code : undefined;
      const message = code ? failureNotice(code) : undefined;
      if (released || message) broadcast(p.slug, message ? [{ sectionId: p.sectionId, message }] : []);
    } else if (s.status === 'queued') {
      // A new job, a user retry or a crash resume (08 §8.1).
      if (track(p, s.id, !retry)) broadcast(p.slug);
      else if (retry && inflight.get(busyKey(p.slug, p.sectionId))?.jobId !== s.id) blocked.add(s.id);
    }
  };

  const readModel = async (slug: string): Promise<ParsedDocument> => {
    let html: string;
    try {
      html = await d.readFile(d.library.docPath(slug));
    } catch {
      return refuse('E_NOT_FOUND', NOTICES.docGone);
    }
    try {
      return parseDocument(html);
    } catch (err) {
      if (err instanceof DocumentFormatError) return refuse('E_CONFLICT', NOTICES.notEditable);
      throw err;
    }
  };

  /** 08 §6.1 steps 1-8 for both action channels. */
  const request = async (r: Omit<SectionActionRequest, 'action'>, action: MenuAction): Promise<{ jobId: string }> => {
    if (d.viewer.currentSlug() !== r.slug) refuse('E_FORBIDDEN', 'Forbidden');
    if (!limiter.take(r.slug)) refuse('E_RATE_LIMITED', NOTICES.rateLimited);
    const key = busyKey(r.slug, r.sectionId);
    let reserved = false;
    try {
      if (tabKeyOfSectionId(r.sectionId) !== r.tabKey) refuse('E_BAD_REQUEST', 'Invalid request');
      if (!d.library.hasSlug(r.slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
      if (inflight.has(key)) refuse('E_CONFLICT', NOTICES.busy);
      // Reserved before any await, so two requests for one section cannot both pass step 4.
      inflight.set(key, { slug: r.slug, sectionId: r.sectionId, action });
      reserved = true;
      if (!(await (d.hasApiKey?.() ?? Promise.resolve(true)))) refuse('E_NO_API_KEY', NOTICES.noApiKey);
      const { model } = await readModel(r.slug);
      const section = model.tabs.find((t) => t.key === r.tabKey)?.sections.find((s) => s.id === r.sectionId);
      if (!section) return refuse('E_NOT_FOUND', NOTICES.sectionGone);
      if (section.kind === 'references') refuse('E_BAD_REQUEST', 'Invalid request');
      if (action === 'eli5-tab' && model.tabs.filter((t) => t.kind === 'section-eli5').length >= MAX_SECTION_ELI5_TABS)
        refuse('E_CONFLICT', NOTICES.tooManyTabs);
      if (!jobs) throw new Error('interactive reading: job queue not attached');
      const payload: SectionJobPayload = {
        slug: r.slug,
        tabKey: r.tabKey,
        sectionId: r.sectionId,
        action,
        selectionText: r.selectionText,
        ...(r.note ? { note: r.note } : {}),
        heading: section.heading,
        baseHash: sectionHash(section),
      };
      const { jobId } = await jobs.enqueueSection(payload);
      const cur = inflight.get(key);
      if (cur && !cur.jobId) cur.jobId = jobId;
      broadcast(r.slug);
      d.log?.info('document.section-action', { slug: r.slug, sectionId: r.sectionId, jobId, kind: action });
      return { jobId };
    } catch (err) {
      if (reserved && !inflight.get(key)?.jobId) inflight.delete(key);
      limiter.refund(r.slug);
      throw err;
    }
  };

  /** 08 §7.2: delete a section ELI5 tab under the lock; its SectionIds are retired. */
  const closeTab = async (r: CloseTabRequest): Promise<void> => {
    if (d.viewer.currentSlug() !== r.slug) refuse('E_FORBIDDEN', 'Forbidden');
    if (!d.library.hasSlug(r.slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
    const left = await d.library.withDocLock(r.slug, async () => {
      const now = d.clock.now().toISOString();
      const { model, assets, runtime, theme } = await readModel(r.slug);
      const index = model.tabs.findIndex((t) => t.key === r.tabKey);
      const tab = model.tabs[index];
      if (!tab) return refuse('E_NOT_FOUND', 'This tab no longer exists');
      if (tab.kind !== 'section-eli5') refuse('E_FORBIDDEN', 'Forbidden');
      for (const f of inflight.values()) {
        if (f.slug === r.slug && tabKeyOfSectionId(f.sectionId) === r.tabKey) refuse('E_CONFLICT', NOTICES.tabBusy);
      }
      const next = removeTab(model, r.tabKey, now);
      const closedIds = sectionIdsOfTab(model, r.tabKey);
      const html = renderDocument(next, assets, { runtime, theme });
      await d.library.updateDocument(r.slug, {
        html,
        meta: (m) => ({ ...m, tabs: mirrorTabs(next.tabs), retiredIds: [...(m.retiredIds ?? []), ...closedIds] }),
        label: changeLabel('close-tab', tab.label),
      });
      return model.tabs[index - 1]?.key ?? model.tabs[0]?.key;
    });
    d.log?.info('document.tab-closed', { slug: r.slug, tabKey: r.tabKey });
    notifyUpdated({ slug: r.slug, ...(left ? { tabKey: left } : {}) });
  };

  const runner = createSectionRunner({
    deps: d,
    claim: (p, jobId) => {
      if (blocked.delete(jobId)) return false;
      track(p, jobId, false);
      return inflight.get(busyKey(p.slug, p.sectionId))?.jobId === jobId;
    },
    committed: (p, jobId, e) => {
      release(p, jobId);
      broadcast(p.slug);
      notifyUpdated(e);
    },
    consumeRetry: (jobId) => retried.delete(jobId),
  });

  /** 08 §6.7: refused while any section of the document is busy; reloads the viewer like an update. */
  const swap = async (slug: string, dir: 'undo' | 'redo'): Promise<DocHistoryState> => {
    if (!d.library.hasSlug(slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
    if (busyFor(slug)) refuse('E_CONFLICT', NOTICES.historyBusy);
    const empty = dir === 'undo' ? NOTICES.nothingToUndo : NOTICES.nothingToRedo;
    const cur = await d.library.history(slug);
    if (!(dir === 'undo' ? cur.canUndo : cur.canRedo)) refuse('E_CONFLICT', empty);
    let next: DocHistoryState;
    try {
      next = await (dir === 'undo' ? d.library.undo(slug) : d.library.redo(slug));
    } catch (err) {
      if (err instanceof LibraryError && err.code === 'HISTORY_EMPTY') refuse('E_CONFLICT', empty);
      throw err;
    }
    d.log?.info('document.history-swap', { slug, kind: dir });
    notifyUpdated({ slug });
    return { ...next, busy: busyFor(slug) };
  };

  const history: DocHistory = {
    state: historyState,
    undo: (slug) => swap(slug, 'undo'),
    redo: (slug) => swap(slug, 'redo'),
    onChanged: (cb) => historyChanged.on(cb),
  };

  const actions: SectionActions = {
    regenerateSection: (r) => request(r, r.action),
    createSectionEli5: (r) => request(r, 'eli5-tab'),
    closeTab,
    onUpdated: (cb) => updated.on(cb),
    onScrollTo: (cb) => scroll.on(cb),
    onSectionBusy: (cb) => busy.on(cb),
  };

  return {
    actions,
    runner,
    history,
    notifyUpdated,
    refreshViewer: (e) => refresh.updated(e),
    attachJobs(q) {
      unsubJobs?.();
      jobs = q;
      unsubJobs = q.on('changed', onJobChanged);
      for (const s of q.list()) {
        if (s.kind !== 'section' || s.status === 'done' || s.status === 'failed') continue;
        const p = q.get(s.id)?.section;
        if (p) track(p, s.id, true);
      }
      const slug = d.viewer.currentSlug();
      if (slug) broadcast(slug);
    },
    dispose() {
      unsubJobs?.();
      unsubLibrary();
      refresh.dispose();
    },
  };
}
