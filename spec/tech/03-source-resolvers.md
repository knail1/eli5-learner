# Source resolvers and clipboard

This file specifies how raw user inputs (dropped files, clipboard pastes, typed URLs) become a normalized, ordered list of `ResolvedSource` records that the extraction stage can consume, plus a list of `SkippedSource` records for anything that could not be used. It covers the `SourceInput` / `ResolvedSource` / `SkippedSource` types, the `SourceResolver` interface and resolver chain, the file resolver (type sniffing by magic bytes and extension), clipboard routing, the URL resolver (which delegates network work to the fetch module), lane routing between the public web lane and the authenticated lane, and the enterprise stubs: the MCP-brokered resolver, the ticket-link resolver, and the single sign-on lifecycle. It does not cover turning bytes into content (see extraction) or HTTP/readability/hidden-window mechanics (see URL fetching). Code lives in `src/main/sources/`.

Related: [01-architecture.md](./01-architecture.md) · [02-llm-provider.md](./02-llm-provider.md) · [04-extraction.md](./04-extraction.md) · [05-url-fetching.md](./05-url-fetching.md) · [06-generation-pipeline.md](./06-generation-pipeline.md) · [09-library-storage.md](./09-library-storage.md) · [10-publishing.md](./10-publishing.md) · [11-app-shell-ui.md](./11-app-shell-ui.md) · [12-configuration-security.md](./12-configuration-security.md) · [13-testing-quality.md](./13-testing-quality.md)

PRD sections implemented: "Build editions and swap seams" (SourceResolver seam, MCP resolver stub), "Inputs and extraction" (input methods, source type table, clipboard paste), "Fetching strategy" (lane rationale, enterprise MCP lane), "Processing pipeline" (skip-and-continue error handling, "Reading sources" status).

## 1. Responsibilities and boundaries

| Concern | Owner |
| --- | --- |
| Capture inputs in the renderer (drop, paste, URL field) and stage clipboard content | this file (renderer capture + `src/main/sources/clipboard.ts`) |
| Decide which resolver handles each input; decide lane for URLs | this file (`src/main/sources/chain.ts`, `lanes.ts`) |
| Identify the format of a file or downloaded body (magic bytes + extension) | this file (`src/main/sources/sniff.ts`) |
| HTTP fetch, readability, hidden-window fallback, timeouts, login detection | [05-url-fetching.md](./05-url-fetching.md) |
| Parse formats into `ExtractedContent` / `ContentBlock` | [04-extraction.md](./04-extraction.md) |
| Job lifecycle, `JobStatus`, "no usable content" failure | [06-generation-pipeline.md](./06-generation-pipeline.md) |
| Registry, `NotAvailableInEdition`, overlay loading | [01-architecture.md](./01-architecture.md) (defines HOOK-CFG-02) |
| Job staging directory, input snapshots at enqueue, staging retention | [06-generation-pipeline.md](./06-generation-pipeline.md) §9 |
| Enterprise sign-in UI | HOOK-UI-01 in [11-app-shell-ui.md](./11-app-shell-ui.md) |

Resolution runs entirely in the main process during the `reading` stage of a job. The renderer never reads files or the network; it only sends `SourceInput` descriptors over IPC.

## 2. Types

All types are exported from `src/main/sources/types.ts` and re-exported (types only) to the preload/renderer through `src/preload/contract.ts` (see [01-architecture.md](./01-architecture.md)). This file is the sole owner of `SourceFormat`, `sniff()`, and the `SkipCode` union used by `SkippedSource.code`; 04 and 05 import them.

```ts
/** Where the user supplied the input. Used for the references list and telemetry-free debugging. */
export type SourceOrigin = 'drop' | 'paste' | 'url-field' | 'picker';

/** One raw input as captured by the input zone. Serializable; crosses IPC. */
export type SourceInput =
  | { id: string; kind: 'file';  origin: SourceOrigin; path: string; snapshot?: FileSnapshot }
  | { id: string; kind: 'url';   origin: SourceOrigin; url: string }
  | { id: string; kind: 'text';  origin: 'paste'; stagedPath: string; markup: 'plain' | 'html'; preview: string }
  | { id: string; kind: 'image'; origin: 'paste'; stagedPath: string; mediaType: 'image/png'; preview: string };
// id: "in-" + 8 hex chars, assigned by the renderer when the chip is created.
// preview: short human label shown on the input chip, e.g. "Pasted image 14:02".
// stagedPath: set by main; before job start it points into <userData>/staging/drafts/<draftId>/,
//   after eli5:jobs:start the pipeline (06 §9.2) rewrites it to <userData>/jobs/<jobId>/inputs/<file>.

/** Written by the pipeline at enqueue (06 §9.2); never supplied by the renderer. */
export interface FileSnapshot {
  copyPath?: string;      // <userData>/jobs/<jobId>/inputs/<index>-<basename>, when size ≤ 200 MB
  sizeBytes: number;      // size of the original at enqueue
  mtimeMs: number;        // mtime of the original at enqueue (used when there is no copy)
}

/** Which access lane served a source. */
export type Lane = 'local' | 'web' | 'mcp';

/** Formats the extraction stage understands. Owned here; 04-extraction.md takes it as given.
 *  Scanned PDFs are NOT a SourceFormat: the PDF extractor decides that and reports
 *  ExtractedContent.format = 'pdf-scanned'. Image subtypes are normalized to PNG/JPEG by 04 §7. */
export type SourceFormat =
  | 'pptx' | 'docx' | 'xlsx' | 'pdf'
  | 'markdown' | 'text' | 'csv' | 'html'
  | 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | 'tiff' | 'bmp';

export const IMAGE_FORMATS = ['png', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'bmp'] as const;

export type SourcePayload =
  | { kind: 'path'; path: string }                    // bytes on disk (original file or staged download)
  | { kind: 'text'; text: string }                    // plain or markdown text already decoded to UTF-8
  | { kind: 'html'; html: string; baseUrl?: string }; // readable HTML (article extract or pasted rich text)

export interface ResolvedSource {
  id: string;             // "src-" + zero-padded index in final job order, e.g. "src-03"
  inputId: string;        // SourceInput.id that produced it (a folder or multi-file paste yields several)
  ref: string;            // human label for references: basename, URL, or "Pasted text: first 40 chars…"
  location: string;       // absolute path, final URL after redirects, or "clipboard"
  lane: Lane;
  resolverId: string;     // 'file' | 'clipboard' | 'url' | 'mcp' | 'ticket' | overlay-defined
  format: SourceFormat;
  mediaType: string;      // IANA type, e.g. application/pdf
  title?: string;         // page title or document title when known
  payload: SourcePayload;
  sizeBytes: number;
  sha256: string;         // of the payload bytes (UTF-8 for text/html payloads); used for dedupe
  notes: string[];        // non-fatal observations, e.g. "extension .pdf but content is PNG"
}

/** The single machine-code union for SkippedSource.code across resolution (this file),
 *  fetching (05 §10, mapped in §7.2) and extraction (04 §8.2). meta.json stores it as `code`. */
export type SkipCode =
  // resolution (this file)
  | 'not-found' | 'permission-denied' | 'not-a-regular-file' | 'empty' | 'file-changed'
  | 'unsupported-type' | 'legacy-office-format' | 'too-large' | 'limit-exceeded'
  | 'not-a-url' | 'unsupported-scheme'
  | 'not-available-in-edition' | 'sign-in-required' | 'access-denied'
  | 'cancelled' | 'read-error'
  // fetching (05)
  | 'fetch-failed' | 'login-required' | 'paywall' | 'timeout' | 'http-error'
  | 'empty-content' | 'render-failed' | 'blocked-private-address'
  // extraction (04)
  | 'encrypted' | 'corrupt' | 'zip-bomb' | 'image-too-large' | 'image-budget-exceeded'
  | 'scan-render-failed' | 'internal-error';

/** A source that could not be used. Listed in the document's references and in meta.json. */
export interface SkippedSource {
  ref: string;       // same labelling rules as ResolvedSource.ref
  reason: string;    // one human sentence, shown verbatim, e.g. "Page required login."
  code: SkipCode;    // machine code; reason text is derived from it (table in §9)
}

export interface ResolveOutcome {
  resolved: ResolvedSource[];
  skipped: SkippedSource[];
}
```

