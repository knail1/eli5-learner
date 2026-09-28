import path from 'node:path';
import { IPC, type JobSnapshot, type StartJobRequest } from '../../preload/contract';
import { log } from '../security';
import { draftDir } from '../sources';
import type { DropRegistry } from './drops';
import { IpcFailure, NO_API_KEY, NoPayload, fail, type Register } from './handle';
import { JobIdPayload, StartJobRequestSchema } from './schemas';

/** The JobQueue surface the handlers use (06 §11); JobQueue satisfies it. */
export interface JobsPort {
  start(req: StartJobRequest): Promise<{ jobId: string }>;
  list(): JobSnapshot[];
  cancel(jobId: string): Promise<void>;
  retry(jobId: string): Promise<void>;
  dismiss(jobId: string): Promise<void>;
  on(event: 'changed', cb: (s: JobSnapshot) => void): () => void;
}

export interface JobsIpcDeps {
  jobs: JobsPort;
  drops: DropRegistry;
  userData: string;
  /** 01 §6.2 pre-check: true when `llm.provider` can run (a Keychain key, or no key needed). */
  apiKeyReady(): Promise<boolean>;
}

function inside(dir: string, p: string): boolean {
  const rel = path.relative(dir, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 06 §11: a file input must carry an id main minted for a trusted drop or clipboard read; its path
 * is replaced by main's own, so a renderer path is never read. Staged pastes must sit in their own
 * chip folder of the request's draft (03 §13). Anything else is forged. Returns the resolved request.
 */
export function authorizeInputs(req: StartJobRequest, o: { drops: DropRegistry; userData: string }): StartJobRequest {
  const inputs = req.inputs.map((input) => {
    if (input.kind === 'file') {
      const registered = o.drops.resolve(input.id);
      if (registered === undefined) {
        log.warn('ipc.forbidden-input', { channel: IPC.jobs.start, sourceKind: 'file' });
        fail('E_FORBIDDEN', 'Add files by dropping or pasting them');
      }
      return { ...input, path: registered };
    }
    if (input.kind === 'text' || input.kind === 'image') {
      const chip = req.draftId ? path.join(draftDir(o.userData, req.draftId), input.id) : undefined;
      if (!chip || !inside(chip, input.stagedPath)) {
        log.warn('ipc.forbidden-input', { channel: IPC.jobs.start, sourceKind: input.kind });
        fail('E_FORBIDDEN', 'That pasted item is no longer available');
      }
    }
    return input;
  });
  return { ...req, inputs };
}

/** `eli5:jobs:*` invokes (06 §11). The `changed` event is wired by registerIpc. */
export function registerJobsIpc(on: Register, d: JobsIpcDeps): void {
  on(IPC.jobs.start, StartJobRequestSchema, async (req): Promise<{ jobId: string }> => {
    // Order: shape, then sources (06 §5.1), then who may read them, then the key (01 §6.2).
    if (req.inputs.length === 0) fail('E_BAD_REQUEST', 'Add at least one source');
    const resolved = authorizeInputs(req, d);
    if (!(await d.apiKeyReady())) throw new IpcFailure(NO_API_KEY);
    const r = await d.jobs.start(resolved);
    d.drops.consume(resolved.inputs.flatMap((i) => (i.kind === 'file' ? [i.id] : [])));
    return r;
  });
  on(IPC.jobs.list, NoPayload, (): JobSnapshot[] => d.jobs.list());
  on(IPC.jobs.cancel, JobIdPayload, (p) => d.jobs.cancel(p.jobId));
  on(IPC.jobs.retry, JobIdPayload, (p) => d.jobs.retry(p.jobId));
  on(IPC.jobs.dismiss, JobIdPayload, (p) => d.jobs.dismiss(p.jobId));
}
