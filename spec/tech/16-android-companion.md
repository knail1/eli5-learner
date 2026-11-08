# 16 · Android companion and personal sync

This file covers the optional Android companion app and the optional personal sync that links it to
the desktop app. It owns `android/` (the whole Android project) and `src/main/sync/` (the desktop
sync module). It implements the PRD section "Optional personal sync and Android companion (v2
amendment)".

Status: M5, specified and being built in slices (build order in [README.md](./README.md)). Everything
that touches the real Google Drive (cross-client visibility of the app-data folder, change feeds, the
consent flows) is **unverified until gate G1** (§13) runs with a real Cloud project. Until then the
sync code is built and tested against the in-memory fake Drive and the `SyncStore` contract suite
(§12) only. The desktop sync engine (§4.5–§4.7: push, claims, heartbeat, garbage collection) was
built ahead of G1 against the fake store, because G1 needs the owner's Cloud project; it must not be
trusted with a real Drive until G1 passes, and a G1 failure moves it to the `google-drive-folder`
store as §13 says. The same holds for Settings > Sync, the sidebar indicator and `eli5:sync:*`
(§8): built and tested end to end against the in-memory store and a stand-in for Google's
endpoints, unverified against a real Google account until G1.

Related: [01-architecture.md](./01-architecture.md) · [06-generation-pipeline.md](./06-generation-pipeline.md) ·
[07-output-document.md](./07-output-document.md) · [08-interactive-reading.md](./08-interactive-reading.md) ·
[09-library-storage.md](./09-library-storage.md) · [10-publishing.md](./10-publishing.md) ·
[11-app-shell-ui.md](./11-app-shell-ui.md) · [12-configuration-security.md](./12-configuration-security.md) ·
[13-testing-quality.md](./13-testing-quality.md) · [hooks.md](./hooks.md)

## 1. Principles

1. **Opt-in, off by default.** The public desktop build still runs with nothing but an LLM API key.
   Sync, the Google sign-in and the phone inbox do nothing until the user turns them on in
   Settings > Sync.
2. **The desktop is the only generator.** Documents are generated, regenerated, merged and checked
   out only on the desktop, with the key held in the macOS Keychain. The phone reads, captures and
   asks the desktop to do work. The phone never holds an LLM key in this version.
3. **No backend.** Sync uses the user's own Google Drive as a plain object store. There is no server
   owned by the project, no webhook and no push channel. Both apps poll.
4. **One writer per remote file.** Google Drive REST v3 offers no conditional write (no `If-Match`,
   no `412`). So every remote file has exactly one writer (§4.2). Merge conflicts cannot occur by
   construction, and no part of the design depends on compare-and-swap.
5. **The desktop disk is the master copy.** The remote store is a mirror plus a mailbox. If the
   remote data is wiped, the desktop rebuilds it with a full push. The phone's data is a cache.
6. **Fire-and-forget holds across devices.** A job sent from the phone never asks a question back.
   Failed sources are skipped and listed in the document's references, as in 06.
7. **Untrusted on both ends.** The desktop treats every job file as untrusted input. The phone
   treats every document as untrusted HTML (12 §9).
8. **No secrets in the repository or the APK.** OAuth client values, refresh tokens, signing keys and
   `local.properties` are configured locally and never committed (§11).
9. **Sync is not publishing.** It does not use the `Publisher` seam, the cloud drive publisher
   (HOOK-PUB-01), the dormant `publish.drive.*` keys, or the `AuthBroker` (`eli5:auth:*`). Those
   stay reserved for the enterprise binding, and publishing stays user-triggered (10 §1).

## 2. Scope

**In this version**

- Android app: offline library, a read-only reader for the self-contained `index.html`, import of
  exported documents, a read-only version tree with "Make current on your Mac", a share-sheet
  capture that queues a job for the desktop, an Inbox with job status, Settings.
- Desktop: Settings > Sync, Google sign-in in the system browser, push of the library to the remote
  store, a job inbox that feeds the existing pipeline, a sync indicator.
- One desktop ("primary") writes. A second desktop that signs in becomes a read-only mirror of status
  until the user makes it primary (§4.6).

**Not in this version**

- Generation, Ask, or section actions run on the phone. The document's own selection menu on the
  phone (the `window.eli5Doc` bridge). Phone-side organization changes (move, archive, trash, rename).
- "Add to an existing learning" from the phone (merges need confirmation on the desktop).
- A second desktop that pulls and materializes documents.
- End-to-end encryption, push notifications, a visible Drive folder, Dropbox, WebDAV or Firebase
  stores (documented stubs only), Play Store distribution.

## 3. Identity and authorization

### 3.1 One Cloud project, three clients

The user (or the person building the app) creates one Google Cloud project, enables the Google
Drive API, and creates these OAuth clients in it:

| Client type | Used by | Identified by |
| --- | --- | --- |
| Desktop app | desktop sync | client ID and client secret, entered at runtime |
| Android | debug APK | application ID + SHA-1 of the debug signing key |
| Android | release APK | application ID + SHA-1 of the release signing key |

All clients must be in the **same project**. Drive treats the project as one app, and the hidden
app-data folder belongs to the project, not to a client. Clients in different projects see
different, empty folders.

Scopes: `openid`, `email`, `https://www.googleapis.com/auth/drive.appdata`. All three are
non-sensitive. The app never requests `drive`, `drive.readonly` or `drive.metadata*`; those are
restricted scopes.

The consent screen starts in **Testing** with the user listed as a test user. In Testing, the
desktop's refresh token and the Android grant expire after 7 days. The setup guide tells the user to
move the project to **In production** once the spike (§13 gate G1) passes. Non-sensitive scopes need
no verification. Google may still show an "unverified app" notice; the guide says so rather than
promising a clean screen. No logo is uploaded, because a logo triggers brand verification.

### 3.2 Desktop (Electron)

`src/main/sync/google/oauth.ts` implements the installed-app flow (RFC 8252):

1. Start an `http.Server` on `127.0.0.1`, port `0` (ephemeral). Build the authorization URL with
   PKCE S256, a random `state`, `access_type=offline`, `include_granted_scopes=true`, and the
   scopes above. Add `prompt=consent` only when no refresh token is stored (keeps under the
   100-refresh-tokens-per-client limit).
