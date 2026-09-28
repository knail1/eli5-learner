/**
 * Fakes for the interactive-reading slice (08): a real FsLibrary in a temp root holding one rendered
 * fixture document, a fake job queue, a scripted viewer and a scripted runSectionAction. No LLM.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import {
  createInteractiveReading,
  mirrorTabs,
  parseDocument,
  renderDocument,
  type DocumentModel,
  type IdSource,
  type InteractiveDeps,
  type InteractiveJobs,
  type SectionId,
  type SectionJobPayload,
  type ViewerPort,
} from '../../../../../src/main/document';
import type { FsLibrary } from '../../../../../src/main/library';
import type { DocumentDraftTab, SectionDraft } from '../../../../../src/main/llm';
import type { SectionRunContext } from '../../../../../src/main/pipeline';
import type { JobFailureCode, JobStatus } from '../../../../../src/preload/contract';
import { fixtureDocument } from '../../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';
import { FakeClock } from '../../../../helpers/clock';
import { SeededIdSource } from '../../../../helpers/ids';
import { makeMeta, testLibrary } from '../../library/fixtures';

export const fixture = fixtureDocument('with-tab');
export const render = (m: DocumentModel): string =>
  renderDocument(m, fixture.assets, { runtime: STUB_RUNTIME, theme: fixture.theme });

export function sec(m: DocumentModel, tab: number, i: number): SectionId {
  const id = m.tabs[tab]?.sections[i]?.id;
  if (!id) throw new Error('fixture has no such section');
  return id;
}

type Snap = { id: string; kind: 'create' | 'section'; status: JobStatus };
type FakeJob = { status: JobStatus; section: SectionJobPayload; failure?: { code: JobFailureCode } };

export class FakeJobs implements InteractiveJobs {
  jobs = new Map<string, FakeJob>();
  private listeners = new Set<(s: Snap) => void>();
  private n = 0;
  enqueueError: Error | undefined;

  enqueueSection = vi.fn(async (p: SectionJobPayload): Promise<{ jobId: string }> => {
    if (this.enqueueError) throw this.enqueueError;
    const id = `job-s${String(++this.n)}`;
    this.jobs.set(id, { status: 'queued', section: p });
    this.emit(id, 'queued');
    return { jobId: id };
  });
  list(): Snap[] {
    return [...this.jobs].map(([id, j]) => ({ id, kind: 'section' as const, status: j.status }));
  }
  get(id: string): FakeJob | undefined {
    return this.jobs.get(id);
  }
  on(_e: 'changed', cb: (s: Snap) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(id: string, status: JobStatus, failure?: JobFailureCode): void {
    const j = this.jobs.get(id);
    if (j) {
      j.status = status;
      if (failure) j.failure = { code: failure };
    }
    for (const cb of this.listeners) cb({ id, kind: 'section', status });
  }
  /** Adds a job as if it had been persisted by an earlier run. */
  seed(id: string, status: JobStatus, section: SectionJobPayload): void {
    this.jobs.set(id, { status, section });
  }
}

export class FakeViewer implements ViewerPort {
  slug: string | null;
  reloads = 0;
  private starts = new Set<() => void>();
  private finishes = new Set<() => void>();
  constructor(slug: string | null) {
    this.slug = slug;
  }
  currentSlug(): string | null {
    return this.slug;
  }
  reload(): void {
    this.reloads++;
  }
  onLoadStart(cb: () => void): () => void {
    this.starts.add(cb);
    return () => this.starts.delete(cb);
  }
  onLoadFinish(cb: () => void): () => void {
    this.finishes.add(cb);
    return () => this.finishes.delete(cb);
  }
  start(slug: string | null = this.slug): void {
    this.slug = slug;
    for (const cb of this.starts) cb();
  }
  finish(): void {
    for (const cb of this.finishes) cb();
  }
  /** One full load (did-start-loading, then did-finish-load). */
  load(slug: string | null = this.slug): void {
    this.start(slug);
    this.finish();
  }
}

export const NEW_SECTION: SectionDraft = {
  heading: 'Where the budget went, rewritten',
  blocks: [{ type: 'paragraph', md: 'Rewritten: search now takes most of the spend, and ROAS decides the rest.' }],
};

export const NEW_TAB: DocumentDraftTab = {
  kind: 'section-eli5',
  title: 'Budget, simply',
  sections: [
    { heading: 'Money moves', blocks: [{ type: 'paragraph', md: 'The shop moved its coins to search ads.' }] },
  ],
};

