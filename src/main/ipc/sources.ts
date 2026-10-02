import { z } from 'zod';
import { IPC, type ClassifyTextResult, type DropRegistration, type SourceInput } from '../../preload/contract';
import { log } from '../security';
import { discardDraft, discardInput, readClipboardInputs, stageText, type ClipboardPort } from '../sources';
import type { Registry } from '../editions';
import type { DropRegistry } from './drops';
import type { Register } from './handle';
import { DiscardPayload, DraftPayload, RegisterDropPayload, ReleaseDropsPayload, StageTextPayload } from './schemas';

export interface SourcesIpcDeps {
  userData: string;
  /** A paste-time snapshot of the clipboard (03 §6.1, §15); see snapshotClipboard. */
  clipboard: () => ClipboardPort | Promise<ClipboardPort>;
  drops: DropRegistry;
  /** Lane router for bare identifiers (`eli5:sources:classify-text`, 11 §5.4). */
  registry: Pick<Registry, 'laneRouter'>;
}

/** 11 §10: `{text}` of at most 2048 chars. */
const ClassifyTextPayload = z.object({
  text: z
    .string()
    .max(2048)
    .refine((t) => t.trim().length > 0, 'Empty'),
});

/**
 * 11 §5.4: http(s) URLs are `url`; a token the lane router accepts as a bare identifier (for
 * example a ticket key, HOOK-SRC-02/03) is `bare`; anything else is `invalid`. The public router
 * accepts no bare identifiers, so the field behaves as URL-only.
 */
export function classifyText(text: string, router: { routeBare(t: string): unknown }): ClassifyTextResult {
  const t = text.trim();
  if (URL.canParse(t) && ['http:', 'https:'].includes(new URL(t).protocol)) return { kind: 'url', label: t };
  if (router.routeBare(t) !== null) return { kind: 'bare', label: t };
  return { kind: 'invalid', label: t };
}

/**
 * `eli5:sources:*` (03 §13). Staged paths are derived in main from validated ids. File paths found
 * on the clipboard, and paths from a trusted drop, get opaque ids that jobs:start maps back (06 §11).
 */
export function registerSourcesIpc(on: Register, d: SourcesIpcDeps): void {
  on(IPC.sources.readClipboard, DraftPayload, async (p): Promise<SourceInput[]> => {
    const inputs = await readClipboardInputs(await d.clipboard(), { userData: d.userData, draftId: p.draftId });
    // File inputs carry main's registry id, like drops (06 §11).
    return inputs.map((i): SourceInput => {
      if (i.kind !== 'file') return i;
      const [reg] = d.drops.register([i.path]);
      return reg ? { ...i, id: reg.inputId, path: reg.path } : i;
    });
  });
  on(IPC.sources.stageText, StageTextPayload, (p): Promise<SourceInput> => stageText(d.userData, p));
  on(IPC.sources.discard, DiscardPayload, (p) => discardInput(d.userData, p.draftId, p.inputId));
  on(IPC.sources.discardDraft, DraftPayload, (p) => discardDraft(d.userData, p.draftId));
  on(IPC.sources.classifyText, ClassifyTextPayload, (p) => classifyText(p.text, d.registry.laneRouter()));
  on(IPC.sources.registerDrop, RegisterDropPayload, (p): DropRegistration[] => {
    const regs = d.drops.register(p.paths);
    log.debug('sources.drop-registered', { count: regs.length });
    return regs;
  });
  // The chip left the draft: its id stops naming a read target (06 §11). Unknown ids are ignored.
  on(IPC.sources.releaseDrops, ReleaseDropsPayload, (p): void => d.drops.release(p.inputIds));
}
