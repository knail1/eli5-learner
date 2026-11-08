/**
 * The sync service behind `eli5:sync:*` (16 §8, 01 §5.2): Settings > Sync and the sidebar indicator
 * talk to the engine and the Google sign-in only through this. Every answer is a `SyncStatus`, which
 * carries no client value, token or document content; the client JSON is write-only.
 *
 * When the sync policy does not allow sync (HOOK-SYNC-01) every call fails with
 * `NotAvailableInEdition`, which is how the renderer knows to hide the section.
 */
import type { SyncStatus } from '../../preload/contract';
import { SettingsError } from '../config';
import { NotAvailableInEdition, type Edition } from '../editions';
import { log } from '../security';
import type { SyncEngine } from './engine';
import type { GoogleOAuth } from './google/oauth';
import type { SyncStateStore } from './state';
import { SYNC_ERROR_TEXT, SyncError, type SyncErrorCode, type SyncPolicy } from './types';

export interface SyncService {
  status(): Promise<SyncStatus>;
  /** Validates and stores the Desktop client JSON in the Keychain; never echoes it. */
  setClient(json: string): Promise<SyncStatus>;
  clearClient(): Promise<SyncStatus>;
  /** The loopback consent in the system browser (16 §3.2); needs Sync on. */
  signIn(): Promise<SyncStatus>;
  signOut(): Promise<SyncStatus>;
  /** "Sync now": starts a full pass and returns at once; progress arrives as `changed`. */
  now(): Promise<void>;
  makePrimary(): Promise<SyncStatus>;
  /** "Delete cloud copy" (16 §4.7): every file in the store, then Sync off. The library is untouched. */
  deleteRemote(): Promise<void>;
  onChanged(cb: (s: SyncStatus) => void): () => void;
}

export interface SyncServiceDeps {
  engine: Pick<
    SyncEngine,
    'status' | 'checkAuth' | 'refresh' | 'syncNow' | 'makePrimary' | 'deleteRemote' | 'onStatus' | 'stop'
  >;
  oauth: Pick<GoogleOAuth, 'setClient' | 'clearClient' | 'signIn' | 'signOut'>;
  state: Pick<SyncStateStore, 'load' | 'update' | 'current'>;
  policy(): Pick<SyncPolicy, 'allowed'>;
  /** `syncActive`: `sync.enabled` and the policy allows it. */
  active(): boolean;
  edition: Edition;
  /** Sets `sync.enabled` to false (after "Delete cloud copy"). */
  disable(): Promise<void>;
  /**
   * `sync.enabled` can be switched off (not locked by managed config). "Delete cloud copy" is
   * refused up front otherwise: a wipe that cannot turn Sync off would be pushed straight back.
   */
  canDisable(): boolean;
}

/** User text for a sync failure at the IPC boundary; module detail never leaves main (01 §5.1). */
export function syncErrorMessage(code: SyncErrorCode, message: string): string {
  switch (code) {
    // These come from `google/oauth.ts` and are written for the user (no values, no URLs).
    case 'E_SYNC_AUTH':
    case 'E_SYNC_NOT_CONFIGURED':
      return message;
    case 'E_SYNC_DISABLED':
      return 'Turn on Sync first';
    case 'E_SYNC_ABORTED':
      return 'Sync was stopped';
    default:
      return SYNC_ERROR_TEXT[code] ?? 'Sync could not finish. Try again in a moment';
  }
}

export function createSyncService(d: SyncServiceDeps): SyncService {
  /** The "Delete cloud copy" in flight: a second request joins it; "Sync now" waits it out. */
  let wiping: Promise<void> | undefined;
  const allowed = (): void => {
    if (!d.policy().allowed) throw new NotAvailableInEdition('sync', 'HOOK-SYNC-01', d.edition);
  };
  /** The engine's status with the Keychain state re-read; loads the local state only while active. */
  const fresh = async (): Promise<SyncStatus> => {
    if (d.active()) await d.state.load();
    return d.engine.checkAuth();
  };
  /** Drops the account label when the grant goes; never creates the state file. */
  const forgetAccount = async (): Promise<void> => {
    let had = false;
    try {
      had = d.state.current().account !== undefined;
    } catch {
      return; // not loaded: sync never ran this session, nothing shown
    }
    if (had) {
      await d.state.update((s) => {
        s.account = undefined;
      });
    }
  };

  return {
    async status() {
      allowed();
      return fresh();
    },
    async setClient(json) {
      allowed();
      await d.oauth.setClient(json);
      log.info('sync.client-saved', { step: 'set-client' });
      d.engine.refresh();
      return fresh();
    },
    async clearClient() {
      allowed();
      await d.oauth.clearClient();
      await forgetAccount();
      d.engine.refresh();
      return fresh();
    },
    async signIn() {
      allowed();
      if (!d.active()) throw new SyncError('E_SYNC_DISABLED');
      const { account } = await d.oauth.signIn();
      await d.state.update((s) => {
        s.account = account;
      });
      d.engine.refresh();
      return fresh();
    },
    async signOut() {
      allowed();
      await d.oauth.signOut();
      await forgetAccount();
      d.engine.refresh();
      return fresh();
    },
    async now() {
      allowed();
      if (!d.active()) throw new SyncError('E_SYNC_DISABLED');
      // During "Delete cloud copy" a pass would push the library back before Sync goes off.
      if (wiping) return;
      void d.engine.syncNow().catch(() => {}); // the outcome arrives as `changed`
    },
    async makePrimary() {
      allowed();
      if (wiping) throw new SyncError('E_SYNC_ABORTED');
      await d.engine.makePrimary();
      return fresh();
    },
    async deleteRemote() {
      allowed();
      if (!d.active()) throw new SyncError('E_SYNC_DISABLED');
      if (wiping) return wiping;
      if (!d.canDisable()) {
        throw new SettingsError('E_SETTINGS_LOCKED', 'This setting is managed by your organization', [
          { path: 'sync.enabled', message: 'locked' },
        ]);
      }
      wiping = (async () => {
        // No pass may start between the wipe and switching sync off, or it would push everything back.
        d.engine.stop();
        try {
          await d.engine.deleteRemote();
        } catch (err) {
          d.engine.refresh(); // nothing was switched off: syncing resumes and the user can try again
          throw err;
        }
        await d.disable();
      })();
      try {
        await wiping;
      } finally {
        wiping = undefined;
      }
    },
    onChanged(cb) {
      return d.engine.onStatus(cb);
    },
  };
}
