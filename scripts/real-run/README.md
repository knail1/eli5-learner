# Real run (developer tooling)

A headless run of the full pipeline against a real LLM provider, under a hard spending cap. It
only works in unpackaged builds. Packaged builds ignore every variable below.

## What it does

1. The bootstrap calls `prepareRealRun` (`src/main/devtools`) as the last step before
   `registry.freeze()`, after `loadOverlay` and `settings.applyExtension`. It re-registers the
   public Claude and OpenAI providers, built without internal retries, wrapped in
   `BudgetGuardProvider`, and every wrapped provider shares one ledger. This replaces any
   overlay-supplied `claude`/`openai` provider for the run. Other provider ids (for example
   `bedrock`) are not wrapped, and `startRealRun` refuses any active provider that is not behind
   the guard.
2. The guard works out the worst case of every call before sending it: the input tokens
   (`countTokens`, or an estimate of `ceil(chars/3) * 1.1` plus 1600 per image) plus
   `maxOutputTokens`, times the number of attempts the provider's retry policy allows (1 for the
   default real-run providers). If that doesn't fit the remaining budget, it lowers
   `maxOutputTokens`. If the budget leaves room for fewer than 2048 output tokens per attempt, it
   refuses the call (`LLMError('cancelled', 'budget exhausted')`). A request that asks for fewer
   than 2048 tokens itself is passed through when the budget covers it.
3. The ledger is append-only JSON Lines:
   - A `reserve` line is written before each call and a `charge` line after it with the actual cost.
     Cache writes are charged at 1.25x the input rate and cache reads at 0.1x.
   - The ledger is re-read at startup, so the cap covers every run that used the same ledger file.
   - A reservation with no matching charge (for example, after a crash) counts at its worst case.
   - The run holds `<ledger>.lock` (containing its PID) until it finishes, so a second run on the
     same ledger is refused while the first is running. A lock left by a process that has exited
     is taken over.
4. Once the job queue is up, `startRealRun` starts one create job per URL. It waits for every job
   to finish, prints a JSON summary to stdout and calls the required `quit` option. The bootstrap
   must pass `quit: (code) => app.exit(code)`. The exit code is 0 only if every job ends `done`.

Models without a price in `src/main/devtools/rates.ts` are refused.

## Command

