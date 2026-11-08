import { z } from 'zod';
import { IPC } from '../../preload/contract';
import type { SyncService } from '../sync';
import { NoPayload, type Register } from './handle';

/** Google downloads a Desktop client JSON of well under 1 KB; `parseClientJson` caps it at 16 KiB. */
const ClientPayload = z
  .object({
    json: z
      .string()
      .min(2)
      .max(16 * 1024),
  })
  .strict();

/**
 * `eli5:sync:*` (16 §8, 01 §5.2). App window only: none is in VIEWER_CHANNELS, so the viewer gets
 * E_FORBIDDEN from the sender check. Answers are `SyncStatus` or void; the client JSON travels one
 * way and no token or client value is ever returned. The changed event is wired by registerIpc.
 */
export function registerSyncIpc(on: Register, d: { sync: SyncService }): void {
  on(IPC.sync.status, NoPayload, () => d.sync.status());
  on(IPC.sync.setClient, ClientPayload, (p) => d.sync.setClient(p.json));
  on(IPC.sync.clearClient, NoPayload, () => d.sync.clearClient());
  on(IPC.sync.signIn, NoPayload, () => d.sync.signIn());
  on(IPC.sync.signOut, NoPayload, () => d.sync.signOut());
  on(IPC.sync.now, NoPayload, () => d.sync.now());
  on(IPC.sync.makePrimary, NoPayload, () => d.sync.makePrimary());
  on(IPC.sync.deleteRemote, NoPayload, () => d.sync.deleteRemote());
}
