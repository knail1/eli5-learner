// Section actions service (08 §6.1, §7.2, §8): request checks, in-flight busy keys, tab close, and
// the events IPC forwards (`eli5:doc:updated`, `scroll-to`, `section-busy`).
import { readFile } from 'node:fs/promises';
import type {
  DeepAskDepth,
  AskSectionRequest,
  CloseTabRequest,
  CreateSectionEli5Request,
  DocHistoryChangedEvent,
  DocHistoryState,
  DocUpdatedEvent,
  DocVersionPending,
  DocVersionTree,
  DocVersionsChangedEvent,
  MenuAction,
  ScrollToEvent,
  SectionActionRequest,
  SectionBusyEvent,
  SectionId,
} from '../../../preload/contract';
import type { DocHistory, SectionActions } from '../../ipc';
import {
  LibraryError,
  historyFromTree,
  redoChild,
  scrollTargetFor,
  toWire,
  type VersionNodeRecord,
  type VersionTreeFile,
  type VersionTreeView,
} from '../../library';
import type { SectionRunner } from '../../pipeline';
import { DocumentFormatError } from '../errors';
import { canonicalJson } from '../canonical-json';
import { sectionIdsOf } from '../ids';
import { MAX_SECTION_ELI5_TABS, removeTab, sectionIdsOfTab } from '../mutate';
import { parseDocument } from '../parse';
import { renderDocument } from '../render';
import { DOC_RUNTIME_VERSION, bundledDocRuntime } from '../runtime-assets';
import { tabKeyOfSectionId } from '../section-id';
import type { DocumentModel, ParsedDocument, SectionJobPayload } from '../types';
import { sectionHash } from './hash';
import { RateLimiter } from './rate-limit';
import { compareRuntimeVersions, createSectionRunner, runtimeFor } from './regenerate';
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

/**
 * 08 §6.1 step 1a: Deep Ask's own limit per document, on top of the shared one, because each deep
 * ask can send up to DEEP_ASK_INPUT_CAP_TOKENS of input.
 */
export const DEEP_ASK_RATE = { max: 3, windowMs: 60_000 } as const;

export interface InteractiveReading {
  /** IpcServices.sectionActions (src/main/ipc/doc.ts). */
  readonly actions: SectionActions;
  /** PipelineDeps.sectionRunner (06 §8.2). */
  readonly runner: SectionRunner;
  /** IpcServices.docHistory: undo/redo and the version tree, refused while a section is busy (08 §6.7). */
  readonly history: DocHistory;
  /** Subscribes to the queue and rebuilds busy keys from non-terminal section jobs (08 §8.1). */
  attachJobs(jobs: InteractiveJobs): void;
  /** Emits `eli5:doc:updated` and refreshes the viewer when it shows that document (08 §7.4). */
  notifyUpdated(e: DocUpdatedEvent): void;
  /** Reload + scroll only, for an update another module already pushed (a merge accept, 09 §10.6 step 12). */
  refreshViewer(e: DocUpdatedEvent): void;
  /**
   * D12 (a), 07 §5.5: before the viewer opens a document whose runtime is older than the bundled
   * one, re-renders the same model with the bundled runtime in place (same version node). Skipped
   * when the library is read-only, a section of the document is busy or it does not parse. Never
   * rejects: on any failure the document keeps its old runtime.
   */
  refreshRuntimeOnOpen(slug: string): Promise<void>;
  /** True while a section job of the document is in flight (08 §8.1); sync mirrors it as `busy` (16 §4.4). */
  isBusy(slug: string): boolean;
  dispose(): void;
}

interface Inflight {
  slug: string;
  sectionId: SectionId;
  action: MenuAction;
  /** Ask deep (08 §6.9) or Ask deeper (§6.10): busy items and pending rows carry it. */
  depth?: DeepAskDepth;
  jobId?: string;
  /** The section heading, once known (the Versions panel's pending row). */
  heading?: string;
}

/** The stored depth of a payload or inflight entry; an unknown value counts as quick. */
const deepOf = (f: { depth?: string | undefined }): { depth?: DeepAskDepth } =>
  f.depth === 'deep' || f.depth === 'deeper' ? { depth: f.depth } : {};

