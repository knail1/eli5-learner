# ELI5 Learner: Product Requirements Document

Sep 27, 2026 · @Omer

## Overview and goals

ELI5 Learner is a macOS Electron app that turns any source material into one beautiful, interactive HTML learning document with two views: a Wall Street Journal grade in depth explainer and an "explain like I'm five" version.

The user drops in files, screenshots, or URLs, optionally types a few clarifying specifics, hits enter, and walks away. The app generates the full document unattended. Afterward the user reads it inside the app and sculpts it: selecting any passage to expand it, simplify it, or spin off a focused ELI5 tab for just that section.

**Goals**

1. Make dense material (decks, financial docs, domain heavy writing) genuinely understandable to the user, calibrated to what the user does not know, not what the original audience knew.
2. Produce output far richer than Markdown: charts, diagrams, visual explanations, and light interactivity.
3. Keep documents alive. Any document, new or old, can be refined in place at the section level.
4. Zero friction workflow: fire and forget generation, no blocking questions, no modals.
5. Ship a public, open source v1 with clean seams so an enterprise edition can swap in AWS Bedrock, MCP brokered auth, and organization publishing without restructuring.

**Primary user:** a technical leader learning across many domains (security, finance, marketing, data), consuming slide decks and Word documents written by domain experts.

## Build editions and swap seams

Build the public v1 now. Every enterprise capability sits behind an interface that exists in v1, configured but dormant, so the enterprise edition is a swap of implementations, not a redesign. Organization specific details are kept out of this public spec. Engineering detail and the full list of private hooks: spec/tech/README.md and spec/tech/hooks.md.

| Capability | Public v1 (build now) | Enterprise edition (later, not implemented now) |
| --- | --- | --- |
| Intelligence (LLM) | Claude API or OpenAI API, user supplied key, selectable in settings | AWS Bedrock (hook: HOOK-LLM-01) |
| Authentication | None. Only sources reachable without login | MCP server: one OAuth login with 2FA, then scoped access to the organization's document, observability, code, and ticketing systems (hook: HOOK-AUTH-01) |
| Source access | Local files, clipboard, public URLs | Adds authenticated organization URLs and ticket links via MCP (hooks: HOOK-SRC-01, HOOK-SRC-02) |
| Publishing | Save to local directory only | Organization cloud drive (org wide share + link returned) and Git push with secret scanning (hooks: HOOK-PUB-01, HOOK-PUB-03) |
| Document location | App project directory | App project directory (moving into sibling monorepo projects is future work) |
| Illustrative photos | Open-licensed stock photos from public photo libraries, found with anonymous searches (no key, no account) | An organization-approved image library, or photos turned off (hook: HOOK-DOC-03) |

**Seam requirements**

- Define an `LLMProvider` interface (generate, generate with images, streaming optional). Ship Claude and OpenAI implementations. Leave a documented Bedrock stub and config key (hook: HOOK-LLM-01).
- Define a `SourceResolver` interface. Ship file, clipboard, and public URL resolvers. Leave a documented MCP resolver stub (hooks: HOOK-SRC-01, HOOK-SRC-05).
- Define a `Publisher` interface. Ship a local publisher. Leave documented cloud drive and Git publisher stubs (hooks: HOOK-PUB-01, HOOK-PUB-03).
- Enterprise only UI (publish buttons) is hidden or disabled in the public build via a build or config flag (hooks: HOOK-UI-01, HOOK-CFG-02).
- Public build must run with nothing but an API key: no accounts, no credentials, no external services that need either. The stock photo search is anonymous, sends only a few generic words, and can be turned off.

## App shell and layout

The app runs as a normal window plus a persistent menu bar item. Closing the window does not quit the app; quitting happens only from the menu bar.

**Menu bar item**

