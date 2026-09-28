import { z } from 'zod';
import {
  IPC,
  type PublicationRecord,
  type PublishProgressEvent,
  type PublishResult,
  type PublishTarget,
} from '../../preload/contract';
import { fail, type Register } from './handle';
import { SlugPayload } from './schemas';

type Unsub = () => void;

/** A progress event as the service emits it: a failure carries the thrown error, mapped here. */
export type PublishServiceProgress = Omit<PublishProgressEvent, 'error'> & { error?: unknown };

/**
 * Publish service (10 §4, §7), implemented by the publishing slice (src/main/publish/service.ts).
 * Throw PublishError, NotAvailableInEdition or IpcFailure; the boundary maps them.
 */
export interface PublishService {
  /** `eli5:publish:targets`: every registered target, stubs with available:false (10 §4). */
  targets(slug: string): Promise<PublishTarget[]>;
  /** `eli5:publish:run` (10 §4 runPublish). */
  run(slug: string, targetId: string): Promise<PublishResult>;
  /** `eli5:publish:history`: newest first. */
  history(slug: string): Promise<PublicationRecord[]>;
  /** `eli5:publish:cancel`: aborts ctx.signal; no-op if not running. */
  cancel(slug: string, targetId: string): Promise<void>;
  /** `eli5:publish:copy-link`: clipboard.writeText in main (10 §7 step 2). */
  copyLink(url: string): Promise<void>;
  /** `eli5:publish:open-link`: https, or file: inside publish.local.dir (10 §7 step 3). */
  openLink(url: string): Promise<void>;
  /** `eli5:publish:reveal`: shell.showItemInFolder for a file: link inside publish.local.dir. */
  reveal(url: string): Promise<void>;
  /** Pushed to the app as `eli5:publish:progress`. */
  onProgress(cb: (e: PublishServiceProgress) => void): Unsub;
}

/** Publisher ids: 'local', 'drive', 'git', or an overlay id (10 §3.1). */
const TargetId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SlugTarget = z.object({ slug: SlugPayload.shape.slug, targetId: TargetId });
const LinkUrl = z.object({
  url: z
    .string()
    .max(4096)
    .refine((u) => URL.canParse(u), 'Invalid URL'),
});

/** 10 §7: which schemes each link action may take; the service applies the folder check. */
function allowScheme(url: string, schemes: readonly string[]): void {
  if (!schemes.includes(new URL(url).protocol)) fail('E_FORBIDDEN', 'That link cannot be opened');
}

/** `eli5:publish:*` invokes (10 §6). The progress event is wired by registerIpc. */
export function registerPublishIpc(on: Register, d: { publish: PublishService }): void {
  on(IPC.publish.targets, SlugPayload, (p) => d.publish.targets(p.slug));
  on(IPC.publish.run, SlugTarget, (p) => d.publish.run(p.slug, p.targetId));
  on(IPC.publish.history, SlugPayload, (p) => d.publish.history(p.slug));
  on(IPC.publish.cancel, SlugTarget, (p) => d.publish.cancel(p.slug, p.targetId));
  on(IPC.publish.copyLink, LinkUrl, (p) => {
    allowScheme(p.url, ['https:', 'file:']);
    return d.publish.copyLink(p.url);
  });
  on(IPC.publish.openLink, LinkUrl, (p) => {
    allowScheme(p.url, ['https:', 'file:']);
    return d.publish.openLink(p.url);
  });
  on(IPC.publish.reveal, LinkUrl, (p) => {
    allowScheme(p.url, ['file:']);
    return d.publish.reveal(p.url);
  });
}
