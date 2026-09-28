# Eval baselines

`<provider>.json` (for example `claude.json`) is the committed baseline that the eval runner
compares each complete run against (spec/tech/13-testing-quality.md §9.6). A regression is a suite
score drop greater than 0.3 for any part (In depth, ELI5, section actions), or a criterion mean drop
greater than 0.5, over the cases both runs scored.

No baseline is committed yet: baselines come only from a real, complete run. To create or update
one, run the eval with `--write-baseline` and open a pull request that adds both the baseline and
the results file it came from (`test/evals/results/<date>-<provider>-<model>.json`, force-added with
`git add -f` because the results folder is ignored). See `test/evals/README.md`.