2. Open the URL with `shell.openExternal` (a new entry in 12 §7.5). Never in a `BrowserWindow`.
3. Accept exactly one `GET /callback` whose `state` matches. Reply with a short static page that
   says "You can close this tab". Close the server. Time out after 5 minutes or on the abort signal.
4. Exchange the code with `client_id`, `client_secret` and `code_verifier`. Google treats a desktop
   client secret as non-confidential, but the app still never commits or compiles it (§11).
5. Store the refresh token in the Keychain. Keep the access token in memory only and refresh it 5
   minutes before `expires_in`.
6. On `invalid_grant`, delete the refresh token and set the sync state to `signed-out` with the
   message "Sign in again to keep syncing". Causes include revocation, 6 months unused, the Testing
   7-day expiry, and the refresh-token cap.
7. Account label: `GET https://openidconnect.googleapis.com/v1/userinfo` (email only). It is a
   display hint, not a security boundary.

<!-- hook:HOOK-SYNC-02 -->
> **Private hook · HOOK-SYNC-02 · OAuth client source.** Public behavior: the user pastes or drops the downloaded Desktop client JSON in Settings > Sync, and the app stores it in the Keychain; in development it may be seeded from `ELI5_GOOGLE_CLIENT_ID` and `ELI5_GOOGLE_CLIENT_SECRET`. Private binding supplies: a managed client source (or none, with sync disabled). Binding lives in the private spec under "HOOK-SYNC-02".

New `KeyAccount` values (12 §6): `'sync.google.client'` (JSON `{clientId, clientSecret}`) and
`'sync.google.refreshToken'`. They are public accounts rather than `ext.*` because the public build
uses them. Neither value ever crosses IPC; `setClient` is write-only and `status` reports only
`configured: boolean`.

### 3.3 Android

The app uses only `com.google.android.gms:play-services-auth` `AuthorizationClient`:

- `Identity.getAuthorizationClient(context).authorize(AuthorizationRequest)` with the three scopes.
  If the result `hasResolution()`, the UI launches its `pendingIntent` through
  `StartIntentSenderForResult` and reads `getAuthorizationResultFromIntent`. Otherwise it uses
  `accessToken` (about 1 hour).
- `authorize()` is called before every sync. Google Play services refreshes silently while consent
  stands. The app stores **no refresh token, no client ID and no secret**. The Android client is
  matched by application ID + signing SHA-1.
- On HTTP 401 or `IllegalStateException`: `clearToken(ClearTokenRequest)`, then authorize once more.
  A second failure sets `AuthState.NeedsReconnect`. Between syncs a token from `authorize()` is
  reused for at most 10 minutes, in memory only. The app persists only "connected", the account
  email (a display hint, from the grant or OpenID userinfo) and "needs reconnect", in DataStore.
- Background work (`WorkManager`) never shows consent. If `authorize()` needs a resolution, the
  worker sets `NeedsReconnect`, stops without retrying, and the Library shows the persistent banner
  "Sign in again to keep syncing". Reading keeps working.