`ResolvedSource`, `SkippedSource`, and the input list are persisted by the library into `meta.json` (see [09-library-storage.md](./09-library-storage.md)); `payload` is not persisted, only `ref`, `location`, `format`, `lane`, `sizeBytes`, `sha256`.

## 3. SourceResolver interface

```ts
export interface ResolveContext {
  jobId: string;
  edition: Edition;              // 'public' | 'enterprise'
  stagingDir: string;            // <userData>/jobs/<jobId>/, created by the pipeline (06 §9.1); downloads go here
  mcp?: McpClient;               // enterprise only: the one shared overlay-owned MCP client (§10.1)
  signal: AbortSignal;           // job cancellation
  limits: ResolveLimits;
  fetchUrl: (url: string, fctx: FetchContext) => Promise<FetchOutcome>; // 05-url-fetching.md §2
  lanes: LaneRouter;             // §8
  log: (msg: string, data?: Record<string, unknown>) => void; // local debug log only
  onInputSettled?: (index: number) => void; // once per input when resolved or skipped; 06 §5.2 step 3 progress
}

export interface SourceResolver {
  /** Stable id; also written to ResolvedSource.resolverId. */
  readonly id: string;
  /** Inputs this resolver may be offered. URL inputs are pre-routed by lane (§8). */
  readonly handles: ReadonlyArray<SourceInput['kind']>;
  readonly lane: Lane;
  /** Cheap, synchronous, no I/O. Returns true if this resolver claims the input. */
  canResolve(input: SourceInput, ctx: ResolveContext): boolean;
  /** Performs I/O. Must never throw for expected failures: return them in `skipped`.
   *  May throw NotAvailableInEdition (stubs) or unexpected errors; the chain converts both. */
  resolve(input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome>;
}

export interface ResolveLimits {
  maxFileBytes: number;        // default 100 MiB
  maxImageBytes: number;       // default 20 MiB (larger images: skipped, 'too-large')
  maxSourcesPerJob: number;    // default 50 resolved sources after folder expansion
  maxTotalBytes: number;       // default 500 MiB across a job
  maxFolderDepth: number;      // default 3
  perSourceTimeoutMs: number;  // default 90_000 (URL fetch has its own tighter timeouts in 05)
  concurrency: number;         // default 4
}
```

Shipped resolvers, in chain order (the registry holds the order; see [01-architecture.md](./01-architecture.md)):

| Order | id | File | handles | Lane | Public build | Enterprise build |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `ticket` | `ticket.stub.ts` | `url` | `mcp` | stub, never claims (router never yields ticket route) | overlay implementation (HOOK-SRC-02) |
| 2 | `mcp` | `mcp.stub.ts` | `url` | `mcp` | stub, never claims | overlay implementation (HOOK-SRC-01) |
| 3 | `url` | `url.ts` | `url` | `web` | active | active for non-organization URLs |
| 4 | `file` | `file.ts` | `file` | `local` | active | active |
| 5 | `clipboard` | `clipboard.ts` | `text`, `image` | `local` | active | active |

The overlay may register additional resolvers via the registry; they are inserted before `url` unless they specify a position.

## 4. Resolver chain algorithm

`resolveAll(inputs: SourceInput[], ctx): Promise<ResolveOutcome>` in `src/main/sources/chain.ts`:

1. Emit job status `reading` (pipeline sets it; the chain does not touch status directly).
2. For each input, in parallel with at most `limits.concurrency` in flight, but collecting results by input index so final order equals input order:
   1. If `ctx.signal.aborted`, record `{ code: 'cancelled' }` and stop scheduling.
   2. If `input.kind === 'url'`: normalize (§7.1). On failure, skip with `not-a-url` or `unsupported-scheme`. If the URL is `file://`, rewrite the input to `{kind: 'file', path}` and continue at step 2.3. Otherwise compute `route = ctx.lanes.route(url)` (§8) and restrict candidates to resolvers whose `id === route.resolverId` (or, when `route.resolverId` is absent, whose `lane === route.lane`).
   3. Select the first candidate in chain order where `handles` contains `input.kind` and `canResolve()` is true. None: skip with `unsupported-type`.
   4. Call `resolve()` wrapped in `withTimeout(limits.perSourceTimeoutMs, ctx.signal)`.
   5. Error mapping: `NotAvailableInEdition` → `not-available-in-edition`; timeout → `timeout`; abort → `cancelled`; any other throw → `read-error` (log stack locally, reason text stays generic).
3. Flatten outcomes in input order.
4. Dedupe resolved sources by `sha256` (files, pastes) and by final URL (web/mcp); later duplicates are dropped silently and a note `"duplicate of <ref>"` is appended to the kept one. Duplicates are not skipped sources, because nothing was lost.
5. Enforce job totals in order: once `maxSourcesPerJob` or `maxTotalBytes` would be exceeded, every further resolved source is converted to a skipped source with `limit-exceeded`.
6. Assign `ResolvedSource.id = "src-" + index` (two digits, zero padded) in final order.
7. Return. If `resolved` is empty the pipeline fails the job with "No usable content in the provided sources." (owned by 06). A non-empty `skipped` with non-empty `resolved` never fails the job (PRD: "A failed source is skipped and noted; the job still produces a document").

