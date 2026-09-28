# Generation quality evals

This folder holds the rubric-based evals from spec/tech/13-testing-quality.md §9. They measure
whether a prompt, skill or model change made documents better or worse. They call real LLM APIs,
cost money and need the network, so they never run in `npm test` or on pull requests.

## What a run does

For each case in `cases/`, in order:

1. The runner stops scheduling cases once the cost cap is reached. The remaining cases are marked
   `skipped_budget` and the run is reported `incomplete`.
2. It runs the real generation pipeline headless. This is the same wiring as
   `test/integration/pipeline.test.ts`: the real registry, resolvers, fetcher, extractors, tasks,
   document builder and library, with URLs served by the local fixture server and `SeededIdSource`
   section ids. The generator is the configured real provider.
3. It applies the deterministic gates:
   - `validateDocument` passes.
   - The In depth and ELI5 tabs are present.
   - The glossary is present if and only if the case enables it.
   - Every `jargon` term has a glossary callout.

   A failed gate scores the case 0 without calling the judge.
4. It judges each tab `ELI5_EVAL_JUDGE_RUNS` times (default 3) and takes the median of each
   criterion. The judge receives:
   - the source text exactly as the generator saw it (images are attached for vision cases)
   - the tab's visible text: glossary notes, captions and chart data are kept as text
   - the rubric with its anchor examples
   - the case facts (`mustCover`, `jargon`, clarifying input, used and skipped sources)

   It replies with JSON `{ scores, rationale, missingFacts }`. An invalid reply is retried once
   with the error appended. A second invalid reply marks the case `judge_error`, and the case is
   left out of the means.
5. It runs each listed section action through 08's section-action service. The rewritten section
   (or the new Section ELI5 tab) is judged with S1 to S3 against the section as it was before and
   its neighbours.

Scoring:

- A case score is the mean of its criterion medians.
- A suite score is the mean of the case scores, separately for In depth, ELI5 and section actions.
  Gate and generation failures count as 0.
- The results file is `results/<date>-<provider>-<model>.json`. The results folder is gitignored.
- A complete run is compared with `baselines/<provider>.json`, over the cases both runs scored. It
  is a regression if any suite score drops more than 0.3 or any criterion mean drops more than 0.5.

Logs and results contain ids, statuses, scores, judge rationales and missing facts only, never
source text or generated text.

## Layout

| Path | Contents |
| --- | --- |
| `cases/*.json` | 16 synthetic cases (`EvalCase`, `lib/types.ts`). They cover every PRD source type and have at least 3 cases per domain. 4 cases are multi-source, one has a skipped source (the login-wall fixture site) and one uses only images. 5 cases include section actions. |
| `sources/` | Eval-owned synthetic sources. The Markdown, text and CSV files are used as they are. `*.docx.json`, `*.xlsx.json` and `*.png.json` are specs that are built into the work dir at run time. `sites/*.html` is served by the fixture server. Cases can also reference committed fixtures (`sources/…`, `sites/…` under `test/fixtures/`). |
| `rubrics/` | D1 to D7 (In depth), E1 to E5 (ELI5) and S1 to S3 (section actions). Each criterion has a score-2 anchor and a score-5 anchor. |
| `prompts/judge.md` | The judge prompt. It uses prompted JSON with placeholders filled by `lib/judge.ts`. |
| `calibration/` | 10 hand-scored synthetic documents: source text, both tabs' visible text, and human scores with notes. |
| `baselines/` | Committed baselines, one per provider. See `baselines/README.md`. |
| `results/` | Results files, cost ledgers and calibration reports. Gitignored. |
| `lib/` | The runner: `config`, `cases`, `sources`, `harness`, `providers`, `gates`, `text`, `judge`, `scoring`, `runner` and `calibrate`. |
| `*.test.ts` | Offline tests of the runner. The generator is `FakeProvider` and the judge is scripted. Both sit behind the real budget guard and ledger. No network. |
| `run.eval.ts`, `calibrate.eval.ts` | Entry points for real runs. Use them only through `scripts/eval/run.mjs`. |

## Commands

Build the document runtime first so generated documents embed the real runtime. Without it, the
harness falls back to the stub runtime that the integration tests use.

```sh
npx vite build --config vite.doc-runtime.config.ts
```

Offline runner tests (no key, no network, no cost):

```sh
npx vitest run --config test/evals/vitest.config.ts --project evals:unit
```

A full eval run. Keys come only from the environment, never from flags or files:

