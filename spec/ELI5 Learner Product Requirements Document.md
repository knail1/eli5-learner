# ELI5 Learner: Product Requirements Document

Sep 27, 2026 · @Omer

## Overview and goals

ELI5 Learner is a macOS Electron app that turns any source material into one beautiful, interactive HTML learning document with three views: a Wall Street Journal grade in depth explainer, an "explain like I'm five" version, and an ASD-STE100 (Simplified Technical English) version.

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
| Personal sync and phone (v2) | Optional and off by default: sync to the user's own Google Drive (hidden app folder) and a sideloaded Android companion | Whether sync is allowed, an organization store in its place, documents excluded from upload, and the OAuth client source (hooks: HOOK-SYNC-01, HOOK-SYNC-02) |

**Seam requirements**

- Define an `LLMProvider` interface (generate, generate with images, streaming optional). Ship Claude and OpenAI implementations. Leave a documented Bedrock stub and config key (hook: HOOK-LLM-01).
- Define a `SourceResolver` interface. Ship file, clipboard, and public URL resolvers. Leave a documented MCP resolver stub (hooks: HOOK-SRC-01, HOOK-SRC-05).
- Define a `Publisher` interface. Ship a local publisher. Leave documented cloud drive and Git publisher stubs (hooks: HOOK-PUB-01, HOOK-PUB-03).
- Enterprise only UI (publish buttons) is hidden or disabled in the public build via a build or config flag (hooks: HOOK-UI-01, HOOK-CFG-02).
- Public build must run with nothing but an API key: no accounts, no credentials, no external services that need either. The stock photo search is anonymous, sends only a few generic words, and can be turned off. The optional personal sync (v2, see below) is the one feature that signs in to anything; it is off by default and nothing else depends on it.

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
- **Main area, Viewer:** renders the generated HTML directly in an embedded Electron view. The user never sees raw HTML. Cmd+F finds text in the open document: a find bar above the viewer shows the match count ("3 of 12"), Cmd+G and Shift+Cmd+G step through the matches, and Escape closes it. Option+Cmd+F searches the Library instead (as does Cmd+F when no document is open).
- **Input zone:** one drop box accepting drag and drop, paste (Cmd+V), and a URL field, plus an optional single line or multiline text field for clarifying specifics. Enter starts generation. What was entered stays on screen after starting, so it can be changed and run again: while that run is still going, Start becomes Restart (cancel it and start again with the edited inputs); once it has finished, Start makes another document and keeps the earlier one. A Clear button (or Cmd+N) empties the input zone.
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
| ASD-STE100 (optional) | Generated after the in depth tab | The in depth content rewritten in Simplified Technical English, section for section, with the same visuals | No | No |
| Section ELI5 (0 to many) | Created on demand | Focused ELI5 of one selected passage | No | No |

Tabs are always in this order: In depth, ELI5, ASD-STE100 (when present), then section ELI5 tabs in the order they were created. The in depth, ELI5 and ASD-STE100 tabs can never be closed.

**In depth tab: visual quality bar**

- Wall Street Journal grade explanatory journalism: charts, bar graphs, diagrams, annotated figures, pull quotes, and light interactivity where it aids understanding. Far richer than Markdown.
- The builder must study how the Wall Street Journal presents graphics and explainers and apply those patterns.
- Structure follows the WSJ "Five-Box" feature formula: a lede on one concrete case from the material (or a scenario that says plainly that it is hypothetical; never invented people, names, quotes or numbers), a nut graf that states the thesis by the third or fourth paragraph, body sections that open with their takeaway and back each claim with a number or an example, one "boring but important" section with the background, assumptions and caveats a newcomer needs, and a kicker that returns to the lede. Headings state takeaways; sentences are short and declarative; numbers come with context.
- Charts follow the WSJ graphics rules after Dona M. Wong: one point per chart with a full takeaway title, bars that start at zero, at most four lines or series and five pie slices, natural round units, sentence case, direct labels instead of legends, the source credited, and a chart that passes a five-second test. The app, not the model, applies one shared, high-contrast chart palette in every theme and both color schemes, and fixes small chart faults in code (duplicate categories are merged, a blank title is derived from the section) instead of dropping the chart. Diagrams use flat fills only, no gradients.
- Generation follows the HTML skills the user will supply (the ELI5 skill and the beautiful documentation skill), and the approach described in Thariq's "unreasonable effectiveness of HTML" article and GitHub repo. Both skills may be used for any tab.