Invariants:
- Every input yields at least one resolved or skipped record (unless it was a silent duplicate).
- The chain never prompts, opens a window, or blocks on user action. Anything needing the user (for example sign-in) becomes a skip.
- Before job start, clipboard/drag staging lives only under `<userData>/staging/drafts/<draftId>/`. On `eli5:jobs:start` the pipeline moves (same volume) or copies those files, and snapshots dropped files, into `<userData>/jobs/<jobId>/inputs/` (06 §9.2). From then on, resolvers read only snapshots, and downloads are written only under `ctx.stagingDir` (`<userData>/jobs/<jobId>/`). Deletion and retention of that directory are owned by 06 §9.

## 5. File resolver (`src/main/sources/file.ts`)

### 5.1 Path handling

0. **Snapshot first.** If `input.snapshot?.copyPath` exists, read that copy (06 §9.2) instead of the original, set `location` to the original real path, and set `ref` to the original basename (never the staging path). Skip steps 1-2 for the copy. If there is no copy (file over 200 MB), `stat` the original and compare with `snapshot.sizeBytes`/`mtimeMs`; a difference or disappearance → `file-changed` ("File changed or moved."). Inputs without a snapshot (dropped folders and the files found inside them, and resolver calls in tests) follow steps 1-4 in place.
1. Resolve `fs.realpath(path)`. `ENOENT` → `not-found`; `EACCES`/`EPERM` → `permission-denied` (reason mentions macOS privacy settings when the path is under a protected folder such as Desktop, Documents, Downloads).
2. `lstat` after realpath: directory → folder expansion (§5.3); regular file → continue; anything else (socket, device, FIFO) → `not-a-regular-file`.
3. Size 0 → `empty`. Size over `maxFileBytes` → `too-large`.
4. Read the first 8 KiB for sniffing. Never execute, open with another app, or modify the file. `payload: {kind: 'path'}` points at the snapshot copy when one exists, otherwise at the original (large files are read in place, as 06 §9.2 specifies). This resolver never copies files itself; copying is the pipeline's job at enqueue.

### 5.2 Type sniffing

`sniff(head: Buffer, fileName: string, opts?: { declaredMediaType?: string; readZipEntry?: (name: string) => Promise<Buffer | null>; oleStreamNames?: () => Promise<string[]> }): Promise<SniffResult>`

```ts
export type SniffResult =
  | { ok: true; format: SourceFormat; mediaType: string; notes: string[] }
  | { ok: false; code: 'unsupported-type' | 'legacy-office-format' | 'encrypted'; detail: string };
```

`sniff()` in `src/main/sources/sniff.ts` is the only format classifier in the app. The extraction stage (`extractSource`, 04) receives `ResolvedSource.format` as given and does not re-sniff.

Rule: magic bytes decide the family; the extension only disambiguates within the text family and is otherwise advisory. A mismatch between extension and content adds a note but does not fail.

| Signature (offset 0 unless noted) | Result |
| --- | --- |
| `25 50 44 46 2D` (`%PDF-`) within the first 1024 bytes | `pdf` |
| `89 50 4E 47 0D 0A 1A 0A` | `png` |
| `FF D8 FF` | `jpeg` |
| `47 49 46 38 37 61` or `47 49 46 38 39 61` | `gif` |
| `52 49 46 46` + `57 45 42 50` at offset 8 | `webp` |
| `49 49 2A 00` or `4D 4D 00 2A` | `tiff` |
| `42 4D` (`BM`) with a plausible header size | `bmp` |
| `50 4B 03 04` (ZIP) | read `[Content_Types].xml` from the central directory and classify by the main part content type: `presentationml.presentation.main+xml` (or the macro-enabled variant) → `pptx`; `wordprocessingml.document.main+xml` → `docx`; `spreadsheetml.sheet.main+xml` → `xlsx`; missing or other → `unsupported-type` ("ZIP archive") |
| `D0 CF 11 E0 A1 B1 1A E1` (OLE compound file) | if the container has an `EncryptedPackage` stream, or the extension is an OOXML one (`.pptx/.docx/.xlsx/.pptm/.docm/.xlsm`) → `encrypted` ("File is password protected"); otherwise (`.ppt`, `.doc`, `.xls`, or unknown) → `legacy-office-format` ("Older Office format; re-save as .pptx, .docx, or .xlsx") |
| `66 74 79 70` at offset 4 with brand `heic`, `heix`, `mif1`, `msf1` | `heic` (converted to PNG/JPEG by 04 §7) |
| `66 74 79 70` at offset 4 with brand `avif` | `unsupported-type` ("AVIF image; export as PNG or JPEG") |
| `7B 5C 72 74 66` (`{\rtf`) | `unsupported-type` ("RTF; save as .docx or plain text") |
| Otherwise, text probe passes (below) | text family by extension |
| Otherwise | `unsupported-type` ("Unrecognized binary file") |

Macro-enabled OOXML (`.pptm`, `.docm`, `.xlsm`) sniffs as the base format; macros are never read. Encrypted OOXML is an OLE container and reports `encrypted`, distinct from legacy binary Office files (`legacy-office-format`). Password-protected PDFs are detected by the extractor (04), which skips them with the same `encrypted` code.

Text probe: strip a UTF-8 BOM, or decode UTF-16 LE/BE when a BOM is present. Fail if the head contains a NUL byte (without UTF-16 BOM) or more than 2% invalid UTF-8 sequences. On pass, map by extension:

| Extension | Format |
| --- | --- |
| `.md`, `.markdown`, `.mdx` | `markdown` |
| `.html`, `.htm`, `.xhtml` | `html` (payload stays a path; the extractor applies readability) |
| `.csv`, `.tsv` | `csv` (04 parses it as a table) |
| `.txt`, `.text`, `.json`, `.yaml`, `.yml`, `.log`, `.xml`, source code extensions, no extension | `text` |
| any other | `text`, note "treated as plain text" |

If the extension is text-like but content starts with `<!doctype html` or `<html`, use `html`.

The same `sniff()` is reused for downloaded bodies from the URL resolver and for MCP-delivered documents, with `declaredMediaType` from the response as an additional tie-breaker only for the text family.

### 5.3 Folder expansion