```sh
ELI5_EVAL_API_KEY_CLAUDE="<your key>" ELI5_EVAL_API_KEY_OPENAI="<your key>" \
ELI5_EVAL_RATES="gpt-5=<input USD per MTok>:<output USD per MTok>" \
node scripts/eval/run.mjs --provider claude --model claude-opus-5
```

A subset of cases with one judge run (a cheap smoke run):

```sh
ELI5_EVAL_API_KEY_CLAUDE="<your key>" \
node scripts/eval/run.mjs --provider claude --model claude-opus-5 \
  --cases general-plain-text,marketing-campaign-md --judge-runs 1 --max-usd 2
```

Judge calibration. This needs only the judge's key:

```sh
ELI5_EVAL_API_KEY_CLAUDE="<your key>" node scripts/eval/run.mjs --calibrate --judge claude:claude-sonnet-5
```

Create or refresh a baseline from a complete run:

```sh
ELI5_EVAL_API_KEY_CLAUDE="<your key>" node scripts/eval/run.mjs --provider claude --write-baseline
```

`node scripts/eval/run.mjs --print-env …` shows the variables the flags map to, without running
anything. The npm aliases `npm run eval -- …`, `npm run eval:calibrate` and `npm run test:evals` run
the same commands once they are added to `package.json`.

Exit codes:

- 0: the run finished. A cost-capped, incomplete run also exits 0.
- 1: the run failed or the config was refused.
- 2: a regression against the baseline, or a calibration MAE above 0.75.

## Configuration

| Flag | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `--provider` | `ELI5_EVAL_PROVIDER` | `claude` | Generator provider (`claude` or `openai`) |
| `--model` | `ELI5_EVAL_MODEL` | The provider's default model (`DEFAULT_MODELS`) | Generator model |
| `--judge` | `ELI5_EVAL_JUDGE` | The other provider if its key is set, otherwise the generator's provider | `provider:model` or `provider`. Configure it separately from the generator to reduce self-preference (§9.5) |
| — | `ELI5_EVAL_API_KEY_CLAUDE`, `ELI5_EVAL_API_KEY_OPENAI` | — | API keys (env only) |
| `--cases` | `ELI5_EVAL_CASES` | All cases | Comma-separated case ids. An unknown id is refused before any spend |
| `--judge-runs` | `ELI5_EVAL_JUDGE_RUNS` | 3 | Judge repetitions, medianed |
| `--max-usd` | `ELI5_EVAL_MAX_USD` | 10 | Cost cap for the run, shared by the generator and the judge |
| `--ledger` | `ELI5_EVAL_LEDGER` | `results/ledger-<time>.jsonl` | Spending ledger. Reuse one path to make the cap span runs |
| `--rates` | `ELI5_EVAL_RATES` | — | `model=in:out` (USD per million tokens) for models missing from `src/main/devtools/rates.ts` |
| `--results-dir` | `ELI5_EVAL_RESULTS_DIR` | `test/evals/results` | Where the results and reports go |
| `--write-baseline` | `ELI5_EVAL_WRITE_BASELINE=1` | off | Write `baselines/<provider>.json` from a complete run |

Cost control:

- Every provider call goes through the devtools `BudgetGuardProvider`, with one `BudgetLedger`
  shared by the generator and the judge.
- Before each call, the guard reserves the worst case (input plus maximum output, for up to 2
  attempts), writes that reservation to the ledger, and afterwards charges the actual token cost.
- Once the remaining budget cannot cover a call, the guard refuses it. The runner then marks the
  case `skipped_budget` and schedules no further cases.
- A model with no price is refused at startup.
- The run refuses to start when `ELI5_LLM_FAKE=1` is set or `GITHUB_EVENT_NAME` is a pull request
  event.

## Adding a case

1. Add the source material. It must be synthetic: invented companies, round numbers. Either
   reference a committed fixture or add a file under `sources/`. For binary formats, add a spec
   (`*.docx.json`, `*.xlsx.json`, `*.png.json`, see `lib/sources.ts`) rather than a binary.
2. Add `cases/<id>.json` with `mustCover` facts phrased so a judge can check them, and `jargon`
   terms. With the glossary on, every jargon term must get a glossary callout, or the case fails its
   gate.
3. Run `npx vitest run --config test/evals/vitest.config.ts --project evals:unit`. `cases.test.ts`
   checks the coverage rules from §9.2.
4. Adding cases changes the suite, so refresh the baseline in the same pull request.
