import { IPC, type DropRegistration, type SourceInput } from '../../preload/contract';
import { log } from '../security';
import { discardDraft, discardInput, readClipboardInputs, stageText, type ClipboardPort } from '../sources';
import type { DropRegistry } from './drops';
import type { Register } from './handle';
import { DiscardPayload, DraftPayload, RegisterDropPayload, StageTextPayload } from './schemas';

export interface SourcesIpcDeps {
  userData: string;
  /** A paste-time snapshot of the clipboard (03 §6.1, §15); see snapshotClipboard. */
  clipboard: () => ClipboardPort | Promise<ClipboardPort>;
  drops: DropRegistry;
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
  on(IPC.sources.registerDrop, RegisterDropPayload, (p): DropRegistration[] => {
    const regs = d.drops.register(p.paths);
    log.debug('sources.drop-registered', { count: regs.length });
    return regs;
  });
}
