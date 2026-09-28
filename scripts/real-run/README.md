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

- `ELI5_LLM_FAKE=1` is set,
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

## Limits

- The default real-run providers make one attempt per call. A custom `base` factory is assumed to
  follow the process retry policy: the guard reserves every allowed attempt, charges each extra
  attempt of a successful call at its worst case, and charges a failed call for every attempt.
- `testConnection()` passes through unmetered. The real-run driver never calls it.