- Always present while the app runs, including after the main window is closed.
- Shows the last 3 finished documents at the top, leaving out archived and trashed ones. Clicking one opens that document in the app's viewer (reopening the main window if needed).
- Entries are finished documents only, not sessions or source material.
- Includes Open ELI5 Learner and Quit.
- A newly finished document appears here automatically, and a native macOS notification announces it (see Completion notifications).

**Main window, modeled on the Claude app and VS Code**

- **Left sidebar, Library:** every finished document, newest first, titled by topic. Clicking one renders it in the main area. Documents can be filed in folders, archived, or moved to the Trash so a long list stays manageable (see Organizing the Library).
- **Main area, Viewer:** renders the generated HTML directly in an embedded Electron view. The user never sees raw HTML.
- **Input zone:** one drop box accepting drag and drop, paste (Cmd+V), and a URL field, plus an optional single line or multiline text field for clarifying specifics. Enter starts generation.
- **Status area (lower right):** a simple, human readable status line per job, for example Reading sources, Extracting content, Generating document, Done. No verbose logs.
- **Suggestions area:** where post generation merge suggestions wait for the user (see Library section).
- No modals anywhere in the ingest and generation flow.

No audio or speech to text in any edition. It was considered and removed; clarifying input is typed.

## Inputs and extraction

Three input methods feed one job: drag and drop files, paste from the clipboard, and enter URLs. Multiple sources can be combined in one job.

| Source type | Extraction approach | Priority |
| --- | --- | --- |
| PowerPoint (.pptx) | Preserve slide order, slide titles, bullet hierarchy, speaker notes | High |
| Word (.docx) | Preserve headings, lists, tables | High |
| PDF (text based) | Extract text with page order | High |
| Markdown, text | Read as is | High |
| Images (JPEG, PNG, screenshots) | Send directly to the LLM's vision input. No OCR engine | High |
| Scanned PDFs | Render pages to images, send to vision | Medium |
| Excel (.xlsx) | Simple text or table dump. Do not over engineer | Low |
| Public URLs | See Fetching strategy | High |
| Ticket links (issue trackers) | Enterprise edition only, via MCP (hook: HOOK-SRC-02) | Enterprise |

**Clipboard paste**

- Detect the clipboard type and route it: image to vision, rich or plain text to the text pipeline, file references to the file pipeline.
- Primary use case: paste a screenshot of something complex someone wrote and ask the app to explain it.

**Principle:** preserve structure where it is cheap and high value (slides, Word), and stay minimal where it is rare (Excel).

## Fetching strategy

Fetch first, render only as a fallback. No separate browser dependency (no Puppeteer, no bundled Chromium beyond Electron itself).

1. **Plain HTTP fetch** of the URL, then a Readability style extractor to pull article content and strip navigation, ads, and boilerplate.
2. **Fallback: hidden Electron BrowserWindow.** If the fetched HTML is empty or clearly client rendered, load the URL in an invisible BrowserWindow, wait for render, extract the finished DOM content, then close the window. This reuses the Chromium engine Electron already ships.
3. **If both fail** (for example, the page requires login in the public build), record the URL as skipped and continue the job.

**Public build:** no authentication of any kind. Sites that require login are out of scope.

**Enterprise edition (documented, not implemented):**

- Authenticated organization sources (documents, dashboards, code, tickets) resolve through the MCP server, which holds credentials and applies the user's authorization scope. The app never handles credentials. (hooks: HOOK-SRC-01, HOOK-SRC-03, HOOK-AUTH-01)
- Rationale recorded for later: the MCP is the authenticated access lane; plain fetch plus hidden window rendering is the public web lane. (hooks: HOOK-FETCH-01, HOOK-FETCH-02)

## Processing pipeline

Generation is fire and forget: once the user hits enter, the job runs to completion with no questions, no modals, and no blocking prompts.

&#91;embedded content: processing pipeline · generation, then post generation merge check\]

A failed source is skipped and noted; the job still produces a document. The merge check runs only after the document is saved.