- Disconnect: `revokeAccess(RevokeAccessRequest)` (revokes all the app's scopes), then offer to
  delete downloaded data.
- Not used: Credential Manager, a Web client ID, `requestOfflineAccess`, the removed `GoogleSignIn`
  APIs, `google-services.json`.

## 4. Remote store

### 4.1 `SyncStore` port

```ts
// src/main/sync/types.ts
export interface SyncStore {
  readonly id: string;                       // 'google-drive-appdata'
  list(q: { kind?: SyncKind; docId?: string }): Promise<RemoteFile[]>;   // paged internally
  startToken(): Promise<string>;
  changes(token: string): Promise<{ changes: RemoteChange[]; nextToken: string }>; // throws E_SYNC_TOKEN on 410
  get(fileId: string, signal?: AbortSignal): Promise<Uint8Array>;
  generateIds(n: number): Promise<string[]>;
  create(id: string, name: string, props: RemoteProps, body: Uint8Array, mime: string): Promise<RemoteFile>;
  update(fileId: string, body: Uint8Array): Promise<RemoteFile>;      // own files only (§4.2)
  touch(fileId: string, props: Partial<RemoteProps>): Promise<void>;  // metadata only, no revision
  delete(fileId: string): Promise<void>;                              // permanent
}
```

Implementations registered by `src/main/sync/register.ts`:

| id | File | Status |
| --- | --- | --- |
| `google-drive-appdata` | `stores/drive-appdata.ts` | shipped (hidden app-data folder, `drive.appdata`) |
| `google-drive-folder` | `stores/drive-folder.stub.ts` | documented stub: same layout in a visible folder under `drive.file`. The fallback if gate G1 fails. |
| `dropbox`, `webdav` | `stores/dropbox.stub.ts`, `stores/webdav.stub.ts` | documented stubs; throw `NotAvailableInEdition` |

The store wrapper (`stores/guard.ts`) enforces §4.2: it refuses `update`, `touch` or `delete` on a
file whose `dev` property is not this device, except the primary's garbage collection of files listed
in §4.7. A refused write is a bug and throws `E_SYNC_OWNERSHIP`.

<!-- hook:HOOK-SYNC-01 -->
> **Private hook · HOOK-SYNC-01 · Cloud sync policy.** Public behavior: personal sync to the user's own Google Drive app-data folder, opt-in and off by default, phone inbox off until enabled. Private binding supplies: whether sync is allowed at all, an organization store in place of the personal one, and which documents (for example ones built from organization sources) are excluded from upload. Binding lives in the private spec under "HOOK-SYNC-01".

A factory receives `SyncStoreContext = { settings, auth: AccessTokenSource, sessions?:
ResumableSessionStore }` and only constructs; nothing is built while sync is off (`connect.ts`
`openSyncStore` returns null), so no request can happen. Besides the plain port methods, the guard
offers `gcDelete(fileId)` (primary only: own files plus foreign `job`, `att`, `cancel`, `device`,
`acks` and `claim` files, §4.7) and `wipe()` ("Delete cloud copy"); it treats a file it has not
seen through `list` or `changes` as foreign.

Registry slots (01 §6.2): `registerSyncStore(id, factory)` (HOOK-SYNC-01) and
`registerSyncPolicy(p: SyncPolicy)` (HOOK-SYNC-01/02), with the public default
`{ allowed: true, excludeDoc: () => false, clientSource: 'user' }`.

### 4.2 Layout and owners

All files live flat in the app-data folder (`parents: ["appDataFolder"]`). Names are cosmetic; Drive
names are not unique. Identity comes from `appProperties` and the cached file id:
`{ k: <kind>, d?: <docId>, s?: <sha256 or id>, dev: <deviceId>, n?: <seq>, seen?: <epoch s> }` (each
key+value at most 124 bytes). `d` is set on `tree` and `blob` files. `s` is the content sha256 on
`blob` and `att` files and the `jobId` on `job`, `cancel` and `status` files. `n` is the `seq` on
`lib` and `tree` files and the claim time in epoch milliseconds on `claim` files, so ordering claims
never downloads one. `seen` is the heartbeat on `device` files (§4.3).

| File | Kind | Writer | Mutability | Content |
| --- | --- | --- | --- | --- |
| `sync-info.json` | `info` | first desktop to bootstrap | written once | `{formatVersion: 1, minReaderVersion: 1, minWriterVersion: 1, createdAt}` |
| `claim-<ms>-<deviceId>.json` | `claim` | a desktop | immutable | `{deviceId, claimedAt}`; the newest claim names the primary (§4.6) |
| `device-<deviceId>.json` | `device` | that device | content rewritten rarely; heartbeat via `touch` | §4.3 |
| `lib-<deviceId>.json` | `lib` | primary | rewritten, `seq` rises | §4.4 |
| `tree-<docId>.json` | `tree` | primary | rewritten, `seq` rises | §4.4 |
| `blob-<sha256>.html.gz` | `blob` | primary | immutable | gzip of one `index.html` snapshot; sha of the uncompressed bytes (09 §4.1) |
| `att-<sha256>.<ext>` | `att` | phone | immutable | a captured attachment |
| `job-<jobId>.json` | `job` | phone | immutable | §5.1 |
| `jobcancel-<jobId>.json` | `cancel` | phone | immutable | `{jobId, at}` |
| `jobstatus-<jobId>.json` | `status` | primary | rewritten | §5.3 |
| `acks-<deviceId>.json` | `acks` | that phone | rewritten | `{terminalJobIds: string[]}` (§4.7) |

Never uploaded: `meta.json`, `catalog.json`, `.versions/tree.json` and node records as-is,
`.eli5/organization.json`, `.eli5/suggestions.json`, `.staging/`, `.trash/`, logs, settings, keys.
The manifest and trees are **derived, sanitized** views (§4.4).

`jobId` is a UUIDv7. `deviceId` is a UUIDv4 minted locally on first sync and stored in local sync
state; it is not a credential.

### 4.3 Device file

```ts
type DeviceRecord = {
  v: 1; deviceId: string; platform: 'macos' | 'android'; name: string; appVersion: string;
  role: 'primary' | 'mirror' | 'phone';
  accepts: Array<'capture' | 'checkout' | 'ask'>;   // desktop only: job kinds it runs today
  inbox: 'on' | 'off' | 'paused-read-only';           // desktop only
};
```

The heartbeat is `touch(fileId, {seen: <epoch seconds>})` every 5 minutes while the desktop app
runs (window or menu bar) and on each phone sync. A metadata-only update creates no revision.
The phone shows "Your Mac was last seen <relative time>" from the newest primary `seen`, and shows
"Your Mac isn't taking jobs right now" when `inbox` is not `on`. The desktop lists in `accepts` only
the job kinds whose desktop path has shipped (for example, `ask` appears only once the Ask feature in
08 is released); the phone hides actions the primary does not accept.

### 4.4 Manifest and trees (primary only)

```ts
type LibraryManifest = {
  v: 1; seq: number; generatedAt: string;
  folders: Array<{ id: string; name: string }>;
  docs: Array<{
    docId: string; title: string; summary: string; headings: string[];   // from the DocumentModel
    tabs: string[]; createdAt: string; updatedAt: string;
    placement: { kind: 'folder'; folderId: string } | { kind: 'unfiled' | 'archive' | 'trash' };
    currentVersionId: string; currentSha: string; sizeBytes: number; busy: boolean;
    replaces?: string;   // old docId when an id was re-minted (09 §7 step 4, Put Back)
  }>;
};
type VersionTree = {
  v: 1; docId: string; seq: number; currentId: string;
  nodes: Array<{ id: string; parentId: string | null; kind: VersionChangeKind; label: string;
                 createdAt: string; sha: string | null; uploaded: boolean }>;
};
```

- `manifest.ts` builds both from `library.list()`, `library.versions(slug)` and the organization
  view, through the library facade only. It reads `meta.json` only to copy the allowlisted fields
  above; clarifying input, source names and URLs, reader questions, model and cost data never leave.
- Labels come from the 08 §6.7 label builder. A label never contains a reader's question text;
  "asked about" labels name the section title.
- Remote objects are keyed by `DocumentMeta.id`, never by slug. A re-minted id appears as a new
  entry with `replaces`; the old entry is dropped.
- Readers ignore a manifest or tree whose `seq` is not greater than the one they hold.
- `busy` mirrors the 08 locks so the phone can say "Your Mac is updating this document".

### 4.5 Push (primary desktop)

Trigger: bootstrap subscribes `library.on('changed' | 'organization' | 'moved')` to
`sync.schedulePush()`, debounced 5 s. Also on sign-in, on enable, and every poll as a safety net.

1. Diff the library against `<userData>/sync/state.json` (atomic write, mode 0600):
   `{deviceId, primary, startToken, manifestSeq, docs: {docId: {treeSeq, uploadedShas[], fileIds}},
   pendingCreates: {name: preallocatedId}, resumable: {fileId: {uri, startedAt, size, sha256}},
   inbox: {...}}`. A session resumes only for the same bytes (size and sha256) and only on Drive's
   upload endpoint.
   Sync state never goes into `meta.json`, so a push never changes `updatedAt` or catalog order.
   `pendingCreates` is keyed by a create key (`<role>` or `doc:<docId>:<role>`), not the file name,
   because two documents can hold blobs with the same sha. Per document the state also keeps the
   tree's root version id (to recognize a re-minted id), the last pushed current version (id, sha,
   size, headings, so headings are parsed once per sha), content hashes of the last tree, manifest
   and device record written (unchanged files are not rewritten), and the Trash and GC bookkeeping of
   §4.7.
