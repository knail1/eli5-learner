# Architecture and process model

This file defines how ELI5 Learner is put together: the Electron process model (main, preload, app
renderer, document viewer), the module map for `src/`, the end-to-end data flow from a dropped
source to a saved `index.html`, the complete IPC contract, the edition model with its capability
registry and private overlay loading, the `NotAvailableInEdition` error, the dependency list, and
the build and packaging pipeline. Behavior inside each module is specified in the sibling files;
this file fixes the boundaries between them so they can be built in parallel.

Related: [02-llm-provider.md](02-llm-provider.md) ·
[03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) ·
[05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) ·
[07-output-document.md](07-output-document.md) · [08-interactive-reading.md](08-interactive-reading.md) ·
[09-library-storage.md](09-library-storage.md) · [10-publishing.md](10-publishing.md) ·
[11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) ·
[13-testing-quality.md](13-testing-quality.md)

PRD sections implemented here: *Build editions and swap seams*, *App shell and layout* (process
and window structure only), *Fetching strategy* (placement of the hidden window), *Processing
pipeline* (placement of the queue), *Configuration, scope, and open items* (edition flag).

## 1. Design principles

1. **Main process owns every side effect.** Network, file system, Keychain, LLM calls, child
   windows. Renderers are untrusted views that talk to main only through the typed preload API.
2. **Every external capability is an interface.** `LLMProvider`, `SourceResolver`, `Extractor`,
   `Publisher`. Concrete implementations are looked up through the capability registry, never
   imported directly by callers (PRD *Seam requirements*).
3. **Editions differ only by what is registered.** The public and enterprise builds share one code
   base and one module graph. The enterprise build adds a private overlay that registers extra
   implementations; nothing in the public tree branches on organization-specific details.
4. **The public build runs with nothing but an API key.** No account, no network service other than
   the chosen LLM API and the public URLs the user enters.
5. **Generated documents are independent of the app.** `index.html` is self-contained vanilla
   HTML/CSS/JS. The app adds interactivity by injecting a bridge at view time; the file itself works
   in any browser without it.

## 2. Process model

| Process / context | Created by | Code | Trust | Responsibilities |
| --- | --- | --- | --- | --- |
| Main | Electron | `src/main/**` | Trusted, Node | App lifecycle, tray/menu bar item, windows, IPC handlers, job queue, LLM calls, file I/O, Keychain, registry |
| App preload | Main window | `src/preload/app.ts` | Bridge | Exposes `window.eli5` via `contextBridge`; no logic beyond marshalling |
| App renderer | Main window | `src/renderer/**` | Untrusted, sandboxed | React UI: Library sidebar, viewer frame, input zone, status, suggestions, settings |
| Document viewer | `WebContentsView` attached to the main window | the document's own `index.html` + `src/doc-runtime/**` (already inlined) | Untrusted, sandboxed | Renders one generated document |
| Doc preload | Document viewer | `src/preload/doc.ts` | Bridge | Exposes `window.eli5Doc` (selection actions, tab close) to the doc-runtime |
| Hidden fetch window | `src/main/fetch/` on demand | none (remote page) | Hostile | Renders client-side pages for the fetch fallback (see 05); never shown, destroyed after extraction; pooled non-persistent partitions `eli5-render-0` / `eli5-render-1`, cleared after every render (05 §8.1) |
| Readability workers | `src/main/fetch/readability.ts` | Node `worker_threads` pool (size 2) | Trusted code, hostile input | Parse fetched HTML with jsdom + Readability off the main thread (05) |
| Extract worker | `src/main/extract/` | Electron `utilityProcess` (`src/main/extract/worker.ts`) | Trusted code, hostile input | Runs every per-format parser; a crash or timeout fails one source, not the app (04 §10.4) |
| pdf-render window | `src/main/extract/pdf-render-window.ts` per job, on demand | bundled `pdf-render.html` + pdf.js | Hostile input | Renders scanned PDF pages to images for vision (04 §6.3); `show:false`, network blocked, partition `eli5-pdf-render`, destroyed at job end |

### 2.1 Window and view topology

```
BrowserWindow "main"  (contextIsolation, sandbox, nodeIntegration=false)
 ├─ webContents: React app (src/renderer)          preload: src/preload/app.ts
 └─ WebContentsView "viewer"                        preload: src/preload/doc.ts
       bounds = rect of <ViewerSlot/> reported by the renderer (eli5:viewer:set-bounds)
Tray "menu bar item"   (lives in main; survives main window close)
BrowserWindow "fetch-N" (show:false, offscreen, no preload, partition "eli5-render-0|1" (pooled, cleared per render), 0..2 concurrent)
BrowserWindow "pdf-render" (show:false, network blocked, partition "eli5-pdf-render", per job)
utilityProcess "extract worker"   worker_threads "readability" x2
session "eli5-fetch" (in-memory; used by net.request for the plain HTTP fetch, 05)
```

- The viewer is a `WebContentsView`, not a `<webview>` tag and not an `<iframe>`. It keeps the
  generated document in its own sandboxed renderer, lets main inject the doc preload, and avoids
  the deprecated `<webview>` path.
- The React renderer owns layout. It renders an empty `<ViewerSlot/>` element and reports its
  bounding rect (on mount, resize, sidebar toggle) via `eli5:viewer:set-bounds`; main applies it
  with `view.setBounds()`. When no document is open the view is hidden (`setVisible(false)`).
- Documents load through a custom protocol, `eli5doc://doc/<topic-slug>/index.html`, registered as
  a privileged, standard, secure scheme. The handler serves files only from inside the library root
  (path traversal rejected with 404). The viewer never gets `file://` access.
- Closing the main window hides it (`close` is prevented); the Tray keeps the app alive. Quit only
  from the Tray menu, which sets the module flag `shell.isQuitting = true` (`src/main/shell/`, 11
  §3.2) before `app.quit()`. Electron's `app` has no `isQuitting` property; do not add one.

### 2.2 Security baseline (all windows)

| Setting | App renderer | Viewer | Fetch window |
| --- | --- | --- | --- |
| `contextIsolation` | true | true | true |
| `sandbox` | true | true | true |
| `nodeIntegration` | false | false | false |
| `webSecurity` | true | true | true |
| Preload | `app.ts` | `doc.ts` | none |
| Network | CSP `default-src 'self'` | CSP: see 12 §7.4 (response header set by the `eli5doc://` handler: `default-src 'none'`, `connect-src 'none'`, no `data:` in `script-src`) and 07 §6.2 (meta tag in the file); no remote origins | unrestricted (public web); fetch session `eli5-fetch` is in-memory, each render uses one of two pooled non-persistent partitions `eli5-render-0`/`-1`, whose storage and cache are cleared after every render (05 §8.1, 12) |
| Navigation | blocked except app URL | blocked except same document; `http(s)` links open in default browser via `shell.openExternal` | allowed |
| `window.open` | denied | denied, routed to `shell.openExternal` for `http(s)` | denied |

Keychain and settings rules are in 12.

Open item (origin isolation): every document is served from the single origin `eli5doc://doc`, so
documents share `localStorage` and could in principle read each other's files. `connect-src 'none'`
blocks the fetch path. A per-document host (`eli5doc://<slug>/index.html`) would give each document
its own origin; adopting it requires the matching slug-parsing change in 08 §4.3 and the handler in
09, and is deferred until both owners agree.

## 3. Module map

Each directory has one public entry (`index.ts`) that is the only import path other modules use.