- Walk depth-first up to `maxFolderDepth`, sorted by name (locale compare, numeric), skipping dotfiles, `node_modules`, `.git`, and macOS package directories (`*.app`, `*.bundle`).
- Each file found is resolved as if dropped individually; unsupported files inside a folder are skipped with `unsupported-type` so the references list shows them.
- A folder with no supported files yields a single skip `{ ref: <folder name>, code: 'empty', reason: 'Folder contained no supported files.' }`.

## 6. Clipboard routing (`src/main/sources/clipboard.ts`)

### 6.1 Capture flow

The clipboard is snapshotted at paste time, not at job start, because the user may copy something else before pressing Enter.

1. The input zone receives Cmd+V (or the Edit > Paste menu item while the drop box is focused). Pastes inside the URL field and the clarifying-specifics field are ordinary text entry and are not routed.
2. The renderer calls `window.eli5.sources.readClipboard(draftId)` → IPC `eli5:sources:read-clipboard`.
3. Main snapshots `electron.clipboard` once into a synchronous `ClipboardPort` (§6.2) and applies the routing algorithm (§6.2), staging any content under `<userData>/staging/drafts/<draftId>/`.
4. Main returns `SourceInput[]` which the renderer shows as chips. Removing a chip calls `eli5:sources:discard` to delete its staged file.
5. On `eli5:jobs:start`, the pipeline (06 §9.2) moves or copies the draft's staged files into `<userData>/jobs/<jobId>/inputs/`, rewrites each `stagedPath` accordingly, and deletes `<userData>/staging/drafts/<draftId>/`. The clipboard resolver (§6.4) only ever reads the `inputs/` copy.
6. **Crash sweep.** Drafts are otherwise cleaned only on chip removal, job start, and quit, so a crash leaks them. At app startup, main deletes every `<userData>/staging/drafts/*` directory whose mtime is older than 24 hours (younger drafts may belong to a second window restored by the app shell and are left alone).

### 6.2 Routing algorithm

Electron 44's `clipboard` is the async W3C-style API (`read()` returning items with `types` and `getType()`, `readText()`, `has()`). `snapshotClipboard()` in `src/main/ipc/clipboard.ts` reads it once at paste time into the synchronous `ClipboardPort` below: `availableFormats()` is the union of item types, `readText()`/`readHTML()` come from the `text/plain`/`text/html` items, `readImage()` from the `image/png` item, and the raw pasteboard formats `NSFilenamesPboardType` and `public.file-url` are reached through Electron's `electron application/osclipboard;format="<name>"` MIME type. Any read failure counts as absent. The names below refer to that port.

Read `clipboard.availableFormats()` once, then take the first matching branch:

1. **File references.** `availableFormats()` does not reliably list file URLs, so this branch probes directly, regardless of what `availableFormats()` reported:
   1. `clipboard.read('NSFilenamesPboardType')`. If non-empty, it is a property-list XML string (`<plist><array><string>/abs/path</string>…</array></plist>`). Parse it with the pure-JS `plist` package (listed in 01 §7) and keep entries that are absolute paths. Parse failure → treat as empty and continue.
   2. Otherwise `clipboard.read('public.file-url')` for a single file: a `file://` URL string, converted with `url.fileURLToPath()`.
   If either yields paths, return one `{kind: 'file', origin: 'paste'}` per path in clipboard order. Finder also places an icon image and the file name as text on the clipboard; both are ignored because this branch wins.
2. **Text with visible characters.** Read `clipboard.readText()`. If it contains at least one non-whitespace character:
   1. If every non-empty line is an `http(s)://` URL (after trimming), return one `{kind: 'url', origin: 'paste'}` per line.
   2. Else if `text/html` is available and `clipboard.readHTML()` is non-empty, stage the HTML (`pasted-<n>.html`) and return `{kind: 'text', markup: 'html'}`. HTML is preferred because it preserves headings, lists, and tables cheaply (PRD principle). It is sanitized at extraction time, not here.
   3. Else stage the plain text (`pasted-<n>.txt`) and return `{kind: 'text', markup: 'plain'}`.

   Office apps and browsers also put a rendered picture of the selection on the clipboard; when real text exists, text wins and the picture is ignored.
3. **Image.** If `clipboard.readImage()` is not empty, encode with `nativeImage.toPNG()`, stage as `pasted-<n>.png`, and return `{kind: 'image', mediaType: 'image/png'}`. This covers the primary use case: a screenshot of something complex, sent straight to the vision input (no OCR).
4. **Nothing usable** (empty, or only RTF/unknown formats): return `[]`; the renderer shows a transient inline hint "Nothing to paste from the clipboard." No modal.

`preview` labels: `Pasted image HH:MM`, `Pasted text: <first 40 chars>…`, and for HTML the same text preview from `readText()`.

### 6.3 Drag and drop capture

Handled in the renderer; listed here because it produces `SourceInput`:

- `DataTransfer.files`: the preload exposes `webUtils.getPathForFile(file)` as `window.eli5.files.pathFor(file)` (01, 11) to obtain absolute paths under `contextIsolation`. Each becomes `{kind: 'file', origin: 'drop'}`.
- `text/uri-list` without files (a link dragged from a browser): each URI becomes `{kind: 'url', origin: 'drop'}`.
- Dragged text without files or URIs: staged through `eli5:sources:stage-text` as a `{kind: 'text'}` input.

### 6.4 Clipboard resolver

`clipboard.ts` also implements `SourceResolver` for `text` and `image` inputs:

- `stagedPath` must lie under `ctx.stagingDir + '/inputs/'`; anything else is a programming error (`read-error`).
- `image`: re-read the staged PNG, verify it sniffs as `png`, enforce `maxImageBytes`, return `format: 'png'`, `payload: {kind: 'path'}`, `ref` = preview.
- `text` with `markup: 'plain'`: read file, return `format: 'text'` (or `markdown` if the text has at least two Markdown heading or list lines), `payload: {kind: 'text'}`.
- `text` with `markup: 'html'`: return `format: 'html'`, `payload: {kind: 'html'}` without `baseUrl`.
- Missing snapshot file (for example the user cleaned the app data folder) → `not-found`, reason "Pasted item was no longer available."

## 7. URL resolver (`src/main/sources/url.ts`)

### 7.1 Normalization

1. Trim; strip surrounding `<>` or quotes.
2. If there is no scheme and the string looks like a host (`label.tld` with an optional path), prefix `https://`.
3. Parse with WHATWG `URL`. Failure → `not-a-url` ("Not a valid web address").
4. Scheme must be `http:` or `https:` (`file:` is rewritten to a file input by the chain). Anything else (`mailto:`, `javascript:`, app deep links) → `unsupported-scheme`.
5. Remove the fragment for dedupe purposes, but keep it for `ref`. Lowercase the host. Do not alter the query string.
6. In the public build, bare identifiers that are not URLs (for example a ticket key) fail at step 3 with `not-a-url`. In the enterprise build, HOOK-SRC-02 may claim them before normalization via `LaneRouter.routeBare()`.

