# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

ELI5 Learner is a macOS Electron app that turns decks, docs, PDFs, screenshots and URLs into one
self-contained interactive `index.html` with an in-depth (WSJ-style) tab and an ELI5 tab, refinable
section by section.

- **Status:** M0 (foundations) is built; M1 modules are skeletons with typed seams, stubs and
  public defaults. See the build order in `spec/tech/README.md`.
- **Source of truth:** `spec/ELI5 Learner Product Requirements Document.md` (what) and
  `spec/tech/` (how: one engineering spec per module; start at `spec/tech/README.md`, which also
  has the build order). `README.md` is the user-facing summary.

## Repo layout

- `spec/` — public product spec; `spec/tech/` — public engineering spec and `hooks.md` registry.
- `scripts/check-spec-hooks.mjs` — validates private-hook markers; run `node scripts/check-spec-hooks.mjs`
  after any spec edit.
- `.library/` — dev library root for generated learnings (gitignored; packaged builds use userData).
- `docs/index.html`, `docs/.nojekyll`, `docs/sample/` — the only committed `docs/` files; they form
  the public GitHub Pages site.
- `.github/workflows/pages.yml` — deploys `docs/` to https://knail1.github.io/eli5-learner/ on pushes
  to `main` that touch `docs/**`.

## This repo is public

- Keep the public spec and all committed files generic. No organization names, internal systems,
  URLs or credentials.
- Never commit:
  - `spec/internal.md` (organization-specific spec details; git-ignored)
  - `.library/` (generated learnings) and `docs/*` other than the whitelisted Pages files
  - `.env*`, keys (`*.pem`, `*.p12`), `config.local.json`, `CLAUDE.local.md`
- Stage specific files only (no `git add .` / `git add -A`). Review `git diff --cached --stat` and
  scan the diff for secrets before every commit.
- When adding a new public file under `docs/`, whitelist it in `.gitignore` explicitly.
- Enterprise differences are named private hooks (`HOOK-<AREA>-<NN>`): a `<!-- hook:ID -->` marker plus
  a generic callout in the public spec, registered in `spec/tech/hooks.md`. The real details go only in
  the gitignored private spec; enterprise code goes only in the gitignored `enterprise/` overlay.

## Architecture rules (from the spec)

- Every external capability sits behind an interface, so enterprise backends swap in without
  restructuring:
  - `LLMProvider` — ship Claude and OpenAI; leave a documented AWS Bedrock stub.
  - `SourceResolver` — ship file, clipboard and public URL; leave a documented MCP stub.
  - `Publisher` — ship local directory; leave documented cloud drive and Git stubs.
- The public build must run with nothing but an API key (stored in the macOS Keychain).
- Generation is fire-and-forget: no modals, no mid-job questions. Failed sources are skipped and
  listed in the document's references.
- URL fetching: plain HTTP + Readability-style extraction, falling back to a hidden Electron
  `BrowserWindow`. No Puppeteer or extra Chromium.
- Images go straight to the model's vision input; no OCR engine.
- Every section of every tab carries a stable, unique ID so one section can be regenerated in place.
- Not in v1: logins/authenticated sources, audio/speech-to-text, cloud publishing.

## Build and run

Node 22.12+ (Electron 44's installer needs it; `postinstall` downloads the Electron binary).

- `npm run dev` — run the app; `npm run build` — production build into `out/`
- `npm run typecheck`, `npm run lint`, `npm test` (Vitest, offline), `npm run test:e2e` (Playwright
  `_electron`, run `npm run build` first), `npm run check:spec`
- Enterprise mechanism check: `ELI5_EDITION=enterprise ELI5_OVERLAY_DIR=test/fixtures/overlay-fake npx electron-vite build`

## Code conventions

- Each `src/main/<module>/` is imported only through its `index.ts` (ESLint enforces this). A module
  registers its public implementations, stubs and policy defaults in its own `register.ts`
  (`registerPublic(reg)`), called from `src/main/editions/public.ts`.
- Types that cross IPC live only in `src/preload/contract.ts`; modules re-export them.
- Zod 4: use `.prefault({})` for object defaults that must run nested defaults.
- Tests live in `test/` mirroring `src/`, never co-located. Secret-shaped test strings are
  assembled at runtime so the repo never contains literal ones.
