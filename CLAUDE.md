# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

ELI5 Learner is a macOS Electron app that turns decks, docs, PDFs, screenshots and URLs into one
self-contained interactive `index.html` with an in-depth (WSJ-style) tab and an ELI5 tab, refinable
section by section.

- **Status:** pre-code. The design is settled; the app has not been scaffolded yet.
- **Source of truth:** `spec/ELI5 Learner Product Requirements Document.md`. Read it before
  designing or building anything. `README.md` is the user-facing summary.

## Repo layout

- `spec/` — public product spec.
- `docs/` — generated learnings live here at runtime. Mostly git-ignored (see below).
- `docs/index.html`, `docs/.nojekyll`, `docs/sample/` — the only committed `docs/` files; they form
  the public GitHub Pages site.
- `.github/workflows/pages.yml` — deploys `docs/` to https://knail1.github.io/eli5-learner/ on pushes
  to `main` that touch `docs/**`.

## This repo is public

- Keep the public spec and all committed files generic. No organization names, internal systems,
  URLs or credentials.
- Never commit:
  - `spec/internal.md` (organization-specific spec details; git-ignored)
  - `docs/*` other than the whitelisted Pages files (generated from possibly private sources)
  - `.env*`, keys (`*.pem`, `*.p12`), `config.local.json`, `CLAUDE.local.md`
- Stage specific files only (no `git add .` / `git add -A`). Review `git diff --cached --stat` and
  scan the diff for secrets before every commit.
- When adding a new public file under `docs/`, whitelist it in `.gitignore` explicitly.

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
- Not in v1: logins/authenticated sources, audio/speech-to-text, cloud publishing, native
  notifications.

## Build and run

Not scaffolded yet. When it is, record the build, run, lint and test commands here.