### 7.2 Delegation to the fetch module

The URL resolver owns no network code. It calls `ctx.fetchUrl(url, { jobId: ctx.jobId, signal: ctx.signal })`, which returns 05's `FetchOutcome` (`{kind:'article'|'binary'|'skipped'}`, [05-url-fetching.md](./05-url-fetching.md) §2). `fetchUrl` throws only `AbortError`, which the chain maps to `cancelled`.

| `FetchOutcome.kind` | Resolver result |
| --- | --- |
| `article` | `format: 'html'`, `mediaType: 'text/html'`, `payload: {kind: 'html', html: content.contentHtml, baseUrl: content.finalUrl}`, `ref` = original URL, `location` = `content.finalUrl`, `title` = `content.title ?? undefined`. `sha256` over `contentHtml` as UTF-8. |
| `binary` | Write `content.bytes` to `<ctx.stagingDir>/downloads/<n>-<content.filename>` (n = input index; directory created on demand), then run `sniff(head, content.filename, { declaredMediaType: content.mime })`. Supported → that format, `payload: {kind: 'path'}`. Unsupported → skip with the sniff code. Text bodies (`text/plain`, `text/markdown`, `text/csv`) arrive here as binaries and are classified by the text probe like any file. |
| `skipped` | `SkippedSource { ref: url, code: map(code), reason }`, using 05's `reason` string verbatim. |

`FetchSkipCode` → `SkipCode` mapping. Reason strings for fetch-originated skips are owned by 05 §10 and are passed through unchanged; the §9 table below applies only when a code is produced outside the fetch module.

| `FetchSkipCode` (05) | `SkipCode` |
| --- | --- |
| `invalid-url` | `not-a-url` |
| `blocked-scheme` | `unsupported-scheme` |
| `credentials-in-url` | `not-a-url` |
| `dns-failure`, `connect-failure`, `tls-error`, `too-many-redirects` | `fetch-failed` |
| `http-not-found`, `http-gone`, `http-client-error`, `http-server-error`, `rate-limited` | `http-error` |
| `timeout` | `timeout` |
| `too-large` | `too-large` |
| `login-required` | `login-required` |
| `paywall` | `paywall` |
| `unsupported-type` | `unsupported-type` |
| `empty-content` | `empty-content` |
| `render-failed` | `render-failed` |
| `blocked-private-address` | `blocked-private-address` |

The original `FetchSkipCode` is also written to the local debug log. Redirect chains are recorded as a note when `finalUrl` differs in host from the input.

## 8. Lane routing (`src/main/sources/lanes.ts`)

PRD rationale: the MCP is the authenticated access lane; plain fetch plus hidden-window rendering is the public web lane. Routing is decided before any network request so that organization URLs are never sent down the public lane.

```ts
export interface LaneRoute {
  lane: Lane;                 // 'web' | 'mcp'
  resolverId?: string;        // e.g. 'ticket' to force the ticket resolver
  ruleId?: string;            // which rule matched (debug log only)
  noWebFallback: boolean;     // true for organization routes
}

export interface LaneRule {
  id: string;
  match: { hostGlob?: string; pathPrefix?: string; pattern?: string /* RegExp source, full URL */ };
  route: Omit<LaneRoute, 'ruleId'>;
}

export interface LaneRouter {
  route(url: URL): LaneRoute;
  /** Enterprise only: classify non-URL identifiers (e.g. ticket keys). Public returns null. */
  routeBare(text: string): { url: URL; route: LaneRoute } | null;
}
```

Algorithm for `route(url)`:

1. Evaluate `LaneRule[]` in order; first match wins. Host globs match against the lowercased host (`*.example.internal` matches subdomains, not the apex).
2. No match → `{ lane: 'web', noWebFallback: false }`.
3. If the matched route has `lane: 'mcp'` but the edition is `public` or no MCP resolver is registered, the chain produces a skip with `not-available-in-edition` ("Organization source; requires the enterprise edition"). It does not fall back to the web lane when `noWebFallback` is true.
4. In the enterprise edition, if the MCP resolver fails for a routed URL, the source is skipped with the MCP failure code; it is never retried on the web lane when `noWebFallback` is true.

Public build: the rule list is empty, so every URL takes the web lane. Sites that require login are skipped by the fetch module with `login-required` (PRD "Fetching strategy", step 3).

<!-- hook:HOOK-SRC-03 -->
> **Private hook · HOOK-SRC-03 · Lane routing rules.** Public behavior: empty rule list; every http(s) URL routes to the web lane; `routeBare()` returns null. Private binding supplies: the ordered `LaneRule[]` (host globs, path prefixes, patterns) that send organization hosts to the MCP lane or to a specific resolver id, covering each host class (document system, org file store, observability system, code host, ticketing system); which routes set `noWebFallback`; the bare-identifier patterns recognized by `routeBare()` and the URL each expands to; any hosts that must be refused outright on the web lane; how rules are delivered (compiled into the overlay vs read from the enterprise settings overlay, see HOOK-CFG-01). Binding lives in the private spec under "HOOK-SRC-03".

## 9. Skip reasons

Reason text is fixed per code so documents read consistently; resolvers may append one short detail clause. Source of the reason string depends on who produced the skip: fetch skips use 05 §10's string verbatim; extraction skips use 04 §8.2's template (04 emits these `SkipCode` values directly, with no separate `reasonCode`); everything else uses the table below. The rows for fetch and extraction codes are fallbacks, used only when such a code is raised outside its owner (for example by an MCP resolver).