**ELI5 tab: picture first, then one critique pass**

- Each ELI5 section is built around a picture: the visual (a diagram, a short stepper, an everyday analogy, a simple chart, a photo, or one simple animation) is chosen first, and the words explain it. One idea per section, short sentences, everyday numbers, no jargon, formulas or Greek letters.
- After the first ELI5 draft, the app runs exactly one critique pass: the model revises the draft against a fixed rubric and the findings of an automatic plain-language checker. Code, not the model, decides whether the revision replaces the draft: it is kept only if it parses, keeps about the same number of sections (within one, and at least three) and at least as many visuals, keeps every figure, photo and animation of the draft, does not read worse to the checker, and adds no number that is in neither the draft nor the in depth tab. Otherwise the first draft stays. The reader never sees a warning either way.

**ASD-STE100 tab**

- ASD-STE100 (Simplified Technical English) is a controlled writing standard that began in aerospace maintenance manuals. The tab restates the in depth content under its rules: short sentences (instructions at most 20 words, descriptions at most 25), one instruction per sentence, one meaning per word, active voice.
- It is generated from the finished in depth draft only, so it adds no facts. Charts, diagrams, tables, figures, photos and animations are reused from the in depth tab unchanged; the model can only point at them, never redraw them.
- An automatic checker counts sentences that break the rules. If too many do, the app makes one repair call and keeps the repaired text only if it scores better.
- The tab opens with a short plain-text hint that explains what ASD-STE100 is. The hint also shows as the tab button's tooltip, without JavaScript, in print and in the Markdown export.
- The tab is optional: if its generation step fails, the document has no ASD-STE100 tab (never a placeholder) and is otherwise complete. The glossary and the references stay in the in depth tab.
- Accepting a merge suggestion drops the ASD-STE100 tab (keeping it would leave stale text); the version before the merge keeps it, and a rebuild recreates it.

**Animations (AI-designed, sandboxed)**