| Path | Owns | Key exports | Spec |
| --- | --- | --- | --- |
| `src/main/index.ts` | App bootstrap, single-instance lock, window + tray creation, IPC registration | `bootstrap()` | this file, 11 |
| `src/main/shell/` | Main window, Tray / menu bar item, viewer `WebContentsView`, app menu, `isQuitting` flag, completion notifications (`notifications.ts`) | `showMainWindow()`, `viewer`, `shell.isQuitting`, `createNotifier()` | 11 |
| `src/main/security/` | Protocol handler hardening, CSP headers, URL allow-listing for `openExternal`, redacting logger | `safeOpenExternal()`, `log` | 12 |
| `src/main/ipc/` | Channel registration, envelope wrapping, payload validation | `registerIpc()` | this file |
| `src/main/llm/` | `LLMProvider`, `claude.ts`, `openai.ts`, `bedrock.stub.ts` | `LLMProvider`, `GenerationRequest`, `GenerationResult` | 02 |
| `src/main/sources/` | `SourceResolver`, file / clipboard / url resolvers, `mcp.stub.ts` | `SourceInput`, `ResolvedSource`, `SkippedSource` | 03 |
| `src/main/extract/` | Per-format extractors, extract worker (`utilityProcess`), pdf-render window | `Extractor`, `ExtractedContent`, `ContentBlock` | 04 |
| `src/main/fetch/` | HTTP fetch, Readability worker pool, hidden-window fallback, `configureSession()` | `fetchUrl()` | 05 |
| `src/main/pipeline/` | Job queue, stages, status events | `Job`, `JobStatus`, `JobQueue` | 06 |
| `src/main/document/` | HTML builder, section IDs, regenerate-in-place, tab add/remove | `DocumentModel`, `Tab`, `Section`, `SectionId` | 07, 08 |
| `src/main/document/interactive/` | Section actions, busy tracking, viewer reload + scroll-to | `ScrollToEvent`, `SectionBusyEvent` | 08 |
| `src/main/library/` | `catalog.json`, `meta.json`, merge suggestions, `eli5doc://` handler | `CatalogEntry`, `DocumentMeta`, `MergeSuggestion` | 09 |
| `src/main/publish/` | `Publisher`, `local.ts`, `drive.stub.ts`, `git.stub.ts` | `Publisher`, `PublishTarget`, `PublishResult` | 10 |
| `src/main/config/` | Settings schema, Keychain, edition flags | `Settings`, `getSettings()`, `edition` | 12 |
| `src/main/editions/` | Capability registry, overlay loader, `NotAvailableInEdition` | `registry`, `Edition`, `NotAvailableInEdition` | this file |
| `src/preload/app.ts` | `window.eli5` API | `Eli5Api` (type) | this file, 11 |
| `src/preload/doc.ts` | `window.eli5Doc` API | `Eli5DocApi` (type) | this file, 08 |
| `src/preload/contract.ts` | IPC channel constants, payload/response types, `IpcResult<T>` (types and string constants only; no runtime deps). The **only** location for types shared with renderers; there is no `src/shared/` (supersedes 03 §1) | `IPC`, `IpcResult` | this file |
| `src/renderer/` | React UI | — | 11 |
| `src/doc-runtime/` | Tabs, glossary layout, selection bridge; built to one IIFE + CSS and inlined into every document | `DOC_RUNTIME_JS`, `DOC_RUNTIME_CSS` (build-time strings) | 07, 08 |

**Dependency rules** (enforced by an ESLint `import/no-restricted-paths` config, see 13):

- `src/renderer`, `src/doc-runtime` may import only `src/preload/contract.ts` (types) and their
  own files. Never `src/main`.
- `src/main/*` modules import each other only through `index.ts`. `pipeline` may depend on
  `sources`, `extract`, `llm`, `document`, `library`; `document` may depend on `llm`; nothing depends
  on `pipeline` except `ipc`. `shell` does not depend on `pipeline` either: bootstrap
  (`src/main/index.ts`) wires the job queue's `done` event to the shell's notifier.
- Only `src/main/editions/` knows about the overlay. Callers ask the registry for a capability.

## 4. End-to-end data flow

### 4.1 New document (PRD *Processing pipeline*)

1. Renderer input zone collects drops, pastes and URLs into `SourceInput[]` plus the optional
   clarifying text and glossary toggle. Dropped files: the app preload converts each `File` to a
   path with `eli5.files.pathFor(file)` (`webUtils.getPathForFile()`; the `File.path` property is
   gone in current Electron). Pasted content is not read in the renderer: at paste time the
   renderer calls `eli5:sources:read-clipboard {draftId}`, main snapshots the clipboard into draft
   staging and returns `SourceInput[]` of kind `'text'`, `'image'`, `'file'` or `'url'` (03 §6).
   `SourceInput` has no `'clipboard'` kind.
2. Renderer calls `eli5.jobs.start({inputs, options})` → `eli5:jobs:start`. Main validates,
   creates and persists a `Job` (`status:'queued'`), returns `{jobId}` immediately. Enter never
   blocks.
3. `JobQueue` (06) schedules jobs (create-lane concurrency per 06; queued jobs wait); every
   persisted change is pushed as a `JobSnapshot` on `eli5:jobs:changed`.
4. **reading**: for each `SourceInput`, the registry picks the first `SourceResolver` whose
   `canResolve()` is true (routing order in 03; enterprise routing is HOOK-SRC-03). Results are
   `ResolvedSource[]` and `SkippedSource[]`.
5. **extracting**: each `ResolvedSource` goes to the matching `Extractor` (04), URLs through
   `fetchUrl()` (05). Output: `ExtractedContent` made of `ContentBlock`s (text, table, image refs).
   Failures become `SkippedSource` entries; the job continues.
6. If no usable content remains → `failed` with a human-readable reason.
7. **generating**: pipeline builds a `GenerationRequest` and calls the active `LLMProvider`
   (`registry.llm()`), images passed as vision input (02, 06). The result is parsed into a
   `DocumentModel` (tabs → sections, each with a `SectionId`).
8. **saving**: `document/` renders `index.html` (runtime inlined), `library/` writes
   `<slug>/index.html`, `<slug>/meta.json`, and updates `catalog.json` atomically (09).
9. **done**: main emits `eli5:library:changed`, rebuilds the Tray menu (last 3), then runs the merge
   check (09); a hit emits `eli5:suggestions:changed`. For a `create` job, bootstrap's completion
   listener posts one native macOS notification "Document ready" (body: the document title) when
   `notifications.enabled` is true; clicking it opens the document in the app, or its published
   link when `notifications.clickAction` is `'published-link'` (11 §14). Failed jobs, section actions,
   merges and publishes post no notification.

### 4.2 Section action (PRD *Interactive reading*)

1. User selects text in the viewer. The doc-runtime finds the enclosing `<section data-section-id>`
   and shows the inline action menu (only if `window.eli5Doc` exists; in a plain browser the menu is
   not shown).
2. On action, the runtime calls `eli5Doc.regenerateSection({tabKey, sectionId, action,
   selectionText, note})` or `eli5Doc.createSectionEli5(...)` → `eli5:doc:regenerate-section` or
   `eli5:doc:create-section-eli5` (the preload adds `slug`). These are jobs too; they enter the same
   queue, report on `eli5:jobs:changed`, and main pushes `eli5:doc:section-busy` to the viewer.
3. `document/` loads the file, regenerates only that section with its neighbors as context,
   replaces the `<section>` node by ID (or appends a new tab), writes atomically, updates
   `meta.json` and `catalog.json.updatedAt`.
4. Main emits `eli5:doc:updated {slug, sectionId|tabKey}`; main reloads the viewer and, after
   `did-finish-load` with a matching `loadSeq`, sends `eli5:doc:scroll-to` (`ScrollToEvent`) to the
   viewer. Details in 08.

### 4.3 Publish (PRD *Enterprise publishing*)

Renderer calls `eli5:publish:run {slug, targetId}` → registry publisher → `PublishResult`;
progress is pushed on `eli5:publish:progress` (10). Before the publisher runs, the registry's
pre-publish policy is applied (HOOK-PUB-05; public: no-op). The public build has only `local`
available; `drive` and `git` resolve to stubs that throw `NotAvailableInEdition` (HOOK-PUB-01,
HOOK-PUB-03). Publish UI visibility is HOOK-UI-01.

## 5. IPC contract

### 5.1 Conventions

- Channel names are `eli5:<area>:<action>`, declared once as constants in
  `src/preload/contract.ts`. No string literals elsewhere.
- Request/response channels use `ipcRenderer.invoke` / `ipcMain.handle`. Every handler returns
  `IpcResult<T>`; handlers never throw across the boundary (Electron strips error classes and
  stacks).
- Main → renderer events use `webContents.send`; the preload exposes `on<Event>(cb): Unsubscribe`.
- Main validates every payload with the schema in `src/main/ipc/schemas.ts` (zod). Invalid →
  `{ok:false, error:{code:'E_BAD_REQUEST'}}`.
- Handlers check `event.senderFrame` origin: app channels accept only the app renderer; D→M
  channels (the `eli5:doc:*` section invokes, `eli5:viewer:open-external`) accept only the viewer.
  `eli5:doc:history`, `eli5:doc:undo` and `eli5:doc:redo` are R→M: the app window only, never the
  viewer. Anything else → `E_FORBIDDEN`.
- The "Response" column in §5.2 is the `value` of `IpcResult<T>`. Where an owning spec writes a
  response as `{ok:boolean}` or `{ok:false, reason}` (06 §11), the wire form is still
  `IpcResult<T>`: success is `{ok:true, value}` and the reason travels as an `IpcError`.
- Module-specific error codes are mapped to `IpcErrorCode` at the IPC boundary. The module's own
  code and detail are logged (IDs only), never sent. In particular `LibraryError` (09 §9) maps
  `LIBRARY_READ_ONLY` → `E_LIBRARY_READ_ONLY`, `SUGGESTION_STALE` → `E_SUGGESTION_STALE`,
  `MERGE_FAILED` → `E_MERGE_FAILED`, `NOT_FOUND` → `E_NOT_FOUND`, `HISTORY_EMPTY` → `E_CONFLICT`,
  everything else → `E_IO`.
  `PublishError` (10) maps to `E_PUBLISH_FAILED` with its `PublishErrorCode` in `detailCode` and,
  for `E_PUBLISH_SECRET_FOUND`, the masked `findings`; its `detail` is never sent.
  A module needing a new code adds it here; `detailCode` carries a finer module code where the
  UI needs one (for example `PublishErrorCode`, 10).