| Code | Origin | Reason text (base) |
| --- | --- | --- |
| `not-found` | 03 | File not found. |
| `permission-denied` | 03 | macOS did not allow the app to read this file. |
| `not-a-regular-file` | 03 | Not a regular file. |
| `empty` | 03, 04 | File was empty. (04: "No readable content found") |
| `file-changed` | 03 | File changed or moved. |
| `unsupported-type` | 03, 04, 05 | Unsupported file type. |
| `legacy-office-format` | 03 | Older Office format; re-save as .pptx, .docx, or .xlsx. |
| `too-large` | 03, 04, 05 | File is larger than the supported size. |
| `limit-exceeded` | 03 | Too many sources in one job; this one was not used. |
| `not-a-url` | 03, 05 | Not a valid web address. |
| `unsupported-scheme` | 03, 05 | Only web addresses (http or https) are supported. |
| `not-available-in-edition` | 03 | Requires the enterprise edition. |
| `sign-in-required` | 03 | Sign in to the organization to include this source. |
| `access-denied` | 03 | Your organization account does not have access to this source. |
| `cancelled` | 03 | Job was cancelled. |
| `read-error` | 03 | Could not be read. |
| `fetch-failed` | 05 | page could not be fetched |
| `login-required` | 05 | page required login |
| `paywall` | 05 | page required a subscription |
| `timeout` | 04, 05 | fetch timed out (04: "Took too long to read") |
| `http-error` | 05 | site returned an error |
| `empty-content` | 05 | page had no readable content |
| `render-failed` | 05 | page could not be rendered |
| `blocked-private-address` | 05 | link redirected to a private network address |
| `encrypted` | 03, 04 | File is password protected |
| `corrupt` | 04 | File could not be read (damaged or not a valid file) |
| `zip-bomb` | 04 | File expands to an unsafe size |
| `image-too-large` | 04 | Image too large to send |
| `image-budget-exceeded` | 04 | Too many images in one job |
| `scan-render-failed` | 04 | Scanned PDF pages could not be rendered |
| `internal-error` | 04 | Unexpected error while reading this file |

04's `unsupported` and `unsupported-legacy` codes are the same as `unsupported-type` and `legacy-office-format` here; 04 should use these names.

## 10. MCP-brokered resolver stub (`src/main/sources/mcp.stub.ts`)

Public build ships a stub that satisfies `SourceResolver` so the seam exists (PRD seam requirement: "Leave a documented MCP resolver stub").

```ts
export const mcpResolverStub: SourceResolver = {
  id: 'mcp',
  handles: ['url'],
  lane: 'mcp',
  canResolve: () => true,            // only ever offered URLs already routed to the mcp lane
  resolve: async (_input, ctx) => {
    throw new NotAvailableInEdition('source:mcp', 'HOOK-SRC-01', ctx.edition);
  },
};
```

### 10.1 MCP connection and transport

In the enterprise edition, one MCP session (one sign-in, including the second factor) serves every organization capability: the MCP source resolver (HOOK-SRC-01), the ticket-link resolver (HOOK-SRC-02), the organization cloud drive publisher (HOOK-PUB-01, see [10-publishing.md](./10-publishing.md)), and the `AuthBroker` (HOOK-AUTH-01). The public contract:

```ts
/** Overlay-owned. Exactly one instance per app process; the public build has none. */
export interface McpClient {
  readonly serverUrl: string;                       // from sources.mcp.url
  state(): 'disconnected' | 'connecting' | 'connected' | 'error';
  /** Calls one MCP tool. Honors signal; rejects with McpError on transport or tool failure. */
  callTool<T = unknown>(name: string, args: Record<string, unknown>,
                        opts: { signal: AbortSignal; timeoutMs?: number }): Promise<T>;
  onStateChange(listener: (s: ReturnType<McpClient['state']>) => void): () => void;
  close(): Promise<void>;
}

export interface McpError extends Error {
  kind: 'transport' | 'auth-expired' | 'forbidden' | 'not-found' | 'too-large' | 'timeout' | 'tool-error';
}
```

Rules:

1. The overlay creates the single `McpClient` and registers it in the registry ([01-architecture.md](./01-architecture.md)). The main process passes that same object to the resolvers (as `ResolveContext.mcp`), the drive publisher, and the `AuthBroker`. No capability opens its own connection.
2. `McpError.kind` maps to `SkipCode`: `auth-expired` → `sign-in-required`; `forbidden` → `access-denied`; `not-found` → `not-found`; `too-large` → `too-large`; `timeout` → `timeout`; `transport`/`tool-error` → `fetch-failed`.
3. The client carries no credentials in the app process (HOOK-AUTH-01 rule 2 in §12).
4. In the public build `sources.mcp.url` is inert: nothing reads it, no client exists, `ResolveContext.mcp` is undefined.

<!-- hook:HOOK-SRC-05 -->
> **Private hook · HOOK-SRC-05 · MCP connection and transport.** Public behavior: none; no MCP client is created and `sources.mcp.url` is inert. Private binding supplies: the transport (remote HTTP/SSE endpoint at `sources.mcp.url` vs a local stdio server process the app launches, and if local: the executable, how it is located, launched, supervised, restarted, and shut down, and how that child process changes the security model); the connection lifecycle and reconnect/backoff policy; confirmation that one shared session is consumed by the SRC, PUB, and AUTH capabilities; per-call timeouts and concurrency limits; the server capability or version check performed on connect and what happens on mismatch; the mapping of server errors onto `McpError.kind`. Binding lives in the private spec under "HOOK-SRC-05".

Required behavior of any enterprise implementation (contract, independent of private details):

1. The app talks to organization systems only through the shared `McpClient` (§10.1) for the server at `sources.mcp.url`. It never receives, stores, logs, or forwards user credentials or access tokens; the MCP server holds them and applies the user's authorization scope (PRD "Fetching strategy", enterprise).
2. Before resolving, check `AuthBroker.state()` (§12). If not `signed-in`, skip with `sign-in-required`. Do not start a sign-in from inside a job.
3. Map MCP results onto the existing formats: document bodies are saved to `stagingDir` and passed through `sniff()`; page/dashboard/code content returned as text or HTML becomes `text`, `markdown`, or `html` payloads. No new `SourceFormat` values are introduced by the overlay.
   - **Org file store** (a file/library store distinct from the document system): a file link resolves to one downloaded file in `stagingDir`; a folder or library link expands to its files under the same rules as local folders (§5.3: depth at most `maxFolderDepth` = 3, name order, subject to `maxSourcesPerJob` and `maxTotalBytes`, with overflow skipped as `limit-exceeded`). Each file's `ref` is its display name and `location` is a stable permalink that pins the version that was read, so the references list points at what the document was actually built from.
4. Authorization failures map to `access-denied`; expired sessions map to `sign-in-required` and set the broker state to `expired`.
5. Respect `ctx.signal` and `perSourceTimeoutMs`.

<!-- hook:HOOK-SRC-01 -->
> **Private hook · HOOK-SRC-01 · MCP-brokered source resolver.** Public behavior: `mcp.stub.ts` is registered but never offered an input (no lane rules), and throws `NotAvailableInEdition` if called, which the chain records as a `not-available-in-edition` skip. Private binding supplies (transport and connection are under HOOK-SRC-05): the MCP tool or resource names used per system (document system, org file store, observability system, code host); for the org file store: resolving a file or folder/library link to downloadable files in `stagingDir`, folder expansion limits within the depth-3 and `maxSourcesPerJob` rules, and version/permalink handling for `ref` and `location`; how each system's response is mapped to `SourceFormat` and payload; which content is downloaded as a file vs returned as text; per-system size and timeout limits; the mapping of MCP error responses to `SkipCode`; how scope violations are reported; any per-system `ref`/`title` conventions for the references list. Binding lives in the private spec under "HOOK-SRC-01".