- When a document's topic has a mechanism, process, trade-off or dynamic that motion or a control makes clearer than a static chart, the model designs and writes a small interactive animation for that topic: one idea, one or two controls whose extremes show the failure modes, a visible numeric readout, and a caption that says what to try and what to notice. Gradient descent's learning rate on a loss curve is an example of the style, not a template; there are no fixed animation kinds, and an example is never reused for a different topic.
- At most one animation per section, two per tab and four per document. The ELI5 tab may have its own simpler one (one control, big shapes, an everyday analogy). The ASD-STE100 tab reuses the in depth ones as identical copies; those copies are not counted against the four-per-document cap (they never exceed the in depth tab's count), so a document can show up to six animation frames.
- The model's code runs only inside a sandboxed frame with its own strict content security policy: no network, no access to the document around it, no navigation, forms, pop-ups or storage. The app checks the code before accepting it and drops an animation that uses a forbidden capability. The real boundary is the sandbox, its policy, and a trusted shell that removes the network APIs before the model's code runs: a content security policy does not cover WebRTC, so the shell deletes the WebRTC APIs too (inside the app, WebRTC is also limited to proxied traffic).
- Every animation has a still poster image of its key insight, shown without JavaScript, in print, before the frame loads, and described in words in the Markdown export. It works in the app, in any browser from a file, in dark mode, at phone width, and honors reduced motion.

**Pictures (every tab, mainly ELI5)**

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

Any document in the Library, new or months old, can be refined in place from the viewer. Documents are never frozen: opening an older document upgrades its built-in reading features (such as the action menu) to the current ones without changing its content.

**Select and act**

- Selecting text in the viewer shows a small inline action menu anchored to the selection. Not a modal, not a new window. It never covers the selection.
- The menu is grouped so it stays short:
  - **Ask a question about this:** a one line question field with an Ask button, always visible at the top of the menu.
  - **Explain:** Expand this; This isn't clear, re explain it; Give me an analogy; Go deeper.
  - **ELI5:** Create a separate ELI5 for this section; ELI5 this selection.
  - **Edit with my note:** rewrites the section following the note (enabled once a note is typed).
- An optional one line text field lets the user add a note to the Explain, ELI5 and Edit actions.
- Everything is reachable from the keyboard; Cmd+. focuses the note, and Enter in the note opens Explain with Expand this ready, so Cmd+. then Enter twice expands the section.
- Selecting text in the body never picks up the glossary margin notes or the question of an answer box next to it, and a selection that starts inside a note stays inside that note, so each can be copied on its own.

**Ask a question**

- The reader types a question about the selected passage and presses Enter or Ask. The question is fire-and-forget like every other action: no dialog, and the reader can keep reading.
- The answer is grounded in the section and its neighbours, written in the tab's register (plain words in an ELI5 tab), and says plainly when the document does not cover something.
- The answer is added to the document as an **answer box** right after the selected passage, in the same `index.html`. Nothing else in the document changes.
- The box shows the answer. A small "?" chip on its border reveals the question that was asked and a short quote of the passage it was about. Landing on a new answer opens the question.
- Several questions about the same passage stack in the order they were asked. A follow-up can be asked by selecting text inside an answer.
- Answer boxes are part of the document: they work without JavaScript, print with the question shown, and are kept when the section is later rewritten (they move to the end of the rewritten section, still quoting the passage they were about).

**Regenerate in place**

- The app identifies the enclosing section by its stable ID, regenerates only that section with the surrounding context, and writes it back into the same `index.html`.
- The viewer refreshes and scrolls to the updated section (or to the new answer box).

**Versions**

- Every change is a version: each section action, each question asked, closing a section ELI5 tab and accepting a merge suggestion. Nothing is ever thrown away by making a change.
- Undo and Redo buttons (and Cmd+Z / Shift+Cmd+Z) in the document header step back to the previous version and forward again. A new change after an undo starts a branch; the version you left stays available, so revert is always lossless.
- A **Versions** panel (toggled from the document header, with Cmd+Y, or View > Show Versions) shows the document's history as a tree: one row per version, named by what changed ("Expanded: Why the plan matters", "Asked: pricing"), with branches indented. Clicking any version opens it and lands on the place where it changed; clicking the current version just scrolls there.
- Versions are kept per document, inside the document's folder, and travel with it to the Trash and back. Very old versions on side branches may have their saved copy removed to bound disk use; their row stays, marked "snapshot removed".
- A document edited outside the app is saved as a version on the next change.
- A document regenerated with new prompts (a rebuild) becomes a new version of the same document, shown in the Versions panel as "Rebuilt with new prompts". It keeps its identity, creation date, folder, merge history and publications. Answer boxes, the action history and section ELI5 tabs are not carried into the rebuilt version; they stay in the earlier versions, and checking out the earlier version restores the old document exactly. Rebuilding is a developer tool in this release, with no menu item.

**Section ELI5 tabs**

- "Create a separate ELI5 for this section" generates a focused ELI5 of the selected passage and adds it as a new tab to the right of the existing tabs.
- Tab label derives from the section heading (for example "ELI5: Revenue recognition"), never a number.
- Section ELI5 tabs can be closed (deleted) by the user so the tab bar does not sprawl.
- "ELI5 this selection" does the same for exactly the selected text, from one phrase to several paragraphs (also across sections): a new tab labeled by topic that starts with the passage the user asked about and explains only that.
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
      .versions/      (the document's version history; never published)
```

- `catalog.json` holds one entry per document: id, title, topic slug, created and updated timestamps, and a one or two sentence summary generated at creation.
- `meta.json` records the sources used, sources skipped, the clarifying input, the tab list, the actions taken and the questions asked.
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
4. On accept, the app weaves the new material into the existing document with one model call: it revises the sections the new material changes (they keep their identity) and inserts new sections where they read best, in both the In depth and the ELI5 tab. Existing facts stay unless the new material contradicts them, and then the text says so and names both sources. The standalone document is moved to the Trash (restorable with Put Back).
5. Every enhancement is highlighted in one distinct color, with a subtle underline and tint so color is not the only cue. Inserted words are marked inside revised passages; new sections and new blocks get a tinted rule and a "New" tag. The app computes the marks by comparing the old and new text, so they are exact. A legend at the top of the document names each merge ("Enhanced on <date> with material from <title>") with a Hide highlights toggle, and the merged-in sources appear in the references with the same swatch and "Added in merge on <date>".
6. One Undo restores the document as it was before the merge.
7. If the model call fails or the spending budget is exhausted, neither document changes, the suggestion stays, and its card says the merge failed and offers Try again. There is no fallback to appending.
8. Regenerating a section later (Expand and the other section actions) rewrites it without the old merge's marks.
9. On dismiss, both documents remain.

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
- Prompt set (power users, no UI): every prompt the app sends lives in a plain-text prompt catalogue that ships with the app. A prompt set is a folder that overrides only the files it contains; the setting `llm.promptSet` selects it (default `default`), and an unknown or broken set falls back to the default with an error in the log. The app ships the frozen baseline set `wsj-v1`, which swaps in only the earlier in depth and ELI5 prompts, so their earlier wording is one setting away; every other step still runs as in the default set (the ASD-STE100 tab and the ELI5 critique included, with their model calls), and charts are still normalized. Each document records the prompt set and a digest of the prompts that produced it. An organization overlay can override individual prompts (hook: HOOK-LLM-02).
- "Use stock photos for real-world scenes" toggle (`images.stockPhotos`, default on). An organization can lock it off.
- **Notifications** section:
  - "Notify me when a document is ready" toggle (`notifications.enabled`, default on).
  - "When I click a notification": "Open it in ELI5 Learner" (default) or "Open its published link in my browser" (`notifications.clickAction`), with a choice of which link: Most recent, Cloud drive, or GitHub Pages (`notifications.preferredLink`, default Most recent). The published link option is disabled in the public build with the note "Available when documents can be published to a cloud drive or GitHub Pages". Enterprise defaults and locking come from the overlay (hook: HOOK-UI-03).
  - "Send test notification" button.
  - A short explanation of the macOS permission and an "Open macOS notification settings" button.
- Dormant, documented keys: `llm.provider = bedrock`, `sources.mcp.url`, `publish.drive.*`, `publish.github.*` (hooks: HOOK-CFG-01, HOOK-LLM-01, HOOK-SRC-05, HOOK-PUB-01, HOOK-PUB-04).

**Out of scope for v1**

- Any authentication or login flows. In v2, the optional personal sync sign-in (below) is the only exception; authenticated sources stay out of scope.
- Speech to text and audio input (removed in all editions).
- Cloud drive, GitHub, Google Drive, and NotebookLM integrations. In v2, the user's own Google Drive is used only as the optional personal sync store, never as a publishing target; organization cloud publishing stays out of scope.
- Moving documents into other monorepo projects.

**Future enhancements**

- Side by side diff between two versions of a document.
- Google Drive publishing and NotebookLM linking.
- Choosing a destination project in the monorepo per document.
- Generation and Ask on the phone, end-to-end encrypted sync, other sync stores (a visible Drive folder, Dropbox, WebDAV), and Play Store distribution.

**Open items**

- [ ] Rebuild from the app UI (today a developer-only tool) and a first-class "rebuild" version kind, once the Android companion understands it.
- [ ] Older installed apps show documents generated by this build (new or rebuilt, all of which can have an ASD-STE100 tab) as invalid or view only; readers must run the current build before opening them.
- [ ] User to supply the ELI5 HTML skill and the beautiful documentation HTML skill.
- [ ] Define the enterprise publishing targets and repo layout.

## Optional personal sync and Android companion (v2 amendment)

Status: specified (spec/tech/16-android-companion.md). Built after v1; the cross-device Drive behavior
is unverified until the spike in 16 §13 (gate G1) passes.

v1 runs on the Mac alone. v2 adds an optional Android app and an optional personal sync that links it
to the desktop app, so the user can read their learnings on the phone and send material to the Mac
from the phone's share sheet. This is an amendment, not a quiet exception: the v1 rules above still
hold for everyone who does not turn it on.

**What it does**

- **Android app (sideloaded, not on the Play Store):** an offline Library, a read-only reader for the
  same self-contained `index.html` (all three tabs including ASD-STE100, glossary, charts, theme, sandboxed animations), import of exported documents
  with no Google setup at all, a read-only Versions view with "Make current on your Mac", a share
  sheet capture ("Send to my Mac") and an Inbox with job status.
- **Desktop:** a Settings > Sync section, Google sign-in in the system browser, a push of the Library
  to the sync store, a job inbox that feeds the existing pipeline, and a small sync indicator.
- **The Mac stays the only generator.** Documents are generated, refined, merged and reverted only on
  the Mac, with the API key in the macOS Keychain. The phone never holds an LLM key. A job sent from
  the phone is fire and forget like every other job: no question is ever asked back, failed sources
  are skipped and listed.

**Rules**

- **Opt in, off by default.** With Sync off (the default) the desktop makes no request to any Google
  endpoint, and the public build still needs nothing but an API key. "Accept jobs from phone" is a
  separate switch, also off by default.
- **The user's own Drive only.** Sync uses a hidden app folder in the user's own Google Drive, with
  the narrow `drive.appdata` permission. There is no project server, no account with the project, and
  no push service; both apps poll.
- **No secrets in the repository or the app.** The user brings their own Google Cloud OAuth clients
  (a setup guide walks through it). The desktop keeps the client and its sign-in in the Keychain; the
  Android app contains no client ID, secret or token (hook: HOOK-SYNC-02).
- **Sync is not publishing.** It never shares anything, and it does not use the publishing seam or
  the enterprise sign-in. Publishing stays user triggered.
- **Untrusted input on both ends.** The Mac treats every job from the phone as untrusted (validated,
  size-capped, rate-limited, private network addresses never fetched). The phone treats every
  document as untrusted HTML (scripts limited to the document's own, no bridge to the app).
- **Enterprise:** whether sync is allowed at all, an organization store in its place, and which
  documents must never be uploaded come from the overlay (hook: HOOK-SYNC-01).

**Privacy**

- Leaves the Mac, only with Sync on and only to the user's own Drive: the document HTML (current and
  recent versions), titles, summaries, headings, tab names, dates, folder placement, a sanitized
  version history, and job statuses.
- Never leaves the Mac: source files, clarifying input, the questions asked, source names and URLs
  in `meta.json`, API keys, tokens and logs.
- Leaves the phone: only what the user explicitly shares or asks.
- The synced copy is not end-to-end encrypted; Google can read it. The user can delete it at any time
  from Settings > Sync ("Delete cloud copy") or from Google Drive's app settings; the Mac's Library is
  not affected.

**Not in v2:** generation, Ask or section actions on the phone; the document's selection menu on the
phone; moving, archiving or renaming from the phone; "add to an existing learning" from the phone; a
second Mac that also generates; end-to-end encryption; push notifications.
