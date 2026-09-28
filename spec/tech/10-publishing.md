# Publishing

This file specifies how a finished document leaves the app: the `Publisher` interface and its
`PublishTarget` / `PublishResult` types, the v1 local publisher, the documented but dormant
organization cloud drive and git publishers (both stubs in the public build), the shared secret
scanner and explicit-file-list rules that any git-based publish must follow, how a returned link is
surfaced to the user (copy, open in the default browser, reveal in Finder), the publish IPC
channels, and the outline of the in-app help page for setting up a GitHub Actions workflow that
renders pushed HTML to GitHub Pages. Every organization-specific detail is a private hook
(HOOK-PUB-01..05) that the private spec binds; nothing here names a real organization or system.

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) ·
[03-source-resolvers.md](03-source-resolvers.md) · [06-generation-pipeline.md](06-generation-pipeline.md) ·
[07-output-document.md](07-output-document.md) · [09-library-storage.md](09-library-storage.md) ·
[11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) ·
[13-testing-quality.md](13-testing-quality.md)

PRD sections implemented here: *Build editions and swap seams* (Publishing row, `Publisher` seam
requirement, enterprise-only UI flag), *Enterprise publishing (documented, not implemented in v1)*
(cloud drive, Git push to GitHub Pages, help documentation), *Configuration, scope, and open items*
(dormant `publish.drive.*`, `publish.github.*` keys; open item "Define the enterprise publishing
targets and repo layout").

## 1. Principles

1. **Publishing is always user triggered.** Nothing is published as a side effect of generation,
   regeneration, or merge. There is no auto-publish and no scheduled publish in any edition.
2. **The document already lives locally.** Generation saves `docs/<slug>/index.html` (09). The
   public build's only publisher, `local`, exports a copy outside the app; it never moves or mutates
   the library copy.
3. **Only `index.html` is a publishable artifact.** `meta.json` records local file paths and the
   user's clarifying input; `catalog.json` lists every document. Neither is ever uploaded or
   committed by any publisher. Publishers operate on an explicit file list (§3.3).
4. **Publishers never hold credentials.** The cloud drive publisher goes through the MCP (token held
   by the MCP, HOOK-AUTH-01). The git publisher uses the host's existing git credential setup; the
   app never reads, stores, or logs tokens.
5. **Stubs are honest.** In the public build `drive` and `git` are registered as stubs that throw
   `NotAvailableInEdition` (01 §6.4) and report `available: false`. Their UI is hidden (HOOK-UI-01).

## 2. Module layout

```
src/main/publish/
  types.ts            Publisher, PublishTarget, PublishResult, PublishContext, PublishLink, PublicationRecord
  index.ts            registerPublicPublishers(registry); publish service (runPublish, listTargets)
  files.ts            buildPublishFileSet(slug) -> PublishFile[] (explicit allowlist, §3.3)
  secret-scan.ts      SecretScanner interface + BaselineSecretScanner (pattern based, public)
  links.ts            copy / open / reveal helpers (clipboard, shell.openExternal, shell.showItemInFolder)
  local.ts            LocalPublisher (v1, available)
  drive.stub.ts       DrivePublisherStub  -> NotAvailableInEdition(HOOK-PUB-01)
  git.stub.ts         GitPublisherStub    -> NotAvailableInEdition(HOOK-PUB-03)
resources/help/
  publish-github-pages.html   in-app help page (§8), self-contained, opened with the default app
```

## 3. Types

### 3.1 Publisher interface

```ts
// src/main/publish/types.ts
export type PublisherKind = 'local' | 'drive' | 'git';

export interface PublishTarget {
  id: string;                    // registry id: 'local' | 'drive' | 'git' | overlay-defined ids
  kind: PublisherKind;
  label: string;                 // button text, e.g. "Export copy", "Share to cloud drive", "Push to Pages"
  available: boolean;            // false for stubs and for misconfigured targets
  unavailableReason?: string;    // human readable, e.g. "Not configured" (never a hook ID)
  destinationPreview?: string;   // e.g. "~/Documents/ELI5 Learner/revenue-recognition/"
  requiresSignIn: boolean;       // true only for MCP-brokered targets (drive)
  lastPublished?: PublicationRecord; // most recent successful publish of this slug to this target
  changedSincePublish?: boolean; // with lastPublished: index.html no longer matches its contentSha256
}

export interface PublishFile {
  relPath: string;               // path relative to the document folder, POSIX separators
  absPath: string;               // resolved on disk, inside docs/<slug>/
  bytes: number;
  sha256: string;
}

export interface PublishContext {
  slug: string;
  title: string;                 // from CatalogEntry
  files: readonly PublishFile[]; // from buildPublishFileSet; publishers MUST NOT add to it
  settings: Settings;            // read-only snapshot
  signal: AbortSignal;           // cancelled when the app quits or the user cancels
  progress(stage: PublishStage): void;
}

export type PublishStage =
  | 'preparing' | 'scanning' | 'uploading' | 'sharing'
  | 'committing' | 'pushing' | 'waiting-for-site' | 'done';

export interface Publisher {
  readonly id: string;
  readonly kind: PublisherKind;
  readonly stub?: true;          // present only on stubs (01 §6.2)
  /** Cheap, no network. Reports availability and configuration state. */
  describe(slug: string, settings: Settings): Promise<PublishTarget>;
  /** Performs the publish. Throws PublishError or NotAvailableInEdition. */
  publish(ctx: PublishContext): Promise<PublishResult>;
}
```

### 3.2 Result, links, history

```ts
export interface PublishLink {
  kind: 'file' | 'share' | 'site' | 'commit';
  url: string;                   // file:// for local, https:// otherwise
  label: string;                 // "Open copy", "Shareable link", "Pages URL", "Commit"
  primary: boolean;              // exactly one link per result is primary
}

export interface PublishResult {
  targetId: string;
  kind: PublisherKind;
  slug: string;
  publishedAt: string;           // ISO 8601
  files: string[];               // relPaths actually published
  links: PublishLink[];          // at least one; primary link is what "Copy link" copies
  warnings: string[];            // non-fatal, human readable (e.g. "Site may take a minute to update")
  commit?: { sha: string; branch: string };           // git only
  sharing?: { scope: 'organization' | 'owner' | 'custom'; description: string }; // drive only
}

/** Persisted per document in meta.json under "publications" (09 owns the file). */
export interface PublicationRecord {
  targetId: string;
  kind: PublisherKind;
  publishedAt: string;
  primaryUrl: string;
  contentSha256: string;         // sha256 of index.html at publish time
}

export type PublishErrorCode =
  | 'E_PUBLISH_NOT_CONFIGURED'   // required settings missing
  | 'E_PUBLISH_SIGN_IN_REQUIRED' // MCP session absent or expired
  | 'E_PUBLISH_SECRET_FOUND'     // scanner blocked the publish
  | 'E_PUBLISH_DESTINATION'      // destination unwritable / repo rejected / quota
  | 'E_PUBLISH_CONFLICT'         // remote moved on, retry after sync failed
  | 'E_PUBLISH_CANCELLED'
  | 'E_PUBLISH_FAILED';          // anything else, message is safe to show

export class PublishError extends Error {
  constructor(readonly code: PublishErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'PublishError';
  }
}
```

Every `PublishError` maps to `IpcError` with `code: 'E_PUBLISH_FAILED'`, the `PublishErrorCode` in
`detailCode` and `message` passed through (01 §5.1), both as an invoke rejection and in the
`eli5:publish:progress` payload (§6), so the UI can show the right hint. `detail` is logged, never sent to the renderer.

### 3.3 The publish file set

`buildPublishFileSet(slug)` is the single place that decides what may leave the machine.

1. Resolve `docs/<slug>/` from the library (09). Reject a slug that does not match
   `^[a-z0-9][a-z0-9-]{0,79}$` or does not exist → `E_NOT_FOUND`.
2. Start from the allowlist `['index.html']`. v1 documents are self-contained (07), so this is the
   whole set. If a future document format adds an `assets/` folder, entries under it are added only
   if their extension is in `{.png,.jpg,.jpeg,.gif,.svg,.webp,.css,.js,.woff2}`.
3. Never include: `meta.json`, `catalog.json`, dotfiles, anything outside `docs/<slug>/`, symlinks
   (checked with `lstat`; a symlink anywhere in the set aborts with `E_PUBLISH_FAILED`).
4. Compute `bytes` and `sha256` for each file. A set larger than 25 MB total aborts with
   `E_PUBLISH_FAILED` ("Document too large to publish").
5. Freeze the array. Publishers receive it read-only and must publish exactly these files, no more.

Rationale: an explicit list rather than "the folder" is what the PRD means by "committing only the
specified files", and it applies to every publisher, not only git.

## 4. Publish service and registration

```ts
// src/main/publish/index.ts
export function registerPublicPublishers(reg: CapabilityRegistry): void {
  reg.registerPublisher('local', () => new LocalPublisher());
  reg.registerPublisher('drive', () => new DrivePublisherStub());
  reg.registerPublisher('git',   () => new GitPublisherStub());
}
export function listTargets(slug: string): Promise<PublishTarget[]>;
export function runPublish(slug: string, targetId: string): Promise<PublishResult>;
```

`listTargets` calls `describe()` on every registered publisher and returns targets in the order
`local`, `drive`, `git`, then overlay ids alphabetically. In the public build it returns stubs too
(with `available: false`) so the UI layer, not the service, decides visibility; the renderer shows
only targets whose feature flag is enabled (`publish.drive`, `publish.git`, 01 §6.2; HOOK-UI-01).
`local` has no feature flag and is always shown.

`runPublish(slug, targetId)`:

1. Look up the publisher; unknown id → `E_NOT_FOUND`. A stub throws `NotAvailableInEdition` on
   `publish()`; the service does not special-case it.
2. Reject if a publish for the same `(slug, targetId)` is already running → `E_CONFLICT`
   ("Already publishing"). Different slugs or targets may run concurrently; publishing does not
   use the generation job queue (06) and does not block it.
3. Acquire the document's read lock from the library (09) so a concurrent regenerate-in-place
   cannot rewrite `index.html` mid-publish. Regeneration requested during a publish waits for the
   lock; it is never rejected.
4. `buildPublishFileSet(slug)` (§3.3).
5. Run the pre-publish content policy (HOOK-PUB-05). Public build: no-op.
6. Call `publisher.publish(ctx)`, forwarding `ctx.progress` to `eli5:publish:progress`.
7. On success, append a `PublicationRecord` to `meta.json.publications` (atomic write, 09) and emit
   `eli5:publish:progress {stage:'done', result}`. The library catalog is not modified.
8. Release the lock. On any error emit `eli5:publish:progress {stage:'failed', error}` and return
   the `IpcResult` error.

Publishing never mutates `index.html`. If the user regenerates a section after publishing, the
published copy is stale; the UI shows "Changed since last publish" by comparing the current
`index.html` sha256 with `lastPublished.contentSha256`. Republishing is a manual action.

## 5. Publishers

### 5.1 Local publisher (v1, available)

Purpose: give the public build a way to get a document out of the app project directory into a
place the user controls (to email, drop into a shared folder by hand, or open in another browser).

| Setting | Default | Notes |
| --- | --- | --- |
| `publish.local.dir` | `~/Documents/ELI5 Learner` | Absolute path after `~` expansion. Schema owned by 12. |
| `publish.local.revealAfter` | `true` | Reveal the exported file in Finder after export |

Algorithm (`LocalPublisher.publish`):

1. Resolve `dir = expandHome(settings.publish.local.dir)`. Reject if it resolves inside the app's
   `docs/` directory (would recurse into the library) → `E_PUBLISH_DESTINATION`.
2. `mkdir -p <dir>/<slug>/`. On `EACCES`/`EROFS`/`ENOSPC` → `E_PUBLISH_DESTINATION` with a message
   naming the folder.
3. For each file in `ctx.files`: copy to `<dir>/<slug>/<relPath>.tmp-<rand>`, fsync, rename over
   the target (atomic replace). Overwriting a previous export of the same slug is expected.
4. Verify the copied `index.html` sha256 equals the source; mismatch → delete the temp and fail.
5. Return `PublishResult` with one primary link `{kind:'file', url: file://<dir>/<slug>/index.html,
   label:'Open copy'}`. If `revealAfter`, call `shell.showItemInFolder` on the file.

`describe()` returns `available: true` always; `destinationPreview` is the resolved folder with
`~` re-abbreviated. A missing directory is not an error at describe time (created on publish).

Edge cases:
- Destination on an unmounted volume: step 2 fails with `ENOENT` on the root → `E_PUBLISH_DESTINATION`
  ("Folder is not available. Is the drive connected?").
- The user picked a synced personal folder: allowed; the app does not detect or special-case sync
  clients.
- Export while the document is being merged away (09 merge accept removes the slug): the read lock
  in §4 step 3 serializes them; whichever runs second sees the final state (a merged-away slug
  → `E_NOT_FOUND`).

### 5.2 Organization cloud drive publisher (stub in public build)

Public build: `drive.stub.ts` registers `id:'drive'`, `kind:'drive'`, `stub: true`.
`describe()` returns `{available:false, unavailableReason:'Available in the enterprise edition',
requiresSignIn:true}`; `publish()` throws
`new NotAvailableInEdition('publisher:drive', 'HOOK-PUB-01', edition)`.

Contract the enterprise implementation must satisfy (PRD *Organization cloud drive*):

1. Precondition: auth capability reports `signed-in` (HOOK-AUTH-01). Otherwise throw
   `E_PUBLISH_SIGN_IN_REQUIRED`; the UI offers the sign-in action, then the user retries. The app
   never opens its own login window for the drive.
2. `progress('uploading')`: upload exactly `ctx.files` to the configured drive location under a
   per-document folder `<location>/<slug>/`, brokered by the MCP. Re-publishing replaces the files
   in place so the shareable link stays stable.
3. `progress('sharing')`: apply the sharing policy (HOOK-PUB-02). If sharing fails after upload
   succeeded, return success with scope `'owner'` and a warning ("Uploaded, but could not share with
   the organization"), never a silent narrower share.
4. Return a primary `{kind:'share'}` link that anyone covered by the policy can open.
5. Honor `ctx.signal`: a cancel after upload but before sharing leaves the uploaded files owner-only.

<!-- hook:HOOK-PUB-01 -->
> **Private hook · HOOK-PUB-01 · Organization cloud drive publisher.** Public behavior: `drive` is
> a stub that reports `available:false` and throws `NotAvailableInEdition('publisher:drive',
> 'HOOK-PUB-01')`; no network access, no UI (hidden by HOOK-UI-01). Private binding supplies: the
> cloud drive product and the MCP tool names and argument shapes used to upload, replace, and
> look up files; the root location and folder naming convention (per user, per team, or shared);
> the `publish.drive.*` keys and their values (see HOOK-CFG-01); how a stable share link is
> obtained and its URL shape; file size and rate limits; behavior when the target folder was
> deleted or moved by the user outside the app; and the error-to-`PublishErrorCode` mapping.
> Binding lives in the private spec under "HOOK-PUB-01".

<!-- hook:HOOK-PUB-02 -->
> **Private hook · HOOK-PUB-02 · Organization-wide sharing policy.** Public behavior: none; the
> public build never shares anything. The drive contract above requires that sharing is applied
> after upload and that a failed share degrades to owner-only with a visible warning. Private
> binding supplies: the exact permission applied (organization-wide view link, group, or domain),
> whether edit or comment rights are ever granted, link expiry if any, content classification or
> sensitivity labels to attach, whether external-sharing must be explicitly blocked, the wording of
> `PublishResult.sharing.description` shown to the user, and any audit or approval step required
> before an organization-wide share. Binding lives in the private spec under "HOOK-PUB-02".

### 5.3 Git publisher (stub in public build)

Public build: `git.stub.ts` registers `id:'git'`, `kind:'git'`, `stub: true`, same shape as the
drive stub, throwing `NotAvailableInEdition('publisher:git', 'HOOK-PUB-03', edition)`.
`secret-scan.ts` and `files.ts` are real public code (tested in 13) because they define the safety
contract any git publisher must follow.

Contract the enterprise implementation must satisfy (PRD *Git push to GitHub Pages*).

**Invocation mode.** The git publisher carries a binding-selected mode (HOOK-PUB-03):

```ts
type GitInvocationMode = 'direct' | 'push-tool' | 'delegate';

interface GitPublisherConfig {
  invocationMode: GitInvocationMode;
  gitPath?: string;                 // absolute; resolved per "Locating git" below when unset
  workspace:                        // step 1
    | { kind: 'app-owned' }                       // <userData>/publish/git/<repo-hash>/
    | { kind: 'user-clone'; path: string };       // absolute path to an existing clone
  pushTimeoutMs: number;            // default 120_000 (direct, push-tool)
  delegateTimeoutMs: number;        // default 900_000 (delegate)
  readinessCheck?: 'head-poll' | 'none' | 'redirect-is-deployed' | 'code-host-status'; // step 10
}
```

| Mode | Who runs commit and push | Steps the app runs itself |
|------|--------------------------|---------------------------|
| `direct` | The app, via plain `git` | 1 to 10 |
| `push-tool` | The app for steps 1 to 7; the secret-scanning push tool performs step 8 (wrapping `git push`, running as a pre-push step, or doing the commit and push itself) | 1 to 10, with 8 (and 7 if the tool commits) replaced by the tool |
| `delegate` | An external executor or AI coding agent that runs the push tool, asynchronously | 1 to 4 (prepare and scan), then the delegate protocol below, then 9 and 10 |

In `direct` and `push-tool` modes the steps below apply as written. In `delegate` mode, steps 5 to 8
are replaced by the delegate protocol that follows the numbered list.

1. **Workspace.** By default (`workspace.kind = 'app-owned'`) operate in a dedicated working copy
   owned by the app (`<userData>/publish/git/<repo-hash>/`), never in the user's own clones and
   never in the app project repository. Clone on first use (shallow, single branch); afterwards
   `fetch` + hard reset to `origin/<branch>` before each publish so no stray local state is ever
   pushed. When the binding requires the tool to run in a user clone
   (`workspace.kind = 'user-clone'`), the app never resets, stashes, or cleans that clone: it
   checks `git status --porcelain` first and, if any path outside `destDir` is modified, staged,
   or untracked, or the checked-out branch is not `<branch>`, aborts with `E_PUBLISH_DESTINATION`
   ("Your clone at <path> has unrelated changes; commit or discard them and try again").
2. **Stage path.** `destDir = <docsPath>/<slug>/` where `docsPath` comes from the target
   (HOOK-PUB-04). Reject a `docsPath` that is absolute, contains `..`, or resolves outside the
   working copy.
3. **Copy.** Copy exactly `ctx.files` into `destDir`. Delete files in `destDir` that are not in
   `ctx.files` only if they were recorded in a previous `PublicationRecord` for this slug; never
   touch other paths.
4. **Scan.** `progress('scanning')`: run the secret scanner (§5.4) over every file in `ctx.files`.
   Any finding → abort with `E_PUBLISH_SECRET_FOUND`; reset the working copy; nothing is committed.
5. **Stage explicitly.** `git add -- <each destDir/relPath>`; never `git add .`, `-A`, or a
   directory path.
6. **Verify the index.** `git diff --cached --name-only` must equal the set of staged paths that
   actually changed. Any extra path → abort and reset (defense against hooks or attributes that
   stage other files). An empty diff → return success with warning "No changes since last publish"
   and no commit.
7. **Commit.** `progress('committing')`: message `docs: publish <slug>` plus a blank line and
   `Published by ELI5 Learner`. Author identity comes from the host's git config; the app does not
   set one.
8. **Push.** `progress('pushing')`: push to `origin <branch>` using the invocation mode from
   HOOK-PUB-03. On non-fast-forward: fetch, reset, repeat steps 3 to 8 once; a second rejection →
   `E_PUBLISH_CONFLICT`. Never force-push.
9. **Link.** Compute the site URL from the Pages URL pattern (HOOK-PUB-04), e.g.
   `https://<owner>.github.io/<repo>/<docsPathWithoutRoot>/<slug>/`. Return it as the primary
   `{kind:'site'}` link, plus a `{kind:'commit'}` link when the code host has a web commit URL.
10. **Optional wait.** `progress('waiting-for-site')`, governed by `readinessCheck` (HOOK-PUB-04;
    default `head-poll`). `head-poll`: fetch `<siteUrl>index.html` with `GET` every 10 s for up to
    3 minutes, following no redirects, until it returns 200 and either its `Last-Modified` is at or
    after the push time or the sha256 of the body equals the sha256 of the published
    `index.html` (the body hash is authoritative; `ETag` values are opaque and never compared for
    order). `none`: skip the wait. `redirect-is-deployed`: for an access-controlled site, a 3xx to
    the identity provider counts as deployed. `code-host-status`: the binding supplies a readiness
    function (for example, querying the code host's deployment status through the MCP lane) with
    signature `(ctx: { siteUrl: string; commitSha: string; signal: AbortSignal }) =>
    Promise<'deployed' | 'pending' | 'failed'>`, polled on the same schedule. Timeout is a warning
    ("Site is still deploying; the link will work shortly"), not a failure; `'failed'` is a warning
    too, since the push itself succeeded.

**Delegate protocol** (`invocationMode = 'delegate'`; replaces steps 5 to 8):

1. **Manifest.** After steps 1 to 4 pass, write a hand-off manifest to
   `<userData>/publish/handoff/<publicationId>.json` (mode 0600):

   ```ts
   interface GitHandoffManifest {
     schema: 1;
     publicationId: string;
     repo: string;              // owner/name on the code host
     branch: string;
     docsPath: string;
     slug: string;
     workspacePath: string;     // where the files were staged (step 1)
     files: string[];           // explicit repo-relative paths, e.g. docs/<slug>/index.html
     deletions: string[];       // repo-relative paths removed per step 3
     commitMessage: string;     // step 7 message
     expectedSiteUrl: string;   // step 9
     resultPath: string;        // where the executor must write its GitHandoffResult
   }
   ```

   No token, credential, or secret is ever written to the manifest.
2. **Launch.** `progress('pushing')`: start the executor or agent with `execFile` (never a shell)
   using the argument vector from the binding, with the manifest path as an argument. Environment
   is the sanitized git environment below; no token is passed. If the executor binary is not found
   → `E_PUBLISH_NOT_CONFIGURED` with the binding's install/fallback text.
3. **Progress.** Stream stdout/stderr lines into the job log (redacted by the §5.4 scanner before
   logging) and poll for `resultPath` every 2 s. Cancellation kills the process tree and yields
   `E_PUBLISH_CANCELLED`. Exceeding `delegateTimeoutMs` kills it and yields `E_PUBLISH_FAILED`
   ("The publishing agent did not finish in time").
4. **Parse result.** The executor writes (or prints as the last stdout line, if the binding says so)
   a structured result; free-form text is never parsed for success:

   ```ts
   interface GitHandoffResult {
     schema: 1;
     status: 'pushed' | 'no-changes' | 'secret-found' | 'rejected' | 'error';
     commitSha?: string;
     pushedPaths?: string[];
     findings?: SecretFinding[];
     message?: string;
   }
   ```

   `secret-found` → `E_PUBLISH_SECRET_FOUND` with `findings`; `rejected` → `E_PUBLISH_CONFLICT`;
   `error` or a missing/invalid result → `E_PUBLISH_FAILED`; `no-changes` → success with warning.
5. **Verify independently.** On `pushed`: `git fetch origin <branch>` in the workspace, then
   `git diff --name-only <commitSha>^ <commitSha>` and confirm `<commitSha>` is reachable from
   `origin/<branch>`. The changed set must be a subset of `files ∪ deletions`. Any extra path →
   report `E_PUBLISH_DESTINATION` ("The publish touched files outside this document: <paths>")
   and mark the publication as failed in history; the app never rewrites history to undo it. Only
   after verification does the publisher proceed to steps 9 and 10.

**Locating git.** A GUI app launched from Finder does not inherit the shell `PATH`, so git is
never resolved through `PATH`. Use `gitPath` if configured (must be absolute and executable);
otherwise take the first executable of `/opt/homebrew/bin/git`, `/usr/local/bin/git`; otherwise
use `/usr/bin/git` only if `xcode-select -p` exits 0 (running the `/usr/bin/git` shim without
Command Line Tools opens the system install dialog). If none qualifies →
`E_PUBLISH_NOT_CONFIGURED` ("git was not found. Install git or set its path in Settings"). The
same absolute-path rule applies to the push tool and delegate executor.

Credentials: the push uses whatever credential helper or SSH configuration git already has. The
app never passes a token on the command line, in the remote URL, or in environment variables it
logs. git (and any tool or executor) is invoked with `execFile` (no shell), a timeout
(`pushTimeoutMs`, default 120 s; `delegateTimeoutMs` in delegate mode), and this environment so
that no prompt or modal can appear:

| Variable | Value | Suppresses |
|----------|-------|------------|
| `GIT_TERMINAL_PROMPT` | `0` | git username/password prompts |
| `GIT_ASKPASS` | `/usr/bin/false` | askpass GUI helpers |
| `SSH_ASKPASS` | `/usr/bin/false` | SSH passphrase GUI helpers |
| `GIT_SSH_COMMAND` | `ssh -o BatchMode=yes` | SSH passphrase and host-key prompts |
| `GCM_INTERACTIVE` | `never` | credential-manager dialogs |

A credential helper that would still raise a system Keychain dialog is outside the app's control;
the help page (§8) tells users to grant access once from a terminal. Any authentication prompt is
therefore a failure with the message "git could not authenticate. Check your git credentials for
this repository."

<!-- hook:HOOK-PUB-03 -->
> **Private hook · HOOK-PUB-03 · Git publisher: secret-scanning push tool integration and
> invocation mode.** Public behavior: `git` is a stub throwing `NotAvailableInEdition('publisher:git',
> 'HOOK-PUB-03')`; the public baseline scanner (§5.4) and explicit file set (§3.3) exist and are
> tested but no git process is ever spawned. Private binding supplies: the organization's
> secret-scanning push tool, how it is located and version-checked, and whether it replaces or runs
> in addition to the baseline scanner; the `invocationMode` chosen (`direct`, `push-tool`, or
> `delegate`) and, for `push-tool`, whether the tool wraps `git push`, runs as a pre-push step, or
> performs the commit and push itself; the tool or delegate executor/agent command, its absolute
> path resolution, and its argument vector (including whether it is invocable only through a
> shell or agent CLI, and the `execFile`-safe wrapper used in that case); exact exit codes and
> output format to parse into `SecretFinding`s; for `delegate`, the hand-off manifest format (or
> confirmation of `GitHandoffManifest` schema 1), the result format and success signal (result
> file vs last stdout line, mapping to `GitHandoffResult`), and `delegateTimeoutMs`; whether the
> tool must run in a user clone (`workspace.kind = 'user-clone'`) and where that clone lives;
> whether it may stash, rewrite, or clean the working copy, how working-copy hazards it guards
> against (stashed or unrelated changes) are reported back to the app, and how the app protects
> against them; the fallback when the tool or executor is not installed (install instructions,
> or falling back to `direct` with the baseline scanner, or refusing); the required git and tool
> versions; the credential mechanism expected on the host (credential helper, SSH host alias)
> described without secrets; and the remediation text shown on `E_PUBLISH_SECRET_FOUND`. Binding
> lives in the private spec under "HOOK-PUB-03".

<!-- hook:HOOK-PUB-04 -->
> **Private hook · HOOK-PUB-04 · Publish targets: repo, branch, docs path, Pages URL pattern.**
> Public behavior: `publish.github.*` keys are accepted by the settings schema but inert; the
> documented defaults are `repo: ""` (unset, target reports "Not configured"), `branch: "main"`,
> `docsPath: "docs"`, `pagesUrlPattern: "https://{owner}.github.io/{repo}/{path}/{slug}/"`. Private
> binding supplies: the concrete repository or repositories (one shared or one per team), branch,
> docs directory layout (flat by slug, or grouped by owner/topic), the Pages URL pattern including
> any custom domain, whether a site index page listing published documents is maintained and by
> whom, retention/unpublish policy, whether the repository's Pages site is private to the
> organization, and, if it is access-controlled, how site readiness (§5.3 step 10) is detected:
> `readinessCheck` set to `none` (disable the wait), `redirect-is-deployed` (a redirect to the
> identity provider counts as deployed), or `code-host-status` (with the readiness function that
> queries deployment status through the code host via the MCP lane). This closes the PRD open item "Define the enterprise publishing targets and repo
> layout". Binding lives in the private spec under "HOOK-PUB-04".

### 5.4 Secret scanner

```ts
// src/main/publish/secret-scan.ts
export interface SecretFinding {
  relPath: string;
  line: number;             // 1-based
  rule: string;             // e.g. "private-key-block", "aws-access-key-id", "generic-high-entropy"
  preview: string;          // matched text with all but first 4 chars masked
}

export interface SecretScanner {
  readonly id: string;
  scan(files: readonly PublishFile[], signal: AbortSignal): Promise<SecretFinding[]>;
}
```

`BaselineSecretScanner` (public, no dependencies) applies:

| Rule | Detects |
| --- | --- |
| `private-key-block` | `-----BEGIN ... PRIVATE KEY-----` |
| `cloud-access-key-id` | common cloud access key id prefixes followed by 16 uppercase alphanumerics |
| `llm-api-key` | Anthropic and OpenAI key prefixes (`sk-ant-`, `sk-proj-`, `sk-` + 40+ chars) |
| `code-host-token` | code host personal access / fine-grained token prefixes (`ghp_`, `github_pat_`, `gho_`, `ghs_`) |
| `bearer-header` | `Authorization: Bearer <20+ chars>` |
| `url-credentials` | `scheme://user:password@host` |
| `generic-high-entropy` | `(secret\|token\|password\|api[_-]?key)\s*[:=]\s*['"]?<24+ chars, Shannon entropy > 4.0>` |

Rules run on decoded text line by line; binary files (images, fonts) are skipped. Findings are
never logged with unmasked values. The scanner exists in the public build because generated
documents can legitimately quote source material that contained a secret (for example a pasted
screenshot of a config file); the LLM output is not trusted to have removed it.

## 6. IPC

Baseline channels are defined in 01 §5.2 (`eli5:publish:targets`, `eli5:publish:run`). This file
adds the following, with the same conventions (`IpcResult<T>`, zod validation, app renderer only):

| Channel | Dir | Request | Response / payload |
| --- | --- | --- | --- |
| `eli5:publish:progress` | M→R | — | `{slug; targetId; stage: PublishStage \| 'failed'; result?: PublishResult; error?: IpcError}`; a `PublishError` arrives as `E_PUBLISH_FAILED` with the `PublishErrorCode` in `detailCode` and, for `E_PUBLISH_SECRET_FOUND`, the masked `findings` (01 §5.1) |
| `eli5:publish:history` | R→M | `{slug}` | `PublicationRecord[]` newest first |
| `eli5:publish:cancel` | R→M | `{slug; targetId}` | `void` (aborts `ctx.signal`; no-op if not running) |
| `eli5:publish:copy-link` | R→M | `{url}` | `void` (writes to system clipboard in main) |
| `eli5:publish:open-link` | R→M | `{url}` | `void` (`https:` via `safeOpenExternal`; `file:` via `shell.openPath`, §7) |
| `eli5:publish:reveal` | R→M | `{url}` (`file:` only) | `void` (`shell.showItemInFolder`) |

Preload addition: `window.eli5.publish` gains `onProgress(cb)`, `history(slug)`, `cancel(slug,
targetId)`, `copyLink(url)`, `openLink(url)`, `reveal(url)`.

## 7. Link surfacing

The PRD requires the returned link to be "one click to copy or open in the default browser".

1. After a successful publish the renderer shows an inline, non-modal result chip in the document
   header area (11 owns placement): target label, primary link text truncated in the middle, and
   three buttons: **Copy link**, **Open**, and (for `file:` links) **Show in Finder**.
2. **Copy link** calls `eli5:publish:copy-link` with the primary URL; main writes it with
   `clipboard.writeText` and the chip shows "Copied" for 2 s. Copying happens in main because the
   sandboxed renderer's clipboard access is not guaranteed without focus.
3. **Open** calls `eli5:publish:open-link`. Main validates the URL: `https:` always allowed;
   `file:` allowed only if it resolves inside `publish.local.dir`; everything else →
   `E_FORBIDDEN`. An `https:` link opens through `safeOpenExternal` (12 §7.5, which accepts
   http(s) only); an allowed `file:` link opens with `shell.openPath` after the export-folder check.
4. The most recent `PublicationRecord` per target is also shown in the document's publish menu as
   "Last published <relative time>" with the same Copy / Open actions, so links survive restarts.
5. Failures show in the same chip area with the `message` and, where applicable, a single action:
   `E_PUBLISH_SIGN_IN_REQUIRED` → "Sign in" (HOOK-UI-01), `E_PUBLISH_NOT_CONFIGURED` → "Open
   settings", `E_PUBLISH_SECRET_FOUND` → an inline list of findings (file, line, rule, masked
   preview). No modals. Publishing itself never posts a native notification; the app's only
   native notification is document completion (11 §14).
6. **Completion-notification click (11 §14).** When `notifications.clickAction` is
   `'published-link'`, the shell resolves the link at click time from `DocumentMeta.publications`
   (newest first): the preferred kind per `notifications.preferredLink` (`'drive'` → the
   organization cloud drive share link, `PublishLink` kind `'share'`, the primary link of a `drive`
   record; `'site'` → the GitHub Pages link, kind `'site'`, the primary link of a `git` record;
   `'most-recent'` → either), then any remote published link, then it falls back to opening the
   document in the app. Local exports (`file:` links, `local` records) never count. The URL is
   opened through `safeOpenExternal` (12 §7.5, `https` only). Publishers need no change for this;
   they only have to keep writing `PublicationRecord`s as in §3.2.

## 8. Help page: rendering HTML to GitHub Pages with GitHub Actions

Shipped as `resources/help/publish-github-pages.html`, a self-contained page that main opens
with the default app (`eli5:settings:open-help`, 11 §10) from Settings → Publishing → "How to set up
a Pages repository", and also useful to anyone reading the repository. It is not shown in the
viewer: the viewer loads only catalogued Library documents (09 §11, 12 §7.7), and the page needs no
app chrome. It is generic: it works for any repository and any owner, and it never mentions a
specific organization. Outline:

1. **What you get.** Every document pushed to `<docsPath>/<slug>/index.html` becomes reachable at
   `https://<owner>.github.io/<repo>/<slug>/`. Documents are plain static HTML; no site generator is
   needed.
2. **Prerequisites.** A repository you can push to; git installed; working git credentials for that
   repository (credential helper or SSH key). Note on plans: on GitHub Free, Pages can be published
   only from a public repository; publishing Pages from a private repository requires a paid plan,
   and even then the site itself is public. Only GitHub Enterprise Cloud can restrict a Pages site
   to organization members (private Pages).
3. **Create or choose the repository and folder.** Recommend a dedicated repository or a dedicated
   `docs/` folder. Add `docs/.nojekyll` so files and folders starting with `_` are served as is.
   Optionally add `docs/index.html` as a landing page.
4. **Enable Pages with Actions as the source.** Settings → Pages → Build and deployment → Source:
   GitHub Actions.
5. **Add the workflow.** Create `.github/workflows/pages.yml`:

   ```yaml
   name: Deploy docs to GitHub Pages
   on:
     push:
       branches: [main]
       paths: ["docs/**", ".github/workflows/pages.yml"]
     workflow_dispatch:
   permissions:
     contents: read
     pages: write
     id-token: write
   concurrency:
     group: pages
     cancel-in-progress: false
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - uses: actions/checkout@v7
         - uses: actions/configure-pages@v6
         - uses: actions/upload-pages-artifact@v5
           with:
             path: docs
         - id: deployment
           uses: actions/deploy-pages@v5
   ```

   Explain each block in one sentence: trigger limited to `docs/**`; least-privilege permissions
   (`id-token: write` is required by the deploy action); `concurrency` so two pushes do not race;
   `path` must match the app's `docsPath`. Tell the reader to use the current major versions of the
   four actions (the versions above match this repository's own workflow).
6. **Branch protection and required reviews.** If `main` requires pull requests, direct pushes from
   the app will be rejected; either publish to an unprotected branch and set the workflow trigger to
   that branch, or keep publishing manual.
7. **Keep private material out.** Only `index.html` files are pushed by the app, but explain
   `.gitignore` allowlisting (`docs/*` ignored, then `!docs/index.html`, `!docs/.nojekyll`,
   `!docs/<published-slug>/`) for repositories that also hold other generated files.
8. **Custom domain (optional).** Add the domain under Settings → Pages; update the Pages URL pattern
   in app settings accordingly.
9. **Configure the app.** Map each field to its setting: repository → `publish.github.repo`
   (`owner/name`), branch → `publish.github.branch`, folder → `publish.github.docsPath`, site URL →
   `publish.github.pagesUrlPattern`. (Enterprise edition only; in the public build these settings are
   dormant and this section says so.)
10. **Verify.** Push a test document, open the Actions tab, confirm the deploy job's `page_url`, and
    open `<page_url><slug>/`.
11. **Troubleshooting.** 404 right after push (deploy still running, or `path` mismatch); CSS or
    scripts missing (none expected: documents are self-contained, check for a `.nojekyll` issue);
    workflow did not run (paths filter or Pages source not set to Actions); push rejected (branch
    protection, non-fast-forward, secret scanning on the code host).

The help page is written in plain HTML using the doc-runtime base styles (07) with no external
requests, so it renders offline and in any browser.

## 9. Pre-publish content policy

<!-- hook:HOOK-PUB-05 -->
> **Private hook · HOOK-PUB-05 · Pre-publish content policy.** Public behavior: `runPublish` step 5
> is a no-op; the only content gate is the secret scanner, and only the git publisher runs it.
> Private binding supplies: whether the secret scan (or the organization's tool from HOOK-PUB-03)
> must also run before cloud drive publishing; any document classification or confidentiality
> banner that must be injected into the published copy (never into the library copy); rules that
> forbid publishing documents built from certain source kinds (for example MCP-brokered sources,
> HOOK-SRC-01) to certain targets; and the user-facing wording when a publish is blocked by policy.
> Binding lives in the private spec under "HOOK-PUB-05".

## 10. Configuration keys

Schema, defaults and validation live in 12; this is the publish namespace summary.

| Key | Edition | Default | Purpose |
| --- | --- | --- | --- |
| `publish.local.dir` | both | `~/Documents/ELI5 Learner` | Local export folder |
| `publish.local.revealAfter` | both | `true` | Reveal in Finder after export |
| `publish.drive.*` | enterprise (dormant in public) | unset | Drive location and options, HOOK-PUB-01, HOOK-CFG-01 |
| `publish.github.repo` | enterprise (dormant) | `""` | `owner/name`, HOOK-PUB-04 |
| `publish.github.branch` | enterprise (dormant) | `"main"` | HOOK-PUB-04 |
| `publish.github.docsPath` | enterprise (dormant) | `"docs"` | HOOK-PUB-04 |
| `publish.github.pagesUrlPattern` | enterprise (dormant) | `https://{owner}.github.io/{repo}/{path}/{slug}/` | HOOK-PUB-04 |
| `publish.github.waitForSite` | enterprise (dormant) | `true` | §5.3 step 10 |

No publish key ever holds a credential. Setting any dormant key in the public build has no effect
beyond being preserved in the settings file.

## 11. Error handling summary

| Situation | Code | User sees | State after |
| --- | --- | --- | --- |
| Stub publisher invoked (public build, e.g. via devtools) | `E_NOT_AVAILABLE_IN_EDITION` | "Available in the enterprise edition" | unchanged |
| Target not configured | `E_PUBLISH_NOT_CONFIGURED` | "Set up <target> in Settings" + Open settings | unchanged |
| MCP session missing/expired | `E_PUBLISH_SIGN_IN_REQUIRED` | "Sign in to publish" + Sign in | unchanged |
| Secret found | `E_PUBLISH_SECRET_FOUND` | findings list, "Remove it and regenerate the section" | working copy reset, nothing committed |
| Destination unwritable / volume missing | `E_PUBLISH_DESTINATION` | message naming the folder or repo | partial temp files removed |
| Push rejected twice | `E_PUBLISH_CONFLICT` | "The repository changed while publishing. Try again." | working copy reset |
| User cancel / app quit | `E_PUBLISH_CANCELLED` | "Publish cancelled" | local: temps removed; git: reset; drive: may be uploaded owner-only (warning) |
| Document deleted/merged mid-request | `E_NOT_FOUND` | "Document no longer exists" | unchanged |

App quit during a publish: main aborts all `ctx.signal`s and waits up to 5 s for publishers to
clean up before exiting.

## Acceptance criteria

- [ ] `Publisher`, `PublishTarget`, `PublishResult`, `PublishContext`, `PublishLink`,
      `PublicationRecord`, `PublishError`, `SecretScanner`, `SecretFinding` exist in
      `src/main/publish/` with the shapes above; `tsc --strict` passes.
- [ ] Public build registers `local` (available) and `drive`, `git` stubs (`stub: true`,
      `available:false`); `eli5:edition:info` lists all three with correct availability.
- [ ] Invoking `eli5:publish:run` with `drive` or `git` in the public build returns
      `E_NOT_AVAILABLE_IN_EDITION` with `hookId` `HOOK-PUB-01` / `HOOK-PUB-03` and performs no
      network or git process spawn (asserted in 13).
- [ ] Drive and git publish buttons are not rendered in the public build; local export is.
- [ ] Local export writes `<publish.local.dir>/<slug>/index.html` atomically, byte-identical to the
      library copy, never writes `meta.json` or `catalog.json`, and returns a `file:` primary link.
- [ ] Exporting into the app's own `docs/` directory is rejected.
- [ ] `buildPublishFileSet` returns only allowlisted files, rejects symlinks and path traversal, and
      is the only source of files for every publisher.
- [ ] `BaselineSecretScanner` flags each rule in §5.4 on fixture files and never logs unmasked
      matches; clean fixtures produce no findings.
- [ ] A successful publish appends a `PublicationRecord` to `meta.json`; "Changed since last
      publish" appears after a section regeneration.
- [ ] Copy link, Open, and Show in Finder work from the result chip and from "Last published";
      `open-link` rejects non-`https` URLs other than exported `file:` paths.
- [ ] Concurrent publish of the same slug and target is rejected; regenerate-in-place during a
      publish waits and then succeeds.
- [ ] No publish path uses a modal or posts a native notification (the only one is document
      completion, 11 §14); a completion-notification click with `'published-link'` resolves
      `share`/`site` links from `publications` and never opens a `file:` link.
- [ ] `resources/help/publish-github-pages.html` exists, follows the §8 outline, contains the
      generic workflow, makes no network requests, and names no organization.
- [ ] HOOK-PUB-01..05 each appear exactly once with the machine marker and callout, and every
      organization-specific value is deferred to the private spec.