- **Clarifying input:** optional, typed before starting. If empty, generation proceeds with defaults. The app never asks follow up questions mid job.
- **Status:** one simple line per job (Reading sources, Extracting content, Generating document, Saving, Done).
- **Error handling:** carry on with whatever was ingested. The finished document lists skipped sources and why (for example, page required login, unsupported file, fetch timed out). Only a total failure (no usable content, LLM unavailable) ends the job, with a clear message in the status area.
- **Concurrency:** the user can queue another job while one runs.
- **Completion:** the document appears in the Library and the menu bar list, and a native macOS notification is posted (see Completion notifications).

## Completion notifications

When a new document finishes, the app posts a native macOS notification. Failures, section regenerations, section ELI5 tabs, merges, and publishes stay inline in the app, with no notification.

- **Trigger:** one notification per finished document (a create job reaches Done and the document is saved to the Library). It is posted whenever notifications are enabled, even if the main window is focused.
- **Content:** title "Document ready"; body is the document title (truncated to 120 characters). No source content. macOS Focus and Do Not Disturb apply as usual. An enterprise overlay may replace the body with a generic "Your document is ready" (hook: HOOK-UI-03).
- **Click, default:** shows and focuses the main window (reopening it if needed) and opens the document in the viewer. If the document no longer exists, the app shows a not found view.
- **Click, published link (setting):** opens the document's published link in the default browser instead: the organization cloud drive share link or the GitHub Pages link, per the preferred link setting (most recent, cloud drive, or GitHub Pages). The link is resolved at click time: the preferred kind first, then any other published link, newest first. If the document has no published link, the click falls back to opening it in the app. Local exports never count as published links. In the public build nothing can be published, so this option is shown disabled. The enterprise edition may set the organization default, for example preferring the cloud drive share link (hook: HOOK-UI-03).
- **Permissions:** macOS asks the user the first time the app posts a notification. If the user declines, notifications silently do not appear; Settings explains how to allow them (System Settings > Notifications > ELI5 Learner > Allow notifications) and links there. If the system does not support notifications, Settings says so and the toggle is disabled.
- **While running:** the app keeps running in the menu bar after the window is closed, so clicks work any time it runs. A notification clicked after the app has quit is ignored.

## Output document

Each learning produces one self contained `index.html` with tabs across the top. The same file opens in the app's viewer and in any browser (Chrome, Safari, Edge).

**Tabs**

| Tab | Default | Structure | Glossary | References |
| --- | --- | --- | --- | --- |
| In depth (WSJ style) | Yes, opens first | May follow the source's logical structure | Yes, in the right margin | Yes, at the bottom |
| ELI5 | Always generated | Rebuilt from scratch for comprehension. Never mirrors the source structure | No. Uses plain words instead of jargon | No |
| Section ELI5 (0 to many) | Created on demand | Focused ELI5 of one selected passage | No | No |

**In depth tab: visual quality bar**

- Wall Street Journal grade explanatory journalism: charts, bar graphs, diagrams, annotated figures, pull quotes, and light interactivity where it aids understanding. Far richer than Markdown.
- The builder must study how the Wall Street Journal presents graphics and explainers and apply those patterns.
- Generation follows the HTML skills the user will supply (the ELI5 skill and the beautiful documentation skill), and the approach described in Thariq's "unreasonable effectiveness of HTML" article and GitHub repo. Both skills may be used for either tab.

**Pictures (both tabs, mainly ELI5)**

- Every ELI5 section gets one picture, chosen by what the idea is.
- Structured ideas (lists, flows, comparisons, timelines) get a clean diagram: a few labeled boxes and arrows, labels that fit inside their shapes, never drawings of people, buildings or scenes.
- Real-world scenes (people, places, objects, what an experience looks like) get a real open-licensed stock photo, embedded in the file, instead of a drawing. The in depth tab may use at most two where a photo genuinely helps.
- Only short generic search words (for example "courthouse exterior") leave the Mac, never names, case details or source text. The app picks the best match with the configured model and skips the photo quietly when nothing fits or the search fails; the document is still produced.
- Every photo carries a small caption credit (title, creator, license, source) marked "Illustrative stock photo", and is listed under "Image credits" in the references. Sensitive topics prefer photos without identifiable faces; logos and brands are avoided.
- A setting turns stock photos off; then the document uses diagrams only.

