# Library, storage, and merge suggestions

This file specifies how finished learnings are stored on disk and how the app lists, updates and merges them. It covers where the library root lives in development and in a packaged app, the directory layout (`catalog.json`, `<topic-slug>/index.html` and `meta.json`, plus hidden housekeeping folders), the JSON schemas for `CatalogEntry` and `DocumentMeta` with versioning and migrations, slug rules and collisions, atomic writes and locking, rebuilding the catalog from folders, the menu bar recents list, and the post-generation merge suggestion feature (matching algorithm, threshold, `MergeSuggestion` lifecycle and persistence, accept and dismiss). It implements PRD "Library, storage, and merge suggestions" and the Library-related parts of PRD "App shell and layout" (Library sidebar, menu bar list, suggestions area) and "Build editions and swap seams" (Document location row). Code lives in `src/main/library/`. HTML mechanics (rendering, section IDs, splicing) belong to [07](07-output-document.md) and [08](08-interactive-reading.md); this module owns the files, the catalog and the merge flow.

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) · [05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [08-interactive-reading.md](08-interactive-reading.md) · [10-publishing.md](10-publishing.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Principles

1. **The folder is the truth, the catalog is an index.** Each `<root>/<topic-slug>/meta.json` holds everything needed to rebuild that document's `CatalogEntry`. `catalog.json` can always be rebuilt from the folders without reading any `index.html`.
2. **Nothing is re-read to list or compare.** The Library sidebar, the menu bar list and merge matching read `catalog.json` only (PRD "Library, storage, and merge suggestions").
3. **Every write is atomic.** A crash or quit at any point leaves each file either old or new, never partial.
4. **One writer per document at a time.** All writes to a document folder go through `withDocLock(slug)`.
5. **Merge never gates generation.** The merge check runs after the save commits and never affects the job's status (PRD "Post generation merge suggestions", step 3).

## 2. Module files

| File | Responsibility |
| --- | --- |
| `src/main/library/root.ts` | `resolveLibraryRoot()`, first-run creation |
| `src/main/library/schema.ts` | zod schemas and TS types: `CatalogEntry`, `CatalogFile`, `DocumentMeta`, `MergeSuggestion`, `SuggestionsFile` |
| `src/main/library/migrations.ts` | Per-file migration chains |
| `src/main/library/fs-atomic.ts` | `writeFileAtomic`, `renameDirAtomic`, `fsyncDir` |
| `src/main/library/locks.ts` | `AsyncMutex`, `withDocLock`, `withCatalogLock`, `withSuggestionsLock`, process lock file |
| `src/main/library/slug.ts` | `slugify`, `allocateSlug`, reservations |
| `src/main/library/catalog.ts` | Load, validate, upsert, remove, rebuild and reconcile |
| `src/main/library/library.ts` | `Library` facade used by the pipeline, document, publish and tray modules |
| `src/main/library/merge/similarity.ts` | Lexical prefilter (`SimilarityScorer`) |
| `src/main/library/merge/check.ts` | `runMergeCheck(docId)` |
| `src/main/library/merge/suggestions.ts` | Suggestion store, lifecycle, accept and dismiss |
| `src/main/library/protocol.ts` | `eli5doc://` handler that serves files under the root ([01](01-architecture.md) §3) |
| `src/main/ipc/library.ts` | Library and suggestions IPC handlers (under `src/main/ipc/` with the other handlers, which avoids an import cycle) |

## 3. Library root location

The PRD puts documents in "the app's own project directory" in both editions (PRD "Build editions and swap seams", Document location row; PRD "Library, storage, and merge suggestions"). A packaged `.app` bundle is read-only and code-signed. Writing inside it would break the signature and be lost on update, so "project directory" cannot mean the bundle. Resolution: the library is the app's own per-user data directory when packaged, and a gitignored `<repo>/.library/` directory in development. The repo's `docs/` folder is the GitHub Pages source, so it is **not** the default dev root: generated learnings built from possibly private material must never sit one `git add -f` or one `.gitignore` edit away from publication. Using `docs/` is an explicit opt-in (§3.2). [01](01-architecture.md) §8.4 records the packaged-app decision.

### 3.1 `resolveLibraryRoot()`

1. If env `ELI5_LIBRARY_DIR` is set and is an absolute path, use it. This is for tests ([13](13-testing-quality.md)) and power users. A relative path is rejected with a startup error.
2. Else if `!app.isPackaged`, use `<repo>/.library/`, where `<repo>` is `app.getAppPath()` resolved to the project root by electron-vite dev. `.library/` must be listed in `.gitignore` (add it when scaffolding, next to `enterprise/`); startup logs a warning in dev if `git check-ignore` does not report it as ignored.
3. Else use `path.join(app.getPath('userData'), 'docs')`, which resolves to `~/Library/Application Support/ELI5 Learner/docs/`.
4. `mkdir -p` the root, the hidden folders (§4), and `catalog.json` (empty, §5.1) if missing.
5. `realpath` the result once and cache it. The `eli5doc://` handler and every library path check compare against this real path.

The resolved root is shown read-only in Settings with a "Reveal in Finder" button ([11](11-app-shell-ui.md), channel `eli5:library:info`). Choosing a different destination per document (monorepo projects) is PRD future work and not in v1.

<!-- hook:HOOK-LIB-01 -->
> **Private hook · HOOK-LIB-01 · Enterprise library storage policy.** Public behavior: the library root is resolved as in §3.1; documents are plain files protected only by the user account and the operating system's disk encryption; trash and resolved suggestions are kept 30 days (§9). Private binding supplies: whether the enterprise build pins or restricts the library root, required at-rest protection for documents built from organization sources, retention periods for `.trash/` and staging, and whether `meta.json` may record source URLs or only redacted forms. Binding lives in the private spec under "HOOK-LIB-01".

### 3.2 Opt-in: library inside the repo's `docs/`

A developer may point the library at the repo's Pages folder explicitly with `ELI5_LIBRARY_DIR=<absolute path to repo>/docs` (for example, to preview the Pages layout). This is never the default. That folder also holds the committed public Pages files (`docs/index.html`, `docs/.nojekyll`, `docs/sample/`), so whenever the resolved root contains foreign files the library:

- ignores any folder without a valid `meta.json` (§7), so `sample/` is never listed;
- never writes, renames or deletes a folder it did not create (a folder is "ours" only if its `meta.json` parses);
- treats `index.html` at the root as foreign and never touches it;
- reserves the slugs in §6.3 so a generated document can never shadow a Pages file (the reservation applies in every mode).

Everything the library writes there is covered by the existing `docs/*` rule in `.gitignore`. The housekeeping folders (`.staging/`, `.trash/`, `.eli5/`) are also covered, but they then live inside the Pages source tree, which is one more reason this mode is opt-in only. Startup logs a warning when the resolved root is inside a git work tree and is not ignored.

## 4. Directory layout

```
<library-root>/                     # dev: <repo>/.library   packaged: <userData>/docs   override: ELI5_LIBRARY_DIR
  catalog.json                      # CatalogFile (§5.1)
  <topic-slug>/                     # one folder per learning
    index.html                      # self-contained document (07)
    meta.json                       # DocumentMeta (§5.2)
  .staging/<jobId>/                 # save staging, owned by the pipeline (06 §5.7)
  .trash/<slug>--<yyyymmddThhmmss>/ # folders removed by merge, plus pre-merge backups (§10.6)
  .eli5/
    suggestions.json                # SuggestionsFile (§9.3)
    library.lock                    # process lock (§8.4)
```

Rules:

- A document folder name equals its `topicSlug`, and slugs never change after creation. There is no rename in v1.
- Names beginning with `.` are housekeeping. They are never listed, served by `eli5doc://`, or published.
- `.staging/` and `.trash/` live under the root so the final `rename` stays on one volume and is atomic.
- Temporary files use the suffix `.tmp-<pid>-<8 hex>` next to their target (§8.1). Reconciliation deletes leftover temp files that are older than 1 hour.

## 5. Schemas

All on-disk JSON is validated with zod on read. Types are exported from `schema.ts` and are inferred from the zod schemas (`z.infer`), so the TS types and runtime checks cannot drift. Timestamps are ISO 8601 UTC strings with milliseconds. IDs are `crypto.randomUUID()`.

### 5.1 `catalog.json`

```ts
export const CATALOG_SCHEMA_VERSION = 1;

export interface CatalogFile {
  schemaVersion: number;           // CATALOG_SCHEMA_VERSION when written
  appVersion: string;              // app version that last wrote the file (diagnostics only)
  updatedAt: string;
  entries: CatalogEntry[];         // stored newest-first by createdAt; readers must not rely on order
}

export interface CatalogEntry {
  id: string;                      // UUID, stable for the life of the document; equals DocumentMeta.id
  title: string;                   // topic title, 1..200 chars
  topicSlug: string;               // folder name (§6)
  createdAt: string;               // when the document was first saved (job done)
  updatedAt: string;               // last write to index.html or meta.json (regenerate, tab close, merge)
  summary: string;                 // 1-2 sentences, <= 300 chars, generated at creation (02 SummaryDraft)
  summarySource: 'llm' | 'fallback'; // 'fallback' when the summary step degraded (06 §7.1)
  tabCount: number;                // tabs in the document, for display only
  mergedFromCount: number;         // number of documents merged into this one (0 for new)
}
```

The PRD requires id, title, topic slug, created and updated timestamps, and summary. `summarySource`, `tabCount` and `mergedFromCount` are cheap display and matching aids. None of them requires reading `index.html`.

### 5.2 `meta.json`

```ts
export const META_SCHEMA_VERSION = 1;   // every field below, including those owned by 07, 08 and 10, is part of v1

export interface DocumentMeta {
  schemaVersion: number;
  id: string;                      // equals CatalogEntry.id
  topicSlug: string;
  title: string;
  summary: string;                 // copy of the catalog summary, so a rebuild needs no LLM call
  summarySource: 'llm' | 'fallback';
  createdAt: string;
  updatedAt: string;
  jobId: string;                   // creating job, used by pipeline crash recovery (06 §9.4)
  edition: Edition;                // edition that created it: 'public' | 'enterprise'
  clarifyingInput: string;         // verbatim; '' when none
  glossaryEnabled: boolean;
  sourcesUsed: SourceRecord[];
  sourcesSkipped: SkippedSource[]; // {ref, reason, code} from 03 (SkipCode)
  tabs: TabRecord[];               // current tab list, in display order
  retiredIds: SectionId[];         // IDs of closed tabs' sections, never reused (07 §4.3); default []
  generation: {
    provider: string;              // ProviderId (02)
    model: string;
    prompts: string[];             // "id@version" per prompt used (02 §9)
  };
  warnings: JobWarning[];          // {kind, message} from 06, e.g. kind 'glossary-omitted'
  merges: MergeRecord[];           // [] unless other documents were merged in (§10)
  actions?: ActionRecord[];        // section-action log, owned by 08 §6.6; stores no content
  publications: PublicationRecord[]; // from 10 §3.2; default []
}

export interface ActionRecord {    // shape owned by 08 §6.6
  at: string;
  action: MenuAction;              // from 08
  sectionId: SectionId;
  tabKey: string;
  note?: string;
  jobId: string;
  resultTabKey?: string;           // set for 'eli5-tab'
}

export interface SourceRecord {
  ref: string;                     // display reference: file basename, URL, or "Pasted image 1"
  kind: 'file' | 'clipboard' | 'url' | 'mcp';
  mimeType?: string;
  sha256?: string;                 // of the snapshot bytes, for files and clipboard items
  origin?: string;                 // e.g. 'merge:<sourceDocId>' when it arrived via a merge
}

export interface TabRecord {
  key: string;                     // tab key used in SectionIds: 'indepth', 'eli5', or 'sx' + 6 hex, e.g. 'sx4e1a07' (07 §4.1)
  kind: 'indepth' | 'eli5' | 'section-eli5'; // Tab['kind'] from 07
  label: string;                   // e.g. 'ELI5: Revenue recognition'
  sectionCount: number;
  sourceSectionId?: SectionId;     // section-eli5 only: the section it was made from (08 §6.6)
  createdAt: string;               // when the tab was added; for tabs of a document created before 08 wrote it, reconcile fills meta.createdAt
}

export interface MergeRecord {
  suggestionId: string;
  sourceDocId: string;
  sourceTitle: string;
  sourceSlug: string;
  sourceSummary: string;
  mergedAt: string;
  anchorSectionIds: SectionId[];   // the marker sections inserted by the merge (§10.3)
}
```

Schema ownership and strictness:

- The library owns the file, the zod schema and every write. Sibling modules own the meaning of their fields: `retiredIds` ([07](07-output-document.md) §4.3), `actions` and `TabRecord.sourceSectionId` / `createdAt` ([08](08-interactive-reading.md) §6.6), `publications` ([10](10-publishing.md) §3.2), `warnings` ([06](06-generation-pipeline.md) `JobWarning`), `sourcesSkipped` ([03](03-source-resolvers.md) `SkippedSource`).
- The zod object for `DocumentMeta` is **not strict**: it uses `.passthrough()`, so an unknown field written by a sibling or a newer minor build is preserved on read-modify-write, never rejected or dropped. Array fields with defaults (`retiredIds`, `publications`) use `.default([])`, so a file that lacks them still validates.
- These are all v1 fields. Adding a new required field or changing a field's shape bumps `META_SCHEMA_VERSION` and adds a migration (§5.3).

Privacy rules for `meta.json`:

- Local file paths are stored as **basename only**. An absolute path would leak the user's home folder name if the folder is ever shared or published ([10](10-publishing.md)).
- URLs are stored without fragment. Query strings are kept only for the public lane. Anything the MCP lane resolved is recorded as its display reference ([03](03-source-resolvers.md)), subject to HOOK-LIB-01 and HOOK-SRC-03.
- No source text, extracted content or credentials are ever written to `meta.json`.

`meta.json` is written by the library only. The pipeline, section jobs and merge flow pass a `DocumentMeta` or a patch function. Every write updates `updatedAt` in both `meta.json` and the catalog entry.

### 5.3 Versioning and migrations

Each file type (`catalog`, `meta`, `suggestions`) has an integer `schemaVersion` and a migration chain in `migrations.ts`:

```ts
type Migration = { from: number; to: number; up(raw: unknown): unknown };
export const metaMigrations: Migration[] = [];      // v1: empty
export const catalogMigrations: Migration[] = [];
export const suggestionsMigrations: Migration[] = [];
```

Read algorithm (`readVersioned(path, schema, chain, current)`):

1. Read and `JSON.parse`. On a parse error go to step 6.
2. If `raw.schemaVersion` is missing, treat it as version 1 (the first shipped version).
3. If `raw.schemaVersion > current`, the file was written by a newer app. Return the data read-only after validating it with `.passthrough()` on the current schema. The library enters **read-only mode** (§8.5).
4. If `raw.schemaVersion < current`, apply the chain in order. A missing step is a fatal error for that file (step 6). After success, copy the original once to `<file>.v<old>.bak` and write the migrated file atomically.
5. Validate with zod. On success return the data.
6. On failure, rename the file to `<file>.corrupt-<timestamp>` and report it. For `catalog.json`, rebuild (§7). For `meta.json`, skip that folder in listings and log `LIB_META_INVALID {slug}`, and the document stays on disk untouched. For `suggestions.json`, start empty.

Migrations are pure functions over plain JSON and are unit-tested with fixture files per version ([13](13-testing-quality.md)).

## 6. Slugs

### 6.1 `slugify(input)`

1. Input is `SummaryDraft.topicSlugHint` when present and non-empty after slugifying, else the title ([06](06-generation-pipeline.md) §5.5).
2. Unicode NFKD, strip combining marks, lowercase.
3. Replace `&` with ` and `, then every run of characters outside `[a-z0-9]` with `-`.
4. Trim `-` from both ends. Collapse repeats.
5. If longer than 60 characters, cut at the last `-` at or before 60. If there is none, hard cut at 60. Trim again.
6. If empty (for example, a title in a non-Latin script), use `learning-<yyyymmdd>`.

Examples: `"ROAS & Marketing Mix Models"` → `roas-and-marketing-mix-models`; `"Q3 FY26 Revenue Recognition (ASC 606)"` → `q3-fy26-revenue-recognition-asc-606`.

### 6.2 `allocateSlug(title, hint?)`

The pipeline calls this at the start of saving ([06](06-generation-pipeline.md) §5.5).

1. `base = slugify(hint ?? title)`. If `base` is reserved (§6.3), use `base + '-doc'`.
2. Candidate `base`, then `base-2`, `base-3`, and so on.
3. A candidate is taken if any of these is true: a directory entry with that name exists under the root (compared **case-insensitively**, because APFS is case-insensitive by default), a catalog entry has that slug, or it is in the in-memory reservation set.
4. Add the first free candidate to the reservation set and return `SlugReservation {slug, release()}`.
5. The reservation is released when `commitDocument` succeeds (the folder now exists) or when the caller calls `release()` on failure or cancellation.
6. After `-999`, append `-<8 hex>` from `randomUUID`.

Reservations are in memory only. After a crash, pipeline recovery re-derives the slug from `checkpoint.topicSlug` and checks the folder ([06](06-generation-pipeline.md) §9.4). Allocation is inside `withCatalogLock` so two concurrent saves can never get the same slug.

### 6.3 Reserved slugs

`catalog`, `index`, `sample`, `assets`, `static`, `api`, `docs`, and any name starting with `.`. `sample` protects the committed Pages sample when the root is the opt-in `docs/` (§3.2).

## 7. Catalog reconciliation and rebuild

`reconcile()` runs at startup before the Library is shown, after any `catalog.json` read failure, and on demand from tests. It reads only `meta.json` files, never `index.html` (PRD: no document is re-read to list).

1. `readdir(root, {withFileTypes:true})`. Keep directories whose names do not start with `.`.
2. For each, `stat` `index.html` and read `meta.json` via §5.3. Skip folders missing either, or with invalid meta. Log them and do not touch them.
3. If `meta.topicSlug !== folderName`, the folder name wins. Patch `meta.topicSlug` (the user may have renamed the folder in Finder).
4. **Duplicate IDs** (the user copied a folder): the folder with the earliest `createdAt` keeps the ID. Each other one gets a new UUID written to its `meta.json`.
5. Build `CatalogEntry` from each meta: `{id, title, topicSlug, createdAt, updatedAt, summary, summarySource, tabCount: tabs.length, mergedFromCount: merges.length}`.
6. Compare with the loaded catalog:
   - An entry with no valid folder is dropped (removed externally).
   - A folder with no entry is added. This covers the crash window between the folder rename and the catalog upsert ([06](06-generation-pipeline.md) §5.7 step 4).
   - Where both exist, meta wins for every field.
7. If anything changed, write `catalog.json` atomically, then emit `changed`.
8. Delete `.tmp-*` files older than 1 hour. Purge `.trash/` entries older than the retention period (§9). Run suggestion validation (§9.4).

Complexity is O(n) small JSON reads. It runs in under 200 ms for 1,000 documents on a local SSD, which is acceptable at startup. v1 has no file watcher. External edits are picked up on the next launch.

## 8. Atomic writes and locking

### 8.1 `writeFileAtomic(target, data)`

1. `tmp = target + '.tmp-' + pid + '-' + hex8`, in the same directory.
2. `open(tmp, 'wx', 0o600)`, write all bytes, `fsync(fd)`, `close`.
3. `rename(tmp, target)`. This is atomic on the same volume under POSIX.
4. `fsync` the parent directory (open it read-only and fsync). Failures here are logged, not thrown, since some filesystems don't support directory fsync.
5. On any error before step 3, `unlink(tmp)` best-effort and rethrow `LibraryError('WRITE_FAILED', {path})`.

Document folders are created with mode `0o700` and files `0o600`. JSON is written with 2-space indentation and a trailing newline for readable diffs.

### 8.2 New documents: `commitDocument`

The pipeline renders `index.html` and `meta.json` into `.staging/<jobId>/` and then calls `library.commitDocument(reservation, stagingDir, meta)` ([06](06-generation-pipeline.md) §5.7 steps 2–4):

1. Inside `withDocLock(slug)`: validate `meta` with zod, and check that the staging dir contains exactly `index.html` and `meta.json`.
2. Inside `withCatalogLock`: `lstat(root/slug)`. If anything exists at that path (directory, empty directory, file or symlink; it should not, given the reservation), fail with `SLUG_TAKEN` and the pipeline re-allocates once. Do not rely on `rename` to fail: POSIX `rename(2)` of a directory silently replaces an existing **empty** directory. Still under the same catalog lock, `rename(stagingDir, root/slug)`, so no other allocation or commit can create the path between the check and the rename.
3. `fsyncDir(root)`.
4. Still inside `withCatalogLock`: upsert the entry, then write `catalog.json` atomically.
5. Release the reservation and emit `changed` with reason `created`.

### 8.3 In-process locks

All writers run in the main process. [01](01-architecture.md) ensures a single app instance.

| Lock | Key | Held by |
| --- | --- | --- |
| `withDocLock(slug, fn)` | per slug, exclusive | commit, section regenerate/ELI5 tab/close tab ([08](08-interactive-reading.md)), `touch`, merge accept, publish ([10](10-publishing.md)) |
| `withCatalogLock(fn)` | global | slug allocation, catalog upsert/remove, reconcile |
| `withSuggestionsLock(fn)` | global | every `suggestions.json` read-modify-write |

`AsyncMutex` is a FIFO promise chain. It is not reentrant, and re-acquiring the same key throws `LOCK_REENTRY` in dev builds.

**Lock order** (deadlock prevention): doc locks first, in ascending slug order when more than one is needed, then the catalog lock, then the suggestions lock. A function holding a later lock never takes an earlier one. `withDocLocks([a,b], fn)` sorts internally.

There is no read/write lock in v1. Where [10](10-publishing.md) §4 says "read lock", it means `withDocLock(slug)`, which is exclusive: a publish holds it for the whole file-set build and upload, and a regenerate requested meanwhile waits. Publishing is rare and short compared with generation, so exclusive locking costs nothing noticeable. Appending the `PublicationRecord` happens inside the same held lock via `updateDocument`.

Readers (`list`, `recents`, `getMeta`, the `eli5doc://` handler) do not lock. Atomic rename guarantees they see a whole old file or a whole new one.

### 8.4 Process lock

At startup, `open(.eli5/library.lock, 'wx')` and write `{pid, appVersion, startedAt}`, where `startedAt` is this process's start time (`Date.now() - process.uptime() * 1000`, ISO). If the file exists, the lock is **held** only if all of these hold, otherwise it is **stale** and is overwritten:

1. The recorded PID is not this process and is alive (`process.kill(pid, 0)` succeeds or fails with `EPERM`).
2. The live PID's actual start time, read with `ps -o lstart= -p <pid>` (macOS), is within 2 s of the recorded `startedAt`. A PID whose process started later than the lock was written is a reused PID, so the lock is stale. If the start time cannot be read, fall back to comparing the process name (`ps -o comm=`) against the app's executable name, and treat a mismatch as stale.

A held lock means another app process uses the same root (for example, dev and packaged builds sharing `ELI5_LIBRARY_DIR`). Enter read-only mode (§8.5). Within one build, `app.requestSingleInstanceLock()` ([01](01-architecture.md)) already stops a second instance before it reaches this check; the file lock covers different builds (dev vs packaged, different `userData`) sharing one root.

Remove the lock on `before-quit`.

### 8.5 Read-only mode

Entered on a newer schema (§5.3 step 3) or a held process lock. Listing, viewing and recents work. Jobs, section actions, merge accepts and dismisses are refused with `LIBRARY_READ_ONLY`. The status area shows "Library is in use by another copy of ELI5 Learner" or "Library was written by a newer version of ELI5 Learner". The renderer disables the input zone ([11](11-app-shell-ui.md)).

## 9. Library API

```ts
export type LibraryChangeReason = 'created' | 'updated' | 'removed' | 'merged' | 'reconciled';

export interface Library {
  readonly root: string;
  readonly readOnly: boolean;

  // listing (catalog only, never reads index.html)
  list(): CatalogEntry[];                                  // newest first by createdAt
  recents(n?: number): CatalogEntry[];                     // default 3, §9.1
  getEntry(idOrSlug: string): CatalogEntry | undefined;
  getMeta(slug: string): Promise<DocumentMeta>;
  docPath(slug: string, file?: 'index.html' | 'meta.json'): string; // throws if slug invalid

  // writes
  allocateSlug(title: string, hint?: string): Promise<SlugReservation>;
  commitDocument(r: SlugReservation, stagingDir: string, meta: DocumentMeta): Promise<CatalogEntry>;
  updateDocument(slug: string, patch: {
    html?: string;                                         // full new index.html
    meta: (m: DocumentMeta) => DocumentMeta;               // pure patch; library sets updatedAt
  }): Promise<CatalogEntry>;                               // caller must hold withDocLock(slug)
  touch(slug: string): Promise<CatalogEntry>;              // bump updatedAt in meta.json and the catalog; caller holds withDocLock(slug)
  withDocLock<T>(slug: string, fn: () => Promise<T>): Promise<T>;
  withDocLocks<T>(slugs: string[], fn: () => Promise<T>): Promise<T>;
  reconcile(): Promise<void>;

  // merge
  runMergeCheck(docId: string): Promise<MergeSuggestion | null>;
  suggestions(): MergeSuggestion[];                        // pending only, newest first
  acceptSuggestion(id: string): Promise<{ targetSlug: string }>;
  dismissSuggestion(id: string): Promise<void>;

  on(event: 'changed', cb: (e: { reason: LibraryChangeReason; slugs: string[] }) => void): () => void;
  on(event: 'suggestions', cb: (s: MergeSuggestion[]) => void): () => void;
}

export type LibraryErrorCode =
  | 'WRITE_FAILED' | 'SLUG_TAKEN' | 'NOT_FOUND' | 'META_INVALID' | 'LIBRARY_READ_ONLY'
  | 'LOCK_REENTRY' | 'LOCK_NOT_HELD' | 'SUGGESTION_STALE' | 'MERGE_FAILED' | 'PATH_OUTSIDE_ROOT';
export class LibraryError extends Error { constructor(public code: LibraryErrorCode, public detail?: object) { super(code); } }
```

`touch(slug)` is used by [08](08-interactive-reading.md) after a write that did not otherwise go through `updateDocument` (for example, tab close). It is `updateDocument(slug, {meta: m => m})`: it writes `meta.json` with a new `updatedAt`, updates the catalog entry's `updatedAt` and `tabCount` under `withCatalogLock`, and emits `changed {reason:'updated'}`. Calling it without holding the doc lock throws `LOCK_NOT_HELD` in dev builds.

`docPath` rejects any slug that fails `^[a-z0-9]+(-[a-z0-9]+)*$` and checks that the resolved path is inside the real root (`PATH_OUTSIDE_ROOT`). The `eli5doc://` handler ([01](01-architecture.md)) uses the same check and serves only `index.html` of listed documents.

Retention constants: `TRASH_RETENTION_DAYS = 30`, `RESOLVED_SUGGESTION_RETENTION_DAYS = 30`, both subject to HOOK-LIB-01.

### 9.1 Menu bar recents

- `recents(3)` returns the 3 catalog entries with the latest `createdAt`, meaning the last 3 **finished** documents (PRD "Menu bar item"). Regenerating a section changes `updatedAt` but does not move a document up. That keeps the list stable and matches "newly finished document appears here".
- A merge removes the source entry, so it drops out of recents. The target keeps its original `createdAt`.
- The tray module ([11](11-app-shell-ui.md)) subscribes to `library.on('changed')` in the main process and rebuilds the menu. No IPC is involved. Clicking an entry calls the same code path as `eli5:library:open {slug}`, reopening the main window if needed.
- The Library sidebar uses `list()`, which has the same ordering.

## 10. Merge suggestions

### 10.1 Trigger

[06](06-generation-pipeline.md) §10 calls `library.runMergeCheck(docId)` as a detached task after the catalog upsert of a `create` job. Section jobs never trigger it. Failures are logged and swallowed. The job is already `done`.

### 10.2 Matching algorithm

Two stages: a cheap local prefilter, then an LLM judge over at most 8 candidates ([02](02-llm-provider.md) prompt `merge-match`, `matchMerge()`).

```ts
export interface SimilarityScorer {
  readonly id: 'lexical' | 'embedding';
  score(query: { title: string; summary: string },
        corpus: CatalogEntry[]): Promise<{ id: string; score: number }[]>; // 0..1, descending
}
```

`runMergeCheck(docId)`:

1. If read-only, stop. Load `newEntry = getEntry(docId)`. If it is missing (deleted or already merged), stop.
2. `corpus = list()` minus `newEntry`, minus any entry `e` where the pair `{newEntry.id, e.id}` is in `dismissedPairs`, minus entries involved in an `accepting` suggestion. If `corpus` is empty, stop.
3. **Prefilter** (`lexical` scorer):
   1. Text = `title + ' ' + summary`, lowercased, NFKD, split on non-alphanumerics.
   2. Drop tokens shorter than 2 chars and a built-in English stopword list (~150 words). Keep all-caps acronyms from the original text (for example `ROAS`, `ASC`) as tokens even when short.
   3. Light suffix stemming: `ies→y`, `es`, `s`, `ing`, `ed` (only when the stem stays at least 3 chars).
   4. TF-IDF vectors with IDF over `corpus ∪ {newEntry}`. Title tokens are weighted ×2.
   5. Cosine similarity. Keep candidates with score ≥ `PREFILTER_MIN = 0.05`, take the top `K = 8`.
4. If there are no candidates, stop without an LLM call.
5. **Judge**: `matchMerge(newEntry.summary, candidates.map(c => ({catalogId, title, summary})))`, through the section lane limiter ([06](06-generation-pipeline.md) §10.3), temperature 0, timeout 30 s. The new title is passed in the summary string as `"<title>: <summary>"`.
6. Discard matches whose `catalogId` is not among the candidates, and clamp scores to [0,1].
7. Pick the best match with `score ≥ MERGE_THRESHOLD = 0.75`. Ties go to the newer `createdAt`. If there is none, stop. At most **one** suggestion per new document.
8. Re-check (under `withSuggestionsLock`) that both documents still exist and that no pending suggestion for this pair exists. Then create the `MergeSuggestion` (§10.4), persist it and emit `suggestions`.

Failure handling: if the LLM is unavailable, errors or returns invalid output, **no suggestion is made**. There is no lexical-only fallback, because a false "looks related" suggestion costs more attention than a missed one. With a `fallback` summary the check still runs. The fallback text is weaker, but still usable.

**Why not embeddings in v1.** `LLMProvider` ([02](02-llm-provider.md)) has no embedding method, and one of the two v1 providers has no embeddings endpoint. Adding one would mean a second model dependency just for this. The `SimilarityScorer` seam lets a future `embedding` scorer replace the lexical prefilter, with the vectors cached in `.eli5/embeddings.json` keyed by `id` and `updatedAt`. An enterprise model gateway could provide embeddings through HOOK-LLM-01. The LLM judge and threshold stay the same.

Constants (`merge/constants.ts`): `K = 8`, `PREFILTER_MIN = 0.05`, `MERGE_THRESHOLD = 0.75`, `JUDGE_TIMEOUT_MS = 30000`.

<!-- hook:HOOK-LIB-02 -->
> **Private hook · HOOK-LIB-02 · Merge eligibility across source sensitivity.** Public behavior: any two documents in the library may be suggested for merge; eligibility is decided only by similarity (§10.2). Private binding supplies: rules that exclude pairs from matching or accepting based on where their sources came from (for example, documents built from organization sources behind the MCP lane versus public web sources, or documents already published to a given target), and the user-facing wording when a pair is excluded. Binding lives in the private spec under "HOOK-LIB-02".

The enterprise overlay registers a `mergeEligibility(a: DocumentMeta, b: DocumentMeta) => boolean` predicate in the edition registry ([01](01-architecture.md)). The public build registers `() => true`. It is applied in step 2 (reading `meta.json` only for the top-K candidates, not the whole corpus) and again at accept time.

### 10.3 What "accept" produces

PRD: v1 appends the new material to the existing document as a clearly marked new section, and removes the standalone document. Intelligent weaving is future work. The existing document (the **target**) receives content from the new document (the **source**):

| Part of source | Where it goes in target |
| --- | --- |
| In-depth tab sections | Appended at the end of the target's in-depth tab, **before** the references section, after a new marker section |
| ELI5 tab sections | Appended at the end of the target's ELI5 tab, after a new marker section |
| Section ELI5 tabs | Added as tabs at the right end, labels unchanged (suffixed ` (2)` on label collision) |
| Glossary notes | Carried over when anchored in moved sections. A term already defined in the target is dropped from the moved copy (first occurrence wins) |
| References / sources | Target references section regenerated from merged `meta.json`: target sources, then a "Added from *Source title*" group with the source's used and skipped sources |

The **marker section** is an ordinary `<section>` with a fresh `SectionId` (for example `sec-indepth-9b04e1aa`), heading "Added from: *Source title*", a line "Merged on <date>. Originally generated from: <source refs>" and a visual banner style from the doc runtime (`data-merge-marker="<suggestionId>"`). It is a real section, so select-and-act works on it like any other.

**Section IDs.** Every moved section receives a **new** SectionId under the target's tab key (`sec-<tabkey>-<8 hex>`, generated by [07](07-output-document.md)'s ID allocator with collision check against the target), and carries `data-merged-from="<sourceDocId>"`. Section ELI5 tabs get fresh tab keys. The builder returns an `idMap` (old → new) that is used only to re-anchor glossary notes.

This is the single merge contract: incoming sections always get **new** IDs (never kept, even without a collision), and each tab gets a separate **marker section** (not an inline banner paragraph). It matches [07](07-output-document.md) §8.1. Fresh IDs keep one rule for every merge, so a `SectionId` never has to be interpreted in the context of which document it came from, and the target's `retiredIds` are honored by the allocator.

The HTML work is done by the document module ([07](07-output-document.md)), which exposes:

```ts
// src/main/document/merge.ts (owned by 07; contract required by 09)
export function appendMergedDocument(input: {
  targetHtml: string; targetMeta: DocumentMeta;
  sourceHtml: string; sourceMeta: DocumentMeta;
  suggestionId: string; mergedAt: string;
}, opts?: { idSource?: IdSource; runtime?: DocRuntime }): {
  html: string; tabs: TabRecord[]; markerSectionIds: SectionId[]; idMap: Record<SectionId, SectionId>;
  warnings: string[];
};
```

The document module may not import library types ([01](01-architecture.md) §3), so `merge.ts` declares structural equivalents (`MergeDocMeta`, `MergeTabRecord`) that 09's `DocumentMeta` and `TabRecord` satisfy.

The target's `title`, `summary` and `createdAt` are unchanged. `updatedAt` is set to the merge time and `mergedFromCount` is incremented. Re-summarizing after merge is not done in v1, since the target's topic is what the user chose to keep.

### 10.4 `MergeSuggestion` and lifecycle

```ts
export type MergeSuggestionStatus = 'pending' | 'accepting' | 'accepted' | 'dismissed' | 'stale';

export interface MergeSuggestion {
  id: string;                      // UUID
  createdAt: string;
  status: MergeSuggestionStatus;
  source: { id: string; slug: string; title: string };   // the new document
  target: { id: string; slug: string; title: string };   // the existing related document "X"
  score: number;                   // judge score, 0..1
  reason: string;                  // judge's one-line reason, <= 200 chars, shown as secondary text
  scorer: 'lexical+llm' | 'embedding+llm';
  resolvedAt?: string;
  lastError?: string;              // human-readable, set when an accept attempt failed
}
```

```
pending ──accept──▶ accepting ──ok──▶ accepted
   │                    │
   │                    └─error──▶ pending (lastError set)
   ├──dismiss──▶ dismissed
   └──either doc gone / merged elsewhere──▶ stale
```

UI text (rendered by [11](11-app-shell-ui.md) in the suggestions area): "This looks related to **{target.title}**. Merge it in or keep it separate?" with buttons **Merge in** and **Keep separate**. Only `pending` suggestions are shown (with `lastError` beneath when set). `accepting` shows "Merging…" with buttons disabled. A suggestion never opens a modal and never blocks input.

### 10.5 Persistence: `.eli5/suggestions.json`

```ts
export interface SuggestionsFile {
  schemaVersion: 1;
  suggestions: MergeSuggestion[];              // all non-pruned, any status
  dismissedPairs: { a: string; b: string; at: string }[]; // doc IDs, a < b (sorted string order)
}
```

- Every mutation goes read → modify → `writeFileAtomic` under `withSuggestionsLock`.
- `accepted`, `dismissed` and `stale` suggestions are pruned after `RESOLVED_SUGGESTION_RETENTION_DAYS`. `dismissedPairs` are pruned when either document leaves the catalog.
- Suggestions survive restarts. A pending suggestion waits indefinitely until the user acts (PRD step 3).

### 10.6 Accept algorithm

`acceptSuggestion(id)`:

1. Under `withSuggestionsLock`: load it. If not `pending`, throw `SUGGESTION_STALE`. Set `accepting` and persist. Emit `suggestions`.
2. `withDocLocks([target.slug, source.slug])` (sorted). This waits for any running section job on either document ([08](08-interactive-reading.md)).
3. Check that both catalog entries exist, and that `mergeEligibility(targetMeta, sourceMeta)` holds (HOOK-LIB-02). On failure → `stale` (missing) or back to `pending` with `lastError` (ineligible). Release and emit.
4. Read both `index.html` and both `meta.json` files.
5. **Backup:** copy the target's `index.html` and `meta.json` to `.trash/<target.slug>--<ts>-premerge/`. This makes a bad merge recoverable by hand. Per-section history is future work.
6. `appendMergedDocument(...)` (§10.3). A thrown error → `MERGE_FAILED`, go to step 11.
7. Write the target `index.html` atomically, then the target `meta.json` atomically, with `tabs` from the result, `sourcesUsed` / `sourcesSkipped` unioned (source items tagged `origin: 'merge:<sourceId>'`, dedup by `ref` + `sha256`), and a new `MergeRecord` appended. **This `meta.json` write is the commit point.**
8. `rename(root/source.slug, .trash/<source.slug>--<ts>)`.
9. `withCatalogLock`: remove the source entry. Update the target entry (`updatedAt`, `tabCount`, `mergedFromCount`). Write atomically.
10. `withSuggestionsLock`: set this suggestion `accepted` with `resolvedAt`. Any other `pending` suggestion that references the source becomes `stale`. Persist.
11. On error before step 7: restore nothing (the target is untouched), set `pending` with `lastError = "Could not merge. The documents were left unchanged."`, and persist. On error after step 7: continue steps 8–10 on the next reconcile (§10.8).
12. Emit `changed {reason:'merged', slugs:[target, source]}`, `suggestions`, and `eli5:doc:updated {slug: target.slug, sectionId: markerSectionIds[0]}`. If the viewer is showing the source document, it navigates to the target and scrolls to the in-depth marker section ([11](11-app-shell-ui.md)). Return `{targetSlug}`.

### 10.7 Dismiss algorithm

`dismissSuggestion(id)`: under `withSuggestionsLock`, if the suggestion is `pending`, set `dismissed` with `resolvedAt` and add `{a,b}` (sorted IDs) to `dismissedPairs`. Otherwise no-op. Persist and emit `suggestions`. Both documents remain unchanged (PRD step 5). The same pair is never suggested again, but either document may still be suggested with a third document.

### 10.8 Validation and crash recovery

At startup, after reconcile:

1. A `pending` suggestion whose source or target is missing from the catalog becomes `stale`.
2. For an `accepting` suggestion, if `targetMeta.merges` contains its `suggestionId`, the commit happened: finish steps 8–10 idempotently (skip a rename whose source folder is already gone). Otherwise the merge did not commit: set it back to `pending` (the premerge backup, if any, stays in `.trash/`).
3. Emit `suggestions` once.

## 11. IPC surface

Channels are registered in `src/main/ipc/library.ts`. Payloads are validated in main with zod. Senders are checked per [01](01-architecture.md) and [12](12-configuration-security.md).

| Channel | Direction | Payload → Result |
| --- | --- | --- |
| `eli5:library:list` | R→M invoke | `void` → `CatalogEntry[]` newest first |
| `eli5:library:open` | R→M invoke | `{slug}` → `void`. Loads `eli5doc://doc/<slug>/index.html` in the viewer |
| `eli5:library:reveal` | R→M invoke | `{slug}` → `void`. `shell.showItemInFolder` on the document folder |
| `eli5:library:info` | R→M invoke | `void` → `{root: string; readOnly: boolean; readOnlyReason?: string; count: number}` (new here, for Settings) |
| `eli5:library:changed` | M→R event | `{entries: CatalogEntry[]}` |
| `eli5:suggestions:list` | R→M invoke | `void` → `MergeSuggestion[]` (pending and accepting) |
| `eli5:suggestions:accept` | R→M invoke | `{suggestionId}` → `{targetSlug}` or `IpcError` (`SUGGESTION_STALE`, `MERGE_FAILED`, `LIBRARY_READ_ONLY`) |
| `eli5:suggestions:dismiss` | R→M invoke | `{suggestionId}` → `void` |
| `eli5:suggestions:changed` | M→R event | `{suggestions: MergeSuggestion[]}`. This is the event [06](06-generation-pipeline.md) §10 step 5 refers to as the library's suggestion event |

The renderer never sends file paths. It only sends slugs and IDs, and main resolves those through `docPath`.

## 12. Edge cases

| Case | Behavior |
| --- | --- |
| `catalog.json` deleted by the user | Rebuilt from folders at the next startup (§7). Nothing is lost |
| `catalog.json` corrupt | Renamed `.corrupt-<ts>`, rebuilt, logged |
| One `meta.json` corrupt | That document is hidden from the Library and logged. Its folder is untouched. Others are unaffected |
| User deletes a document folder in Finder | Entry dropped on next reconcile. Suggestions referencing it become `stale` |
| User renames a folder in Finder | Treated as the new slug (§7 step 3). An invalid folder name (for example with spaces) is skipped and logged |
| Two jobs with the same title finish together | Distinct slugs `x` and `x-2` via reservations under the catalog lock |
| Title differs only in case from an existing slug | Case-insensitive check yields `-2` |
| Disk full during save | `WRITE_FAILED`. The pipeline retries once, then `SAVE_FAILED` ([06](06-generation-pipeline.md)). The old files are intact |
| Quit during merge accept | Recovered per §10.8 |
| Section regenerate requested during a merge accept | Waits on `withDocLock`. If the source was merged away, the section job fails with "This document was merged into *X*" |
| Merge accepted while the source is open in the viewer | Viewer switches to the target at the marker section |
| Suggestion pending for a target the user is currently reading | Allowed. The accept waits for any in-flight section job |
| Merge check finishes after the new doc was already merged elsewhere | Step 8 re-check discards it ([06](06-generation-pipeline.md) §10 step 6) |
| New doc and target are the same topic re-run (user pressed Enter twice) | Usually a suggestion with a high score. Accept appends a near-duplicate block. The user can dismiss instead |
| Library written by a newer app version | Read-only mode (§8.5) |
| Second process on the same root | Read-only mode (§8.4) |
| Empty library | Merge check stops at step 2. Recents is empty and the tray shows only Open and Quit |
| Very large library (5,000 docs) | Catalog about 2 MB, loaded into memory once. Prefilter under 50 ms. Reconcile under 1 s at startup |

## 13. Testing notes

Unit (Vitest, temp dir via `ELI5_LIBRARY_DIR`): slugify table tests; allocate under concurrency (100 parallel allocations, all distinct); `writeFileAtomic` crash simulation (kill between write and rename leaves the old file); migrations per fixture; reconcile scenarios from §12; prefilter ranking on a fixed corpus; accept/dismiss state machine with a fake `appendMergedDocument` and a fake `matchMerge`; recovery of `accepting` at each step boundary. E2E (Playwright `_electron`): generate two related documents with a stubbed provider, see the suggestion, accept, and verify one Library entry, the marker section and the tray recents. Details are in [13](13-testing-quality.md).

## Acceptance criteria

- [ ] Library root resolves to the gitignored `<repo>/.library/` in dev, `<userData>/docs/` when packaged, and `ELI5_LIBRARY_DIR` (absolute) when set; the repo's `docs/` is used only by explicit opt-in; the root is created on first run and shown in Settings.
- [ ] Each finished learning is `<root>/<topic-slug>/index.html` + `meta.json`, and `<root>/catalog.json` has one entry per document with id, title, topic slug, created/updated timestamps and a 1–2 sentence summary.
- [ ] `meta.json` records sources used, sources skipped with reason and code, clarifying input, tab list, retired IDs, `JobWarning`s, generation info, action log, publications and merge history, validated by a non-strict v1 schema that preserves unknown fields; it never contains absolute local paths, source text or credentials.
- [ ] Library sidebar, menu bar recents and merge matching never read `index.html`.
- [ ] Slugs follow §6: ASCII, at most 60 chars, case-insensitive collision suffixes, reserved names avoided; concurrent saves never collide.
- [ ] Every file write is temp + fsync + rename; killing the app at any point never leaves a truncated `index.html`, `meta.json`, `catalog.json` or `suggestions.json`.
- [ ] All document writes and publishes serialize through the exclusive `withDocLock`; lock order is doc(s) → catalog → suggestions.
- [ ] `commitDocument` fails with `SLUG_TAKEN` when anything (including an empty directory) exists at the target path, checked with `lstat` under `withCatalogLock`.
- [ ] A stale process lock whose PID was reused by an unrelated process is detected by start time and does not force read-only mode.
- [ ] Deleting or corrupting `catalog.json` is repaired at startup from folders; folders without valid `meta.json` (including the dev `sample/`) are ignored and never modified.
- [ ] Files with an older `schemaVersion` migrate with a `.bak`; a newer `schemaVersion` puts the library in read-only mode with a clear status message.
- [ ] Menu bar shows the 3 most recently finished documents (by `createdAt`) and updates automatically on create and merge.
- [ ] The merge check runs only after a create job commits, never affects job status, uses a lexical prefilter (K = 8) then an LLM judge, and posts at most one suggestion when score ≥ 0.75.
- [ ] LLM failure during the merge check produces no suggestion and no user-visible error.
- [ ] Suggestions persist across restarts in `.eli5/suggestions.json`, wait until acted on, and go `stale` when either document disappears.
- [ ] Accept appends the source's content to the target behind clearly marked "Added from" sections with fresh unique SectionIds, merges references and sources, removes the source from the Library (folder moved to `.trash/`), and opens the target at the marker.
- [ ] Accept is crash-safe: recovery completes or rolls back an interrupted accept, with `meta.json` as the commit point.
- [ ] Dismiss leaves both documents unchanged and the same pair is never suggested again.
- [ ] HOOK-LIB-01 and HOOK-LIB-02 are marked, and the public build uses the default behavior described in each.