export interface Setup {
  lib: FsLibrary;
  slug: string;
  model: DocumentModel;
  html: string;
  jobs: FakeJobs;
  viewer: FakeViewer;
  clock: FakeClock;
  runSectionAction: ReturnType<typeof vi.fn<(i: { action: string }) => Promise<SectionDraft | DocumentDraftTab>>>;
  hasApiKey: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  ir: ReturnType<typeof createInteractiveReading>;
  events: { updated: unknown[]; scroll: unknown[]; busy: unknown[] };
  /** Current index.html on disk. */
  read(): Promise<string>;
  write(html: string): Promise<void>;
  /** Replaces the document on disk with a re-render of `m` (as another writer would). */
  writeModel(m: DocumentModel): Promise<void>;
  /** A SectionRunContext for a job the fake queue holds. */
  ctx(jobId: string, signal?: AbortSignal): { ctx: SectionRunContext; steps: string[] };
}

export async function setup(
  opts: { model?: DocumentModel; deps?: Partial<InteractiveDeps>; idSource?: IdSource } = {},
): Promise<Setup> {
  const model = opts.model ?? fixture.model;
  const { lib } = await testLibrary({ devChecks: true });
  const r = await lib.allocateSlug('Example Widgets');
  const html = render(model);
  const staging = await lib.stagingDir('job-c1');
  await writeFile(path.join(staging, 'index.html'), html);
  const meta = makeMeta({ title: 'Example Widgets', topicSlug: r.slug, tabs: mirrorTabs(model.tabs) });
  await writeFile(path.join(staging, 'meta.json'), JSON.stringify(meta));
  await lib.commitDocument(r, staging, meta);
  const slug = r.slug;
  const jobs = new FakeJobs();
  const viewer = new FakeViewer(slug);
  const clock = new FakeClock('2026-09-28T10:00:00.000Z');
  const runSectionAction = vi.fn(async (i: { action: string }): Promise<SectionDraft | DocumentDraftTab> =>
    i.action === 'eli5-tab' ? NEW_TAB : NEW_SECTION,
  );
  const hasApiKey = vi.fn(async () => true);
  const ir = createInteractiveReading({
    library: lib,
    tasks: { runSectionAction },
    viewer,
    hasApiKey,
    clock,
    sectionIds: opts.idSource ?? new SeededIdSource(42),
    ...opts.deps,
  });
  ir.attachJobs(jobs);
  const events: Setup['events'] = { updated: [], scroll: [], busy: [] };
  ir.actions.onUpdated((e) => events.updated.push(e));
  ir.actions.onScrollTo((e) => events.scroll.push(e));
  ir.actions.onSectionBusy((e) => events.busy.push(e));
  const file = lib.docPath(slug);
  return {
    lib,
    slug,
    model,
    html,
    jobs,
    viewer,
    clock,
    runSectionAction,
    hasApiKey,
    ir,
    events,
    read: () => readFile(file, 'utf8'),
    write: (h) => writeFile(file, h),
    writeModel: async (m) => {
      const cur = parseDocument(await readFile(file, 'utf8'));
      await writeFile(file, renderDocument(m, cur.assets, { runtime: cur.runtime, theme: cur.theme }));
    },
    ctx(jobId, signal = new AbortController().signal) {
      const job = jobs.get(jobId);
      if (!job) throw new Error('no job');
      const steps: string[] = [];
      const ctx = {
        job: { id: jobId, section: job.section, attempt: 1 },
        signal,
        enterSaving: async () => {
          steps.push('saving');
        },
        markCommitStarted: () => {
          steps.push('commit');
        },
      } as unknown as SectionRunContext;
      return { ctx, steps };
    },
  };
}

/** The request the runtime would send for a section of the fixture. */
export function req(s: Setup, over: Record<string, unknown> = {}) {
  return {
    slug: s.slug,
    tabKey: 'indepth',
    sectionId: sec(s.model, 0, 0),
    action: 'expand' as const,
    selectionText: 'judges every channel',
    ...over,
  };
}

/** Rejection of a promise, for asserting on error codes. */
export async function rejection(p: Promise<unknown>): Promise<{ name?: string; code?: string; message?: string }> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as { name?: string; code?: string; message?: string },
  );
}