```sh
npm run build
ELI5_KEYSTORE=memory \
ELI5_TEST_API_KEY_CLAUDE="<key from your own shell, never committed>" \
ELI5_USER_DATA_DIR="$TMPDIR/eli5-real-run/userData" \
ELI5_LIBRARY_DIR="$TMPDIR/eli5-real-run/library" \
ELI5_REAL_RUN_LEDGER="$HOME/.eli5-real-run-ledger.jsonl" \
ELI5_REAL_RUN_URLS="https://example.com/,https://example.org/" \
ELI5_REAL_RUN_BUDGET_USD=2 \
npx electron .
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `ELI5_REAL_RUN_URLS` | yes | Comma-separated `http(s)` URLs, one create job each (duplicates are dropped) |
| `ELI5_REAL_RUN_BUDGET_USD` | yes | The cap across every run that uses this ledger, in (0, 50] |
| `ELI5_REAL_RUN_LEDGER` | no | Ledger path. Default: `<userData>/devtools/real-run-ledger.jsonl`. Keep it stable (and outside the repo) so the cap spans runs |
| `ELI5_REAL_RUN_TIMEOUT_MS` | no | Overall wait before still-running jobs are cancelled. Default: 30 minutes |
| `ELI5_KEYSTORE=memory` + `ELI5_TEST_API_KEY_CLAUDE` | for dev runs | API key without the Keychain (unpackaged builds only) |

The run refuses to start when:

- `ELI5_LLM_FAKE=1` is set (except a rebuild rehearsal in a test build, below),
- a URL is not `http(s)`, or
- the budget is missing or out of range.

To raise the cap for a later run, pass a larger `ELI5_REAL_RUN_BUDGET_USD`. To reset it, point
`ELI5_REAL_RUN_LEDGER` at a new file.

## Summary shape

```json
{
  "ok": true,
  "provider": "claude",
  "model": "claude-opus-5",
  "budgetUsd": 2,
  "spentUsd": 0.41,
  "remainingUsd": 1.59,
  "ledgerPath": "…",
  "jobs": [
    {
      "url": "https://example.com/",
      "jobId": "…",
      "status": "done",
      "slug": "…",
      "title": "…",
      "indexPath": "…/index.html",
      "skipped": [],
      "costSoFarUsd": 0.2
    }
  ]
}
```

`costSoFarUsd` is the ledger total (across all runs) at the moment that job settled. Calls are not
attributed to individual jobs, because jobs run concurrently.

## Rebuild mode (new versions of existing documents)

`ELI5_REAL_RUN_REBUILD` regenerates existing Library documents from their source files with the
current prompts and saves each result as a new version of the same document (spec 06 §5.7.1,
09 §9 "Rebuild patch"). The id, slug, `createdAt`, merges, publications and folder stay; Q&A
answers, the action log and section ELI5 tabs stay in the previous version in History. The
version is labelled `Rebuilt with prompt set <set> (<digest8>)`, and History shows it as
"Rebuilt with new prompts". To roll back, check out its parent in History (`Original` for a
document that had no versions before).

```sh
npm run build
ELI5_USER_DATA_DIR="$TMPDIR/eli5-rebuild/userData" \
ELI5_LIBRARY_DIR="<library root>" \
ELI5_REAL_RUN_LEDGER="$HOME/.eli5-rebuild-owner-ledger.jsonl" \
ELI5_REAL_RUN_BUDGET_USD=12 \
ELI5_REAL_RUN_PROMPT_SET=default \
ELI5_REAL_RUN_REBUILD="my-topic=/abs/path/source.md,other-topic=/abs/path/other.md" \
ELI5_REAL_RUN_DRY=1 \
npx electron .
```

| Variable | Meaning |
| --- | --- |
| `ELI5_REAL_RUN_REBUILD` | 1-4 `slug=/absolute/source-file` entries, run in order, one at a time. Exclusive with `ELI5_REAL_RUN_URLS` |
| `ELI5_REAL_RUN_LEDGER` | Required for a rebuild (not a rehearsal). Use a new file of its own, never the URL runs' ledger: the rebuild spends on the owner's key, and the $10 hard stop and the per-document gate read this ledger's total |
| `ELI5_REAL_RUN_DRY=1` | Preflight and cost plan only. No job, no provider call, nothing written to the ledger. Wins over a rehearsal |
| `ELI5_REAL_RUN_PROMPT_SET` | Optional. Must equal the prompt set in effect (`ELI5_PROMPT_SET` or settings `llm.promptSet`), else the run refuses |
| `ELI5_REAL_RUN_DOC_GATE_USD` | Default 4. Before each document the remaining cap must be at least this, else the run stops cleanly with `stopped: "budget-gate"` |

No `ELI5_KEYSTORE` is needed: the key is read in-process from the macOS Keychain, so macOS may
ask once for access ("Always Allow"). The run also stops with `stopped: "hard-stop"` before a
document once the ledger total has passed $10. Check `ledgerBeforeUsd` in the dry run: on a new
ledger it is 0. A job that runs past `ELI5_REAL_RUN_TIMEOUT_MS` is cancelled, the driver waits for it
to stop, and the run ends with `stopped: "timeout"`; no further document starts.

Rebuild jobs are never resumed. If the run is interrupted (Ctrl-C, crash), the next launch with the
same userData finishes the job as done when its version had committed, and otherwise fails it with
`INTERRUPTED`; rerun the driver to retry (the preflight captures the base again).

Preflight (all documents, before any call; any problem aborts the whole run): the Library is
writable (quit the app first: a locked Library is read-only), each slug exists, the sha256 of each
source file equals the one recorded in that document's `meta.sourcesUsed` (matched by file name)
and is that document's only source, the live `index.html` is a known version (not changed outside
the app), the model is priced, the prompt set matches, and the provider key is present. It captures each
document's current version id and the sha256 of its `index.html`; the save refuses
(`SAVE_FAILED`, detail `REBUILD_BASE_MOVED`) if either changed meanwhile.

The plan gives, per document, a typical cost (the design's output sizes) and a worst case (every
call at its full `maxOutputTokens`, one STE repair, one more in-depth-sized retry, input at the
cache-write rate) over in-depth, ELI5, ASD-STE100, the ELI5 critique (step 1b), the glossary (when
the document had it), the summary, photo-pick (when stock photos are on) and a retry allowance.
Source tokens are a rough bound from the file size (images at the flat vision rate). The worst case
is a planning bound; the budget guard's cap is what limits spend.

The printed summary has no clarifying input and only source file names, not paths. It is still
private: report the totals ("owner key: $X"), not the rows.

After each document commits, the driver verifies: the new `index.html` passes the validity checks
and parses and renders back byte for byte, it has the ASD-STE100 tab, the catalog id and
`createdAt` are unchanged, the current version node is this job's, its parent is the captured base,
and the parent's stored html hashes to the captured sha256 (so the rollback restores it exactly).

**Rehearsal.** In a test build (`ELI5_TEST_BUILD=1 npm run build`), `ELI5_LLM_FAKE=1` together with
`ELI5_REAL_RUN_REBUILD` runs the same flow against the fake LLM on a copy of the library: no guard,
no pricing, no key check and no money gates (a budget is still required). With
`ELI5_REAL_RUN_DRY=1` it stays a dry run: preflight and plan only, nothing is written. Everywhere
else `ELI5_LLM_FAKE=1` is refused.

Summary (one row per document that started):

```json
{
  "ok": true, "mode": "rebuild", "provider": "claude", "model": "…", "promptSet": "default",
  "budgetUsd": 12, "docGateUsd": 4, "hardStopUsd": 10, "ledgerPath": "…",
  "ledgerBeforeUsd": 0, "ledgerAfterUsd": 1.7, "spentUsd": 1.7, "remainingUsd": 10.3,
  "preflight": [{ "slug": "…", "ok": true, "sha256": "…", "shaMatches": true, "baseVersionId": "v-…", "baseHtmlSha256": "…" }],
  "plan": [{ "slug": "…", "sourceTokens": 20000, "typicalUsd": 1.7, "worstUsd": 4.1 }],
  "planTotal": { "typicalUsd": 1.7, "worstUsd": 4.1 },
  "docs": [{
    "slug": "…", "ok": true, "jobId": "…", "status": "done", "versionId": "v-…", "parentVersionId": "v-…",
    "label": "Rebuilt with prompt set default (1a2b3c4d)", "spentUsd": 1.7,
    "steLint": { "sentences": 120, "failing": 9, "score": 0.075 }, "eli5CritiqueAccepted": true,
    "warnings": [], "verify": { "ok": true, "parentHtmlMatches": true, "roundTrip": true }
  }]
}
```

The installed app must be at least the version that wrote the rebuilt documents (it has the
ASD-STE100 tab); an older app shows them as view-only.

## Limits

- The default real-run providers make one attempt per call. A custom `base` factory is assumed to
  follow the process retry policy: the guard reserves every allowed attempt, charges each extra
  attempt of a successful call at its worst case, and charges a failed call for every attempt.
- `testConnection()` passes through unmetered. The real-run driver never calls it.