2. Upload missing blobs for each document's versions selected by `sync.history`:
   `'current'`, `'recent'` (default: the 10 newest snapshots that still have blobs), or `'all'`
   (bounded by the 09 caps: 60 snapshots, 48 MiB, 300 nodes). Blob bytes are read under
   `withDocLock(slug)` only long enough to copy html and sha as a consistent pair.
3. Rewrite changed `tree-<docId>.json` (seq + 1), then `lib-<deviceId>.json` (seq + 1). Order is
   always blobs, then trees, then manifest, so a reader never sees a reference to a blob that was
   not uploaded first. A reader that still cannot see a blob (Drive listing is eventually
   consistent) retries on its next pass without an error. A new `seq` is one more than the larger
   of this device's last `seq` and the highest `n` of any `lib` (or that document's `tree`) file in
   the store, so after a takeover the new primary's files continue above the old primary's.
   Documents in the desktop Trash stay in the manifest with placement `trash` and keep their blobs
   until they are purged (a Trash entry stays in every later manifest until then; a document that
   leaves the manifest while it was in the Trash counts as purged). A document with a section job in flight is listed with `busy: true` and
   is re-read only after the job ends. A re-minted id is detected by its version tree's root id: a
   new docId whose tree root matches a document that left the library gets `replaces`.
4. Creates call `generateIds` first and persist the id before uploading, so a retried create never
   duplicates. Bodies of 5 MiB or less use multipart upload; larger ones use resumable upload in
   8 MiB chunks with the session URI persisted (valid one week). After upload, the returned
   `sha256Checksum` must match; a mismatch deletes the file and retries. A retried create that
   finds the id holding a file with other identity properties fails with `E_SYNC_OWNERSHIP` and
   leaves that file alone. Every request attempt has a deadline (60 s; 5 min per resumable chunk).
5. Errors: 403 `userRateLimitExceeded`, 429 and 5xx retry with exponential backoff and full jitter,
   capped at 64 s. Sync never blocks generation. A failed push stays pending in `state.json`.
6. Sync does not start, and stops, while the library is read-only (09 §8.5), while signed out, or
   while `sync-info.json` has a `formatVersion` major (or `minWriterVersion`) this app does not
   know. In those states the app never deletes anything remotely. With an unknown format it writes
   nothing at all; a `sync-info.json` whose version fields cannot be read counts as unknown (the
   check reads only the version fields, so a newer format's extra fields do not hide it). While the library is read-only it still keeps its own device file current (with
   `inbox: 'paused-read-only'`, so the phone can say why) and its heartbeat, and pushes nothing.

### 4.6 Primary desktop

- The first desktop to enable sync writes `sync-info.json` and `claim-<ms>-<deviceId>.json`.
- The primary is the device of the newest claim (`ms`, then `deviceId` as tie-break).
- A second desktop that signs in sees an existing claim, writes its device file with
  `role: 'mirror'`, and only shows status. Settings offers "Make this Mac the primary". That writes a
  new claim, then waits until the old primary's device file shows `role: 'mirror'` or its `seen` is
  older than 15 minutes, and only then pushes. The old primary checks claims on every poll and stops
  writing as soon as it sees a newer one. Both steps write only files the writing device owns.
- A device that never wrote a device file is judged by its claim time for the 15 minutes. Until it
  has taken over, a claiming device describes itself as `role: 'mirror'`. Besides the previous claim
  holder, the new claimer also waits for any older claimer whose device file still says `primary`
  and that was seen in the last 15 minutes (it may not have seen the newer claims yet).
- After a takeover, the old primary's `lib`, `tree` and `blob` files stay in the store: no other
  device may delete them (§4.2), and readers follow the newest claim's device. "Delete cloud copy"
  clears them.

### 4.7 Garbage collection (primary only)

The app-data folder has no trash; delete is permanent. Only the primary deletes, only when it is in
a normal state (§4.5 step 6), and only:

- blobs and trees of documents purged from the desktop Trash (09 §4.2) or absent from the manifest
  for more than 30 days;
- blobs no longer selected by `sync.history` for more than 7 days;
- `job`, `att`, `cancel` and `status` files of a job that is terminal **and** listed in the
  sender's `acks-<deviceId>.json`, or terminal for more than 30 days regardless;
- device files and acks of phones not seen for 180 days; claims older than the newest one.

A job is terminal when the primary's own `jobstatus` file says `done`, `failed`, `rejected` or
`cancelled`; the 30 days count from its `updatedAt`. An `att` file goes with the last collected job
that names it; one that no job names is removed 30 days after it was written (a phone that stopped
between the attachment and the job). Collection runs at most every 6 hours, and at once when a
document was purged from the Trash.

Settings > Sync > "Delete cloud copy" deletes every file in the store (paged), then turns Sync off
(`sync.enabled` false), so the next poll does not push everything straight back. If the wipe fails
part way, Sync stays on and the user can try again. While it runs, Sync now is a no-op and a second
request joins the first. When managed config locks `sync.enabled` it is refused up front with
`E_SETTINGS_LOCKED` and nothing is deleted, since a wipe that cannot turn Sync off would be pushed
straight back (the button is disabled with a note). The user can do the same from Google Drive >
Settings > Manage apps > Delete hidden app data. Either way the desktop keeps its library and a
later enable pushes everything again.

### 4.8 Pull (phone; desktop pulls only jobs, cancels, devices and claims)

- Bootstrap or token loss: `files.list` with `spaces=appDataFolder`, `pageSize=1000`, a narrow
  `fields` mask, then `changes.getStartPageToken`.
- Steady state: `changes.list` with `spaces=appDataFolder`, `includeRemoved=true`, `pageSize=1000`
  and `fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,appProperties,sha256Checksum,size,modifiedTime))`.
  Follow `nextPageToken` to the end, apply, then persist `newStartPageToken`. A 410 or invalid token
  triggers a full rescan. Signing out drops the desktop's index and store, so the next sign-in
  (perhaps as another account) starts with a full listing.
- The desktop downloads small JSON files written by other devices (info, device, job, status, acks)
  only up to 4 MiB; a larger or unparsable one is treated as invalid.