**In context glossary (in depth tab only)**

- Optional per job: a toggle such as "Explain domain specific terms".
- When on, the model identifies jargon and acronyms the original audience assumed (example: ROAS, return on ad spend) and explains each one in the right margin, aligned with the passage where it first appears.
- Styled as visually distinct marginal callouts, for example a lightbulb "extra knowledge" note like a textbook sidebar. Never a list at the end of the document.
- Responsive: on narrow widths, margin notes collapse into expandable inline notes.

**References:** the in depth tab ends with a references section listing every source used (file names, URLs, pasted items), plus any sources that were skipped.

**Structural requirement:** every section in every tab carries a stable, unique identifier so a single section can be regenerated and replaced without touching the rest of the file. This is required by the interactive reading features.

## Interactive reading

Any document in the Library, new or months old, can be refined in place from the viewer. Documents are never frozen.

**Select and act**

- Selecting text in the viewer shows a small inline action menu anchored to the selection. Not a modal, not a new window.
- Actions:
  - Expand this
  - This isn't clear, re explain it
  - Give me an analogy
  - Go deeper
  - Create a separate ELI5 for this section
- An optional one line text field lets the user add a note to the action.

**Regenerate in place**

- The app identifies the enclosing section by its stable ID, regenerates only that section with the surrounding context, and writes it back into the same `index.html`.
- v1 replaces the original text outright, but keeps exactly one prior version of each document: Undo and Redo buttons (and Cmd+Z / Shift+Cmd+Z) in the document header swap back to the previous version and forward again, like a word processor. A new change after an undo replaces the saved version, so there is one level only. Full per-section history remains future work.
- The viewer refreshes and scrolls to the updated section.

**Section ELI5 tabs**

- "Create a separate ELI5 for this section" generates a focused ELI5 of the selected passage and adds it as a new tab to the right of the existing tabs.
- Tab label derives from the section heading (for example "ELI5: Revenue recognition"), never a number.
- Section ELI5 tabs can be closed (deleted) by the user so the tab bar does not sprawl.
- The same select and act menu works inside ELI5 tabs.

## Library, storage, and merge suggestions

All documents live inside the Electron app's own project directory, one folder per learning, in both editions.

```
<app-project>/
  docs/
    catalog.json
    <topic-slug>/
      index.html
      meta.json
```

- `catalog.json` holds one entry per document: id, title, topic slug, created and updated timestamps, and a one or two sentence summary generated at creation.
- `meta.json` records the sources used, sources skipped, the clarifying input, and the tab list.
- The catalog powers the Library sidebar, the menu bar list, and merge matching, so no document is re read to list or compare.

**Organizing the Library**

A long Library is pruned with folders, an Archive and a Trash. Nothing here asks a question mid-task, and only emptying the Trash (or deleting one trashed document for good) cannot be undone.

- **Folders:** a "New folder" button beside the Library heading. Folders are one level deep, collapsible and renamable. Unfiled documents are listed first. The filter searches inside folders and opens the ones that match. Deleting a folder moves its documents to the Trash, which remembers the folder they came from.
- **Moving:** drag a document onto a folder, or use its context menu: Move to (a folder or No folder), Archive, Move to Trash. Cmd+Delete on a selected document moves it to the Trash.
- **Swipe:** on a document, a two-finger swipe (or a drag) left archives it and right moves it to the Trash. The row slides to reveal a colored action; a short swipe leaves the action button showing to click.
- **Archive:** a built-in folder above the Trash that cannot be renamed or deleted. Archived documents stay in the Library but leave the menu bar list.
- **Trash:** a row at the bottom of the sidebar with a count. Trashed documents leave the Library and the menu bar list, but their files are kept inside the library folder and can be put back to where they were (or unfiled if that folder is gone). Documents removed by accepting a merge suggestion also appear there. Delete Permanently and Empty Trash each ask for one confirmation. The Trash is managed by the app, not the system Trash, and old entries are cleared after a retention period.
- **Undo:** each move shows a short "Moved to … · Undo" notice; Cmd+Z undoes it while the notice is showing.
- Opening a trashed document from a notification or a stale link shows that it is in the Trash, with Put Back.