<!-- hook:HOOK-SRC-04 -->
> **Private hook · HOOK-SRC-04 · Handling of organization-sourced material on disk.** Public behavior: pre-job clipboard drafts live under `<userData>/staging/drafts/<draftId>/`; at job start the pipeline snapshots all inputs (pastes, dropped files up to 200 MB) into `<userData>/jobs/<jobId>/inputs/`, larger files are read in place by path and mtime, and downloads go under `<userData>/jobs/<jobId>/`; retention and deletion follow 06 §9 (see also HOOK-PIPE-01). Private binding supplies: whether MCP-delivered content may be staged to disk at all or must stay in memory; required deletion timing or secure-deletion rules; whether organization source locations may be written to `meta.json` and the references section verbatim or must be redacted/shortened; any labelling required on documents built from organization material. Binding lives in the private spec under "HOOK-SRC-04".

## 11. Ticket-link resolver stub (`src/main/sources/ticket.stub.ts`)

Ticket links (ticketing system) are an enterprise-only source type (PRD source table: "Ticket links (issue trackers) · Enterprise edition only, via MCP"). The public build registers a stub with `id: 'ticket'`, `handles: ['url']`, `lane: 'mcp'`, whose `resolve()` throws `new NotAvailableInEdition('source:ticket', 'HOOK-SRC-02', ctx.edition)`. It is only ever selected when a lane rule sets `resolverId: 'ticket'`, which never happens in the public build. A ticket URL pasted into the public build therefore takes the web lane and is typically skipped as `login-required`.

Required behavior of the enterprise implementation:

1. Fetch through the MCP broker only, under the same auth rules as §10.
2. Produce one `ResolvedSource` per ticket with `format: 'markdown'` and a deterministic layout (title, key fields, description, then discussion in chronological order) so the LLM sees a stable structure.
3. Linked items (sub-items, linked tickets, attachments) are followed only as far as the private binding allows; each followed item becomes its own `ResolvedSource` with `inputId` of the original ticket input, subject to `maxSourcesPerJob`.
4. Attachments are downloaded to `stagingDir` and passed through `sniff()`; unsupported attachments are skipped individually.

<!-- hook:HOOK-SRC-02 -->
> **Private hook · HOOK-SRC-02 · Ticket-link resolver.** Public behavior: `ticket.stub.ts` is registered but never selected; ticket URLs follow the web lane and are usually skipped as login-required; bare ticket keys are rejected as `not-a-url`. Private binding supplies: the ticketing system's URL shapes and bare-key pattern (fed into HOOK-SRC-03); the MCP tools used to read a ticket, its comments, links, and attachments; which fields are included and in what order in the Markdown rendering; link-following depth and limits; attachment handling rules; `ref` and `title` formatting for the references list. Binding lives in the private spec under "HOOK-SRC-02".

## 12. Single sign-on lifecycle (AUTH)

The public build has no authentication of any kind (PRD "Out of scope for v1: Any authentication or login flows"). The seam is an `AuthBroker` in `src/main/sources/auth.ts` that the MCP and ticket resolvers consult and the UI observes.

AUTH has no dedicated spec file; this file owns the AUTH area. The `AuthBroker` interface and public stub live in `src/main/sources/auth.ts`, and the enterprise implementation is registered through `registry.registerAuth` as described in [01-architecture.md](./01-architecture.md). Defining HOOK-AUTH-01 here is therefore intentional. The enterprise broker uses the shared `McpClient` (§10.1) and never opens its own connection.

```ts
export type AuthState =
  | 'unavailable'   // public build, or sources.mcp.url unset
  | 'signed-out'
  | 'signing-in'
  | 'signed-in'
  | 'expired'
  | 'error';

export interface AuthStatus {
  state: AuthState;
  account?: string;     // display name only, as reported by the MCP server; never a token
  detail?: string;      // short human message for the error state
  updatedAt: string;    // ISO timestamp
}

export interface AuthBroker {
  status(): AuthStatus;
  /** User-initiated only (from settings or the sign-in indicator). Never called from a job. */
  signIn(): Promise<AuthStatus>;
  signOut(): Promise<AuthStatus>;
  onChange(listener: (s: AuthStatus) => void): () => void;
}
```

Public implementation: `status()` always returns `{ state: 'unavailable' }`; `signIn()`/`signOut()` throw `new NotAvailableInEdition('auth', 'HOOK-AUTH-01', edition)`; `onChange` never fires.

IPC (defined here, surfaced by the UI in [11-app-shell-ui.md](./11-app-shell-ui.md) under HOOK-UI-01):

| Channel | Direction | Payload | Returns |
| --- | --- | --- | --- |
| `eli5:auth:status` | renderer → main (invoke) | none | `AuthStatus` |
| `eli5:auth:sign-in` | renderer → main (invoke) | none | `AuthStatus` (public: rejects with `NotAvailableInEdition`) |
| `eli5:auth:sign-out` | renderer → main (invoke) | none | `AuthStatus` |
| `eli5:auth:changed` | main → renderer (event) | `AuthStatus` | n/a |

Lifecycle rules for any enterprise implementation:

1. Sign-in is always user-initiated and happens outside the ingest flow, so the "no modals in ingest and generation" rule holds. The interactive login (including second factor) runs in the system browser or in a flow owned by the MCP server, never in an app-rendered credential form.
2. The app stores nothing secret. At most it persists `account` and the last known state for display. Tokens, refresh tokens, and second-factor material live only with the MCP server.
3. When a session expires mid-job, the affected sources are skipped with `sign-in-required`, the state becomes `expired`, and the job continues with remaining sources.
4. Sign-out tells the MCP server to drop the session and moves state to `signed-out`.

<!-- hook:HOOK-AUTH-01 -->
> **Private hook · HOOK-AUTH-01 · MCP single sign-on lifecycle.** Public behavior: `AuthBroker` reports `unavailable`; sign-in and sign-out throw `NotAvailableInEdition`; no auth UI is shown; no credential or token is ever stored. Private binding supplies: the OAuth flow variant and where it runs (system browser, MCP-hosted page); the second-factor method and its expected user steps; how the app learns the session is established (callback, polling, MCP notification); session lifetime, refresh behavior, and expiry signalling; how sign-out is propagated; the account display string; the exact user-facing messages for `expired` and `error`; confirmation that no token material crosses into the app process. Binding lives in the private spec under "HOOK-AUTH-01".