```ts
// src/preload/contract.ts
export type IpcErrorCode =
  | 'E_BAD_REQUEST' | 'E_FORBIDDEN' | 'E_NOT_FOUND'
  | 'E_NOT_AVAILABLE_IN_EDITION'   // see §6.4
  | 'E_NO_API_KEY' | 'E_LLM_UNAVAILABLE' | 'E_RATE_LIMITED'
  | 'E_IO' | 'E_CONFLICT' | 'E_INTERNAL'
  // settings and Keychain (12)
  | 'E_SETTINGS_INVALID' | 'E_SETTINGS_LOCKED' | 'E_SECRET_IN_SETTINGS' | 'E_SETTINGS_IO'
  | 'E_KEY_FORMAT' | 'E_KEYCHAIN_UNAVAILABLE'
  // library (09)
  | 'E_LIBRARY_READ_ONLY' | 'E_SUGGESTION_STALE' | 'E_MERGE_FAILED'
  // publish (10): every PublishError; its PublishErrorCode travels in detailCode
  | 'E_PUBLISH_FAILED';

export interface IpcError {
  code: IpcErrorCode;
  message: string;          // human readable, safe to show in the status area
  detailCode?: string;      // optional finer module code (e.g. a PublishErrorCode); never secret
  capability?: string;      // set for E_NOT_AVAILABLE_IN_EDITION
  hookId?: string;          // e.g. "HOOK-PUB-01", set for E_NOT_AVAILABLE_IN_EDITION
  findings?: SecretFinding[]; // masked secret-scanner hits for detailCode E_PUBLISH_SECRET_FOUND (10 §7)
}
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };
```

### 5.2 Channel table

Direction: **R→M** invoke from app renderer, **D→M** invoke from document viewer, **M→R** event to
app renderer, **M→D** event to viewer. Payload types are defined in the owning module and
re-exported as types from `contract.ts`. The "Spec" column names the file that owns the payload
shape; where this table and the owning spec disagree on a payload type, the owning spec wins and
this table is corrected. Channel **names** are fixed here.