const nodeOf = (tree: VersionTreeFile, id: string | null | undefined): VersionNodeRecord | undefined =>
  id == null ? undefined : tree.nodes.find((n) => n.id === id);

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
    bundledRuntime: input.bundledRuntime ?? bundledDocRuntime,
  };
  const inflight = new Map<string, Inflight>();
  const updated = new Emitter<DocUpdatedEvent>();
  const scroll = new Emitter<ScrollToEvent>();
  const busy = new Emitter<SectionBusyEvent>();
  const historyChanged = new Emitter<DocHistoryChangedEvent>();
  const versionsChanged = new Emitter<DocVersionsChangedEvent>();
  const limiter = new RateLimiter({
    ...(d.rateLimit ?? {}),
    now: () => d.clock.now().getTime(),
  });
  const deepLimiter = new RateLimiter({
    ...DEEP_ASK_RATE,
    ...(d.deepAskRate ?? {}),
    now: () => d.clock.now().getTime(),
  });
  /** Last status seen per section job, to tell a user retry (failed -> queued) from a new job. */
  const lastStatus = new Map<string, string>();
  const retried = new Set<string>();
  /** Retries queued while another action held their section; their run fails fast (08 §8.1). */
  const blocked = new Set<string>();
  let jobs: InteractiveJobs | undefined;
  let unsubJobs: Unsub | undefined;

  // ---- undo/redo and the version tree (08 §6.7, 09 §4.1) ----
  const busyFor = (slug: string): boolean => [...inflight.values()].some((f) => f.slug === slug);
  /** Section jobs of `slug` that will add a version when they finish. */
  const pendingFor = (slug: string): DocVersionPending[] =>
    [...inflight.values()]
      .filter((f) => f.slug === slug)
      .map((f) => ({
        sectionId: f.sectionId,
        action: f.action,
        heading: f.heading ?? (f.jobId ? jobs?.get(f.jobId)?.section?.heading : undefined) ?? '',
        ...deepOf(f),
      }));
  const historyOf = (slug: string, view: VersionTreeView): DocHistoryState => ({
    ...historyFromTree(view.tree),
    busy: busyFor(slug),
  });
  const wireOf = (slug: string, view: VersionTreeView): DocVersionTree =>
    toWire(view, { busy: busyFor(slug), pending: pendingFor(slug) });
  const viewOf = async (slug: string): Promise<VersionTreeView> => {
    if (!d.library.hasSlug(slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
    return d.library.versions(slug);
  };
  const historyState = async (slug: string): Promise<DocHistoryState> => historyOf(slug, await viewOf(slug));
  const versionsState = async (slug: string): Promise<DocVersionTree> => wireOf(slug, await viewOf(slug));
  /** Serialized, so the last events for a slug always carry its latest state. */
  let historyChain: Promise<void> = Promise.resolve();
  const pushHistory = (slug: string): void => {
    historyChain = historyChain.then(async () => {
      if (!d.library.hasSlug(slug)) return;
      let view: VersionTreeView;
      try {
        view = await d.library.versions(slug);
      } catch {
        // A document that vanished or cannot be read has no history to show.
        return;
      }
      historyChanged.emit({ slug, state: historyOf(slug, view) });
      versionsChanged.emit({ slug, tree: wireOf(slug, view) });
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
      .map((f) => ({ sectionId: f.sectionId, action: f.action, ...deepOf(f) }));
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
    inflight.set(key, {
      slug: p.slug,
      sectionId: p.sectionId,
      action: p.action,
      ...(p.action === 'ask' ? deepOf(p) : {}),
      jobId,
      heading: p.heading,
    });
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
      const message = code ? failureNotice(code, p) : undefined;
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
  const request = async (
    r: Omit<SectionActionRequest, 'action'> &
      Pick<CreateSectionEli5Request, 'sectionIds'> &
      Partial<Pick<AskSectionRequest, 'question' | 'depth'>>,
    action: MenuAction,
  ): Promise<{ jobId: string }> => {
    if (d.viewer.currentSlug() !== r.slug) refuse('E_FORBIDDEN', 'Forbidden');
    // 08 §6.1 step 1a: Ask deep and Ask deeper share the deep limiter.
    const depth = action === 'ask' ? deepOf(r).depth : undefined;
    const deep = depth !== undefined;
    if (!limiter.take(r.slug)) refuse('E_RATE_LIMITED', NOTICES.rateLimited);
    if (deep && !deepLimiter.take(r.slug)) {
      limiter.refund(r.slug);
      refuse('E_RATE_LIMITED', NOTICES.rateLimited);
    }
    const key = busyKey(r.slug, r.sectionId);
    let reserved = false;
    try {
      if (tabKeyOfSectionId(r.sectionId) !== r.tabKey) refuse('E_BAD_REQUEST', 'Invalid request');
      if (action === 'ask' && !r.question?.trim()) refuse('E_BAD_REQUEST', 'Invalid request');
      if (!d.library.hasSlug(r.slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
      if (inflight.has(key)) refuse('E_CONFLICT', NOTICES.busy);
      // Reserved before any await, so two requests for one section cannot both pass step 4.
      inflight.set(key, { slug: r.slug, sectionId: r.sectionId, action, ...(depth ? { depth } : {}) });
      reserved = true;
      if (!(await (d.hasApiKey?.() ?? Promise.resolve(true)))) refuse('E_NO_API_KEY', NOTICES.noApiKey);
      const { model } = await readModel(r.slug);
      const section = model.tabs.find((t) => t.key === r.tabKey)?.sections.find((s) => s.id === r.sectionId);
      if (!section) return refuse('E_NOT_FOUND', NOTICES.sectionGone);
      if (section.kind === 'references') refuse('E_BAD_REQUEST', 'Invalid request');
      const mine = inflight.get(key);
      if (mine) mine.heading = section.heading;
      // 08 §7.5: every section a selection covers must still exist in the tab and be actionable.
      const covered = action === 'eli5-selection' ? (r.sectionIds ?? [r.sectionId]) : undefined;
      for (const id of covered ?? []) {
        const c = model.tabs.find((t) => t.key === r.tabKey)?.sections.find((s) => s.id === id);
        if (!c) refuse('E_NOT_FOUND', NOTICES.sectionGone);
        else if (c.kind === 'references') refuse('E_BAD_REQUEST', 'Invalid request');
      }
      if (
        (action === 'eli5-tab' || action === 'eli5-selection') &&
        model.tabs.filter((t) => t.kind === 'section-eli5').length >= MAX_SECTION_ELI5_TABS
      )
        refuse('E_CONFLICT', NOTICES.tooManyTabs);
      if (!jobs) throw new Error('interactive reading: job queue not attached');
      const payload: SectionJobPayload = {
        slug: r.slug,
        tabKey: r.tabKey,
        sectionId: r.sectionId,
        action,
        selectionText: r.selectionText,
        ...(r.note ? { note: r.note } : {}),
        ...(covered ? { sectionIds: covered } : {}),
        ...(action === 'ask' ? { question: r.question } : {}),
        ...(depth ? { depth } : {}),
        heading: section.heading,
        baseHash: sectionHash(section),
      };
      const { jobId } = await jobs.enqueueSection(payload);
      const cur = inflight.get(key);
      if (cur && !cur.jobId) cur.jobId = jobId;
      broadcast(r.slug);
      d.log?.info('document.section-action', {
        slug: r.slug,
        sectionId: r.sectionId,
        jobId,
        kind: depth ? `ask-${depth}` : action,
      });
      return { jobId };
    } catch (err) {
      if (reserved && !inflight.get(key)?.jobId) inflight.delete(key);
      limiter.refund(r.slug);
      if (deep) deepLimiter.refund(r.slug);
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
      const rt = runtimeFor({ model, runtime }, d.bundledRuntime);
      const next = rt.stamp(removeTab(model, r.tabKey, now));
      const closedIds = sectionIdsOfTab(model, r.tabKey);
      const html = renderDocument(next, assets, { runtime: rt.runtime, theme });
      const origin = tab.origin?.sectionId;
      await d.library.updateDocument(r.slug, {
        html,
        meta: (m) => ({ ...m, tabs: mirrorTabs(next.tabs), retiredIds: [...(m.retiredIds ?? []), ...closedIds] }),
        label: changeLabel('close-tab', tab.label),
        change: {
          kind: 'close-tab',
          topic: tab.label,
          ...(origin ? { target: { tabKey: tabKeyOfSectionId(origin), sectionId: origin } } : {}),
          undoTarget: { tabKey: r.tabKey },
        },
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

  /**
   * D7: SectionIds no version may reuse. Every id retired in either version, plus every id the live
   * version has that the target lacks, minus the ids the target uses itself.
   */
  const retiredFor = (
    live: DocumentModel | undefined,
    target: DocumentModel,
    liveRetired: readonly string[],
    targetRetired: readonly string[],
  ): SectionId[] => {
    const inTarget = sectionIdsOf(target.tabs);
    const out = new Set<string>([...targetRetired, ...liveRetired]);
    for (const id of live ? sectionIdsOf(live.tabs) : []) out.add(id);
    for (const id of inTarget) out.delete(id);
    return [...out] as SectionId[];
  };

  const tryParse = (html: string): ParsedDocument | undefined => {
    try {
      return parseDocument(html);
    } catch (err) {
      if (err instanceof DocumentFormatError) return undefined;
      throw err;
    }
  };

  /**
   * 09 §4.1, D1: makes a version the live document and scrolls the viewer to where it changed.
   * Refused while any section of the document is busy. The version already shown only scrolls.
   * `pick` chooses the version from the tree read under the doc lock, so Undo and Redo step from
   * the version that is current when they run, not from one a concurrent write replaced.
   */
  const checkoutWith = async (slug: string, pick: (tree: VersionTreeFile) => string): Promise<VersionTreeView> => {
    if (!d.library.hasSlug(slug)) refuse('E_NOT_FOUND', NOTICES.docGone);
    if (busyFor(slug)) refuse('E_CONFLICT', NOTICES.historyBusy);
    const out = await d.library.withDocLock(slug, async () => {
      // A job that became busy while this waited for the lock wins.
      if (busyFor(slug)) refuse('E_CONFLICT', NOTICES.historyBusy);
      const view = await d.library.versions(slug);
      const id = pick(view.tree);
      if (id === view.tree.currentId && nodeOf(view.tree, id)) return { view, id, previousId: id, moved: false };
      const liveMeta = await d.library.getMeta(slug);
      const liveRetired = liveMeta.retiredIds ?? [];
      let target: Awaited<ReturnType<typeof d.library.readVersion>>;
      try {
        target = await d.library.readVersion(slug, id);
      } catch (err) {
        // readVersion never writes (D5). library.checkout reads the same snapshot again, stubs the
        // node when it is corrupt so it is not offered again, and throws VERSION_CORRUPT.
        if (!(err instanceof LibraryError && err.code === 'VERSION_CORRUPT')) throw err;
        await d.library.checkout(slug, id, { retiredIds: liveRetired });
        throw err;
      }
      let liveHtml: string | undefined;
      try {
        liveHtml = await d.readFile(d.library.docPath(slug));
      } catch {
        liveHtml = undefined;
      }
      const live = liveHtml === undefined ? undefined : tryParse(liveHtml);
      const parsed = tryParse(target.html.toString('utf8'));
      const targetRetired = target.meta.retiredIds ?? [];
      let retiredIds: SectionId[];
      let html: string | undefined;
      if (parsed) {
        retiredIds = retiredFor(live?.model, parsed.model, liveRetired, targetRetired);
        // D12 (c): an old-runtime snapshot comes back with the bundled runtime, same model.
        const rt = runtimeFor(parsed, d.bundledRuntime);
        if (rt.upgraded) {
          html = renderDocument(rt.stamp(parsed.model), parsed.assets, { runtime: rt.runtime, theme: parsed.theme });
        }
      } else {
        // Not a document 08 can read: checked out as it is, retiring everything either side retired.
        retiredIds = [...new Set([...liveRetired, ...targetRetired])] as SectionId[];
      }
      const r = await d.library.checkout(slug, id, { retiredIds, ...(html !== undefined ? { html } : {}) });
      return { view: r.tree, id, previousId: r.previousId, moved: r.previousId !== id };
    });
    const e: DocUpdatedEvent = { slug, ...scrollTargetFor(out.view.tree, out.previousId, out.id) };
    if (out.moved) {
      d.log?.info('document.version-checkout', { slug });
      notifyUpdated(e);
    } else {
      refresh.scrollTo(e);
    }
    return out.view;
  };

  /** 08 §6.7: Undo checks out the parent, Redo the redo child (09 §4.1). */
  const step = async (slug: string, dir: 'undo' | 'redo'): Promise<DocHistoryState> => {
    const view = await checkoutWith(slug, (tree) => {
      const parent = nodeOf(tree, nodeOf(tree, tree.currentId)?.parentId);
      const to = dir === 'undo' ? (parent?.sha256 ? parent : undefined) : redoChild(tree, tree.currentId);
      return to?.id ?? refuse('E_CONFLICT', dir === 'undo' ? NOTICES.nothingToUndo : NOTICES.nothingToRedo);
    });
    d.log?.info('document.history-swap', { slug, kind: dir });
    return historyOf(slug, view);
  };

  const history: DocHistory = {
    state: historyState,
    undo: (slug) => step(slug, 'undo'),
    redo: (slug) => step(slug, 'redo'),
    onChanged: (cb) => historyChanged.on(cb),
    versions: versionsState,
    checkout: async (r) => wireOf(r.slug, await checkoutWith(r.slug, () => r.versionId)),
    onVersionsChanged: (cb) => versionsChanged.on(cb),
  };

  /** `; runtime X.Y.Z` in the generator meta tag, so a current document is skipped without a parse. */
  const GENERATOR_RUNTIME_RE = /<meta name="generator" content="[^"]*; runtime ([0-9][0-9.]*)">/;
  const refreshRuntimeOnOpen = async (slug: string): Promise<void> => {
    try {
      if (d.library.readOnly || !d.library.hasSlug(slug) || busyFor(slug)) return;
      const head = GENERATOR_RUNTIME_RE.exec((await d.readFile(d.library.docPath(slug))).slice(0, 65536));
      if (head?.[1] && compareRuntimeVersions(head[1], DOC_RUNTIME_VERSION) >= 0) return;
      const refreshed = await d.library.withDocLock(slug, async () => {
        // A job that started while this waited for the lock writes its own upgrade.
        if (busyFor(slug)) return false;
        const parsed = tryParse(await d.readFile(d.library.docPath(slug)));
        if (!parsed) return false;
        const rt = runtimeFor(parsed, d.bundledRuntime);
        if (!rt.upgraded) return false;
        const next = rt.stamp(parsed.model);
        const html = renderDocument(next, parsed.assets, { runtime: rt.runtime, theme: parsed.theme });
        // Same model only: a page that does not parse back to it is never written (the old one stays).
        const back = tryParse(html);
        if (!back || canonicalJson(back.model) !== canonicalJson(next)) {
          d.log?.warn('document.runtime-refresh-skipped', { slug, kind: 'roundtrip' });
          return false;
        }
        await d.library.refreshRuntime(slug, html);
        return true;
      });
      if (refreshed) d.log?.info('document.runtime-refreshed', { slug });
    } catch (err) {
      // The old runtime keeps working; the next mutation upgrades it (D12 b).
      d.log?.info('document.runtime-refresh-skipped', { slug, kind: (err as Error)?.name ?? 'error' });
    }
  };

  const actions: SectionActions = {
    regenerateSection: (r) => request(r, r.action),
    createSectionEli5: (r) => request(r, r.scope === 'selection' ? 'eli5-selection' : 'eli5-tab'),
    closeTab,
    askSection: (r) => request(r, 'ask'),
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
    refreshRuntimeOnOpen,
    isBusy: busyFor,
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