- Cadence. Desktop: every `sync.pollSeconds` (default 60) while the app runs, on window focus (at
  most once per 30 s), on `powerMonitor` `resume`, and right after a push. Phone: on app foreground, pull-to-refresh, "Sync
  now", a `WorkManager` periodic request (15 minutes, `NetworkType.CONNECTED`, unique, `KEEP`), and
  expedited one-time work after queueing a job. While a job is pending and the app is in the
  foreground, the phone polls every 30 s.

## 5. Job inbox (phone to desktop)

### 5.1 Job file

```ts
type JobRequest = { v: 1; jobId: string; deviceId: string; createdAt: string } & (
  | { kind: 'capture'; urls: string[]; text: string; clarifyingInput: string; focus: FocusChip[];
      attachments: Array<{ sha: string; name: string; mime: string; size: number }> }
  | { kind: 'checkout'; docId: string; versionId: string }
  | { kind: 'ask'; docId: string; sectionId: string; sectionHash: string; question: string } );
type FocusChip = 'big-picture' | 'how-it-works' | 'numbers' | 'beginner';
```

Limits (both sides enforce): `urls` at most 20, `http:` or `https:` only; `text` at most 20,000
characters; `clarifyingInput` at most 500; attachments at most 10 per job, 20 MiB each, 50 MiB per
job; MIME allowlist = the image, PDF, Office, HTML and plain-text types the desktop resolvers accept
(03), checked by sniffing, not by the declared type; `question` 3 to 500 characters, one line.
Focus chips are appended to the clarifying input as fixed English phrases.

### 5.2 Phone side

1. The share target copies the shared bytes into `filesDir/outbox/<jobId>/` at once (URI grants are
   short-lived). Files over the caps are refused in the sheet with a one-line reason. HEIC stays
   HEIC, because the desktop resolvers accept it.
2. A `JobEntity` is stored as `LOCAL`. An expedited `UploadWorker` uploads each `att-<sha>` that does
   not already exist, then `job-<jobId>.json`, then marks the job `UPLOADED` ("Waiting for your Mac").
3. Cancel: write `jobcancel-<jobId>.json`. The desktop honours it only while the job is not running.
4. After the phone has shown a terminal status, it adds the jobId to its `acks` file.

### 5.3 Desktop side

`src/main/sync/inbox.ts` runs on each pull while `sync.inbox.enabled` is true (default **false**; the
user turns it on in Settings > Sync, which also lists the phones seen).

1. Parse with zod `.strict()`. Reject `v` other than 1, `createdAt` older than 30 days or more than
   1 day in the future, unknown kinds, and kinds missing from this desktop's `accepts`.
2. Dedupe by `jobId` against `<userData>/sync/inbox.json` (durable ledger) and the 06 §9 job store.
   A replay is a no-op.
3. Rate limits per Google account, not per device id (a device id is self-asserted): 30 jobs per
   hour and 100 per day. Over the limit the job is `rejected` with `E_RATE`.
4. Download attachments into `<userData>/sync/inbox/<jobId>/` (0700), verify sha256, sniff the
   type, enforce the caps.
5. Write `jobstatus` `received`, then call the `enqueue` callback that bootstrap injects.
   `src/main/sync` never imports `pipeline` (01 §3).
6. URLs from the inbox go through the 05 public-URL guard with `allowPrivate` **never** set: private,
   loopback and link-local targets are skipped, redirects included. The `inbox` origin is never
   treated as user-typed.

Kinds:

- `capture` becomes `jobs.start({inputs, options: {clarifyingInput}}, {origin: 'inbox'})`, a
  main-side entry that skips the renderer drop-id check (06 §11) because the files were staged by
  main.
- `checkout` runs the 08 §6.7 checkout service. A busy document is retried for 10 minutes, then
  `failed` with `E_CONFLICT` and the 08 text "Your Mac is updating this document; try again in a
  moment".
- `ask` runs the 08 §6.8 Ask path. A `sectionHash` that no longer matches is `failed` with
  `E_STALE` ("This section changed on your Mac"). Inbox asks count against the same per-document
  rate limits as asks made in the app.

```ts
type JobStatus = { v: 1; jobId: string; updatedAt: string;
  state: 'received' | 'queued' | 'running' | 'done' | 'failed' | 'rejected' | 'cancelled';
  stage?: string;                                     // the 06 §6 one-line status
  docId?: string; versionId?: string; skippedSources?: number; anchorId?: string;
  code?: string; reason?: string };                   // reason is the user-facing one-liner
```

Bootstrap maps pipeline events (`stage`, `done`, `failed`) to `sync.reportJob(jobId, …)`. A `done`
inbox job also posts the normal completion notification (11 §14), and the status area shows a
"From phone" chip.

## 6. Android app

### 6.1 Project

- `android/` at the repo root, its own Gradle build, one `:app` module. It never touches the npm
  toolchain. Kotlin, Jetpack Compose with Material 3 and dynamic color, single activity.
- `applicationId` default `io.github.eli5learner`, overridable by the Gradle property
  `ELI5_APPLICATION_ID` so a fork can register its own OAuth clients.
- `minSdk 31`, `compileSdk` the newest stable platform, `targetSdk` one below it if the newest
  brings behaviour changes the app has not been tested with. All versions pinned in
  `gradle/libs.versions.toml` and resolved against the official Maven metadata when the build is set
  up.
- Edge-to-edge with insets everywhere; predictive back through `BackHandler` only; adaptive
  list-detail at width 600 dp and above.
- Manual dependency injection (`AppContainer`), `ViewModel` + `StateFlow`, Room as a cache that can
  always be rebuilt from `filesDir/docs`, DataStore for preferences and sync cursors, WorkManager,
  OkHttp + kotlinx.serialization against Drive REST v3 (no Google API client library).
- Manifest: `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS` (asked after the first capture),
  `android:allowBackup="false"` and data extraction rules that exclude everything.

### 6.2 Screens