**Post generation merge suggestions**

1. Only after a new document is fully generated and saved, the app compares its summary against the catalog.
2. If a strong match exists, it posts a non blocking suggestion: "This looks related to *X*. Merge it in or keep it separate?"
3. The suggestion waits in the suggestions area until the user acts. It never interrupts or gates generation.
4. On accept, v1 appends the new material to the existing document as a clearly marked new section, and the standalone document is moved to the Trash (restorable with Put Back). Intelligent weaving into existing sections is future work.
5. On dismiss, both documents remain.

## Enterprise publishing (documented, not implemented in v1)

The public build saves locally only and pushes nothing. The enterprise edition adds two user triggered publish actions per document.

**Organization cloud drive**

- Upload the document's `index.html` (and its folder if needed) to a configured cloud drive location, brokered by the MCP (hook: HOOK-PUB-01).
- Apply an organization wide sharing permission so everyone in the organization can open it, not just the owner (hook: HOOK-PUB-02).
- Return the shareable link in the app, one click to copy or open in the default browser.

**Git push to GitHub Pages**

- Push the document's files to a configured repo and docs directory, scanning for secrets first and committing only the specified files (hooks: HOOK-PUB-03, HOOK-PUB-05).
- The repo renders pushed HTML to a GitHub Pages (github.io) link; the app surfaces that link (hook: HOOK-PUB-04).
- Include help documentation on setting up the GitHub Actions workflow that renders HTML to GitHub Pages.

## Configuration, scope, and open items

**Settings (v1)**

- LLM provider (Claude or OpenAI), API key stored in the macOS Keychain, model name.
- Default for the "Explain domain specific terms" toggle.
- "Use stock photos for real-world scenes" toggle (`images.stockPhotos`, default on). An organization can lock it off.
- **Notifications** section:
  - "Notify me when a document is ready" toggle (`notifications.enabled`, default on).
  - "When I click a notification": "Open it in ELI5 Learner" (default) or "Open its published link in my browser" (`notifications.clickAction`), with a choice of which link: Most recent, Cloud drive, or GitHub Pages (`notifications.preferredLink`, default Most recent). The published link option is disabled in the public build with the note "Available when documents can be published to a cloud drive or GitHub Pages". Enterprise defaults and locking come from the overlay (hook: HOOK-UI-03).
  - "Send test notification" button.
  - A short explanation of the macOS permission and an "Open macOS notification settings" button.
- Dormant, documented keys: `llm.provider = bedrock`, `sources.mcp.url`, `publish.drive.*`, `publish.github.*` (hooks: HOOK-CFG-01, HOOK-LLM-01, HOOK-SRC-05, HOOK-PUB-01, HOOK-PUB-04).

**Out of scope for v1**

- Any authentication or login flows.
- Speech to text and audio input (removed in all editions).
- Cloud drive, GitHub, Google Drive, and NotebookLM integrations.
- Moving documents into other monorepo projects.

**Future enhancements**

- Git style version history per section: view, diff, and roll back regenerations. (v1 keeps exactly one prior version per document with undo/redo.)
- Intelligent merge that weaves new material into existing sections.
- Google Drive publishing and NotebookLM linking.
- Choosing a destination project in the monorepo per document.

**Open items**

- [ ] User to supply the ELI5 HTML skill and the beautiful documentation HTML skill.
- [ ] Define the enterprise publishing targets and repo layout.
