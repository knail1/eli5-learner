import { SyncStoreStub } from './stub-base';

/**
 * `google-drive-folder` (16 §4.1, documented stub): the same flat layout in a visible Drive folder
 * under the `drive.file` scope. It is the fallback if gate G1 (16 §13) shows that the desktop and
 * Android clients do not share the app-data folder; then this stub is implemented and becomes the
 * default store. Until then every call throws `NotAvailableInEdition` (HOOK-SYNC-01).
 */
export class DriveFolderStoreStub extends SyncStoreStub {
  readonly id = 'google-drive-folder';
}