| Screen | Content |
| --- | --- |
| Onboarding | Welcome; "Use on this phone only" (import), "Connect Google Drive" (one-line rationale, then authorize); "Waiting for your Mac" until a desktop device file appears. Skippable. |
| Library | Navigation suite with Library, Inbox, Settings. Search, folder chips, rows (title, updated time, offline pin, unread dot), sync icon (synced, syncing, offline/error) that opens a status sheet, pull-to-refresh, empty state. |
| Reader | Full-bleed WebView (§6.3), collapsing bar with title and a version chip, "Updated on your Mac · Reload" banner (never auto-reloads), reading position per document and sha. |
| Versions | Read-only tree, lanes from the Kotlin port of `version-tree-layout.ts`; preview of uploaded versions; "Make current on your Mac" queues a `checkout`; versions without an uploaded blob show "Not available on this phone". |
| Capture | Translucent share target with a bottom sheet: preview, "What do you want to understand?", focus chips, "Send to my Mac". Never waits for the network. |
| Inbox | Jobs with chips: Waiting to upload, Waiting for your Mac, Queued, Generating (stage), Ready, Built · N sources skipped, Failed (reason, Retry, Delete). "Mac last seen" line. |
| Ask | From the Reader overflow, only when the primary accepts `ask`: section picker from the document outline, one-line question. |
| Settings | Account and Disconnect, Sync now, offline policy (All, Recent 20, Pinned), large downloads on Wi-Fi only, Macs seen, storage and Clear cache, Import HTML, Diagnostics (counts only), licenses, About ("Sideloaded build", version, commit). |

Copy follows 11's tone. Offline is a state, not an error: a quiet icon and snackbars with Retry for
transient failures; a persistent banner only for lost authorization.

### 6.3 Reader WebView contract

Documents are LLM-generated HTML and are untrusted.

- Served by `WebViewAssetLoader` from `https://appassets.androidplatform.net/docs/<docId>/<sha>.html`
  through a path handler over `filesDir/docs`. Never `file://`, `data:` or `loadData`.
- Settings: JavaScript on for a valid ELI5 document and off for a foreign file; DOM storage on (the
  runtime keeps its theme in `localStorage`); `allowFileAccess`, `allowContentAccess`,
  `allowFileAccessFromFileURLs`, `allowUniversalAccessFromFileURLs` all false;
  `MIXED_CONTENT_NEVER_ALLOW`; Safe Browsing on; `setSupportMultipleWindows(false)` and
  `javaScriptCanOpenWindowsAutomatically` false, so no window is ever created. Every reference link
  carries `target="_blank"`; with multiple windows off it reaches `shouldOverrideUrlLoading` below
  (with multiple windows on and no `onCreateWindow`, such links would silently do nothing).
- The path handler adds a response `Content-Security-Policy` header:
  `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src <hashes>; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`,
  where `<hashes>` are the sha256 of the document's inline scripts **only if** the file is a valid
  ELI5 document (it contains `<script type="application/json" id="eli5-model">` and its meta CSP
  pins the same hashes). Any other HTML is served with `script-src 'none'` and labelled "Foreign
  file · scripts off".
- `shouldInterceptRequest` answers every request itself and returns 403 for anything outside `/docs/`
  (404 for a missing or hash-mismatched file), so no request reaches the network. `shouldOverrideUrlLoading`
  allows only same-document navigation; an `http(s)` link opens in a Custom Tab only when the
  request has a user gesture; everything else is dropped.
- No `addJavascriptInterface`, and nothing named `eli5Doc`. The runtime's bridge check (08 §4,
  `src/doc-runtime/bridge.ts`) then keeps it in its plain-browser, read-only mode, where tabs,
  glossary, charts, stepper, theme and print work.
- `BackHandler` goes back in WebView history first. The WebView is destroyed when the screen leaves.

### 6.4 Local storage on the phone

- `filesDir/docs/<docId>/<sha>.html`: gunzipped, sha-verified, written atomically. An older sha is
  kept while the Reader shows it.
- Room tables: documents, versions, jobs, attachments, devices, and an FTS table over title,
  summary, headings and the plain text of the embedded model for cached documents.
- Offline policy (default All) decides which current blobs download eagerly. Older versions download
  on demand when previewed. "Large downloads on Wi-Fi only" applies to blobs over 5 MiB.
- Imported documents (§7) live under `filesDir/docs/local-<sha>/` with `source = imported`. A synced
  document with the same `docId` replaces the imported copy.

## 7. Before sync is set up

The APK is useful with no Google setup. "Import HTML" (Settings, onboarding, Library empty state)
uses `ACTION_OPEN_DOCUMENT` for `text/html` (multiple). The share target and an `ACTION_VIEW`
filter for `text/html` also import. The importer reads `docId`, title, tabs and headings from the
embedded model; HTML without one is imported as a foreign file (scripts off, §6.3). Captures can be
composed and wait in the outbox as "Connect Google Drive to send".

Ways to get documents onto the phone: share an exported `index.html` from Files, email or the Drive
app; `adb push`; the public sample on the project's Pages site.

## 8. Desktop changes

- **Module** `src/main/sync/`: `index.ts`, `register.ts`, `types.ts`, `protocol.ts` (zod wire
  schemas, the single source of truth), `google/oauth.ts`, `google/drive.ts` (fetch-based REST
  client), `stores/drive-appdata.ts`, `stores/guard.ts`, the three stubs (sharing
  `stores/stub-base.ts`), `connect.ts` (`syncActive`, `openSyncStore`), `engine.ts` (push, poll,
  GC), `manifest.ts`, `claims.ts`, `heartbeat.ts`, `inbox.ts`, `ledger.ts`, `state.ts`.
  Allowed imports: `library`, `config`, `security`, `editions` (through their `index.ts`).
  Never `pipeline`.
- **Bootstrap** (01 §6.3): create the sync service after the library; wire library events to
  `schedulePush`, the inbox `enqueue` to `jobs.start` with origin `'inbox'`, job events to
  `reportJob`; start polling only when `sync.enabled`, signed in and the library is writable.