**Jobs (06)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:jobs:start` | R→M | `StartJobRequest {inputs: SourceInput[]; options: JobOptions}` | `{jobId: string}` | 06 §11 |
| `eli5:jobs:list` | R→M | — | `JobSnapshot[]` (non-terminal plus undismissed terminal jobs) | 06 §11 |
| `eli5:jobs:cancel` | R→M | `{jobId}` | `void` | 06 §8 |
| `eli5:jobs:retry` | R→M | `{jobId}` | `void` | 06 §7 |
| `eli5:jobs:dismiss` | R→M | `{jobId}` | `void` (hides the line, frees retained staging) | 06 §11 |
| `eli5:jobs:changed` | M→R | — | `JobSnapshot`, on every persisted change | 06 §11 |

**Sources and auth (03)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:sources:read-clipboard` | R→M | `{draftId}` | `SourceInput[]` (possibly empty) | 03 §13 |
| `eli5:sources:stage-text` | R→M | `{draftId; text; markup: 'plain'\|'html'}` | `SourceInput` | 03 §13 |
| `eli5:sources:discard` | R→M | `{draftId; inputId}` | `void` | 03 §13 |
| `eli5:sources:discard-draft` | R→M | `{draftId}` | `void` | 03 §13 |
| `eli5:sources:classify-text` | R→M | `{text}` (≤ 2048 chars) | `ClassifyTextResult {kind: 'url'\|'bare'\|'invalid'; label}` (lane router `routeBare`; public: non-URL text is `invalid`) | 11 §5.4 |
| `eli5:sources:register-drop` | R→M | `{paths: string[]}` (absolute; sent only by the app preload's capture-phase listener for a trusted `drop`) | `DropRegistration[]` (`{inputId, path}`). Main mints an opaque input id per path; file `SourceInput`s in `eli5:jobs:start` carry that id (the preload swaps it in), and main reads its own registered path, never the renderer's. An unknown id → `E_FORBIDDEN`; a successful start uses the ids up. File inputs from `eli5:sources:read-clipboard` get ids the same way | 06 §11 |
| `eli5:auth:status` | R→M | — | `AuthStatus`; public: `{state:'unavailable'}` (HOOK-AUTH-01) | 03 §12 |
| `eli5:auth:sign-in` | R→M | — | `AuthStatus`; public: `E_NOT_AVAILABLE_IN_EDITION` | 03 §12 |
| `eli5:auth:sign-out` | R→M | — | `AuthStatus`; public: `E_NOT_AVAILABLE_IN_EDITION` | 03 §12 |
| `eli5:auth:changed` | M→R | — | `AuthStatus` (never fires in the public build) | 03 §12 |

**LLM (02)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:llm:test-connection` | R→M | `{provider?: ProviderId}` | `{ok: boolean; model?: string; message?: string}` | 02 §14 |
| `eli5:llm:models` | R→M | `{provider: ProviderId}` | `{suggested: string[]; default: string}` | 02 §14 |

**Library and suggestions (09)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:library:list` | R→M | — | `CatalogEntry[]` newest first | 09 §11 |
| `eli5:library:open` | R→M | `{slug}` | `void` (loads viewer) | 09 §11 |
| `eli5:library:reveal` | R→M | `{slug}` | `void` (Finder) | 09 §11 |
| `eli5:library:info` | R→M | — | `{root: string; readOnly: boolean; readOnlyReason?: string; count: number}` | 09 §11 |
| `eli5:library:reveal-root` | R→M | — | `void` (Finder shows the Library root; Settings > Library) | 11 §7 |
| `eli5:library:changed` | M→R | — | `{entries: CatalogEntry[]}` | 09 §11 |
| `eli5:suggestions:list` | R→M | — | `MergeSuggestion[]` | 09 §11 |
| `eli5:suggestions:accept` | R→M | `{suggestionId}` | `{targetSlug}`; `E_SUGGESTION_STALE`, `E_MERGE_FAILED`, `E_LIBRARY_READ_ONLY` | 09 §11 |
| `eli5:suggestions:dismiss` | R→M | `{suggestionId}` | `void` | 09 §11 |
| `eli5:suggestions:changed` | M→R | — | `{suggestions: MergeSuggestion[]}` (06's `eli5:library:suggestion` is this channel) | 09 §11 |

**Document and viewer (07, 08, 11)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:doc:regenerate-section` | D→M | `SectionActionRequest {slug; tabKey; sectionId; action: SectionAction; selectionText; note?}` | `{jobId}` | 08 §3 |
| `eli5:doc:create-section-eli5` | D→M | `CreateSectionEli5Request` (06's `eli5:doc:section-eli5` is this channel) | `{jobId}` | 08 §3 |
| `eli5:doc:close-tab` | D→M | `CloseTabRequest {slug; tabKey}` (section ELI5 tabs only) | `void` | 08 §3 |
| `eli5:doc:updated` | M→R | — | `{slug; sectionId?: SectionId; tabKey?: string}` | 08 |
| `eli5:doc:scroll-to` | M→D | — | `ScrollToEvent {sectionId?; tabKey?; flash: boolean; loadSeq: number}` | 08 §3 |
| `eli5:doc:section-busy` | M→D | — | `SectionBusyEvent` (full busy list for the loaded document; optional `notices` for failed jobs, 08 §9) | 08 §4.1 |
| `eli5:doc:history` | R→M | `{slug}` | `DocHistoryState {canUndo; canRedo; undoLabel?; redoLabel?; busy?}` | 08 §6.7, 09 §4.1 |
| `eli5:doc:undo` | R→M | `{slug}` | `DocHistoryState` after the swap; `E_CONFLICT` while a section of the document is busy or with nothing to undo | 08 §6.7, 09 §4.1 |
| `eli5:doc:redo` | R→M | `{slug}` | `DocHistoryState` after the swap; `E_CONFLICT` as for undo | 08 §6.7, 09 §4.1 |
| `eli5:doc:history-changed` | M→R | — | `DocHistoryChangedEvent {slug; state: DocHistoryState}` after any library change or busy change for that document | 08 §6.7 |
| `eli5:viewer:set-bounds` | R→M | `{x; y; width; height}` | `void` | 11 |
| `eli5:viewer:set-visible` | R→M | `{visible: boolean}` | `void` | 11 §10 |
| `eli5:viewer:open-external` | D→M | `{url}` (`http`/`https` only) | `void` | 12 |
| `eli5:viewer:focus` | R→M | — | `void` (main focuses the viewer view's webContents when it is attached) | 11 §12 |

**App shell (11)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:app:navigate` | M→R | — | `AppNavigateEvent {route: UiRoute}` | 11 §10 |
| `eli5:app:cycle-region` | M→R | — | `CycleRegionEvent {dir: 1 \| -1}` (F6 / Shift+F6 pressed in the viewer) | 11 §12 |
| `eli5:app:context-menu` | R→M | `{kind: 'library-item'; slug}` | `void` (native menu shown by main) | 11 §10 |
| `eli5:app:test-notification` | R→M | — | `TestNotificationResult {shown: boolean; reason?: 'disabled' \| 'unsupported'}` | 11 §14 |
| `eli5:app:open-notification-settings` | R→M | — | `void` (main opens the fixed System Settings > Notifications URL; 12 §7.5 exception) | 11 §14 |
| `eli5:test:tray-click` | R→M | test-defined | `void`; registered **only** when `__ELI5_TEST__` is true (§8.1) | 13 |

**Settings and edition (12, this file)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:settings:get` | R→M | — | `Settings` (no secrets) | 12 §5 |
| `eli5:settings:set` | R→M | `DeepPartial<Settings>` | `Settings`; `E_SETTINGS_INVALID`, `E_SETTINGS_LOCKED`, `E_SECRET_IN_SETTINGS`, `E_SETTINGS_IO` | 12 §5 |
| `eli5:settings:set-api-key` | R→M | `{provider: 'claude'\|'openai'; key: string}` | `void` (Keychain); `E_KEY_FORMAT`, `E_KEYCHAIN_UNAVAILABLE` | 12 §5 |
| `eli5:settings:has-api-key` | R→M | `{provider}` | `boolean` | 12 §5 |
| `eli5:settings:clear-api-key` | R→M | `{provider}` | `void` | 12 §5 |
| `eli5:settings:describe` | R→M | — | `SettingsDescription` | 12 §5 |
| `eli5:settings:choose-folder` | R→M | `{key: 'publish.local.dir'}` | `ChooseFolderResult` = `{path}` \| `{cancelled: true}` (main shows the open panel, validates, saves the key) | 11 §10 |
| `eli5:settings:open-help` | R→M | `{topic: 'readme'\|'publish-pages'\|'licenses'}` | `void` (main opens the fixed README URL or bundled help file); `E_NOT_FOUND` when it is missing | 11 §10 |
| `eli5:settings:changed` | M→R | — | `{changed: string[]; settings: Settings}` | 12 §5 |
| `eli5:edition:info` | R→M | — | `EditionInfo` (§6.2) | this file |

**Publish (10)**

| Channel | Dir | Request | Response / event payload | Spec |
| --- | --- | --- | --- | --- |
| `eli5:publish:targets` | R→M | `{slug}` | `PublishTarget[]`: all registered targets; stubs have `available:false` | 10 §6 |
| `eli5:publish:run` | R→M | `{slug; targetId}` | `PublishResult` | 10 §6 |
| `eli5:publish:progress` | M→R | — | `{slug; targetId; stage: PublishStage\|'failed'; result?; error?: IpcError}` (a failure is `E_PUBLISH_FAILED` + `detailCode`) | 10 §6 |
| `eli5:publish:history` | R→M | `{slug}` | `PublicationRecord[]` newest first | 10 §6 |
| `eli5:publish:cancel` | R→M | `{slug; targetId}` | `void` | 10 §6 |
| `eli5:publish:copy-link` | R→M | `{url}` | `void` (clipboard written in main) | 10 §6 |
| `eli5:publish:open-link` | R→M | `{url}` | `void` (`https:` via `safeOpenExternal`; `file:` inside the export folder via `shell.openPath`) | 10 §6 |
| `eli5:publish:reveal` | R→M | `{url}` (`file:` only) | `void` (`shell.showItemInFolder`) | 10 §6 |

This table is the complete v1 registry: channels not in it do not exist. A spec that needs a new
channel adds a row here (and the constant to `contract.ts`) in the same change; defining a channel
only in a sibling file is not enough.

### 5.3 Preload surfaces

```ts
type Unsub = () => void;

// window.eli5 (app renderer)
export interface Eli5Api {
  jobs: {
    start(r: StartJobRequest): Promise<IpcResult<{ jobId: string }>>;
    list(): Promise<IpcResult<JobSnapshot[]>>;
    cancel(jobId: string); retry(jobId: string); dismiss(jobId: string);
    onChanged(cb: (s: JobSnapshot) => void): Unsub;
  };
  sources: {
    readClipboard(draftId: string); stageText(draftId: string, text: string, markup: 'plain' | 'html');
    discard(draftId: string, inputId: string); discardDraft(draftId: string); classifyText(text: string);
  };
  library: { list(); open(slug: string); reveal(slug: string); info(); revealRoot(); onChanged(cb): Unsub };
  suggestions: { list(); accept(id: string); dismiss(id: string); onChanged(cb): Unsub };
  doc: { onUpdated(cb): Unsub };
  viewer: { setBounds(r: { x: number; y: number; width: number; height: number }); setVisible(v: boolean); focus() };
  llm: { testConnection(provider?: ProviderId); models(provider: ProviderId) };
  settings: {
    get(); set(p: DeepPartial<Settings>); describe();
    setApiKey(p, k); hasApiKey(p); clearApiKey(p); chooseFolder(key: 'publish.local.dir');
    onChanged(cb: (e: { changed: string[]; settings: Settings }) => void): Unsub;
  };
  edition: { info(): Promise<IpcResult<EditionInfo>> };
  publish: {
    targets(slug: string); run(slug: string, targetId: string); history(slug: string);
    cancel(slug: string, targetId: string); copyLink(url: string); openLink(url: string); reveal(url: string);
    onProgress(cb): Unsub;
  };
  auth: { status(); signIn(); signOut(); onChanged(cb: (s: AuthStatus) => void): Unsub };
  app: {
    onNavigate(cb: (e: AppNavigateEvent) => void): Unsub; contextMenu(r: { kind: 'library-item'; slug: string });
    testNotification(); openNotificationSettings();
    onCycleRegion(cb: (e: CycleRegionEvent) => void): Unsub;
  };
  files: { pathFor(file: File): string };   // webUtils.getPathForFile; the single drop-path helper
}

// window.eli5Doc (document viewer only; absent in a normal browser)
export interface Eli5DocApi {
  regenerateSection(r: Omit<SectionActionRequest, 'slug'>): Promise<IpcResult<{ jobId: string }>>;
  createSectionEli5(r: Omit<CreateSectionEli5Request, 'slug'>): Promise<IpcResult<{ jobId: string }>>;
  closeTab(tabKey: string): Promise<IpcResult<void>>;
  openExternal(url: string): Promise<IpcResult<void>>;
  onScrollTo(cb: (e: ScrollToEvent) => void): Unsub;
  onSectionBusy(cb: (e: SectionBusyEvent) => void): Unsub;
}
```

Every method without an explicit return type returns `Promise<IpcResult<T>>` with `T` from §5.2.
`files.pathFor` is the only way to turn a dropped `File` into a path; 03's
`sources.pathForFile` refers to this helper. The test-only `eli5:test:tray-click` has no preload
method; e2e tests invoke it through Playwright's main-process evaluation (13).

The doc preload fills `slug` itself from the loaded `eli5doc://` URL; the doc-runtime cannot
target a different document.

## 6. Edition model and capability registry

### 6.1 Editions

`Edition = 'public' | 'enterprise'`, fixed at build time from `ELI5_EDITION` (default `public`)
and compiled in as the constant `__ELI5_EDITION__`. It is not a runtime setting: a public binary
cannot be switched to enterprise by editing settings.

| | Public | Enterprise |
| --- | --- | --- |
| Registered LLM providers | `claude`, `openai`; `bedrock` → stub | public set + overlay (HOOK-LLM-01); prompt policy (HOOK-LLM-02) |
| Source resolvers | file, clipboard, url; `mcp`, `ticket` → stubs; empty lane rules | public set + overlay (HOOK-SRC-01, HOOK-SRC-02), lane rules (HOOK-SRC-03), staging policy (HOOK-SRC-04), shared MCP client (HOOK-SRC-05) |
| Auth | `AuthBroker` reporting `unavailable` | overlay broker (HOOK-AUTH-01) |
| Fetch | system proxy and trust store; no login signatures | network configurator (HOOK-FETCH-01), login signatures (HOOK-FETCH-02) |
| Pipeline | `defaultPipelinePolicy` | overlay policy (HOOK-PIPE-01) |
| Documents | default theme; public reference kinds | org theme (HOOK-DOC-01), org reference formatter (HOOK-DOC-02) |
| Library | default storage policy; every pair merge-eligible | storage policy (HOOK-LIB-01), merge eligibility (HOOK-LIB-02) |
| Publishers | `local`; `drive`, `git` → stubs; baseline secret scanner; no pre-publish policy | `local` + overlay (HOOK-PUB-01..04), pre-publish policy (HOOK-PUB-05) |
| Settings | public schema; dormant keys accepted but inert | schema extended by overlay (HOOK-CFG-01) |
| UI features | publish buttons and sign-in state hidden; public branding; completion notifications open the document in the app | enabled per overlay flags (HOOK-UI-01), branding (HOOK-UI-02), completion notification defaults and body policy (HOOK-UI-03) |
| Build, CI and tests | public build only; denylist and private suites skipped with a notice | HOOK-CFG-02, HOOK-CFG-03, HOOK-TEST-01, HOOK-TEST-02 |

**Hook index (canonical).** This table lists every private hook in the tech spec, the registry slot
the overlay uses to bind it, and the public default. The overlay contract test (HOOK-TEST-01) and
the private spec's checklist are built from it. A spec that adds a hook adds a row here.

| Hook | Owner | Registry slot (§6.2) | Public default |
| --- | --- | --- | --- |
| HOOK-LLM-01 | 02 | `registerLLMProvider('bedrock' \| gateway id)` | `bedrock.stub.ts` |
| HOOK-LLM-02 | 02 | `registerPromptPolicy` | `defaultPromptPolicy`: no preamble, no overrides, pass-through filter |
| HOOK-AUTH-01 | 03 | `registerAuth(AuthBroker)` | `PublicAuthBroker` (`unavailable`) |
| HOOK-SRC-01 | 03 | `registerSourceResolver` (id `mcp`) | `mcp.stub.ts` |
| HOOK-SRC-02 | 03 | `registerSourceResolver` (id `ticket`) | `ticket.stub.ts` |
| HOOK-SRC-03 | 03 | `registerLaneRules`, `registerLaneRouter` | empty rules; `routeBare()` → null |
| HOOK-SRC-04 | 03 | `registerStagingPolicy` | drafts under `<userData>/staging/drafts/`, job inputs under `<userData>/jobs/<jobId>/`; retention per 06 §9 |
| HOOK-SRC-05 | 03 | `registerMcpClient` | no MCP client; `sources.mcp.url` inert |
| HOOK-FETCH-01 | 05 | `registerNetworkConfigurator` | system proxy, default trust store |
| HOOK-FETCH-02 | 05 | `registerLoginSignatures` | `[]` |
| HOOK-PIPE-01 | 06 | `registerPipelinePolicy` | `defaultPipelinePolicy` |
| HOOK-DOC-01 | 07 | `registerDocTheme` | neutral default `DocTheme` |
| HOOK-DOC-02 | 07 | `registerReferenceFormatter` | public formatter (never produces `kind:'org'`) |
| HOOK-LIB-01 | 09 | `registerLibraryPolicy` | root per 09 §3, 30-day retention |
| HOOK-LIB-02 | 09 | `registerMergeEligibility` | `() => true` |
| HOOK-PUB-01 | 10 | `registerPublisher('drive')` | `drive.stub.ts` |
| HOOK-PUB-02 | 10 | inside the `drive` publisher; values via `registerSettingsExtension` | never shares |
| HOOK-PUB-03 | 10 | `registerPublisher('git')`, `registerSecretScanner` | `git.stub.ts`; `BaselineSecretScanner` |
| HOOK-PUB-04 | 10 | `registerSettingsExtension` (`publish.github.*`) | inert defaults |
| HOOK-PUB-05 | 10 | `registerPrePublishPolicy` | no-op |
| HOOK-CFG-01 | 12 | `registerSettingsExtension` | none registered |
| HOOK-CFG-02 | 01 | build time (§6.5), no runtime slot | `overlay.none.ts` |
| HOOK-CFG-03 | 12 | none (CI script `scripts/check-hygiene.ts`, env `ELI5_HYGIENE_DENYLIST`) | deny-list scan skipped with a notice |
| HOOK-UI-01 | 11 | `enableUiFeatures` | `[]` |
| HOOK-UI-02 | 11 | `EditionOverlay.name` + `registerSettingsExtension` | "ELI5 Learner", "Public edition" |
| HOOK-UI-03 | 11 | `registerNotificationPolicy` + `registerSettingsExtension` (`notifications.*` defaults / managed) | `{hideTitle:false}`; `notifications.clickAction` `'app'` |
| HOOK-TEST-01 | 13 | none (overlay `contracts/` entry) | suite skipped with a notice |
| HOOK-TEST-02 | 13 | none (private corpus) | synthetic fixtures only |

### 6.2 Registry API

```ts
// src/main/editions/registry.ts
import type { AuthBroker, AuthStatus, LaneRule, LaneRouter, McpClient, StagingPolicy } from '../sources'; // 03
import type { PipelinePolicy } from '../pipeline';                              // 06
import type { DocTheme, ReferenceFormatter } from '../document';                // 07
import type { LibraryPolicy, MergeEligibility } from '../library';              // 09
import type { SecretScanner, PrePublishPolicy } from '../publish';              // 10
import type { PromptPolicy } from '../llm';                                     // 02
import type { LoginSignature, NetworkConfigurator } from '../fetch';            // 05

export type Edition = 'public' | 'enterprise';
export const OVERLAY_API_VERSION = 1;

export type UiFeature = 'publish.drive' | 'publish.git' | 'auth.signIn';

export interface CapabilityRegistry {
  readonly edition: Edition;

  // Implementations keyed by id (register with an existing id replaces it)
  registerLLMProvider(id: string, factory: (s: Settings) => LLMProvider): void;      // HOOK-LLM-01
  registerSourceResolver(r: SourceResolver, opts?: { priority?: number }): void;     // HOOK-SRC-01/02
  registerExtractor(e: Extractor): void;
  registerPublisher(id: string, factory: (s: Settings) => Publisher): void;          // HOOK-PUB-01/03
  registerAuth(b: AuthBroker): void;                                                 // HOOK-AUTH-01
  registerMcpClient(c: McpClient): void;                                             // HOOK-SRC-05; one shared client (03 §10.1)

  // Single-slot policies (register replaces the public default)
  registerPromptPolicy(p: PromptPolicy): void;             // HOOK-LLM-02 {preamble, overridesDir, skills, preSendFilter}
  registerLaneRules(rules: LaneRule[]): void;              // HOOK-SRC-03; default router built from these
  registerLaneRouter(r: LaneRouter): void;                 // HOOK-SRC-03; full replacement incl. routeBare()
  registerStagingPolicy(p: StagingPolicy): void;           // HOOK-SRC-04
  registerNetworkConfigurator(fn: NetworkConfigurator): void;   // HOOK-FETCH-01; (ses: Session) => Promise<void>
  registerLoginSignatures(sigs: LoginSignature[]): void;   // HOOK-FETCH-02; appended to the public (empty) list
  registerPipelinePolicy(p: PipelinePolicy): void;         // HOOK-PIPE-01
  registerDocTheme(t: DocTheme): void;                     // HOOK-DOC-01
  registerReferenceFormatter(fn: ReferenceFormatter): void;     // HOOK-DOC-02
  registerLibraryPolicy(p: LibraryPolicy): void;           // HOOK-LIB-01
  registerMergeEligibility(fn: MergeEligibility): void;    // HOOK-LIB-02; (a: DocumentMeta, b: DocumentMeta) => boolean
  registerSecretScanner(s: SecretScanner): void;           // HOOK-PUB-03
  registerPrePublishPolicy(fn: PrePublishPolicy): void;    // HOOK-PUB-05
  registerSettingsExtension(ext: SettingsExtension): void; // HOOK-CFG-01; shape defined in 12
  enableUiFeatures(f: UiFeature[]): void;                  // HOOK-UI-01
  registerNotificationPolicy(p: NotificationPolicy): void; // HOOK-UI-03; {hideTitle: boolean}, 11

  // Lookups
  llm(): LLMProvider;                         // uses settings llm.provider
  resolvers(): readonly SourceResolver[];     // sorted by priority desc, then registration order
  extractors(): readonly Extractor[];
  publisher(id: string): Publisher;
  publishers(): readonly { id: string; available: boolean }[];
  auth(): AuthBroker;                         // never null; public returns PublicAuthBroker
  mcp(): McpClient | undefined;               // undefined in the public edition
  promptPolicy(): PromptPolicy;
  laneRouter(): LaneRouter;
  stagingPolicy(): StagingPolicy;
  networkConfigurator(): NetworkConfigurator;
  loginSignatures(): readonly LoginSignature[];
  pipelinePolicy(): PipelinePolicy;
  docTheme(): DocTheme;
  referenceFormatter(): ReferenceFormatter;
  libraryPolicy(): LibraryPolicy;
  mergeEligibility(): MergeEligibility;
  secretScanner(): SecretScanner;
  prePublishPolicy(): PrePublishPolicy;
  notificationPolicy(): NotificationPolicy;   // public default {hideTitle:false}
  info(): EditionInfo;
  freeze(): void;                             // after bootstrap; later register* throws
}

export interface EditionInfo {
  edition: Edition;
  version: string;                            // app.getVersion(), for Settings > About (11 §7)
  overlayLoaded: boolean;
  overlayName?: string;                       // display name supplied by the overlay (HOOK-UI-02)
  llmProviders: { id: string; available: boolean }[];
  publishers: { id: string; available: boolean }[];
  uiFeatures: UiFeature[];
  authAvailable: boolean;                     // auth().status().state !== 'unavailable'
}

/** Contract a private overlay module must default-export. */
export interface EditionOverlay {
  apiVersion: number;                          // must equal OVERLAY_API_VERSION
  name: string;
  register(reg: CapabilityRegistry): void | Promise<void>;
}
```

The policy types are defined in their owning modules (column "Owner" of the hook index) and
exported through each module's `index.ts`. `AuthBroker` and `AuthStatus` come from
`src/main/sources/auth.ts` (03 §12, where HOOK-AUTH-01 is defined); there is no separate
`AuthCapability` type, and 13's `describeAuthContract` tests `AuthBroker`. There is no untyped
`registry.get(key)`: every overlay seam is one of the typed slots above (05's
`fetch.loginSignatures` is `loginSignatures()`).

Rules:

- Registering an ID that already exists **replaces** it (this is how an overlay swaps a stub for a
  real implementation). Replacement is logged at info level with the ID only. A single-slot policy
  `register*` replaces the public default the same way.
- `registerPublicCapabilities()` registers a public default for **every** slot, so every lookup
  returns a value in both editions and callers never null-check.
- A stub counts as `available: false` in `EditionInfo`. Stubs are marked by a `readonly stub = true`
  property on the instance.
- **Resolver order.** `resolvers()` sorts by priority descending, then registration order. Public
  defaults: `ticket` 40, `mcp` 30, `url` 20, `file` 10, `clipboard` 10. A resolver replacing an
  existing ID keeps that ID's priority unless `opts.priority` is given. A new overlay resolver with
  no priority gets 25 (after `mcp`, before `url`). This is the "insert before url" rule 03 relies
  on; lane routing (HOOK-SRC-03) decides which resolver is offered a URL at all.
- **Missing API key.** `llm()` does not check keys; with an unregistered or stub provider it throws
  `NotAvailableInEdition`. The key check is a pre-check: the pipeline (before `generating`) and
  the IPC layer (`eli5:jobs:start`, section actions, `eli5:llm:test-connection`) return
  `E_NO_API_KEY` when the Keychain has no key for `llm.provider`. If a provider nevertheless finds
  no key at call time, it raises `LLMError('auth')` (02 §4), which maps to `E_NO_API_KEY` at the
  IPC boundary.
- The registry is a process singleton in main; it is never exposed to renderers. Renderers see only
  `EditionInfo`.

### 6.3 Bootstrap order

1. `config/` loads settings from disk (schema defaults applied).
2. `registerPublicCapabilities(registry)` registers all public implementations, all stubs
   (`bedrock.stub.ts`, `mcp.stub.ts`, `ticket.stub.ts`, `drive.stub.ts`, `git.stub.ts`) and the
   public default for every policy slot in §6.2.
3. If `__ELI5_EDITION__ === 'enterprise'`: load the overlay (§6.5) and call `register()`.
   The overlay may replace stubs and policy defaults, add resolvers, register auth, extend
   settings, enable UI features (hook index, §6.1).
4. `config/` re-validates settings against the (possibly extended) schema.
5. `registry.freeze()`.
6. IPC handlers are registered; windows and Tray are created.

A failure in step 3 is fatal in an enterprise build: the app shows a single error window with the
message and the overlay path, and does not start with a partial capability set.

### 6.4 `NotAvailableInEdition`

```ts
// src/main/editions/errors.ts
export class NotAvailableInEdition extends Error {
  readonly code = 'E_NOT_AVAILABLE_IN_EDITION' as const;
  constructor(
    readonly capability: string,   // e.g. "publisher:drive", "llm:bedrock", "source:mcp"
    readonly hookId: string,       // e.g. "HOOK-PUB-01"
    readonly edition: Edition,
  ) {
    super(`${capability} is not available in the ${edition} edition.`);
    this.name = 'NotAvailableInEdition';
  }
}
```

- Every stub method throws this error; stubs contain no partial logic and no network calls.
- The IPC layer maps it to `IpcError {code:'E_NOT_AVAILABLE_IN_EDITION', capability, hookId}`.
- In the pipeline, a source whose resolver throws it becomes a `SkippedSource` with reason
  "Requires the enterprise edition" (03, 06); the job continues.
- The UI never shows a raw hook ID to users; it is for logs and support only.

### 6.5 Private overlay loading

<!-- hook:HOOK-CFG-02 -->
> **Private hook · HOOK-CFG-02 · Edition build flag and overlay loading.** Public behavior:
> `ELI5_EDITION` defaults to `public`; the overlay import resolves to the empty module
> `src/main/editions/overlay.none.ts`, no private code is bundled, all enterprise capabilities are
> stubs that throw `NotAvailableInEdition`. Private binding supplies: the overlay directory location
> and how it is obtained (private repository, submodule or checkout step), the overlay entry file
> and its `EditionOverlay.name`, the list of capabilities it registers, mapped to every hook in the
> §6.1 hook index (HOOK-LLM-01/02, HOOK-AUTH-01, HOOK-SRC-01..05, HOOK-FETCH-01/02, HOOK-PIPE-01,
> HOOK-DOC-01/02, HOOK-LIB-01/02, HOOK-PUB-01..05, HOOK-CFG-01/03, HOOK-UI-01..03 and
> HOOK-TEST-01/02) with the registry slot used for each, extra runtime
> dependencies the overlay needs, enterprise packaging identity (app ID, product name suffix,
> signing identity, notarization credentials source, distribution channel), and the CI job that
> produces the enterprise build. Binding lives in the private spec under "HOOK-CFG-02".

The overlay is bundled at **build time**, not loaded from disk at runtime. This keeps code signing
and ASAR integrity intact and means a public binary contains no loader that could be pointed at
arbitrary code.

Algorithm (in `config/electron.vite.config.ts`, main build):

1. `edition = process.env.ELI5_EDITION ?? 'public'`. Any other value → build error.
2. `define: { __ELI5_EDITION__: JSON.stringify(edition) }`.
3. If `edition === 'public'`: alias `@eli5/overlay` → `src/main/editions/overlay.none.ts`
   (`export default null`).
4. If `edition === 'enterprise'`:
   1. `dir = path.resolve(process.env.ELI5_OVERLAY_DIR ?? './enterprise/')`.
   2. Require `dir/index.ts` to exist, else fail the build with
      "Enterprise build requires an overlay at <dir>/index.ts (set ELI5_OVERLAY_DIR)".
   3. Alias `@eli5/overlay` → `dir/index.ts`. The overlay may import public modules only through
      the alias `@eli5/public/*` → `src/main/*/index.ts` (no deep imports). One test-only exception:
      the fixture overlay (13 §10.1) imports `@eli5/public/llm/testing/fake`, because
      `src/main/llm/index.ts` leaves `FakeProvider` out so package bundles never contain it.
5. `src/main/editions/load-overlay.ts`:
   ```ts
   import overlay from '@eli5/overlay';
   export async function loadOverlay(reg: CapabilityRegistry): Promise<void> {
     if (__ELI5_EDITION__ !== 'enterprise') return;
     if (!overlay) throw new Error('Enterprise build without overlay');
     if (overlay.apiVersion !== OVERLAY_API_VERSION)
       throw new Error(`Overlay API ${overlay.apiVersion} != ${OVERLAY_API_VERSION}`);
     await overlay.register(reg);
   }
   ```
6. The renderer and doc-runtime builds receive only `__ELI5_EDITION__`; they never import overlay
   code. Enterprise UI is driven by `EditionInfo.uiFeatures` at runtime (HOOK-UI-01).

Repository hygiene:

- `enterprise/` must be listed in `.gitignore` (add it when scaffolding). The public repo never contains overlay code, overlay
  configuration, or organization names.
- CI for the public repo builds and tests only `ELI5_EDITION=public`, and additionally runs a check
  that the public bundle contains no string from a deny-list file supplied via CI secret (optional;
  defined in 13).
- Public unit tests exercise the overlay path with a fixture overlay in
  `test/fixtures/overlay-fake/` that registers fake implementations (13).

## 7. Dependencies

Runtime dependencies are kept small; each one needs a row here. Versions: current stable at
scaffold time, pinned via lockfile.

| Package | Where | Why |
| --- | --- | --- |
| `electron` | dev (runtime host) | App shell, Chromium for viewer and hidden-window fetch fallback; no separate browser (PRD *Fetching strategy*) |
| `react`, `react-dom` | renderer | App UI (decided stack) |
| `@anthropic-ai/sdk` | main/llm | Claude provider (02) |
| `openai` | main/llm | OpenAI provider (02) |
| `zod` | main (config, ipc) | Settings schema and IPC payload validation, one schema source |
| `@mozilla/readability` | main/fetch | Readability-style article extraction (05) |
| `jsdom` | main/fetch (Readability `worker_threads` only) | DOM for Readability (05). Externalized from the Vite main bundle and loaded only inside the worker. Readability must run on jsdom, not linkedom, because Readability is tested against jsdom |
| `linkedom` | main/extract, main/document | HTML-to-blocks (04 `htmlToBlocks`) and SVG sanitizing (07) |
| `tldts` | main/fetch | Registrable-domain and public-suffix parsing (05) |
| `marked` | main/extract | Markdown → HTML before `htmlToBlocks` (04) |
| `jszip` | test fixture generators (13) | Writes the synthetic OOXML fixtures. Runtime OOXML reads go through the in-repo `SafeZip` reader (04 §10.3), which checks sizes before inflating; `mammoth` brings its own copy |
| `fast-xml-parser` | main/extract | Parse slide XML, speaker notes (04) |
| `mammoth` | main/extract | `.docx` → structured HTML preserving headings, lists, tables (04) |
| `pdfjs-dist` | main/extract, pdf-render window | Text with page order; render scanned pages to images for vision (04) |
| `xlsx` (SheetJS CE) | main/extract | Spreadsheet reading (04). Installed from the SheetJS CDN tarball URL, pinned by `integrity` in the lockfile (the npm registry copy is outdated) |
| `d3-scale`, `d3-shape`, `d3-format` | main/document | Build-time chart SVG generation; no d3 in generated documents (07) |
| `parse5` | main/document | Spec-compliant HTML parsing for section locate/replace (08); also a test helper (13) |
| `ulid` | main/pipeline | Time-sortable `JobId` (06) |
| `@napi-rs/keyring` | main/config | API keys in macOS Keychain, service "ELI5 Learner" (12). Native, per-arch packages; see §8.3 |

Dev dependencies: `typescript`, `electron-vite`, `vite`, `@vitejs/plugin-react`,
`electron-builder`, `@electron/fuses` (12), `vitest`, `@playwright/test`, `eslint` +
`typescript-eslint` + `eslint-plugin-import`, `prettier`, `rimraf`. `exceljs` is allowed as a dev
dependency for 13's fixture generators only; it is not a runtime dependency (04 rejected it).

Open: 03 reads `NSFilenamesPboardType` from the clipboard, which is a property-list payload. If 03
parses it with a library rather than a small built-in parser, that library gets a row here.

Explicitly **not** used: Puppeteer/Playwright at runtime, any OCR engine, any UI framework inside
generated documents, any analytics or telemetry SDK, `keytar` (archived), `<webview>`.

Adding a runtime dependency requires: a row in this table, a license compatible with the repo
license, and no network activity at import time.

## 8. Build and packaging

### 8.1 Build outputs

`config/electron.vite.config.ts` defines three builds, plus one pre-step (every tool config lives in `config/`):

| Build | Entry | Output | Notes |
| --- | --- | --- | --- |
| doc-runtime (pre-step) | `src/doc-runtime/index.ts`, `index.css` | `build/doc-runtime/runtime.iife.js`, `runtime.css` | Vite library mode, IIFE, ES2020, minified, no imports allowed; imported into main as `?raw` strings. `build/doc-runtime/` is git-ignored |
| main | `src/main/index.ts`, `src/main/extract/worker.ts` | `out/main/index.js`, `out/main/extract-worker.js` (the extract `utilityProcess` entry, 04 §6), plus a `readability.worker` chunk (05 §5.2) | Node target, `@eli5/overlay` alias per §6.5, `__ELI5_EDITION__` and `__ELI5_TEST__` defined; `jsdom` and `@mozilla/readability` externalized (§7) |
| preload | `src/preload/app.ts`, `src/preload/doc.ts` | `out/preload/` | Two entries, CJS (sandboxed preload requirement) |
| renderer | `src/renderer/index.html` | `out/renderer/` | React, `__ELI5_EDITION__` and `__ELI5_TEST__` defined |

Compile-time constants:

| Constant | Source | Values | Use |
| --- | --- | --- | --- |
| `__ELI5_EDITION__` | env `ELI5_EDITION` (§6.5) | `'public'` (default) \| `'enterprise'` | Edition gate |
| `__ELI5_TEST__` | env `ELI5_TEST_BUILD=1` | `true` only in dev and e2e test builds; `false` in every packaged build | Registers the FakeProvider and test-only channels such as `eli5:test:tray-click` (13). With `false`, dead-code elimination removes them from the bundle |

Both are declared once in `src/env.d.ts`, included by both tsconfigs:

```ts
declare const __ELI5_EDITION__: 'public' | 'enterprise';
declare const __ELI5_TEST__: boolean;
```

### 8.2 Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `build:runtime` | `vite build --config config/vite.doc-runtime.config.ts` | doc-runtime pre-step |
| `dev` | `npm run build:runtime && ELI5_TEST_BUILD=1 electron-vite dev` | Public edition, HMR for renderer. A small Vite plugin in the main config rebuilds the runtime on change to `src/doc-runtime/**`, so a clean checkout never hits a missing `?raw` import |
| `build` | `npm run build:runtime && electron-vite build` | Public production build (`__ELI5_TEST__` false) |
| `build:enterprise` | `ELI5_EDITION=enterprise npm run build` | Requires overlay (§6.5) |
| `typecheck` | `tsc --noEmit -p config/tsconfig.node.json && tsc --noEmit -p config/tsconfig.web.json` | Strict TS |
| `lint` | `eslint .` | Includes import boundary rules |
| `test` | `vitest run` | Unit tests (13) |
| `test:e2e` | `ELI5_TEST_BUILD=1 npm run build && playwright test` | Electron e2e via `_electron` against a test build (13) |
| `test:update-goldens` | `ELI5_UPDATE_GOLDENS=1 vitest run` | Rewrites extraction and document goldens (04, 07, 13) |
| `fixtures:build` | `ELI5_WRITE_FIXTURES=1 vitest run test/unit/fixtures/build.test.ts` | Regenerates the synthetic binary fixtures and `test/fixtures/manifest.json` (13 §5) |
| `test:crossbrowser` | `playwright test -c config/playwright.crossbrowser.config.ts` | Golden documents in Chromium and WebKit: smoke, axe, zero-network probe (13 §7.2, §7.3); no app build |
| `test:perf` | `vitest run --project perf` | Extraction RSS budget (13 §13) |
| `test:perf:startup` | `npm run build && playwright test -c test/perf/playwright.perf.config.ts` | Startup time, warning only (13 §13) |
| `test:evals` | `vitest run --project evals:unit` | Offline tests of the eval runner (13 §9) |
| `eval` | `node scripts/eval/run.mjs` | Real, paid generation-quality evals; keys from `ELI5_EVAL_API_KEY_*` only (13 §9) |
| `eval:calibrate` | `node scripts/eval/run.mjs --calibrate` | Judge vs human agreement (13 §9.5) |
| `check:spec` | `node scripts/check-spec-hooks.mjs` | Private-hook marker registry |
| `check:hygiene` | `jiti scripts/check-hygiene.ts` | Public-repo hygiene (13 §11); pass `-- --out out --package` after a build |
| `check:licenses` | `node scripts/check-licenses.mjs` | Runtime dependency licenses; `--audit <file>` for the advisory gate (13 §13) |
| `check:editions` | `node scripts/check-editions.mjs` | Edition cells F, F-missing, P-stub (13 §10) |
| `package` | `rimraf out build/doc-runtime && npm run build && electron-builder --mac dmg --$(node -p process.arch)` | Clean build without `ELI5_TEST_BUILD`, then a dmg for the build machine's architecture only (per-arch keyring, below). The e2e output in `out/` is never packaged |
| `package:arm64` | `rimraf out build/doc-runtime && npm run build && CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dmg --arm64` | Unsigned arm64 dmg on an Apple silicon machine |
| `test:package` | `ELI5_RUN_PACKAGE_TESTS=1 playwright test -c config/playwright.package.config.ts` | Packaged-app bundle checks and launch smoke (13 §11.1); run after `package:arm64` |

### 8.3 Packaging (electron-builder)

```yaml
# config/electron-builder.yml (public)
appId: io.github.eli5-learner
productName: ELI5 Learner
asar: true
asarUnpack: ['**/*.node']
files: ['out/**', 'package.json']
extraResources:
  - { from: resources, to: . }       # prompts/, skills/, help/, pdf-render/ (page, preload, normalizer), tray/ icons
  - { from: node_modules/pdfjs-dist/build, to: pdfjs, filter: [pdf.mjs, pdf.worker.mjs] }  # served as eli5res://pdfjs/ (04 §6.3)
mac:
  target: [{ target: dmg, arch: [arm64, x64] }]
  hardenedRuntime: true
  entitlements: config/packaging/entitlements.mac.plist
  entitlementsInherit: config/packaging/entitlements.mac.plist
  notarize: true                     # effective only when credentials are present (below)
  x64ArchFiles: '**/*.node'          # only for a universal build
```

- **Resources.** Prompts (02), skills (02), the help page (10 §8), the `pdf-render/` page (04 §6.3) and tray
  template images (11 §4) live in the repo's `resources/` and ship via `extraResources`; pdf.js
  (`pdf.mjs`, `pdf.worker.mjs`) is copied from `node_modules/pdfjs-dist/build` to `pdfjs/`. Asset
  generators live in `scripts/` (for example `scripts/generate-tray-icons.mjs`), never in
  `resources/`. Code never builds these paths by hand; it calls
  `resourcePath(rel)` from `src/main/config/paths.ts`, which returns
  `path.join(process.resourcesPath, rel)` when `app.isPackaged` and `path.join(<repo>/resources,
  rel)` in dev.
- **Native keyring.** `@napi-rs/keyring` ships per-arch npm packages
  (`@napi-rs/keyring-darwin-arm64`, `@napi-rs/keyring-darwin-x64`), not one universal binary
  (this corrects 12 §6). `.node` files are unpacked from the ASAR. Default: build **two per-arch
  dmgs**, each on (or with `npm install --cpu=<arch>` for) its own architecture. A `universal`
  build is allowed only when both arch packages are installed explicitly (listed in
  `optionalDependencies`) and `mac.x64ArchFiles` covers the `.node` file.
- **Entitlements.** `config/packaging/entitlements.mac.plist` grants only
  `com.apple.security.cs.allow-jit` (required by V8 under the hardened runtime). No other
  entitlement.
- **Signing and notarization.** Run only when credentials are present: `CSC_LINK` /
  `CSC_KEY_PASSWORD` for signing; `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` (or
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`) for notarization; the dmg is
  stapled after notarization. Public CI produces unsigned artifacts. Users opening an unsigned
  public dmg must use System Settings > Privacy & Security > **Open Anyway** (or
  `xattr -dr com.apple.quarantine "/Applications/ELI5 Learner.app"`); the README says so.
  Enterprise identity is part of HOOK-CFG-02.
- **Fuses.** `@electron/fuses` is applied after packaging as configured in 12. Because
  `GrantFileProtocolExtraPrivileges` is off, builds load the renderer from `eli5app://app/index.html`
  (12 §7.7), never `file://`. An unsigned Apple silicon build is ad-hoc re-signed after the fuses
  flip (`resetAdHocDarwinSignature`), or macOS kills it at launch.
- Minimum macOS: the oldest version supported by the chosen Electron release.
- `enterprise/`, `spec/`, `docs/`, tests and `build/doc-runtime/` are never in `files`.
- `LSUIElement` stays false (the app has a Dock icon while the window is open; Tray behavior in 11).
- No auto-updater in v1.

### 8.4 Library root location

The PRD places documents in the app project directory under `docs/`. At runtime the library root
is resolved by `library/` (09 §3): in `dev` it is the gitignored `<repo>/.library/` (never `docs/`, which is the
public Pages source); in a packaged app it is `app.getPath('userData')/docs/`. The `eli5doc://` handler
serves only from this root.

**Deviation from PRD wording (Document location row):** packaged builds store the library in
`~/Library/Application Support/ELI5 Learner/docs` because the signed .app bundle is read-only.
Proposed PRD amendment: "App data directory (the repo `docs/` directory in development)". Tracked
as an open item until the PRD is updated.

## 9. Error handling and edge cases

| Case | Behavior |
| --- | --- |
| Second app launch | `requestSingleInstanceLock` fails → focus existing window, exit |
| Main window closed during a job | Job continues; Tray updates on completion |
| Quit with jobs running | Tray Quit proceeds; running and queued jobs are persisted and resume on the next launch from their last checkpoint (06 §9); partial files are never written (atomic writes, 09). The Tray shows "Quit (N jobs will resume)" (11) |
| Renderer crash (`render-process-gone`) | Reload the renderer; jobs in main are unaffected; status re-fetched via `eli5:jobs:list` |
| Viewer crash | Reload the current document URL once; on second crash show "Could not display this document" in the viewer slot |
| Extract worker crash or timeout | That source becomes a `SkippedSource`; the worker is restarted for the next source (04 §10.4) |
| IPC payload invalid | `E_BAD_REQUEST`, logged with channel name only (never payload contents) |
| IPC from wrong sender | `E_FORBIDDEN` |
| Stub invoked | `NotAvailableInEdition` → `E_NOT_AVAILABLE_IN_EDITION` |
| No API key for `llm.provider` | Pre-check returns `E_NO_API_KEY` (§6.2); the job is not started |
| Overlay missing/mismatched in enterprise build | Build error, or fatal startup error window (§6.3) |
| Unknown `ELI5_EDITION` | Build error |
| Document requests remote resource | Blocked by viewer CSP; document still renders |
| Link click in document | `http(s)` → default browser; other schemes ignored |

Logging: main writes JSON lines to `<userData>/logs/main.log` with rotation (12 §11). It never
contains API keys, source content, or LLM prompts/responses; only stage names, durations, error
codes and IDs.

## Out of scope and future work

Each PRD "Out of scope for v1" and "Future enhancements" item, its v1 status, and the seam later
work plugs into:

| PRD item | v1 status | Future seam |
| --- | --- | --- |
| Cloud drive and git (GitHub Pages) publishing | Documented stubs only (HOOK-PUB-01..04); `local` export works | Enterprise overlay publishers (10) |
| Google Drive publishing | Not built | A new `Publisher` implementation registered with `registerPublisher` (10 §3.1) |
| NotebookLM linking | Not built | A new `Publisher` implementation (10 §3.1) |
| Git style version history per section (view, diff, roll back) | Not built | `SectionId` stability plus the per-document actions log (08 §10) |
| Moving documents into other monorepo projects / choosing a destination project per document | Single library root | `resolveLibraryRoot` (09 §3) |
| Any authentication or login flows | Permanent in v1 (public build) | Enterprise only, through the MCP server (HOOK-AUTH-01) |
| Speech to text and audio input | Removed in all editions | None |

## Acceptance criteria

- [ ] `src/` matches the module map in §3; each `src/main/*` module exposes a single `index.ts`.
- [ ] Lint fails on any renderer or doc-runtime import from `src/main`, and on cross-module deep imports.
- [ ] All windows use `contextIsolation`, `sandbox`, `nodeIntegration:false`; the viewer loads only `eli5doc://` URLs from the library root.
- [ ] Closing the main window keeps the app running; Quit is only in the Tray menu.
- [ ] Only main posts native notifications: one per finished `create` job when `notifications.enabled`, wired by bootstrap (`shell` never imports `pipeline`).
- [ ] Every channel in §5.2 is declared in `src/preload/contract.ts`, validated in main, and returns `IpcResult<T>`; no other channels exist.
- [ ] Doc channels reject calls from the app renderer and vice versa.
- [ ] `npm run build` with no env produces a public build; the bundle contains no overlay code.
- [ ] Public build: `eli5:edition:info` reports `edition:'public'`, `overlayLoaded:false`, `bedrock`/`drive`/`git`/`mcp` as unavailable, no UI features.
- [ ] Calling any stub returns `E_NOT_AVAILABLE_IN_EDITION` with the correct `hookId`.
- [ ] `ELI5_EDITION=enterprise` without an overlay fails the build with the documented message.
- [ ] `ELI5_EDITION=enterprise ELI5_OVERLAY_DIR=test/fixtures/overlay-fake` builds, loads the fixture, replaces stubs, and reports `overlayLoaded:true`.
- [ ] Overlay `apiVersion` mismatch prevents startup with a clear error.
- [ ] Registry is frozen after bootstrap; late registration throws.
- [ ] Every registry slot in §6.2 has a public default; each lookup returns a value in the public build, and `auth().status().state` is `'unavailable'`.
- [ ] `resolvers()` returns `ticket`, `mcp`, `url`, then `file`/`clipboard` by default priority; an overlay resolver without a priority sorts between `mcp` and `url`.
- [ ] Every hook ID defined anywhere in `spec/tech/` appears in the §6.1 hook index.
- [ ] A missing API key yields `E_NO_API_KEY` from `eli5:jobs:start` without creating a job.
- [ ] `npm run package` produces a dmg that launches, shows the Tray item, loads prompts, skills and tray icons via `resourcePath()`, reads the Keychain through the unpacked `.node`, and generates a document with only an API key configured.
- [ ] The packaged bundle contains no `__ELI5_TEST__` code (no FakeProvider, no `eli5:test:*` channel); a clean checkout runs `npm run dev` without a missing-runtime error.
- [ ] `enterprise/` and `build/doc-runtime/` are git-ignored and excluded from packaged files.
- [ ] Every runtime dependency in `package.json` appears in §7; `exceljs` is not a runtime dependency.
- [ ] HOOK-CFG-02 is bound in the private spec.
