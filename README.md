# ELI5 Learner

macOS app that turns decks, docs, PDFs, screenshots and URLs into interactive HTML explainers: an in-depth WSJ-style view plus an ELI5 view, refinable section by section.

> **Status:** early development. The design is settled; the code is still to come.
> Full requirements: [spec/ELI5 Learner Product Requirements Document.md](spec/ELI5%20Learner%20Product%20Requirements%20Document.md)

## What it does

Drop in source material, optionally type a few clarifying specifics, hit Enter, and walk away. ELI5 Learner builds one self-contained `index.html` learning document with two views:

- **In depth.** Wall Street Journal-grade explanatory writing, with charts, diagrams, annotated figures, pull quotes and light interactivity. An optional in-context glossary explains jargon and acronyms in the right margin, next to where each one first appears.
- **ELI5.** The same material, rebuilt from scratch for comprehension, in plain words. It doesn't follow the structure of the source.

The document opens in the app's viewer and in any browser.

## Features

- **Fire-and-forget generation.** No modals and no mid-job questions. A source that fails is skipped and listed in the document's references. Jobs can be queued.
- **Many inputs in one job.** Drag and drop, paste (Cmd+V) or URLs:
  - PowerPoint (slide order, bullet hierarchy and speaker notes are kept)
  - Word (headings, lists and tables are kept)
  - PDF, including scanned PDFs through vision
  - Markdown and text
  - Images and screenshots, sent straight to the model's vision input with no OCR step
  - Excel
  - Public web pages
- **Living documents.** Select any passage to get:
  - *Expand this*
  - *Re-explain it*
  - *Give me an analogy*
  - *Go deeper*
  - *Create a separate ELI5 for this section*

  Only that section is regenerated, in place.
- **Section ELI5 tabs.** Focused ELI5 tabs, spun off from any passage and labeled by topic. You can close them.
- **Library and menu bar.** Every document is listed in a sidebar. The menu bar shows the last three, and the app keeps running in the menu bar when the window is closed.
- **Merge suggestions.** After a job finishes, the app suggests merging related documents. The suggestion never interrupts you.

## How it works

```
sources ──▶ resolve & extract ──▶ LLM generation ──▶ docs/<topic-slug>/index.html
 files        (file / clipboard /     (Claude or          + meta.json
 clipboard     public URL)             OpenAI)            + docs/catalog.json
 URLs                                                       │
                                                            ▼
                                                  merge-suggestion check
```

- **URL fetching:** first a plain HTTP fetch with Readability-style extraction. If that comes back empty, the app renders the page in a hidden Electron window. There's no Puppeteer and no extra Chromium download.
- **Stable section IDs:** every section of every tab has a stable ID, so one section can be regenerated without touching the rest of the file.
- **Local storage:** documents live in the app's `docs/` folder. That folder is git-ignored because it's built from your own source material.

## Architecture: swappable seams

Every external capability sits behind an interface, so other backends can be swapped in without restructuring the app:

| Interface | Ships with | Documented stubs |
| --- | --- | --- |
| `LLMProvider` | Claude API, OpenAI API | AWS Bedrock |
| `SourceResolver` | Local files, clipboard, public URLs | MCP-brokered authenticated sources |
| `Publisher` | Local directory | Organization cloud drive, GitHub Pages |

The public build needs nothing but an API key: no accounts, no logins and no other services.

## Configuration

- LLM provider (Claude or OpenAI) and model name
- API key, stored in the macOS Keychain
- Default setting for "Explain domain-specific terms"

## Not in v1

- Logins or authenticated sources
- Audio input or speech to text
- Cloud publishing (cloud drive, GitHub, Google Drive) and NotebookLM
- Native macOS notifications

## Roadmap

- Per-section version history with diff and rollback
- Merges that weave new material into existing sections
- Google Drive publishing and NotebookLM linking

## Getting started

Build and run instructions will be added once the app is scaffolded (Electron, macOS).

## License

[MIT](LICENSE) © 2026 Omer Ansari
