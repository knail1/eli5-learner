import type { CapabilityRegistry } from '../editions';
import { DRIVE_APPDATA_STORE_ID, DriveAppDataStore } from './stores/drive-appdata';
import { DriveFolderStoreStub } from './stores/drive-folder.stub';
import { DropboxStoreStub } from './stores/dropbox.stub';
import { WebDavStoreStub } from './stores/webdav.stub';
import { DEFAULT_SYNC_POLICY } from './types';

/**
 * Public-build sync capabilities (16 §4.1; hooks HOOK-SYNC-01/02). Registering makes no request:
 * a store is only built when sync is on (`connect.ts`).
 */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerSyncStore(DRIVE_APPDATA_STORE_ID, (ctx) => DriveAppDataStore.fromContext(ctx)); // shipped
  reg.registerSyncStore('google-drive-folder', () => new DriveFolderStoreStub()); // G1 fallback
  reg.registerSyncStore('dropbox', () => new DropboxStoreStub());
  reg.registerSyncStore('webdav', () => new WebDavStoreStub());
  reg.registerSyncPolicy(DEFAULT_SYNC_POLICY); // HOOK-SYNC-01/02
}
