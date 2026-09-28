import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  IPC,
  type CloseTabRequest,
  type CreateSectionEli5Request,
  type DocUpdatedEvent,
  type ScrollToEvent,
  type SectionActionRequest,
  type SectionBusyEvent,
  type SectionId,
} from '../../preload/contract';
import { SECTION_ELI5_TAB_KEY_RE, SECTION_ID_RE, SectionActionError, TAB_KEY_RE, tabKeyOfSectionId } from '../document';
import { fail, type Register } from './handle';
import { SlugPayload } from './schemas';

type Unsub = () => void;

/**
 * Section actions service (08 §6, §7), implemented by the interactive-reading slice
 * (src/main/document/interactive/). Requests arrive validated, with the viewer's own slug.
 * Throw PipelineRequestError / LibraryError / IpcFailure for a specific IpcError.
 */
export interface SectionActions {
  /** `eli5:doc:regenerate-section`: enqueues a section job (06 §8.2). */
  regenerateSection(r: SectionActionRequest): Promise<{ jobId: string }>;
  /** `eli5:doc:create-section-eli5`: enqueues a job that appends a Section ELI5 tab (08 §7.1). */
  createSectionEli5(r: CreateSectionEli5Request): Promise<{ jobId: string }>;
  /** `eli5:doc:close-tab`: deletes a Section ELI5 tab (08 §7.2). */
  closeTab(r: CloseTabRequest): Promise<void>;
  /** Pushed to the app renderer as `eli5:doc:updated`. */
  onUpdated(cb: (e: DocUpdatedEvent) => void): Unsub;
  /** Pushed to the viewer as `eli5:doc:scroll-to` (08 §7.4); the service times it by loadSeq. */
  onScrollTo(cb: (e: ScrollToEvent) => void): Unsub;
  /** Pushed to the viewer as `eli5:doc:section-busy` (08 §4.1, §8.3). */
  onSectionBusy(cb: (e: SectionBusyEvent) => void): Unsub;
}

const Slug = SlugPayload.shape.slug;
const TabKey = z.string().regex(TAB_KEY_RE);
const SectionIdSchema = z
  .string()
  .regex(SECTION_ID_RE)
  .transform((s) => s as SectionId);
/** 08 §5.3: 3..4000 chars after the runtime's normalization; main re-checks the bounds. */
const SelectionText = z
  .string()
  .max(4000)
  .refine((t) => t.trim().length >= 3, 'Selection too short');
/** 08 §3: 0..200 chars, single line. */
const Note = z
  .string()
  .max(200)
  .refine((n) => !/[\r\n]/.test(n), 'Single line only');

const sectionInTab = (r: { tabKey: string; sectionId: SectionId }): boolean =>
  tabKeyOfSectionId(r.sectionId) === r.tabKey;

const Eli5Fields = {
  slug: Slug,
  tabKey: TabKey,
  sectionId: SectionIdSchema,
  selectionText: SelectionText,
  note: Note.optional(),
};

export const SectionActionPayload = z
  .object({ ...Eli5Fields, action: z.enum(['expand', 'reexplain', 'analogy', 'deeper']) })
  .refine(sectionInTab, 'Section is not in that tab');
export const CreateSectionEli5Payload = z.object(Eli5Fields).refine(sectionInTab, 'Section is not in that tab');
/** Only Section ELI5 tabs can be closed (08 §7.2). */
export const CloseTabPayload = z.object({ slug: Slug, tabKey: z.string().regex(SECTION_ELI5_TAB_KEY_RE) });

/** The slug of the document the calling viewer has loaded (eli5doc://doc/<slug>/index.html). */
function viewerSlug(e: IpcMainInvokeEvent): string | null {
  try {
    const m = /^\/([^/]+)\//.exec(new URL(e.senderFrame?.url ?? '').pathname);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

/** 08 §4.3 step 1: a page can only act on the document it is. The preload fills slug; main re-checks. */
function sameDocument(slug: string, e: IpcMainInvokeEvent): void {
  if (viewerSlug(e) !== slug) fail('E_FORBIDDEN', 'Forbidden');
}

/** 08 §9: a refused request carries its IpcErrorCode and the runtime's inline notice text. */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SectionActionError) fail(err.code, err.message);
    throw err;
  }
}

/** `eli5:doc:*` invokes (08 §3); viewer-only via VIEWER_CHANNELS. Events are wired by registerIpc. */
export function registerDocIpc(on: Register, d: { actions: SectionActions }): void {
  on(IPC.doc.regenerateSection, SectionActionPayload, (p, e) => {
    sameDocument(p.slug, e);
    return mapped(() => d.actions.regenerateSection(p));
  });
  on(IPC.doc.createSectionEli5, CreateSectionEli5Payload, (p, e) => {
    sameDocument(p.slug, e);
    return mapped(() => d.actions.createSectionEli5(p));
  });
  on(IPC.doc.closeTab, CloseTabPayload, (p, e) => {
    sameDocument(p.slug, e);
    return mapped(() => d.actions.closeTab(p));
  });
}