- **Contract** (`src/preload/contract.ts`): `IPC.sync = { status: 'eli5:sync:status', setClient:
  'eli5:sync:set-client', clearClient: 'eli5:sync:clear-client', signIn: 'eli5:sync:sign-in',
  signOut: 'eli5:sync:sign-out', now: 'eli5:sync:now', makePrimary: 'eli5:sync:make-primary',
  deleteRemote: 'eli5:sync:delete-remote', changed: 'eli5:sync:changed' }`;

  ```ts
  type SyncStatus = {
    state: 'off' | 'not-configured' | 'signed-out' | 'idle' | 'syncing' | 'error' | 'paused-read-only' | 'mirror';
    configured: boolean; signedIn: boolean; account?: string; lastSyncAt?: string; pendingUploads: number;
    inboxPending: number; devices: Array<{ name: string; platform: 'macos' | 'android'; role: string; lastSeen: string }>;
    message?: string };
  ```
  `SourceOrigin` gains `'inbox'`; `SettingsSection` gains `'sync'`. `VersionChangeKind` gains
  `'sync'`, reserved for a later desktop pull, unused in this version.
  The channels are app-window only (`assertSender`); the viewer gets `E_FORBIDDEN`.
  `signedIn` reports only whether a grant is stored (true also while Sync is off, so Disconnect stays
  reachable); `configured` and `signedIn` are re-read from the Keychain on every status call, with
  no request. The handlers sit in `src/main/ipc/sync.ts` over a `SyncService`
  (`src/main/sync/service.ts`, `createSyncService`). While the sync policy does not allow sync,
  every call fails with `NotAvailableInEdition` (HOOK-SYNC-01), which is how the renderer hides the
  section and the indicator. `sign-in` needs Sync on (`E_SYNC_DISABLED` otherwise), so turning
  Sync on comes first and nothing reaches Google before it. A `SyncError` crosses IPC as
  `E_SYNC_FAILED` with the `SyncErrorCode` in `detailCode` (01 §5.1).
- **Config** (12 §3):
  `sync: z.object({ enabled: z.boolean().default(false), store: z.string().default('google-drive-appdata'), pollSeconds: z.number().int().min(30).max(3600).default(60), history: z.enum(['current','recent','all']).default('recent'), inbox: z.object({ enabled: z.boolean().default(false) }).strict().prefault({}) }).strict().prefault({})`.
- **Renderer** (11): Settings > Sync with the client JSON field (paste or drop; write-only), Connect
  Google Drive / account / Disconnect, history choice, "Accept jobs from phone", Sync now, last sync,
  devices, "Make this Mac the primary", "Delete cloud copy", and the privacy line: "Turning this on
  copies your learnings (not your sources or notes) to a hidden folder in your Google Drive. Google
  can read them." A sidebar footer sync indicator with the same three states as the phone.
- **Guardrails** in the same change: ESLint network allowlist gains `src/main/sync/**`;
  `mainModules` gains `sync`; 12 §7.5 gains the consent URL; 12 §10.1 and principle 6 gain "only with
  Sync on, to your own Drive".

## 9. Privacy

Leaves the desktop, only with Sync on, only to the user's own Drive app-data folder: document HTML
snapshots per `sync.history`, the manifest (titles, summaries, headings, tabs, dates, folder
placement), sanitized version trees, job statuses. Leaves the phone: what the user explicitly
captures or asks. Never leaves: `meta.json` fields outside the allowlist, source files on the
desktop, API keys, tokens, logs. There is no end-to-end encryption; Google can read the files.
Logs on both surfaces record ids, counts and HTTP codes only, never titles, URLs, questions or
tokens.

## 10. Errors

| Code | Where | Meaning and user text |
| --- | --- | --- |
| `E_SYNC_AUTH` | both | grant lost; "Sign in again to keep syncing" |
| `E_SYNC_TOKEN` | both | change token expired; full rescan, no user text |
| `E_SYNC_QUOTA` | both | Drive storage full; "Your Google Drive is full" |
| `E_SYNC_FORMAT` | both | remote format newer; read-only, "Update ELI5 Learner to keep syncing" |
| `E_SYNC_OWNERSHIP` | desktop | refused write to a file owned by another device (bug) |
| `E_RATE` | desktop inbox | over the inbox limit |
| `E_CONFLICT`, `E_STALE` | desktop inbox | §5.3 |
| `E_ATTACHMENT` | desktop inbox | attachment missing, wrong sha, wrong type or too large |

Internal codes without user text of their own (desktop, `SyncError`): `E_SYNC_DISABLED` (sync off
or not allowed; no request made), `E_SYNC_NOT_CONFIGURED` (no OAuth client; "Add your Google client
in Settings > Sync"), `E_SYNC_NOT_FOUND` (HTTP 404), `E_SYNC_CHECKSUM` (an upload's reported sha256
did not match; the file is deleted and the push retries with a new id), `E_SYNC_HTTP` (other
failures after retries) and `E_SYNC_ABORTED`.

## 11. Secrets and repository hygiene

- Never committed: the Desktop client JSON or its values, refresh tokens, `local.properties`,
  `keystore.properties`, `*.jks`, `*.keystore`, `google-services.json`, `client_secret*.json`,
  APK and AAB files.
- Committed: `android/local.properties.example` (key names only), `.env.example` names
  `ELI5_GOOGLE_CLIENT_ID` and `ELI5_GOOGLE_CLIENT_SECRET` with no values.
- The Android build reads signing values from `~/.gradle/gradle.properties` or environment
  (`ELI5_ANDROID_KEYSTORE`, `ELI5_ANDROID_KEYSTORE_PASSWORD`, `ELI5_ANDROID_KEY_ALIAS`,
  `ELI5_ANDROID_KEY_PASSWORD`) and falls back to the debug key, so a fresh clone builds.
  The release keystore lives outside the repository and is backed up; every update must be signed
  with it.
- `scripts/check-hygiene.ts` gains tracked-path rules for the files above, `.jar` in the binary
  extension list, and content patterns for `GOCSPX-` secrets and
  `<digits>-<32 chars>.apps.googleusercontent.com` client IDs, over tracked files and `out/**`.
- `.prettierignore` gains `android/`.
- CI gains an `android` job (Linux, JDK 21, wrapper validation, lint, unit tests, debug assemble). It
  uses no secrets and never signs a release.

## 12. Testing