## 13. IPC surface (sources area)

| Channel | Direction | Payload | Returns |
| --- | --- | --- | --- |
| `eli5:sources:read-clipboard` | invoke | `{ draftId: string }` | `SourceInput[]` (possibly empty) |
| `eli5:sources:stage-text` | invoke | `{ draftId: string; text: string; markup: 'plain' \| 'html' }` | `SourceInput` |
| `eli5:sources:discard` | invoke | `{ draftId: string; inputId: string }` | `void` |
| `eli5:sources:discard-draft` | invoke | `{ draftId: string }` | `void` (input zone cleared) |

`draftId` and `inputId` are validated against `^[a-z0-9-]{1,64}$`; staged paths are always derived in main from these ids and never accepted from the renderer. File paths from drops are accepted from the renderer but only as read targets for the file resolver. Job submission (`eli5:jobs:start` with `SourceInput[]`) is defined in [06-generation-pipeline.md](./06-generation-pipeline.md).

## 14. Edge cases

| Case | Behavior |
| --- | --- |
| Same file dropped twice, or dropped and also inside a dropped folder | Deduped by `sha256`; one resolved source. |
| Same URL with different fragments | Deduped by normalized URL; `ref` keeps the first. |
| `.pdf` extension but PNG content | Resolved as `png`; note "extension .pdf but content is PNG". |
| Text file with Windows-1252 bytes | Fails the UTF-8 probe if over 2% invalid; otherwise decoded with replacement characters and a note. |
| Screenshot pasted from the macOS screenshot thumbnail | Image branch; `png`. |
| Copy of cells from a spreadsheet app | Text branch with HTML; tables survive as HTML. |
| Copy of a file in Finder | File-reference branch; icon image ignored. |
| Clipboard holds only a URL | URL branch; chip shows the URL. |
| Clipboard holds a huge text (over `maxFileBytes`) | Staged, then skipped at resolve time as `too-large`. |
| iCloud placeholder file not downloaded locally | Read fails or yields zero bytes: `read-error` or `empty`, with detail "file may not be downloaded". |
| Symlink to a file | Followed via realpath; `location` is the real path. |
| Job cancelled mid-resolution | In-flight fetches aborted via `signal`; remaining inputs recorded as `cancelled`. |
| Organization URL in public build with a private rule list absent | Web lane; typically `login-required`. |
| Organization URL in enterprise build while signed out | `sign-in-required` skip; job continues; sign-in indicator shows state (HOOK-UI-01). |

## 15. Testing notes

Details in [13-testing-quality.md](./13-testing-quality.md). This module needs:

- Fixture corpus under `test/fixtures/sources/`: one minimal file per supported format, each unsupported signature (legacy OLE, encrypted OOXML, AVIF, RTF, generic ZIP), HEIC/TIFF/BMP images, a CSV file, mismatched extensions, BOM variants, empty file, directory tree with hidden files.
- Unit tests for `sniff()` table rows, URL normalization, lane routing with a synthetic rule list, chain ordering/dedupe/limits, and error mapping (including `NotAvailableInEdition`).
- Clipboard routing tested against a fake clipboard adapter (`ClipboardPort` wrapping `availableFormats/read/readText/readHTML/readImage/readBuffer`, including a multi-file `NSFilenamesPboardType` plist fixture) so the branch precedence is testable without a real pasteboard. `snapshotClipboard()` is tested separately against a fake async clipboard (§6.2).
- The fetch module and `AuthBroker` are injected, so the URL and MCP paths are tested with fakes.

## Acceptance criteria

- [ ] `SourceInput`, `ResolvedSource`, `SkippedSource` (with `ref`, `reason`, `code`), `SourceResolver`, `ResolveContext`, `LaneRouter`, and `AuthBroker` are exported from `src/main/sources/` with the shapes in this file.
- [ ] Resolution preserves input order, runs at most `concurrency` inputs at once, and never shows a modal or waits on the user.
- [ ] Every input produces a resolved source, a skipped source, or is a silent duplicate; skipped sources carry a human reason from the §9 table.
- [ ] A job with at least one resolved source proceeds even when other sources are skipped; a job with zero resolved sources is failed by the pipeline with a clear message.
- [ ] `sniff()` classifies every row of the signature table correctly, prefers magic bytes over extension, and records a note on mismatch.
- [ ] Legacy Office, encrypted Office, AVIF, RTF, and generic ZIP files are skipped with specific codes (`legacy-office-format`, `encrypted`, `unsupported-type`) and reasons; HEIC, TIFF, and BMP resolve to image formats; OOXML is classified by `[Content_Types].xml`.
- [ ] Dropped folders expand up to depth 3, skip hidden entries, and respect `maxSourcesPerJob`.
- [ ] Clipboard paste routes file references first, then visible text (URL list, HTML, plain), then image; a pasted screenshot becomes a `png` source sent to vision with no OCR.
- [ ] The clipboard is snapshotted at paste time into `staging/drafts/<draftId>/`; drafts are deleted on chip removal and job start, and a startup sweep removes drafts older than 24 h. After job start, resolvers read only the 06 snapshots under `jobs/<jobId>/inputs/`, and `ref` is always the original name.
- [ ] Multi-file Finder copies are read via `NSFilenamesPboardType` (plist parsed with `plist`), with `public.file-url` as the single-file fallback.
- [ ] The URL resolver contains no network code, consumes 05's `FetchOutcome`, writes binaries to `stagingDir` before sniffing, maps every `FetchSkipCode` via the §7.2 table, and passes 05's reason strings through unchanged.
- [ ] `SkippedSource.code` uses only the `SkipCode` union in §2 across 03, 04, and 05.
- [ ] Stubs throw `NotAvailableInEdition(capability, hookId, edition)` with `source:mcp`/`HOOK-SRC-01`, `source:ticket`/`HOOK-SRC-02`, and `auth`/`HOOK-AUTH-01`.
- [ ] In the enterprise edition exactly one `McpClient` exists and is shared by the MCP and ticket resolvers, the drive publisher, and the `AuthBroker`.
- [ ] In the public build, every URL routes to the web lane, `mcp` and `ticket` stubs are registered but never selected, and calling either yields a `not-available-in-edition` skip.
- [ ] The public build performs no authentication, stores no credentials, and `eli5:auth:status` returns `unavailable`.
- [ ] Organization-routed URLs with `noWebFallback` are never fetched on the web lane in any edition.
- [ ] HOOK-SRC-01, HOOK-SRC-02, HOOK-SRC-03, HOOK-SRC-04, HOOK-SRC-05, and HOOK-AUTH-01 each have a machine marker and a visible callout, and the public behavior they describe matches the stubs.
