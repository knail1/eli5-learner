# Generation pipeline and job queue

This file specifies how a user's inputs become a saved learning document, with no user interaction after Enter. It covers the `Job` model and its `JobStatus` state machine, the queue and its concurrency rules, each stage (reading, extracting, generating in-depth, generating ELI5, glossary, summary, saving), the status line strings the user sees, the fire-and-forget rules, partial versus total failure, cancellation, persisting job state and recovering after a crash, and the trigger for the post-save merge check. It implements PRD "Processing pipeline" and the fire-and-forget goal (PRD "Overview and goals", goal 4). Where the pipeline hands work to other modules, it relies on them for "Inputs and extraction", "Fetching strategy", "Output document" and "Library, storage, and merge suggestions". Code lives in `src/main/pipeline/`.

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) · [05-url-fetching.md](05-url-fetching.md) · [07-output-document.md](07-output-document.md) · [08-interactive-reading.md](08-interactive-reading.md) · [09-library-storage.md](09-library-storage.md) · [10-publishing.md](10-publishing.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Principles

1. **Fire and forget.** Once `eli5:jobs:start` succeeds, the job never asks the user anything. It shows no modal, no confirmation and no follow-up question (PRD "Processing pipeline"). Every decision a stage could want to ask about has a default in this spec.
2. **Carry on.** A failed source is skipped and recorded as a `SkippedSource`. A failed optional generation step (glossary, summary) degrades gracefully. Only the total-failure conditions in §7.2 end a job without a document.
3. **One line of status.** Each job shows exactly one human-readable line (§6). The user never sees logs. Diagnostics go to the main-process log file only.
4. **Durable.** Job state and snapshots of the inputs are persisted before the job is acknowledged, so a crash, force quit or reboot never loses a queued or running job (§9). This spec chooses persistence over the "abandon on quit" behavior previously listed in doc 01 §9 ("Quit with jobs running"); doc 01 is to be updated to match.
5. **Merge check is post-save only.** The merge check starts only after the document folder and catalog entry are committed (§10). It never gates, delays or fails the job.

## 2. Module layout

| File | Responsibility |
| --- | --- |
| `src/main/pipeline/types.ts` | `Job`, `JobStep`, `JobCheckpoint`, `PipelinePolicy`, and the dependency interfaces (`PipelineDeps`, `ExtractRunner`, `PipelineLibrary`, `SectionRunner`) |
| `src/main/pipeline/job.ts` | `createJob()`, the persisted-record schema, `snapshotOf()` (the `JobSnapshot` sent to the renderer) |
| `src/main/pipeline/status.ts` | Maps `(status, step, progress)` to the status line string (§6); the transition table and `assertTransition()` |
| `src/main/pipeline/queue.ts` | `JobQueue`: FIFO lanes, concurrency slots, the stage runner, cancel/retry/dismiss, crash recovery (§9.4), retention (§9.5) |
| `src/main/pipeline/store.ts` | `JobStore`: persisting job records and staged artifacts under `<userData>/jobs/` |
| `src/main/pipeline/inputs.ts` | Input snapshots at enqueue (§9.2) |
| `src/main/pipeline/stages/read.ts` | Reading stage (calls `SourceResolver`s, doc 03) |
| `src/main/pipeline/stages/extract.ts` | Extracting stage (calls the job's `ExtractRunner`, doc 04) |
| `src/main/pipeline/stages/generate.ts` | Orders the in-depth, ELI5, glossary and summary steps by calling doc 02's task functions (`src/main/llm/tasks.ts`) |
| `src/main/pipeline/stages/save.ts` | Saving stage: builds and renders the `DocumentModel` (doc 07) and commits it through the library (doc 09) |
| `src/main/pipeline/runner.ts` | In-process `ExtractRunner` for Node tests; production uses `ExtractWorkerHost` (04 §10.4) |
| `src/main/pipeline/theme.ts` | Parses the skill CSS (02 §11) into `DocTheme` tokens (07 §11.3) |
| `src/main/pipeline/deps.ts` | `createPipelineDeps()`: assembles every production dependency from the registry, settings, Keychain, library and injected Electron services |
| `src/main/ipc/` | Registers the `eli5:jobs:*` IPC handlers and pushes events (§11), calling `JobQueue` |

The pipeline depends on interfaces only (`SourceResolver`, `Extractor`, `LLMProvider`, library API). It never imports an edition-specific implementation. Implementations come from `src/main/editions/registry.ts` (doc 01, HOOK-CFG-02).

## 3. Job model

### 3.1 Types

```ts
// src/main/pipeline/job.ts
export type JobStatus =
  | 'queued' | 'reading' | 'extracting' | 'generating' | 'saving' | 'done' | 'failed';

/** Sub-step shown while status === 'generating'. */
export type JobStep = 'indepth' | 'eli5' | 'glossary' | 'summary';

export type JobKind = 'create' | 'section';   // 'section' jobs: see §8

export type JobId = string;                    // ULID: time-sortable, used for FIFO ordering

export interface JobOptions {
  clarifyingInput: string;                     // '' when the user typed nothing
  glossary: boolean;                           // per-job toggle; default from settings glossary.defaultOn
}

export interface JobProgress {
  sourcesTotal: number;
  sourcesDone: number;                         // resolved + skipped so far
  step?: JobStep;                              // only while generating
  stepsPlanned: JobStep[];                     // e.g. ['indepth','eli5','summary'] when glossary is off
}

export interface JobFailure {
  code: 'NO_USABLE_CONTENT' | 'LLM_UNAVAILABLE' | 'LLM_AUTH' | 'SAVE_FAILED'
      | 'CANCELLED' | 'INTERRUPTED' | 'INTERNAL'
      | 'SECTION_TOO_LARGE' | 'SECTION_GONE' | 'SECTION_CHANGED' | 'DOC_GONE';  // section jobs, doc 08 §9
  message: string;                             // the user-facing text shown after "Failed: "
  detail?: string;                             // log-only diagnostic, never rendered
}

export interface JobWarning {                  // partial-failure notes, persisted into meta.json
  kind: 'source-skipped' | 'glossary-omitted' | 'summary-fallback'
      | 'eli5-placeholder' | 'input-truncated';     // input-truncated: recorded from doc 02 §8.4's warning
  message: string;
}

export interface Job {
  id: JobId;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;                           // ISO 8601
  startedAt?: string;
  finishedAt?: string;
  inputs: SourceInput[];                       // defined in 03-source-resolvers.md; snapshotted (§9.2)
  options: JobOptions;
  progress: JobProgress;
  resolved: ResolvedSource[];                  // 03
  skipped: SkippedSource[];                    // 03: {ref, reason}
  warnings: JobWarning[];
  attempt: number;                             // 1 on first run, +1 on each crash-resume or user retry
  checkpoint?: JobCheckpoint;                  // §9.3
  result?: { docId: string; topicSlug: string; title: string };  // set when done
  failure?: JobFailure;                        // set when failed
  cancelRequested?: boolean;
  section?: SectionJobPayload;                 // doc 08; present iff kind === 'section'
}

export interface JobSnapshot {                 // what the renderer receives; no file contents
  id: JobId; kind: JobKind; status: JobStatus; statusLine: string;
  createdAt: string; finishedAt?: string; queuePosition?: number;
  result?: Job['result']; failureCode?: JobFailure['code'];
  skippedCount: number; canCancel: boolean; canRetry: boolean; canDismiss: boolean;
}
```

`SourceInput`, `ResolvedSource` and `SkippedSource` belong to doc 03, `ExtractedContent` and `ContentBlock` to doc 04, `GenerationRequest` and `GenerationResult` to doc 02, `DocumentModel`, `Tab`, `Section` and `SectionId` to doc 07, `SectionJobPayload` to doc 08, and `DocumentMeta`, `CatalogEntry` and `SlugReservation` to doc 09. The pipeline only references them.

### 3.2 State machine

```
            ┌──────────── cancel ─────────────┐
            │                                  ▼
queued ─► reading ─► extracting ─► generating ─► saving ─► done
  │          │            │             │           │
  └──────────┴────────────┴─────────────┴───────────┴──► failed
```

| From | To | Trigger |
| --- | --- | --- |
| `queued` | `reading` | A concurrency slot frees up (§4) |
| `queued` | `generating` | Section jobs only (§8.2) |
| `reading` | `extracting` | Every input has been resolved or skipped |
| `extracting` | `generating` | Every resolved source has been extracted or skipped, and at least one usable block exists |
| `generating` | `saving` | Every planned step has finished (a step may degrade per §7.1) |
| `saving` | `done` | Folder committed and catalog updated (§5.7) |
| any non-terminal | `failed` | Total failure (§7.2) or cancellation (§8.1) |
| `failed` | `queued` | The user presses Retry (§7.3). Creates a new attempt with the same `id` |
| running (on launch) | `queued` | Crash recovery re-enqueues with a checkpoint (§9.4) |

`done` is terminal. `failed` is terminal except for Retry. Every other transition throws `IllegalTransitionError`, which is a programming error: it is logged and the job fails with `INTERNAL`. `assertTransition()` enforces the table. Every transition is persisted (§9.1) *before* the event is pushed to the renderer.

## 4. Queue and concurrency

### 4.1 Lanes

| Lane | Job kind | Default slots | Rationale |
| --- | --- | --- | --- |
| Create | `create` | 1 | Document generation makes several long LLM calls. One at a time keeps provider rate limits and status simple. |
| Section | `section` | 1 | Interactive refinements (doc 08) must not wait behind a 10-minute create job. |

- Each lane is FIFO in `JobId` (ULID) order.
- The user can start any number of create jobs while one runs (PRD "Concurrency"). They wait as `queued` and show their position (§6).
- Create-lane slots come from `pipeline.maxConcurrentJobs` (integer 1 to 3, default 1). This is a new key proposed for the schema in doc 12. Values out of range are clamped, with a log warning.
- Within one job, the pipeline's generation steps run in the order of §5.4. Doc 02 may run the in-depth and ELI5 calls concurrently and parallelize chunk calls, all through its shared limiter. The total number of in-flight LLM requests across all jobs is bounded by `llm.maxConcurrency` (doc 02 §7.3), not by the pipeline.
- Stage work that is not an LLM call (fetching and extraction) is not throttled across jobs beyond the lane slot. Doc 05 has its own per-host limits.

### 4.2 Per-document write lock

Every write to `docs/<topic-slug>/` goes through `library.withDocLock(slug, fn)` (doc 09). Writers include the saving stage, section regenerations, merge accepts and section-tab deletes. The lock is an in-process async mutex keyed by slug. It prevents a section regeneration from racing a merge append into the same `index.html`. The create lane takes the lock only in the saving stage.

### 4.3 Power and lifecycle

- While any job is non-terminal, hold `powerSaveBlocker.start('prevent-app-suspension')`, and release it when the queue drains. This keeps App Nap from stalling a walked-away job, but it does not prevent display sleep.
- Closing the main window does not affect jobs, because the app keeps running from the menu bar (PRD "App shell and layout").
- Quit from the menu bar does not ask for confirmation. Running jobs keep their last persisted checkpoint and resume on next launch (§9.4). While jobs are active, the menu bar Quit item label reads `Quit (N jobs will resume)` (doc 11).

## 5. Stages

Every stage receives `(job, ctx)`. `ctx` carries `signal: AbortSignal`, the resolver/extractor/provider registry, a `persist()` function and an `emit()` function. Stages check `signal.aborted` between units of work and pass `signal` into every I/O call.

### 5.1 Enqueue (`eli5:jobs:start`)

1. Validate the request. It must include at least one source. Clarifying text alone is not enough. A job with zero sources is rejected synchronously with `{ok:false, error:{code:'E_BAD_REQUEST', message:'Add at least one source'}}` (doc 01 `IpcResult`). The input zone disables Enter in this case, so the rejection is a guard only.
2. Snapshot the inputs into the staging directory `<userData>/jobs/<jobId>/` (§9.2). File copies use an APFS clone, so this is near-instant; a copy that cannot be cloned continues in the background after step 3.
3. Create a `Job` with `status: 'queued'` and `attempt: 1`, persist it, and return `{ok:true, value:{jobId}}`.
4. Emit `eli5:jobs:changed` and kick the scheduler.

This is the last point where the app can reject anything synchronously. After it, all errors become job state.

### 5.2 Reading (`reading`)

1. For each `SourceInput`, in input order, route it to a `SourceResolver` through the registry (doc 03; routing between lanes is HOOK-SRC-03). Resolve with parallelism 4 per job.
2. A successful resolve appends a `ResolvedSource`. A failure appends a `SkippedSource {ref, reason}` whose reason is one of the user-readable reasons in doc 03 (for example "page required login", "fetch timed out", "unsupported file type"). The job never throws for a source.
3. Increment `progress.sourcesDone` and persist after each source, so the status line can show "Reading sources (2 of 5)".
4. Checkpoint: `{stage:'reading', resolvedRefs}`. On resume, already-resolved sources are not refetched when their staged artifacts exist.

### 5.3 Extracting (`extracting`)

1. Create the job's `ImageBudget` (doc 04 §7.4) and pass it in every extractor context. Before extracting any other source, extract the standalone image sources (dropped or pasted images) and reserve budget for each with priority `'standalone'`. A standalone image that cannot fit is skipped with `image-budget-exceeded`.
2. For each remaining `ResolvedSource`, pick an `Extractor` by detected type (doc 04) and produce `ExtractedContent`. Run with parallelism 2 per job, because extraction can be CPU-heavy (PDF rendering).
3. When an extractor fails or returns zero usable blocks, move that source to `skipped` with reason `could not extract content` or the extractor's specific reason.
4. Serialize each `ExtractedContent` to `jobs/<jobId>/extracted/<sourceId>.json` (for example `src-03.json`), with image bytes written as sibling binary files `<sourceId>-<n>.bin`. `checkpoint.extractedIndexes` holds the numeric part of each staged source id; a source that fails extraction leaves `resolved` for `skipped`, so the ids of the rest stay stable. This is the resume checkpoint for generation. On resume, the image budget is rebuilt from the staged artifacts before extraction continues.
5. **Usable-content gate:** if no resolved source produced a usable block (a text block with at least 1 non-whitespace character after trimming, or an image block), fail with `NO_USABLE_CONTENT` (§7.2). Clarifying input alone is not content.

### 5.4 Generating (`generating`)

Doc 02 owns everything about an LLM call: prompt construction, schema validation and the single repair pass (02 §10.1), retries and timeouts (02 §7, `retry.ts`), rate limiting (02 §7.3, `limiter.ts`) and context budgeting with chunk-then-synthesize (02 §8, `budget.ts`). Doc 07 does semantic validation and sanitizing of the returned drafts. The pipeline only orders the steps, maps errors to job state, and checkpoints outputs. It never retries an LLM call itself, so retries never nest.

This file is the single place that fixes the step order. The steps run in this order:

| # | Step | Call (doc 02 §12) | Input | Output | Required? | On failure |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `indepth` + `eli5` | `prepareContent()`, then `generateIndepth()` ∥ `generateEli5()` | All `ExtractedContent`, clarifying input, glossary flag | In-depth draft with a proposed title; ELI5 draft (built from the sources, not the in-depth text, per PRD "Output document") | In-depth: **yes**. ELI5: always attempted | In-depth: job fails (mapping below). ELI5 `null`: placeholder tab (§7.1) |
| 2 | `glossary` | `generateGlossary()`, after in-depth | In-depth draft | Term notes, anchored to section IDs by doc 07 | Only if `options.glossary` | `null`: omit glossary, add warning |
| 3 | `summary` | `summarize()` | In-depth draft | `SummaryDraft` (summary text, `topicSlugHint`) | Yes, with a fallback | Deterministic fallback (§7.1) |

The pipeline calls 02 §12's step functions directly: `prepareContent` (persisted as `gen/prepared.json`), then `generateIndepth` and `generateEli5` concurrently (`gen/document.json`), `generateGlossary` (`gen/glossary.json`) and `summarize` (`gen/summary.json`). It derives the running steps for the status line from which of those promises are pending, so no `onStep` extension of doc 02 is needed. The provider id and model recorded in `meta.json` are read when step 1 starts.

Within step 1, doc 02 runs the in-depth and ELI5 calls concurrently and may parallelize chunk calls, all within `llm.maxConcurrency`. The summary runs after generation and **before** saving, because slug allocation (§5.5) and the catalog entry both need it. Doc 02 §9's "pipeline after save" label for the `summary` task is superseded by this order.

Rules:

1. **Section IDs** are assigned by the document builder (doc 07) when each tab is materialized, in the form `sec-<tabkey>-<8 hex>`. Glossary notes are anchored to in-depth IDs, so the in-depth tab is materialized first.
2. **Error mapping.** An `LLMError` (doc 02 §3.1) that escapes a required call maps to `JobFailure` as follows:

   | `LLMError.kind` | `JobFailure.code` |
   | --- | --- |
   | `auth` | `LLM_AUTH` |
   | `rate_limited`, `overloaded`, `server`, `timeout`, `network` (retries exhausted in 02) | `LLM_UNAVAILABLE` |
   | `invalid_output`, `not_available`, `refusal`, `context_overflow` | `LLM_UNAVAILABLE` (kind recorded in `detail`) |
   | `bad_request` | `INTERNAL` (programming error) |
   | `cancelled` | `CANCELLED` |

3. **Truncation.** When doc 02's budgeting has to truncate input (02 §8.4 step 4), the pipeline records its warning as an `input-truncated` `JobWarning` naming the affected sources. The pipeline does no budgeting of its own.
4. **Progress.** The pipeline tracks which step calls are pending (the in-depth and ELI5 calls, then glossary, then summary). `status.ts` derives the status line from that set of running steps (§6).
5. **Checkpoints.** After step 1 returns, persist its drafts to `jobs/<jobId>/gen/document.json` and add `indepth` and `eli5` to `checkpoint.completedSteps`; the glossary output goes to `gen/glossary.json` and adds `glossary`. After step 3, persist `gen/summary.json` and add `summary`. On resume, finished steps are not re-run.
6. Once the in-depth draft exists, an `LLM_AUTH` or `LLM_UNAVAILABLE` class error in a later step never fails the job. The later-step failure rules apply instead, so the user still gets a document.
7. Retry, timeout and concurrency values come from doc 02. The enterprise `PipelinePolicy` (HOOK-PIPE-01) can override doc 02's retry policy and timeouts by passing an override into doc 02's retry module; it never adds a second retry loop.

### 5.5 Title and slug

The title comes from the `indepth` output. If it is missing or empty, the fallback is the first heading of the first source. If there is none, it is `Untitled learning, <YYYY-MM-DD>`. The slug is reserved by `library.allocateSlug(title, summary.topicSlugHint)` (doc 09 §6.2, which handles collisions and returns a `SlugReservation`) at the start of saving, not earlier. A crash before saving therefore never reserves a slug. When the summary fell back (§7.1), the hint is omitted and doc 09 slugifies the title.

### 5.6 Clarifying input

Clarifying input (PRD "Processing pipeline") goes verbatim into the `indepth` and `eli5` requests as user guidance and is stored in `meta.json`. An empty string means defaults. The pipeline never generates a question back to the user. If a model response contains a question aimed at the user, doc 07's validator strips it and the pipeline does not surface it.

### 5.7 Saving (`saving`)

`library.commitDocument()` takes `withDocLock(slug)` itself (09 §8.2 step 1), and the lock is not reentrant, so the saving stage does not wrap its own calls in the lock. Steps:

1. Build the final `DocumentModel` (doc 07): the in-depth tab, the ELI5 tab (or placeholder), the glossary notes, and a references section listing every resolved and skipped source with reasons (PRD "References").
2. Render `index.html` and `meta.json` (a `DocumentMeta` containing sources used, sources skipped, clarifying input, tab list, `jobId`, `warnings`) into `<library-root>/.staging/<jobId>/`, on the same volume as the library root.
3. Call `library.commitDocument(reservation, '<library-root>/.staging/<jobId>/', meta)` (doc 09 §8.2). Doc 09 fsyncs, atomically renames the directory to `<library-root>/<topic-slug>/`, and upserts the `CatalogEntry` (including the summary) into `catalog.json` with its atomic write. The pipeline does no rename or catalog write of its own.
4. If saving fails or the job is cancelled before step 3 begins, call `reservation.release()` and remove `<library-root>/.staging/<jobId>/`.
5. Set `result`, move to `done`, persist, and emit `eli5:jobs:changed` and `eli5:library:changed`. The Library sidebar and menu bar list update from the library event (doc 11). `JobQueue` also emits an in-process `done` event with the finished job (`kind`, `slug`, `docId`, `title`). Bootstrap's completion listener posts the completion notification (doc 11 §14): one per `create` job, never for failed jobs, section jobs or merges. The pipeline itself never imports `shell`; bootstrap (`src/main/index.ts`) wires the two (doc 01 §3).
6. Delete `jobs/<jobId>/` staging for the job (§9.5).
7. Fire the merge check (§10).

Step 3 is the commit point. Crash recovery (§9.4) treats "folder exists with `meta.json.jobId === job.id` but no catalog entry" as "finish step 4". Saving failures, such as a full disk or permission errors, get 1 retry after 2s and then fail with `SAVE_FAILED`. The generated outputs stay in staging so Retry skips straight to saving.

## 6. Status line strings

Doc 11 renders the status line (lower right). `status.ts` is the only producer of these strings. They are plain English, sentence case and have no trailing period. Placeholders are in `{}`.

| Status / step | String |
| --- | --- |
| `queued`, position 1 behind a running job | `Queued` |
| `queued`, position n ≥ 2 | `Queued ({n} ahead)` |
| `queued` after a crash resume | `Resuming` |
| `reading` | `Reading sources ({done} of {total})`. For a single source: `Reading sources` |
| `extracting` | `Extracting content` |
| `generating`, before any step has started | `Generating document` |
| `generating`, `indepth` and `eli5` both running | `Generating document (in-depth and ELI5)` |
| `generating`, only `indepth` still running | `Generating document (in-depth explainer)` |
| `generating`, only `eli5` still running | `Generating document (ELI5 version)` |
| `generating` / `glossary` | `Generating document (glossary notes)` |
| `generating` / `summary` | `Generating document (finishing up)` |
| `saving` | `Saving` |
| `done`, no warnings | `Done: {title}` |
| `done`, with skipped sources | `Done: {title} · {k} source(s) skipped` |
| `done`, other warnings only | `Done: {title} · with notes` |
| `failed` / `NO_USABLE_CONTENT` | `Failed: no usable content in {n} source(s)` |
| `failed` / `LLM_AUTH` | `Failed: API key rejected. Check Settings` |
| `failed` / `LLM_UNAVAILABLE` | `Failed: AI service unavailable. Try again later` |
| `failed` / `SAVE_FAILED` | `Failed: could not save the document` |
| `failed` / `CANCELLED` | `Cancelled` |
| `failed` / `INTERRUPTED` | `Failed: interrupted by app restart` (only when `PipelinePolicy.resumeAfterCrash` returns false) |
| `failed` / `INTERNAL` | `Failed: something went wrong` |
| section job running (doc 08) | `Updating section: {heading}` |
| section job done | `Updated: {heading}` |
| section job running, action `eli5-tab` | `Adding ELI5 tab: {heading}` |
| section job done, action `eli5-tab` | `Added tab: {label}` |
| `failed` / `SECTION_TOO_LARGE` | `Failed: section too long to rewrite` |
| `failed` / `SECTION_GONE` | `Failed: section no longer exists` |
| `failed` / `SECTION_CHANGED` | `Failed: section changed, try again` |
| `failed` / `DOC_GONE` | `Failed: document no longer exists` |

The PRD strings ("Reading sources, Extracting content, Generating document, Saving, Done") are the minimum set. The generating stage keeps the PRD's `Generating document` wording and adds the running step as a suffix, which the PRD's "for example" wording allows. If product prefers the literal PRD wording, `status.ts` sets the constant `GENERATING_DETAIL = false` and every generating row collapses to `Generating document`. Retries inside doc 02 are silent (02 §7.1) and do not change the line.

Behavior:

- A `done` line is clickable and opens the document in the viewer. It stays until the user dismisses it or 10 minutes pass, whichever comes first.
- A `failed` line stays until the user dismisses it. It offers **Retry** (except `CANCELLED`) and **Dismiss**. Neither is a modal.
- Hovering a line with skipped sources shows a tooltip listing `ref: reason`. The full list is also in the document's references section.
- Titles longer than 60 characters are truncated with an ellipsis.

## 7. Failure handling

### 7.1 Partial failure (document is still produced)

| Condition | Handling | Warning kind |
| --- | --- | --- |
| Some sources fail to resolve or extract | Skip them, list them in references and `meta.json` | `source-skipped` |
| Content exceeds the context budget | Doc 02 chunks, then truncates as a last resort (02 §8.4); the pipeline records its warning (§5.4 rule 3) | `input-truncated` |
| `eli5` draft is `null` (doc 02 failed it after its retries) | Insert a placeholder ELI5 tab with one section (normal `SectionId`) reading "The ELI5 version could not be generated. Select this text and choose *This isn't clear, re-explain it* to try again." Doc 08's regenerate-in-place can then fill it | `eli5-placeholder` |
| `glossary` step fails | Save without margin notes | `glossary-omitted` |
| `summary` step fails | Summary = first 2 sentences of the in-depth lead section, truncated to 300 chars | `summary-fallback` |

Warnings are persisted in `meta.json.warnings` and summarized on the status line (§6). The document never shows internal error text. It shows only the user-readable reasons.

### 7.2 Total failure (no document)

A job fails with no document only when:

1. **`NO_USABLE_CONTENT`:** every source was skipped, or none produced a usable block (§5.3 step 5).
2. **`LLM_AUTH`:** the in-depth call failed with `LLMError.kind === 'auth'` (§5.4 rule 2). This includes no API key in the Keychain for the selected provider, which is checked before the first call without making a network request.
3. **`LLM_UNAVAILABLE`:** the in-depth call failed after doc 02 exhausted its retries, or with a non-retryable kind mapped in §5.4 rule 2.
4. **`SAVE_FAILED`:** saving failed after its retry (§5.7).
5. **`CANCELLED`:** the user cancelled (§8.1).
6. **`SECTION_TOO_LARGE`, `SECTION_GONE`, `SECTION_CHANGED`, `DOC_GONE`:** section jobs only; conditions defined in doc 08 §9.
7. **`INTERNAL`:** an unexpected exception anywhere in the stage code. It is logged with a stack trace, and the message stays generic.

On total failure, the staging directory is kept (for Retry) until the job is dismissed or the 7-day cleanup runs (§9.5). A `CANCELLED` job deletes its staging directory immediately.

### 7.3 Retry

The Retry action (`eli5:jobs:retry`) moves a `failed` job back to `queued`, increments `attempt`, keeps `inputs` and the staging directory, and resumes from the last valid checkpoint (§9.3). URL sources are refetched: Retry clears their `reading` checkpoint entries, because the page may have changed or come back online. File and clipboard snapshots are reused. Refetching a URL invalidates everything derived from it, so a job with URL inputs restarts from `reading` unless every generation step is already staged (checkpoint stage `saving`, for example after `SAVE_FAILED`); then Retry goes straight to saving, as §5.7 requires. A job whose staging was purged (§9.5, dismiss) also restarts from `reading`.

## 8. Cancellation and section jobs

### 8.1 Cancellation (`eli5:jobs:cancel`)

- **Queued job:** it is removed from the lane immediately and goes `failed/CANCELLED`, and its staging directory is deleted.
- **Running job:** set `cancelRequested`, persist, then call `abortController.abort()`. Resolvers, fetches (including hidden windows, doc 05) and LLM streams must honor the signal within 2s. The stage runner catches `AbortError` and goes `failed/CANCELLED`.
- **Job in `saving`:** cancellation is refused (`canCancel: false`) once `library.commitDocument()` has been called, so a half-committed document never results. Before that, cancel removes `docs/.staging/<jobId>/` and calls `reservation.release()`.
- Cancellation never touches the Library. A cancelled job leaves no folder and no catalog entry.
- If a job has `cancelRequested` but its process died before the abort took effect, recovery (§9.4) finishes it as `CANCELLED`, not as resumed.

### 8.2 Section jobs

Interactive reading actions (doc 08: expand, re-explain, analogy, go deeper, section ELI5) run as `kind: 'section'` jobs in the Section lane. They reuse the same `Job` record (with `section: SectionJobPayload` set), persistence and status line; LLM retries are doc 02's. They use a reduced stage set, which doc 08 defines in full:

`queued → generating (one step) → saving → done | failed`

These jobs skip `reading` and `extracting` (a JobStatus is skipped by a direct legal transition `queued → generating`, which `assertTransition()` allows only for `kind === 'section'`). A section job's saving stage writes back into the existing `index.html` under that document's lock. It does **not** trigger a merge check. A failed section job leaves the document unchanged.

## 9. Persistence and crash recovery

### 9.1 Job store

- Location: `<userData>/jobs/`, where `userData` is Electron `app.getPath('userData')`. This is outside `docs/`, so job internals are never mixed with Library content and are never published.
- `jobs/<jobId>.json` holds one `Job` record, written atomically (temp file + rename) on every status or progress change. Progress-only writes are debounced to at most 1 every 500ms. Status transitions are written immediately.
- `jobs/<jobId>/` is the staging directory (§9.2).
- No central index file exists. On launch the store scans `jobs/*.json`. Each file is validated with a schema, and a corrupt record is moved to `jobs/corrupt/` and logged.

### 9.2 Input snapshots

At enqueue time (§5.1), inputs are made independent of the outside world:

| Input | Snapshot |
| --- | --- |
| Dropped file ≤ 200 MB | Copied into `jobs/<jobId>/inputs/<index>-<basename>` with `fs.copyFile(src, dst, fs.constants.COPYFILE_FICLONE)` (APFS clone, near-instant, no extra disk use), with the original path recorded for references. If the clone is not possible (another volume, non-APFS), the copy continues in the background after `jobs:start` returns, and the reading stage waits for it. A copy that fails is skipped with reason `file changed or moved` |
| Dropped file > 200 MB | Referenced by absolute path plus `size`/`mtime`. If it changes or disappears before reading, it is skipped with reason `file changed or moved` |
| Clipboard image | Written as PNG into `inputs/` |
| Clipboard text / rich text | Written as `.txt` / `.html` into `inputs/` |
| Clipboard file references | Treated as dropped files |
| Clipboard drafts staged before Enter (doc 03 §6) | Moved into `jobs/<jobId>/inputs/` |
| URL | Stored as a string only. Fetched in the reading stage |

The `SourceInput.ref` shown to the user (in references and skipped lists) is always the original name or URL, never the staging path.

There is one staging root: `<userData>/jobs/<jobId>/` (inputs, `extracted/`, `gen/`). It is the `stagingDir` passed to resolvers (doc 03 §3, §4, §6 use the same root). Doc 03's in-place read of local files applies only to files above the snapshot threshold.

### 9.3 Checkpoints

```ts
export interface JobCheckpoint {
  stage: 'reading' | 'extracting' | 'generating' | 'saving';
  resolvedRefs: string[];            // inputs whose ResolvedSource artifact is staged
  extractedIndexes: number[];        // ExtractedContent files present in jobs/<jobId>/extracted
  completedSteps: JobStep[];         // generation outputs present in jobs/<jobId>/gen
  topicSlug?: string;                // set once saving reserved a slug
}
```

A checkpoint is valid only when every artifact it names exists and parses. Otherwise the resume point moves back to the earliest stage with missing artifacts.

### 9.4 Recovery on launch

Recovery runs once in the main process after the registry loads and before the renderer receives its first `eli5:jobs:list` result:

1. Load all job records (§9.1).
2. For each non-terminal job, in `JobId` order:
   1. If `cancelRequested`, finish it as `failed/CANCELLED` and delete staging.
   2. If `status === 'saving'` and `checkpoint.topicSlug` is set:
      - If `docs/<slug>/meta.json` exists with a matching `jobId`, ask doc 09 to finish the commit (upsert the catalog entry if it is missing), then mark it `done` (and fire the merge check if the catalog entry was just added).
      - Otherwise remove any leftover `docs/.staging/<jobId>/` and resume at saving.
   3. If `policy.resumeAfterCrash?.(job) === false`, fail it with `INTERRUPTED` and apply its staging retention.
   4. Otherwise, validate the checkpoint (§9.3), set `status: 'queued'` with a `resuming` flag (status line `Resuming`), and increment `attempt`.
3. If a job's `attempt` exceeds 3 because of repeated crashes, fail it with `INTERNAL`, message "stopped after repeated interruptions". This avoids a crash loop on a poisonous input.
4. Re-enqueue the resumed jobs at the front of their lanes in their original order, then start the scheduler.
5. Remove orphaned `docs/.staging/*` directories whose `jobId` matches no non-terminal job.

The app does not ask the user whether to resume. Resuming is the default, per the fire-and-forget principle.

### 9.5 Retention

- `done` job records: kept for 30 days for diagnostics, then deleted. Their staging is deleted at `done`.
- `failed` job records: staging is kept until the user dismisses the job or 7 days pass, whichever comes first. The record is kept for 30 days.
- The job store never holds API keys or any credential. It holds source content snapshots, so it is treated as user data (doc 12).

<!-- hook:HOOK-PIPE-01 -->
> **Private hook · HOOK-PIPE-01 · Enterprise job policy.** Public behavior: the pipeline uses the defaults in this file (create-lane concurrency 1 to 3, doc 02's retry policy and call timeouts (02 §7) unchanged, 200 MB file-copy threshold, 7-day staging retention for failed jobs, 30-day job-record retention). Private binding supplies: overrides of these values sized to the cloud-hosted model gateway's quotas and latency (see HOOK-LLM-01), any stricter retention or purge rule for staged content that came through the MCP lane (for example, never persisting organization-sourced snapshots beyond job completion), and whether organization-sourced jobs must be resumable after a crash or are failed as `INTERRUPTED` instead. Binding lives in the private spec under "HOOK-PIPE-01".

The hook is implemented as an optional `PipelinePolicy` object that the enterprise overlay can register in `src/main/editions/registry.ts` (HOOK-CFG-02). The public build registers `defaultPipelinePolicy`:

```ts
export interface PipelinePolicy {
  maxCreateSlots: number;                       // clamp ceiling for pipeline.maxConcurrentJobs
  /** Optional overrides passed into doc 02's retry.ts; absent means doc 02's defaults (02 §7). Never a second retry loop. */
  llmRetryOverride?: { maxAttempts?: Partial<Record<LLMErrorKind, number>>; baseMs?: number; maxRetryAfterMs?: number };
  llmTimeoutOverride?: { idleMs?: number; totalMs?: number };
  snapshotCopyMaxBytes: number;
  retention: { failedStagingDays: number; recordDays: number };
  /** Called for each staged artifact; enterprise may shorten retention by source lane. */
  stagingRetention?(src: ResolvedSource): 'default' | 'purge-on-terminal';
  resumeAfterCrash?(job: Job): boolean;         // default: always true
}
```

## 10. Post-save merge check trigger

1. The trigger fires only after §5.7 step 3 has committed the folder and catalog entry, and only for `kind === 'create'`.
2. It calls `library.runMergeCheck(docId)` (doc 09 owns the matching algorithm and the `MergeSuggestion` type) as a detached task. The call is not awaited by the job, the job is already `done`, and the status line is not affected.
3. The merge check never goes through the Create lane, so it never delays the next queued job. It may call the LLM when doc 09's algorithm needs it. Such calls go through doc 02's shared limiter like any other.
4. Failures are logged and swallowed. No suggestion is produced and nothing is shown.
5. When a suggestion is produced, the library emits `eli5:suggestions:changed` and the suggestions area picks it up (doc 11). The pipeline plays no further part.
6. If the user deleted the new document or already merged it before the check finishes, doc 09 discards the result.

## 11. IPC surface

All channels are registered in `src/main/ipc/jobs.ts` (with the other handlers under `src/main/ipc/`, which avoids an import cycle with the shared handler wrapper) and exposed via `window.eli5.jobs` (doc 01 preload). Every invoke handler returns `IpcResult<T>` (doc 01) and never throws across the boundary.

| Channel | Direction | Payload → Result |
| --- | --- | --- |
| `eli5:jobs:start` | renderer → main (invoke) | `{inputs: SourceInput[], options: JobOptions}` → `IpcResult<{jobId}>`. Zero sources → `E_BAD_REQUEST` ("Add at least one source"); a file input whose drop id is unknown → `E_FORBIDDEN` |
| `eli5:jobs:list` | invoke | `void` → `IpcResult<JobSnapshot[]>`: non-terminal jobs plus undismissed terminal ones |
| `eli5:jobs:cancel` | invoke | `{jobId}` → `IpcResult<void>`. Unknown id → `E_NOT_FOUND`; terminal job or `canCancel: false` → `E_CONFLICT` |
| `eli5:jobs:retry` | invoke | `{jobId}` → `IpcResult<void>`. Unknown id → `E_NOT_FOUND`; not `failed`, or code not retryable → `E_CONFLICT` |
| `eli5:jobs:dismiss` | invoke | `{jobId}` → `IpcResult<void>`. Hides the line and frees retained staging. Unknown id → `E_NOT_FOUND`; non-terminal job → `E_CONFLICT` |
| `eli5:jobs:changed` | main → renderer (event) | `JobSnapshot`, sent on every persisted change |

Section jobs are started through doc 08's `eli5:doc:regenerate-section` / `eli5:doc:create-section-eli5` channels. Those channels call `JobQueue.enqueueSection()` internally and report through `eli5:jobs:changed`.

Renderer payloads are validated with a schema in the main process. Main cannot tell a preload-captured path from a forged one, so raw paths are never accepted from the renderer. Instead, `src/preload/app.ts` registers its own `drop` listener, ignores events where `event.isTrusted` is false, resolves each file with `webUtils.getPathForFile`, and sends the paths to main via `eli5:sources:register-drop`, which returns opaque input ids. The renderer keeps working with paths (`window.eli5.files.pathFor`); the preload swaps in the id main minted for each dropped path when it sends `eli5:jobs:start`, so file `SourceInput`s there carry those ids and main maps them back to paths from its own registry. An unknown id is refused with `E_FORBIDDEN`; a successful start uses the ids up. Details are in doc 03 §6.3 and doc 12.

## 12. Edge cases

| Case | Behavior |
| --- | --- |
| The user presses Enter twice quickly with the same inputs | Two independent jobs. There is no dedupe; the merge check will usually suggest merging them |
| Duplicate source within one job (same file twice) | Deduplicated at enqueue by content hash (files) or normalized URL, and the duplicate is ignored silently |
| Provider or model changed in Settings while a job is queued | The job uses the settings in effect when its generation stage starts. A running job keeps the provider it started with |
| API key removed mid-job | The next LLM call fails as auth. It is total failure only if the in-depth draft does not exist yet (§5.4 rule 6) |
| App offline at start | URL sources are skipped (`network unavailable`). Local sources continue. `indepth` retries, then `LLM_UNAVAILABLE` |
| Only images provided | Valid. Vision input is used (doc 02). An image counts as a usable block |
| The Library's `docs/` directory is unwritable | `SAVE_FAILED`. Retry works after the user fixes permissions |
| System sleep mid-LLM call | The call errors or times out on wake; doc 02 classifies and retries it (02 §7.1) |
| Two create slots finish at the same moment | Slug allocation and catalog writes are serialized by the library (doc 09). The slugs are distinct |
| The user deletes a document while a section job targets it | The section job fails with `DOC_GONE` (`Failed: document no longer exists`), and nothing is written |
| Enterprise source needing sign-in when the MCP session has expired | Skipped with the resolver's reason (doc 03, HOOK-AUTH-01). The pipeline never prompts mid-job |

## 13. Observability

- Log file: `<userData>/logs/main.log` (doc 12 covers rotation). One structured line is written per transition: `jobId, attempt, from, to, durationMs, step?, failure.code?`. Source refs are logged as names or URLs only, never as content.
- The renderer never receives `JobFailure.detail` or stack traces.
- Timings per stage are kept on the job record (`timings: Partial<Record<JobStatus|JobStep, number>>`) for the tests in doc 13 and for local diagnostics.

## Acceptance criteria

- [ ] `eli5:jobs:start` returns within 1s for a local drop (≤ 200 MB, same APFS volume) and the job is persisted before it returns; a non-clonable copy finishes in the background before reading starts.
- [ ] Every `eli5:jobs:*` invoke returns an `IpcResult<T>`; zero sources returns `E_BAD_REQUEST`, and a raw file path (not a registered drop id) is rejected.
- [ ] A second job started while one is `generating` shows `Queued` and runs automatically when the first finishes (default concurrency 1).
- [ ] No dialog, modal or prompt appears at any point between Enter and `done`/`failed`, including on crash resume and quit.
- [ ] A `create` job reaching `done` fires the queue's `done` event exactly once; section jobs and failed jobs never lead to a completion notification.
- [ ] Status lines match §6 exactly for every state. While generating, the line starts with `Generating document` and its suffix reflects the running steps (in-depth and ELI5 together, then glossary, then finishing up).
- [ ] A job with 3 sources where 1 URL requires login finishes `done`, shows `· 1 source(s) skipped`, and the document's references list the skipped URL with its reason.
- [ ] A job whose sources all fail ends `failed/NO_USABLE_CONTENT` and leaves no Library entry.
- [ ] An invalid API key ends the job `failed/LLM_AUTH` without retries and with the Settings hint.
- [ ] When doc 02 returns a `null` ELI5 draft, the document is still saved with a placeholder ELI5 tab that can be regenerated in place.
- [ ] With the glossary toggle off, no glossary LLM call is made.
- [ ] The pipeline never retries an LLM call itself: a transient error is retried only by doc 02 (02 §7.1), and an exhausted retryable error on the in-depth call ends the job `failed/LLM_UNAVAILABLE`.
- [ ] All standalone images are reserved in the job `ImageBudget` before any other source is extracted.
- [ ] Saving goes through `library.allocateSlug(title, hint)` and `library.commitDocument()`; a failed or cancelled save calls `reservation.release()`.
- [ ] Section-job failures use `SECTION_TOO_LARGE`, `SECTION_GONE`, `SECTION_CHANGED` or `DOC_GONE` with the §6 strings.
- [ ] Cancelling a queued or running job ends it `Cancelled` within 2s and leaves no folder, catalog entry or staging directory.
- [ ] Killing the app during `generating` and relaunching resumes the job without redoing finished reading, extraction or generation steps, and ends with exactly one document.
- [ ] Killing the app inside `commitDocument` between the folder rename and the catalog update and then relaunching produces the catalog entry without regenerating anything.
- [ ] A job interrupted 3 times ends as `failed/INTERNAL` ("stopped after repeated interruptions").
- [ ] The merge check starts only after the catalog entry exists, never runs for section jobs, and its failure does not change the job's `done` state.
- [ ] Section jobs are not blocked by a running create job.
- [ ] Concurrent writes to the same document (a section regeneration and a merge accept) are serialized by the per-document lock, and neither is lost.
- [ ] Job records and staging live under `<userData>/jobs/`, never under `docs/`, and contain no credentials.
- [ ] The public build registers `defaultPipelinePolicy`, and an overlay-registered `PipelinePolicy` (HOOK-PIPE-01) overrides its values without code changes in `src/main/pipeline/`.