- **Shared contract.** `src/main/sync/protocol.ts` exports JSON Schema to `test/contracts/sync/`,
  with golden fixtures (manifest, tree, job, jobstatus, device, version-tree-layout input and expected
  lanes). Vitest and the Android unit tests both read them; the Android build adds the folder as a
  test resource directory. `npm run gen:sync-schema` (`scripts/export-sync-schema.ts`) writes the
  `<type>.schema.json` files, the `layout.<name>.json` fixtures (expected rows computed by the
  desktop's `layoutVersionTree`), `patterns.json` (every id pattern, limit and enum, which the
  Android tests compare with `Models.kt`) and `fixtures/index.json`; `-- --check` fails on drift
  or on an orphaned generated file and runs in CI. Hand-written fixtures are named `<type>.valid.<name>.json` or `<type>.invalid.<name>.json`, and
  both sides must accept every valid one unchanged and reject every invalid one. Cross-field rules
  (for example the 50 MiB per-job attachment total or a manifest folder reference) are not
  expressible in the exported JSON Schema; the fixtures cover them. The cross-field rules are: a
  phone's device record has `role: 'phone'`, `accepts: []` and `inbox: 'off'` (and only a phone has
  that role); ids are unique within a manifest, tree, `accepts`, `focus`, attachments and acks; a
  folder placement names a folder in the manifest; `replaces` differs from `docId`; `currentId` is
  a node of its tree; an `uploaded` node has a `sha`; a capture has at least one URL, non-blank
  text or an attachment, and at most 50 MiB of attachments; `failed` and `rejected` statuses carry
  `code` and `reason`, other states no `code`; `done` carries `docId`. Field rules both sides share:
  string lengths count Unicode code points (as zod does); a job URL is printable ASCII starting
  with `http://` or `https://` (any case), parses with a DNS-style host and a valid port, and has
  no user name or password (the phone percent-encodes and IDNA-encodes shared URLs; the desktop
  never sees a WHATWG-repaired string); an attachment name has no bidi embedding, override or
  isolate characters; a job status `stage` is one line and `anchorId` is a Q&A or section id;
  "blank" text means only what JavaScript's `trim` removes; integers stay within
  `Number.MAX_SAFE_INTEGER`. The Kotlin twin is
  `android/app/src/main/kotlin/io/github/eli5learner/sync/protocol/Models.kt`, decoded only through
  `SyncProtocol`, which adds the JSON-type and `null`-versus-omitted checks kotlinx.serialization
  leaves out.
- **Desktop (Vitest, offline).** An in-memory fake Drive at the fetch level (generateIds, multipart,
  resumable with 256 KiB-multiple checks, changes with tokens and 410, appProperties queries,
  eventual-consistency delay, injected 403, 429 and 5xx); a `SyncStore` contract suite run against the
  fake and every stub; engine tests (ordering, seq, re-minted ids, history selection, GC ages, GC off
  in read-only and unknown-format states, claim and takeover, crash between steps); inbox tests
  (schema fuzzing, sha mismatch, type sniffing, private-address URLs, replay, rate limits, cancel,
  `E_CONFLICT`, `E_STALE`, kinds not accepted); OAuth tests against a fake token endpoint (state
  mismatch, timeout, `invalid_grant`); IPC sender tests (the viewer gets `E_FORBIDDEN`; no answer
  carries a client value or token); sync service tests with the real engine and sign-in over the
  in-memory store; renderer tests for Settings > Sync and the indicator; hygiene tests for the new
  rules.
- **Desktop e2e** (`test/e2e/sync.e2e.ts`). Test builds with `ELI5_SYNC_FAKE=1` register
  `MemorySyncStore` (`src/main/sync/testing/`) under the shipped store id and a stand-in that plays
  the browser (it calls the app's own 127.0.0.1 callback) and answers the token, userinfo and revoke
  endpoints, so the real loopback sign-in runs offline. The spec turns Sync on, saves the client,
  connects, runs Sync now, sees the document's files in the store, follows the indicator to
  Settings > Sync and deletes the cloud copy. The inbox slice adds: drop a job file, see a "From
  phone" document reach done.
- **Visual.** Doc runtime cases at 360 px and 412 px width.
- **Android (JVM, headless).** DriveClient against MockWebServer (multipart shape, resumable chunks,
  backoff, 401 then clearToken); sync repository with a fake client and in-memory Room under
  Robolectric (seq regression ignored, missing blob retried, offline policy); WorkManager test
  driver; share intent parsing; importer; WebView settings, CSP header and URL policy; Compose UI
  tests for Library, Inbox and the capture sheet; the version-tree layout port against the shared
  fixtures.
- **Manual on a phone.** The sideload checklist in `android/README.md`.

## 13. Gates

- **G1 (before trusting the sync engine with a real Drive; the engine itself was built ahead of it
  against the fake store).** In one Cloud project, the desktop client writes
  `probe-desktop.json` to the app-data folder and an Android debug build lists and reads it; the
  phone writes `probe-phone.json` and the desktop lists it; `changes.list` on each side reports the
  other's file; the desktop can delete the phone's file. If any check fails, the same layout ships on
  the `google-drive-folder` store (`drive.file`) instead, and this file is amended. The phone side
  is Settings > Diagnostics > Drive probe, shown in debug builds only (write, list, read, change
  feed, delete; probe files carry `appProperties {k: "probe", dev}`); release builds show counts only.
- **G2.** Real two-device round trip: a capture shared on the phone becomes a document on the
  desktop and opens on the phone.

## Acceptance criteria

1. With `sync.enabled` false (the default), the desktop makes no request to any Google endpoint, and
   every existing test passes unchanged.
2. The desktop consent opens in the system browser, completes through a `127.0.0.1` loopback with
   PKCE and state, and stores the refresh token only in the Keychain; no token or client secret
   appears in settings, logs, IPC payloads or `out/`.
3. After enable and sign-in, every non-trashed document appears in the remote manifest with its
   current blob uploaded before the manifest that references it; `meta.json` content outside the
   allowlist never appears in any remote file.
4. No device ever updates or deletes a remote file whose owner is another device, except the
   primary's GC of the files listed in §4.7; the store guard enforces this and a test proves it.
5. A replayed job file produces exactly one pipeline job. A job with a private-address URL never
   fetches that address.
6. The APK contains no OAuth client ID, client secret, refresh token or LLM key (verified by
   scanning the APK contents).
7. A cached document opens offline in the reader with tabs, glossary and theme working, makes no
   network request, and exposes no JavaScript interface.
8. Foreign HTML opens with scripts off.
9. An expired or revoked grant on the phone shows the reconnect banner and stops background retries;
   reading still works.
10. Inbox jobs appear in the phone's Inbox with the desktop's stage text and reach Ready or Failed
    with a one-line reason.
11. `npm run check:hygiene`, `npm run check:spec`, the desktop suite and the Android `lint`,
    `testDebugUnitTest` and `assembleDebug` tasks pass.
