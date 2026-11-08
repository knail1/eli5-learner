// Public entry of src/main/sync (16): optional personal sync with the Android companion.
export type {
  AccessTokenSource,
  GoogleClient,
  RemoteChange,
  RemoteFile,
  RemoteProps,
  ResumableSession,
  ResumableSessionStore,
  SyncClientSource,
  SyncErrorCode,
  SyncKind,
  SyncPolicy,
  SyncStore,
  SyncStoreContext,
  SyncStoreFactory,
} from './types';
export { DEFAULT_SYNC_POLICY, SYNC_ERROR_TEXT, SYNC_KINDS, SyncError } from './types';
export {
  GoogleOAuth,
  parseClientJson,
  buildConsentUrl,
  pkcePair,
  SYNC_SCOPES,
  DRIVE_APPDATA_SCOPE,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_REVOKE_URL,
} from './google/oauth';
export type { GoogleOAuthDeps } from './google/oauth';
export { DriveClient, DRIVE_API, DRIVE_UPLOAD_API, MULTIPART_MAX_BYTES, RESUMABLE_CHUNK_BYTES } from './google/drive';
export { DriveAppDataStore, DRIVE_APPDATA_STORE_ID, sha256Hex } from './stores/drive-appdata';
export { GuardedStore, GC_FOREIGN_KINDS } from './stores/guard';
export type { GuardOptions } from './stores/guard';
export { DriveFolderStoreStub } from './stores/drive-folder.stub';
export { DropboxStoreStub } from './stores/dropbox.stub';
export { WebDavStoreStub } from './stores/webdav.stub';
export { SyncStateStore, SyncStateSchema, freshState, SYNC_STATE_FILE } from './state';
export type { SyncState, SyncDocState } from './state';
export { openSyncStore, syncActive } from './connect';
export { SyncEngine, PUSH_DEBOUNCE_MS, GC_INTERVAL_MS, FOCUS_POLL_GAP_MS, MAX_JSON_BYTES } from './engine';
export type { SyncEngineDeps, SyncLibrary, EngineTimers } from './engine';
export { Heartbeat, HEARTBEAT_MS, seenNow } from './heartbeat';
export {
  selectHistory,
  buildTree,
  buildDocEntry,
  buildManifest,
  remoteLabel,
  placementOf,
  RECENT_SNAPSHOTS,
  ALL_MAX_SNAPSHOTS,
  ALL_MAX_BYTES,
} from './manifest';
export type { HistoryMode, CurrentVersion } from './manifest';
export {
  decideRole,
  claimRefs,
  claimName,
  newestClaim,
  nextClaimMs,
  staleClaims,
  compareClaims,
  TAKEOVER_SILENCE_MS,
} from './claims';
export type { ClaimRef, ClaimRole, DeviceView } from './claims';
export { planGc, GC_ABSENT_DOC_MS, GC_UNSELECTED_BLOB_MS, GC_TERMINAL_JOB_MS, GC_PHONE_SILENT_MS } from './gc';
export type { GcInput, GcDoc, GcDeletion } from './gc';
export { registerPublic } from './register';
