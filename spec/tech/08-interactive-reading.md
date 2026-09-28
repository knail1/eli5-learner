# Interactive reading and regenerate-in-place

This file specifies how a finished document is read and refined inside the app. It covers how the viewer embeds a document, the selection-driven inline action menu (five actions plus an optional one-line note), the bridge that carries an action from the document to the main process, how the enclosing section is found, the regenerate-in-place algorithm (context assembly, LLM call, parse → mutate → render of the document model by `SectionId`, write-back, viewer refresh and scroll), section ELI5 tabs (label, insertion, close/delete), how the same menu works inside ELI5 tabs, concurrency (one in-flight action per section), and failure handling. Undo and version history are out of scope for v1. The code lives in `src/doc-runtime/selection/` (menu and selection bridge, inlined into every document), `src/preload/doc.ts` (viewer preload), and `src/main/document/interactive/` (request handling, regenerate, tab add/remove). It implements PRD sections "Interactive reading" (all of it), "Output document" (structural requirement: stable section IDs; section ELI5 tab row), and "Build editions and swap seams" (the feature is identical in both editions).

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [09-library-storage.md](09-library-storage.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Scope and ownership

| This file owns | Owned elsewhere |
| --- | --- |
| Selection detection, action menu UI and behavior, section busy indicators (doc-runtime) | Tab bar, glossary layout, charts inside the doc-runtime ([07](07-output-document.md)) |
| `window.eli5Doc` behavior and message envelope; request validation | Channel names and the viewer `WebContentsView` setup ([01](01-architecture.md) §2, §5) |
| Section job payload, regenerate-in-place, tab add and close | Queue, lanes, job persistence, status strings ([06](06-generation-pipeline.md) §4, §6, §8.2) |
| Context assembly for section actions | Prompts, `runSectionAction`, `SectionDraft` schema ([02](02-llm-provider.md) §9, §10) |
| Orchestration of parse → mutate → render → write for section actions | `parseDocument`, `getSectionContext`, `replaceSection`, `addSectionEli5Tab`, `removeTab`, `renderDocument`, `SectionId` minting, tab labels, glossary re-anchoring ([07](07-output-document.md) §4, §8, §9.3) |
| `meta.json` tab list and action log fields written by this module | `withDocLock`, `Library.updateDocument` (atomic write, catalog `updatedAt`), `meta.json`/catalog schemas ([09](09-library-storage.md)) |
| Undo/redo requests: busy refusal, change labels, viewer refresh (§6.7) | The prior-version slot and the swap ([09](09-library-storage.md) §4.1); the header buttons ([11](11-app-shell-ui.md) §5.3) |

The feature has no edition-specific behavior and defines no private hooks. Enterprise-only UI in the app shell (publish buttons, sign-in state) is HOOK-UI-01 in [11](11-app-shell-ui.md); an enterprise LLM backend used by section actions is HOOK-LLM-01 in [02](02-llm-provider.md). Neither changes anything in this file.

## 2. Viewer embedding

The viewer is the `WebContentsView` described in [01](01-architecture.md) §2.1. This file adds these requirements:

1. **Load:** `view.webContents.loadURL('eli5doc://doc/<slug>/index.html')`. The protocol handler sets `Cache-Control: no-store` so a reload always reads the file on disk.
2. **Preload:** `src/preload/doc.ts`, with `contextIsolation: true` and `sandbox: true`. The doc-runtime runs in the page's main world and reaches the app only through `window.eli5Doc`.
3. **Navigation lock:** `will-navigate` and `will-redirect` are prevented for any URL other than the current `eli5doc://` document. In-document anchors (`#...`) are allowed. `setWindowOpenHandler` returns `{action:'deny'}`. `http`/`https` links are routed by the runtime to `eli5Doc.openExternal(url)`.
4. **Current document tracking:** main keeps `viewerState = { slug: string | null; loadSeq: number }`. `loadSeq` increments on every `loadURL` or reload, and is used to drop stale scroll requests (§7.4).
5. **Crash:** handled by [01](01-architecture.md) §9 (one reload, then an error message). After a crash reload, main re-sends busy state (§8.3).
6. **Plain-browser parity:** when the same `index.html` is opened in a browser, `window.eli5Doc` is undefined. The runtime then installs no selection listeners and shows no menu, busy styles, or tab close buttons. The document stays fully readable.

## 3. Types

```ts
// src/main/document/interactive/types.ts  (re-exported as types from src/preload/contract.ts)

export type SectionAction = 'expand' | 'reexplain' | 'analogy' | 'deeper';
export type MenuAction = SectionAction | 'eli5-tab' | 'eli5-selection';

/** Request for the four in-place actions. Channel eli5:doc:regenerate-section. */
export interface SectionActionRequest {
  slug: string;              // filled by the doc preload from the loaded URL, never by the page
  tabKey: string;            // tab that contains the section
  sectionId: SectionId;      // "sec-<tabKey>-<8 hex>"
  action: SectionAction;
  selectionText: string;     // 3..4000 chars after normalization (§5.3)
  note?: string;             // 0..200 chars, single line
}

/**
 * Channel eli5:doc:create-section-eli5. Without `scope` (or 'section') it is "Create a separate ELI5
 * for this section" (§7.1). `scope: 'selection'` is "ELI5 this selection" (§7.5): `selectionText` is
 * the whole selection (3..12,000 chars, paragraph breaks kept) and `sectionIds` lists the 1..40
 * covered sections of the tab in document order, starting with `sectionId`.
 */
export type CreateSectionEli5Request = Omit<SectionActionRequest, 'action'> & {
  scope?: 'section' | 'selection';
  sectionIds?: SectionId[];
};

/** Channel eli5:doc:close-tab. */
export interface CloseTabRequest { slug: string; tabKey: string }

/** Stored on the Job record for kind === 'section' (06 §8.2). */
export interface SectionJobPayload {
  slug: string;
  tabKey: string;
  sectionId: SectionId;
  action: MenuAction;
  selectionText: string;
  note?: string;
  sectionIds?: SectionId[];  // 'eli5-selection' only: every covered section, first = sectionId (§7.5)
  heading: string;           // source section heading at request time, for status strings
  baseHash: string;          // sectionHash(section) at request time (§6.3)
}

/** Main -> viewer events. */
export interface ScrollToEvent { sectionId?: SectionId; tabKey?: string; flash: boolean; loadSeq: number }
export interface SectionBusyEvent {
  busy: { sectionId: SectionId; action: MenuAction }[];
  notices?: { sectionId: SectionId; message: string }[]; // §9 inline notices for jobs that just failed
}
```

`SectionId`, `Tab`, `Section`, `DocumentModel`, and `SectionDraft`/`DocumentDraftTab` are defined in [07](07-output-document.md) §3 and [02](02-llm-provider.md) §10. The `SectionId` regex is not redefined here: `SECTION_ID_RE` is imported from `src/main/document/model.ts`, which holds 07's pattern `/^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/` (07 §3, §4.2). The tab key segment of a `sectionId` must equal `tabKey`.

## 4. Bridge: document to app

### 4.1 Surface

`window.eli5Doc` is the `Eli5DocApi` from [01](01-architecture.md) §5.3, exposed by `src/preload/doc.ts` through `contextBridge.exposeInMainWorld`. This file adds one event subscription:

```ts
// added to Eli5DocApi (contract.ts)
onSectionBusy(cb: (e: SectionBusyEvent) => void): () => void;   // channel eli5:doc:section-busy (M→D)
```

New channel, following [01](01-architecture.md) §5.1 conventions:

| Channel | Dir | Owner (main) | Request | Response / event payload |
| --- | --- | --- | --- | --- |
| `eli5:doc:section-busy` | M→D | document | — | `SectionBusyEvent` (full list of busy sections in the loaded document) |

### 4.2 Message envelope

The runtime and the preload exchange structured messages. v1 carries them as `contextBridge` function arguments and callbacks. The envelope is versioned so that a future host that embeds documents in an `<iframe>` can carry the same messages over `window.postMessage` without changing the runtime.

```ts
// src/doc-runtime/selection/protocol.ts
export interface DocBridgeMessage<T extends string, P> {
  source: 'eli5-doc';        // postMessage receivers ignore anything else
  v: 1;
  type: T;
  payload: P;
}
// runtime -> host: 'act' {tabKey, sectionId, action, selectionText, note?}
//                  'close-tab' {tabKey}
//                  'open-external' {url}
// host -> runtime: 'scroll-to' ScrollToEvent
//                  'section-busy' SectionBusyEvent
```

**Why not `postMessage` in v1.** Any script in the page can call `postMessage`, and the receiver cannot tell the runtime from other code. The `contextBridge` path lets the preload attach the slug itself and check user activation (§4.3). A future `postMessage` host must apply the same checks: exact `event.origin`, `event.source === frame.contentWindow`, envelope `source` and `v` match, and a per-load nonce issued by the host.

### 4.3 Preload checks (before any IPC is sent)

1. **Slug:** taken from `location.href` (`eli5doc://doc/<slug>/index.html`). Any `slug` in the page's argument is ignored.
2. **User activation:** `act` and `close-tab` require `navigator.userActivation.isActive === true` at call time. The menu click and the Enter key both provide transient activation. Without it the call resolves to `E_FORBIDDEN` and no IPC is sent. This stops a script in the document from triggering paid LLM calls on load.
3. **Shape:** the preload applies the same bounds as main's zod schema with plain checks (the sandboxed preload does not bundle `src/main`). Main re-validates anyway ([01](01-architecture.md) §5.1).
4. **Scroll buffering:** the preload keeps the most recent `scroll-to` event if the runtime has not subscribed yet, and replays it on `onScrollTo` subscription if the event's `loadSeq` matches the current load. The buffer expires after 5 s.

## 5. Selection and the inline action menu

### 5.1 Menu contents

| Order | Label (exact) | `MenuAction` | Result |
| --- | --- | --- | --- |
| 1 | Expand this | `expand` | Section replaced in place |
| 2 | This isn't clear, re-explain it | `reexplain` | Section replaced in place |
| 3 | Give me an analogy | `analogy` | Section replaced in place |
| 4 | Go deeper | `deeper` | Section replaced in place |
| 5 | Create a separate ELI5 for this section | `eli5-tab` | New tab added at the right |
| 6 | ELI5 this selection | `eli5-selection` | New tab at the right that explains exactly the selected text (§7.5) |

Actions 1 to 5 act on the start section (§5.3). Action 6 acts on the whole selection, which may be one phrase or several paragraphs across sections. When the normalized selection (§7.5) is longer than 12,000 characters, action 6 is disabled and a line under the actions reads `Too long to ELI5 as a selection (12,000 characters max)`; the other actions stay available.

Above the actions is a single-line text input, placeholder `Add a note (optional)`, max 200 characters. The menu is a small floating toolbar: not a modal, no backdrop, no new window (PRD "Select and act").

### 5.2 Showing the menu

The runtime listens for `mouseup`, `keyup` (Shift plus arrow or Home/End selection), and `selectionchange`, debounced by 150 ms:

1. `sel = document.getSelection()`. If `sel.isCollapsed` or `sel.rangeCount === 0`, hide the menu unless focus is inside it. Stop.
2. `range = sel.getRangeAt(0)`. Find the enclosing section (§5.3). If there is none, hide the menu. Stop.
3. Normalize the text (§5.3). If fewer than 3 non-whitespace characters remain, stop.
4. Take a **selection snapshot**: `{tabKey, sectionId, heading, text, rects: range.getClientRects()}`. The menu operates only on the snapshot, because clicking the note field clears the live selection.
5. Keep the passage visibly marked while the menu is open with the CSS Custom Highlight API (`CSS.highlights.set('eli5-pending', new Highlight(range))`). Remove the highlight when the menu closes.
6. Position the menu in document coordinates (it scrolls with the content), centered on the last rect of the selection, 8 px above it. Flip it below the selection if it would overlap the sticky tab bar or leave the viewport top. Clamp it horizontally with 8 px margins. On narrow widths, the menu is full width minus 16 px.
7. Do not move focus. Focus enters the menu on click, on Tab, or on the shortcut `Cmd+.`.

The menu is rendered in a closed shadow root attached to `document.body` so document CSS cannot restyle it, and it carries `data-eli5-noact` so it is never itself a selection target. It is hidden under `@media print`.

### 5.3 Finding the enclosing section

```
enclosing(range):
  a = closestSection(range.startContainer)
  b = closestSection(range.endContainer)
  if a is null: return null
  if isExcluded(range.startContainer): return null
  if b !== a: clip range end to the end of a   // multi-section selection targets the start section
  return { section: a, clippedRange }

closestSection(node):
  el = node is Element ? node : node.parentElement
  return el?.closest('section[data-section-id]') ?? null     // innermost if nested

isExcluded(node):
  closest match of: [data-eli5-noact], nav.tabbar, details.gl-note,
                    section[data-eli5-actionable='false'], header.doc-head, footer.doc-foot
```

Selectors are the markup emitted by [07](07-output-document.md) §6.1 and §9.2: the tab bar is `nav.tabbar[role=tablist]`, glossary notes are `details.gl-note`, the references section is `section[data-kind='references'][data-eli5-actionable='false']`, and the header and footer are `header.doc-head` and `footer.doc-foot`.

- The target is the innermost `section[data-section-id]` that contains the range start. [07](07-output-document.md) emits flat sections, so nesting is defensive only.
- A selection that spans sections is clipped to the start section. The menu then shows a one-line hint `Applies to: {heading}`.
- Selections inside glossary margin notes, the references section, the tab bar, the document header or footer, or the menu itself produce no menu. A note is a definition generated from the in-depth text, so rewriting it in place has no meaning; a note selection is for reading and copying only (§5.6).
- **Selected text:** the range's contents without any excluded element (the `isExcluded` list above, so glossary notes never reach the model even when a body selection spans them, §5.6) and without chart SVG marks, with block boundaries as paragraph breaks.
- **Text normalization:** the selected text of the clipped range, collapse whitespace runs to one space, trim, and cut at 4000 characters on a word boundary with a trailing `…`. The note is trimmed, newlines become spaces, and it is cut to 200 characters. Action 6 uses the unclipped selection instead (§7.5).
- `tabKey` comes from the closest `.tabpanel[data-tab-key]` ancestor of the section ([07](07-output-document.md) §6.1). It must equal the tab segment of the `sectionId`, or the menu is not shown.

### 5.4 Interaction

| Input | Behavior |
| --- | --- |
| Click an action | Submit `{snapshot, action, note}` (§5.5) |
| Enter on a focused action | Same as click |
| Enter in the note field | Move focus to the first action. It does not submit, so a half-typed note never fires the wrong action |
| Up/Down or Left/Right | Move between actions (roving tabindex, `role="toolbar"`) |
| Esc | Close the menu and restore the selection from the snapshot |
| Click outside, tab switch, or a new non-empty selection | Close (a new selection re-opens the menu for that selection) |
| Window resize or scroll | Reposition; close if the anchor rect leaves the viewport |

Accessibility: each action is a `<button>` with its exact label as the accessible name. The note input has `aria-label="Note for this action"`. The hint and the busy message use `aria-live="polite"`.

### 5.5 Submit

1. Close the menu and clear the highlight.
2. Mark the section busy locally (optimistic): add `data-eli5-busy="<action>"`, which renders a thin animated left rule plus the label `Updating…` or `Creating ELI5 tab…` (both tab actions). Pulsing is disabled under `prefers-reduced-motion`. "ELI5 this selection" marks the first covered section.
3. Call `eli5Doc.regenerateSection(...)` or `eli5Doc.createSectionEli5(...)` (with `scope: 'selection'` and `sectionIds` for action 6).
4. On `{ok:false}`, remove the busy mark and show a small inline notice under the section heading with `error.message`. The notice auto-dismisses after 6 s or on click. It is not a modal.
5. On `{ok:true}`, keep the mark. Main's `eli5:doc:section-busy` events are the source of truth from now on.

While a section is busy, selecting text in it still opens the menu, but every action is disabled and the hint reads `This section is being updated`.

### 5.6 Selection zones (glossary notes)

Glossary margin notes (`details.gl-note`, [07](07-output-document.md) §9.2) are DOM siblings of the body blocks they explain, so a plain drag through two body paragraphs would also select the note between them. The runtime keeps two self-contained selection zones. It runs in every context, in the app and in a plain browser (`src/doc-runtime/selection/zones.ts`).

- **Body zone (default).** Notes are `user-select: none`, so a selection that starts in the body never visibly includes a note. Inline glossary terms (`dfn.gl-term`) are ordinary body text and select normally.
- **Note zone.** A selection that starts inside a note stays inside that note: `html.eli5-sel-note` makes the rest of the page `user-select: none` and the active note (`[data-eli5-sel]`) selectable.
- **Which zone:** decided by where the selection starts. `mousedown` (capture, primary button) sets it before the browser starts the selection; `selectionchange` keeps it in sync with the selection's anchor for keyboard selections and restores the body zone when a selection starts elsewhere.
- **Clamp.** On `selectionchange`, a selection anchored in a note whose focus left it is cut back to the note's end (forward) or start (backward); a body selection whose focus landed inside a note is moved to just before (forward) or after (backward) that note.
- **Copy.** When a body selection spans notes, the `copy` handler writes `text/plain` and `text/html` without them. Other copies are left to the browser.
- **Select All** (`Cmd+A`, `Ctrl+A`), outside text fields and the menu: selects the visible tab panel in the body zone and the active note alone in the note zone.
- **Menu.** A selection inside a note opens no menu (§5.3). The text a body selection sends never includes notes (§5.3 "Selected text").
- The CSS rules are gated on `html.js`, so without JavaScript nothing changes; print styles are not affected.

## 6. Regenerate in place

Implemented in `src/main/document/interactive/regenerate.ts`. The four in-place actions and `eli5-tab` all run as `kind: 'section'` jobs in the Section lane ([06](06-generation-pipeline.md) §4.1, §8.2) with the reduced stage set `queued → generating → saving → done | failed`.

### 6.1 Request handling (`eli5:doc:regenerate-section`, `eli5:doc:create-section-eli5`)

1. Check that the sender is the viewer `webContents` ([01](01-architecture.md) §5.1) and that `req.slug === viewerState.slug`. Otherwise return `E_FORBIDDEN`.
   1a. **Rate limit:** at most 10 section actions per minute per document ([12](12-configuration-security.md), IPC validation rules for `eli5:doc:*`). A sliding 60 s window keyed by `slug` counts accepted requests of both channels. Excess requests return `E_RATE_LIMITED`; the runtime shows the inline notice `Too many requests; wait a moment`.
2. Validate with zod: `sectionId` matches `SECTION_ID_RE` (imported from 07, §3), its tab segment equals `tabKey`, and the text and note lengths are within §5.3 limits. For `scope: 'selection'` the text may be up to 12,000 characters and `sectionIds` must hold 1 to 40 unique IDs of the same tab starting with `sectionId`; `sectionIds` is refused without that scope. Otherwise return `E_BAD_REQUEST`.
3. Check that the document exists in the catalog ([09](09-library-storage.md)). Otherwise return `E_NOT_FOUND` "This document no longer exists".
4. **Busy check:** if `inflight.has(slug + '#' + sectionId)`, return `E_CONFLICT` "This section is already being updated".
5. Check that an API key is configured for the selected provider. Otherwise return `E_NO_API_KEY`. Checking this up front avoids queuing a job that is certain to fail.
6. Read `index.html` without the lock and run `parseDocument(html)` ([07](07-output-document.md) §8). A `DocumentFormatError` returns `E_CONFLICT` "This document can't be edited" (07: such documents stay viewable but not editable). Find the section in `model.tabs[*].sections` by `sectionId`. If it is missing, return `E_NOT_FOUND` "This section changed. Reload and try again". If its `kind` is `'references'`, return `E_BAD_REQUEST` (the runtime never offers it, §5.3). Compute `baseHash = sectionHash(section)` (§6.3) and take `heading` from `section.heading`.
   For `eli5-selection`, every ID in `sectionIds` must also be a section of that tab (`E_NOT_FOUND` "This section changed. Reload and try again" otherwise) and none may be the references section (`E_BAD_REQUEST`).
7. For `eli5-tab` and `eli5-selection`: if the model already has `MAX_SECTION_ELI5_TABS` (20, 07 §5.4) tabs of kind `section-eli5`, return `E_CONFLICT` "Close a section ELI5 tab before adding another".
8. Add the busy key to `inflight`, enqueue the job with a `SectionJobPayload`, and broadcast busy state (§8.3). Return `{jobId}`.

### 6.2 Context assembly (generating stage)

The model gets the section plus its surroundings, not the whole document ([02](02-llm-provider.md) §9 "Section actions"). All context comes from the embedded `DocumentModel` through 07's API; this module does not read section HTML.

1. Read `index.html` (no lock) and run `parseDocument(html)`. A missing file fails the job with `DOC_GONE`; a `DocumentFormatError` fails it with `INTERNAL` (detail `document_corrupt`).
2. `ctx = getSectionContext(model, sectionId)` ([07](07-output-document.md) §8). It returns `{tab, section, draft, prev?, next?, outline}`: the target and its neighbors in `SectionDraft` form (figure assets mapped back to labels), and the headings of every section in the tab. An unknown ID fails the job with `SECTION_GONE`.
3. Document framing: `model.title`, `model.dek`, and `tabKind = ctx.tab.kind` (`indepth` | `eli5` | `section-eli5`).
4. `sourceExcerpt` (only for `deeper`): if [09](09-library-storage.md) retained extracted source text for this document, take up to 6000 characters around the best lexical match for `selectionText`. Otherwise omit it.
5. **Budget:** if the target plus neighbors exceed 60% of the model's input budget (`inputBudget(limitsFor(provider, model), 0, llm.maxOutputTokens)`, [02](02-llm-provider.md) §8, read at request time), shrink each neighbor to its heading plus its first 1500 characters. If the target alone still does not fit, fail with `SECTION_TOO_LARGE` (§9).
6. Call `runSectionAction({action, tabKind, section: ctx.draft, outline: ctx.outline, prev: ctx.prev, next: ctx.next, selection: selectionText, note, sourceExcerpt, signal})`. `eli5-tab` and `eli5-selection` return a `DocumentDraftTab` of kind `section-eli5`; the other four return one `SectionDraft`. The model never returns an ID. `eli5-selection` sends `context` (§7.5) instead of `prev`/`next` and skips step 5.

**Register rules by tab kind** (sent as part of the prompt input; prompt text is in [02](02-llm-provider.md)):

| `tabKind` | Rules |
| --- | --- |
| `indepth` | WSJ register; visuals allowed; glossary re-anchoring applies (§6.5) |
| `eli5`, `section-eli5` | Plain words, no jargon, no glossary. "Go deeper" adds depth but stays at ELI5 reading level. "Create a separate ELI5" from an ELI5 tab makes an even more focused explainer of the selected passage |

### 6.3 Section hash (staleness precondition)

```ts
// src/main/document/interactive/hash.ts
export function sectionHash(section: Section): string {
  return sha256Hex(canonicalJson(section));   // sorted keys, same canonical form 07 §5.5 embeds
}
```

The hash covers the whole `Section` object (heading, blocks, `origin`, `updatedAt`, `lastAction`, merge stamp), so any mutation through 07's API changes it. It is computed from the parsed model, never from HTML bytes, so a runtime-only re-render (07 §5.5) does not invalidate pending actions.

### 6.4 Replace, render, and write (saving stage)

All of this runs inside `library.withDocLock(slug, …)` ([09](09-library-storage.md), [06](06-generation-pipeline.md) §4.2). `now` is read once from the clock at the start and passed to every mutator.

1. Re-read `index.html` from disk and run `parseDocument(html)`, giving `{model, assets}`. Other sections may have changed while the model was running, so the model from §6.2 is never reused. A missing file or catalog entry fails with `DOC_GONE`; a `DocumentFormatError` fails with `INTERNAL` (detail `document_corrupt`).
2. Find the target section by `sectionId`. If it is gone, fail with `SECTION_GONE`.
3. **Precondition:** `sectionHash(section) === baseHash`. If not, fail with `SECTION_CHANGED`. Only one action per section can be in flight (§8), so a mismatch means something outside this feature changed it, such as a hand edit. The newer content wins.
4. `{model: next, warnings} = replaceSection(model, sectionId, draft, action, now)` ([07](07-output-document.md) §8). The ID is reused unchanged, `origin` becomes `'regenerated'`, `updatedAt` and `lastAction` are set, and glossary notes of that section are re-anchored (§6.5). Warnings are logged.
5. `out = renderDocument(next, assets)`. By 07 §5.5, `out` differs from a re-render of `model` only in the target section's bytes, the embedded `#eli5-model` JSON, and `updatedAt`; everything outside that `<section>` is byte-identical.
6. Post-check: `parseDocument(out)` succeeds, the set of `SectionId`s is unchanged, and the target section equals `next`'s. A failure fails the job with `INTERNAL` (detail `document_corrupt`) and nothing is written.
7. Write back with one call: `library.updateDocument(slug, { html: out, meta: m => ({ ...m, tabs: mirrorTabs(next.tabs), actions: [...(m.actions ?? []), entry] }), label })` ([09](09-library-storage.md)). 09 performs the atomic write of `index.html` and `meta.json` and bumps the catalog `updatedAt`, and first keeps the current files as the document's single prior version (09 §4.1). `label` names the change for Undo (§6.7). `entry` is the `actions` record from §6.6. `mirrorTabs` maps each `Tab` to `{key, kind, label, sourceSectionId: origin?.sectionId, createdAt}`.
8. Release the lock, remove the busy key, broadcast busy state, and emit `eli5:doc:updated {slug, sectionId, tabKey}`.

If any step before step 7 fails, nothing is written. If `updateDocument` throws, 09 guarantees `index.html` and `meta.json` are unchanged, and the job fails with `SAVE_FAILED`.

### 6.5 Glossary re-anchoring (in-depth tab only)

Glossary notes (`details.gl-note`, [07](07-output-document.md) §9.2) are stored in `model.glossary` and are re-anchored by `replaceSection` using 07 §9.3: notes of the replaced section are kept when their `anchorText` term still appears in the new blocks and dropped otherwise. This module adds only these rules:

1. Dropped notes surface as `replaceSection` warnings and are logged as `glossary-dropped`.
2. Notes are never moved into other sections. New jargon introduced by a regeneration is not glossed in v1.
3. ELI5 and section ELI5 tabs have no notes, and a document generated with the glossary off has `glossary: []`, so there is nothing to re-anchor.

### 6.6 `meta.json` fields written here

These fields are added to the [09](09-library-storage.md) schema:

```ts
interface DocumentMetaInteractive {
  tabs: { key: string; kind: 'indepth' | 'eli5' | 'section-eli5'; label: string;
          sourceSectionId?: SectionId; createdAt?: string }[];     // mirror of DocumentModel.tabs
  actions?: { at: string; action: MenuAction; sectionId: SectionId; tabKey: string;
              sectionIds?: SectionId[];                                // eli5-selection only
              note?: string; jobId: string; resultTabKey?: string }[];  // append-only log, no content
}
```

`actions` is a log, not version history. It stores no previous content, so it cannot be used to undo. Undo uses the single prior version that 09 §4.1 keeps beside the document (§6.7).

### 6.7 Undo and redo (one prior version)

Every section action (§6.4, §7.1), tab close (§7.2) and woven merge (09 §10.6) records the document's previous `index.html` and `meta.json` as its single prior version (09 §4.1). Undo and redo swap the live files with that version. There is exactly one level: a new change after an undo replaces the slot, so redo is lost, as in a word processor.

- **Labels.** Each write passes `label` to `updateDocument`: `expanded '<heading>'`, `re-explained '<heading>'`, `added an analogy to '<heading>'`, `went deeper on '<heading>'` (heading of the target section before the change), `added ELI5 tab '<label>'`, `added ELI5 tab '<label>' for a selection` (§7.5), `closed tab '<label>'`, and 09's `merged '<source title>' in`. Names are one line and cut to 32 characters with `…`. A change without a label shows `last change`.
- **Service** (`IpcServices.docHistory`, app window only, 01 §5.2): `eli5:doc:history {slug}` returns `DocHistoryState {canUndo, canRedo, undoLabel?, redoLabel?, busy}`; `eli5:doc:undo` and `eli5:doc:redo {slug}` swap and return the new state. An unknown slug returns `E_NOT_FOUND`.
- **Refused while busy.** While any section job for the document is queued or running (any `inflight` key for the slug, §8.1), undo and redo return `E_CONFLICT` "Wait for the section update to finish" and `busy` is true. With nothing to swap they return `E_CONFLICT` "Nothing to undo" / "Nothing to redo".
- **After a swap** main emits `eli5:doc:updated {slug}` (§7.4: the viewer reloads when it shows the document), and the library's `changed` event updates the Library sidebar and the Tray.
- **`eli5:doc:history-changed {slug, state}`** (M→R) is pushed after every library `changed` event for the slug and after every change to its `inflight` keys, so the header buttons follow new changes, swaps and busy state without polling.
- The Edit menu's "Undo Document Change" / "Redo Document Change" call the same service for the document in the viewer (11 §9).

## 7. Section ELI5 tabs

### 7.1 Creation (`eli5-tab` action, saving stage)

Under the document lock, with `now` read once:

1. Re-read `index.html` and run `parseDocument`, as in §6.4 step 1. Confirm the source section still exists; if it is gone, fail with `SECTION_GONE`, because `addSectionEli5Tab` derives the tab's origin and label from it. No `baseHash` check is made: the new tab is built from the selection snapshot, so edits to the source section do not invalidate it.
2. `{model: next, tabKey: newKey} = addSectionEli5Tab(model, sectionId, selectionText, draft, now)` ([07](07-output-document.md) §8). 07 mints the tab key (`sx` + 6 hex, 07 §4.1) and a fresh `SectionId` `sec-<newKey>-<8 hex>` for each new section, and appends the tab at the right. If 07 throws `TooManyTabsError` (another `eli5-tab` job won the race after §6.1 step 7), fail with `TOO_MANY_TABS`.
3. **Label** (never a number) is computed by 07 §4.1. The expected result: `"ELI5: " + heading` of the source section, with leading numbering like `3.` or `II.` stripped; the first 6 words of `selectionText` when the heading is empty; cut to 48 characters on a word boundary with `…`, full text in the `title` attribute. Label collisions are resolved by the single rule in 07 §4.1 (currently a ` (2)`, ` (3)` suffix); this file does not define its own.
4. `out = renderDocument(next, assets)`. Post-check: `parseDocument(out)` succeeds, the new tab is last, and every pre-existing `SectionId` is unchanged.
5. `library.updateDocument(slug, { html: out, meta: m => ({ ...m, tabs: mirrorTabs(next.tabs), actions: [...(m.actions ?? []), { ...entry, resultTabKey: newKey }] }) })`.
6. Emit `eli5:doc:updated {slug, tabKey: newKey}`. The viewer activates the new tab and scrolls to its top.

### 7.2 Close (delete)

- Only `section-eli5` tabs show a close control (`button.tab-close[data-close-tab]`, `aria-label="Close tab {label}"`, 07 §6.1, §12). The in-depth and ELI5 tabs can never be closed. The runtime hides the control for them, and main refuses with `E_FORBIDDEN`.
- **Two-step inline confirm, no modal:** the first click turns the `×` into a `Delete?` pill for 3 s. A second click within that time sends `eli5Doc.closeTab(tabKey)`. Esc or a timeout reverts it.
- **Main (`eli5:doc:close-tab`)**, under the lock, with `now` read once:
  1. Check the sender and slug as in §6.1. Re-read `index.html` and run `parseDocument`. Find the tab in `model.tabs` by `tabKey`; if it is missing, return `E_NOT_FOUND`. Require `kind === 'section-eli5'`, otherwise `E_FORBIDDEN`.
  2. If any in-flight action targets a section inside this tab, return `E_CONFLICT` "Wait for the update in this tab to finish".
  3. `next = removeTab(model, tabKey, now)`, `out = renderDocument(next, assets)`, then `library.updateDocument(slug, { html: out, meta: m => ({ ...m, tabs: mirrorTabs(next.tabs), retiredIds: [...(m.retiredIds ?? []), ...closedIds] }), label: "closed tab '<label>'" })`, where `closedIds` are the tab's section IDs (07 §4.3: never reused).
  4. Emit `eli5:doc:updated {slug, tabKey: <tab to the left>}`.
- A closed tab can be brought back with Undo until the next change replaces the prior version (§6.7).

### 7.3 Actions inside ELI5 tabs

The menu, bridge, and algorithm are the same in every tab kind, including section ELI5 tabs. The only differences are the register rules in §6.2 and that §6.5 is skipped. "Create a separate ELI5 for this section" from any tab appends a new tab at the far right.

### 7.4 Viewer refresh and scroll

On `eli5:doc:updated {slug, sectionId?, tabKey?}` in main:

1. Forward the event to the app renderer, which updates the status line and Library ordering ([11](11-app-shell-ui.md)).
2. If `viewerState.slug !== slug`, stop. The user is reading something else, and the new version appears when the document is next opened.
3. If a reload of this document is already pending or loading, coalesce: the most recent target wins.
4. `loadSeq++`, then `webContents.reload()`. On `did-finish-load` with a matching `loadSeq`, send `eli5:doc:scroll-to {sectionId, tabKey, flash:true, loadSeq}`, and then send busy state (§8.3).
5. **Runtime `onScrollTo`:** activate `tabKey`, or the tab derived from `sectionId`, using the 07 tab API without adding a history entry. Wait one animation frame, then `el.scrollIntoView({block:'start'})` with `scroll-margin-top` equal to the sticky tab bar height. Flash a background highlight on the section for 1.5 s (a static outline under reduced motion). Then move focus to the section heading (`tabindex="-1"`) for screen readers.
6. If the target no longer exists (for example, the tab was closed before the reload finished), activate the first tab and do not scroll.

Scroll position elsewhere in the document is not preserved across a reload. The user asked for this section, so jumping to it is the intended result (PRD "The viewer refreshes and scrolls to the updated section").

### 7.5 ELI5 this selection (`eli5-selection`)

"ELI5 this selection" builds a focused ELI5 tab about exactly the selected text, from one phrase to several paragraphs. It reuses the section ELI5 tab flow: same channel (`createSectionEli5` with `scope: 'selection'`), Section-lane job, busy key, rate limit, tab limit, prior version for Undo, cancel and retry from the status line, and the fire-and-forget model.

1. **Runtime.** The snapshot also records the unclipped selection: its selected text (§5.3) with paragraph breaks kept (blocks joined by a blank line, spaces collapsed within a paragraph), and `sectionIds`, the start section plus every later actionable section of the same tab that holds selected text. Longer than 12,000 characters disables the action (§5.1). The job anchors to the first section: its busy key, busy mark and status heading.
2. **Context (generating stage).** From the embedded model: the covered headings (`Section: …` or `Sections: a; b`), and the block just before the selection's start and just after its end, each cut to 600 characters, located by matching the first and last 6 words of the selection against block text. When the selection cannot be located (for example, it starts in a chart), the first block of the first section stands in. The context is for grounding only.
3. **Prompt** `selection-eli5-tab` ([02](02-llm-provider.md) §9): explain exactly the selection, not the section; a short phrase gets a short explanation of that one concept, several paragraphs a plain-language walk through the passage (at most 4 sections). ELI5 skill rules, no `photo` or `figure` blocks (section-level jobs never search stock photos), a diagram only when one fits. The draft's `title` names the topic.
4. **Save** (under the lock, as §7.1): `addSectionEli5Tab(model, sectionId, selectionText, draft, now, { selectionOf: sectionIds })`. The tab is labelled `"ELI5: " + title` (first 6 words of the selection when the title is empty; collisions per 07 §4.1). Its `origin` records `scope: 'selection'`, `sectionIds`, and the selection (paragraph breaks kept, cut to 4000 characters). The tab shows `From: <source heading>` and a quote `You asked about: "…"` cut to 240 characters (07 §6.1).
5. `meta.json.actions` gets `{ action: 'eli5-selection', sectionIds, resultTabKey }`; the Undo label is `added ELI5 tab '<label>' for a selection`; the status line reads `Adding ELI5 tab for a selection: {heading}`, then `Added tab: {label}`.

The tab is an ordinary `section-eli5` tab afterwards: closable (§7.2) and every action works inside it (§7.3).

## 8. Concurrency

### 8.1 Rules

| Rule | Mechanism |
| --- | --- |
| At most one in-flight action per section, of any kind (the four in-place actions, `eli5-tab` and `eli5-selection`, which holds its first covered section) | `inflight: Set<"<slug>#<sectionId>">` in main, checked at request time (§6.1 step 4) |
| Different sections of the same document may have actions queued at the same time | Allowed; they run in Section-lane FIFO order ([06](06-generation-pipeline.md) §4.1) |
| Writes to one document never interleave | `withDocLock(slug)` around every section replace, tab add, tab close, woven merge, and create-job save |
| A stale view of the file is never written back | Re-read and `parseDocument` inside the lock, find the section by ID in the model, `baseHash` precondition (§6.3, §6.4) |
| Section jobs never wait behind create jobs | Separate Section lane |

`inflight` is rebuilt from non-terminal `section` job records at launch, so busy state survives a restart.

### 8.2 Interaction with other writers

- **Merge accept** ([09](09-library-storage.md)) that appends to this document takes the lock and adds a new section. It does not change existing sections, so pending actions still pass their precondition.
- **Merge accept that removes this document** (it was the standalone one): pending section jobs fail with `DOC_GONE` at save. Main refuses new requests for it with `E_NOT_FOUND`. If the viewer is showing it, [11](11-app-shell-ui.md) navigates to the merge target.
- **Undo / redo** (§6.7) swaps both files under `withDocLock` and is refused while any section of the document is busy, so no section job ever saves against a swapped-in version it did not read. A job requested after a swap re-reads the file and takes its `baseHash` from the swapped-in content.
- **Crash or quit mid-job:** recovery follows [06](06-generation-pipeline.md) §9.4. A resumed section job re-runs `generating` from scratch, because it has no checkpoint. This is safe because the save re-validates `baseHash`.

### 8.3 Busy broadcast

After any change to `inflight` for the document shown in the viewer, and after every `did-finish-load`, main sends `eli5:doc:section-busy` with the full list for that slug. The runtime makes the DOM match the list: it adds or removes `data-eli5-busy`, and it clears the local optimistic marks from §5.5 that are not in the list.

## 9. Failure handling

A failed section job leaves `index.html` and `meta.json` unchanged ([06](06-generation-pipeline.md) §8.2). Errors appear in two places: the status line (per 06 §6), and, if the document is still open, an inline notice on the section. Main delivers the notice in the `notices` field of the next `eli5:doc:section-busy` event (§4.1).

| Condition | Where detected | Job failure code | Status line | Inline notice |
| --- | --- | --- | --- | --- |
| No API key | §6.1 step 5 | — (request refused, `E_NO_API_KEY`) | none | `Add an API key in Settings` |
| Rate limit exceeded | §6.1 step 1a | — (`E_RATE_LIMITED`) | none | `Too many requests; wait a moment` |
| Section already busy | §6.1 step 4 | — (`E_CONFLICT`) | none | `This section is already being updated` |
| Too many section ELI5 tabs | §6.1 step 7 | — (`E_CONFLICT`) | none | `Close a section ELI5 tab before adding another` |
| Tab limit reached while queued | §7.1 step 2 | `TOO_MANY_TABS` | `Failed: too many ELI5 tabs` | `Close a section ELI5 tab before adding another` |
| Document model missing or invalid | §6.1 step 6 | — (`E_CONFLICT`) | none | `This document can't be edited` |
| Key rejected / provider down after retries | `runSectionAction` | `LLM_AUTH` / `LLM_UNAVAILABLE` | per 06 §6 | `Couldn't update this section. Try again` |
| Model output invalid after repair | `runSectionAction` | `INTERNAL` (detail `invalid_output`) | `Failed: something went wrong` | same as above |
| Target too large for the model | §6.2 step 7 | `SECTION_TOO_LARGE` | `Failed: section too long to rewrite` | `This section is too long to rewrite in one step` |
| Section removed before save | §6.4 step 2, §7.1 step 1 | `SECTION_GONE` | `Failed: section no longer exists` | none (section is gone) |
| Section changed outside the app | §6.4 step 3 | `SECTION_CHANGED` | `Failed: section changed, try again` | `This section changed. Try again` |
| Document deleted or merged away | §6.4 / lock acquisition | `DOC_GONE` | `Failed: document no longer exists` | none |
| Model invalid at save, or post-check failure | §6.4 steps 1 and 6, §7.1 step 4 | `INTERNAL` (detail `document_corrupt`) | `Failed: something went wrong` | same as above |
| Disk write failure | §6.4 step 7 (`updateDocument` throws) | `SAVE_FAILED` | per 06 §6 | `Couldn't save the change` |
| User cancels from the status line | [06](06-generation-pipeline.md) §8.1 | `CANCELLED` | `Cancelled` | busy mark removed, no notice |

`SECTION_TOO_LARGE`, `SECTION_GONE`, `SECTION_CHANGED`, `DOC_GONE`, and `TOO_MANY_TABS` are added to the `JobFailure['code']` union in [06](06-generation-pipeline.md). Retry from the status line re-issues the same `SectionJobPayload` with a fresh `baseHash` taken at retry time. Retry is disabled for `SECTION_GONE`, `DOC_GONE`, and `TOO_MANY_TABS`.

Status strings for running section jobs come from [06](06-generation-pipeline.md) §6: `Updating section: {heading}` and `Updated: {heading}`. This file proposes two more for `eli5-tab`: `Adding ELI5 tab: {heading}` and `Added tab: {label}`, and `Adding ELI5 tab for a selection: {heading}` for `eli5-selection` (which also ends with `Added tab: {label}`).

## 10. Out of scope (v1)

- **Version history beyond one step.** v1 keeps exactly one prior version per document with undo/redo (§6.7, 09 §4.1). The `actions` log in `meta.json` stores no content. Per-section history with diff and rollback is the PRD's "Future enhancements" item, and the `SectionId` scheme plus the model-based replace (07 §8) are chosen so it can be added later without format changes.
- Streaming partial section text into the viewer while the model is still writing.
- In-place actions on several sections at once, or on a selection spanning sections (it is clipped, §5.3). Only "ELI5 this selection" (§7.5) spans sections, and it adds a tab rather than rewriting them.
- Re-glossing new jargon introduced by a regeneration (§6.5).
- Actions on documents opened outside the app (plain browser: no menu, §2).

## 11. Contract with 07 (output document)

This feature depends on these guarantees from [07](07-output-document.md). They are listed here so both files agree; markup refers to 07 §6.1 and §9.2.

| # | Requirement | 07 reference |
| --- | --- | --- |
| 1 | Every `<section>` has `id` and `data-section-id` equal to the same `SectionId`, unique in the file; nothing else carries `data-section-id` | §4.2, §6.1 |
| 2 | Sections are direct, non-nested children of `div.tabpanel[data-tab-key][data-tab-kind]` | §6.1 |
| 3 | The canonical `DocumentModel` is embedded once in `<script type="application/json" id="eli5-model">`; all edits go parse → pure mutator → render | §5.5, §6.1, §8 |
| 4 | `parseDocument`, `getSectionContext`, `replaceSection`, `addSectionEli5Tab`, `removeTab`, `renderDocument` are exported, pure, and deterministic; `SECTION_ID_RE` is exported from `model.ts` | §3, §8 |
| 5 | A section mutation changes only that section's bytes, the embedded model JSON, and `updatedAt` | §5.5 |
| 6 | Tab bar is `nav.tabbar[role=tablist]`; section ELI5 close controls are `button.tab-close[data-close-tab]`, hidden unless `window.eli5Doc` exists | §6.1, §12 |
| 7 | Excluded regions: `details.gl-note`, `section[data-kind='references'][data-eli5-actionable='false']`, `header.doc-head`, `footer.doc-foot` | §6.1, §9.2 |
| 8 | The doc-runtime tab API activates a tab without a history entry and handles `onScrollTo` (07 §12 items 3 and 6) | §12 |
| 9 | Tab labels and label collisions follow one rule, owned by 07 | §4.1 |

## 12. Testing notes

Details are owned by [13](13-testing-quality.md). Minimum coverage for this module:

- **Unit (Vitest):** selection zones (§5.6: zone switching, clamping, copy without notes, Select All) and the menu text without notes; "ELI5 this selection" request bounds (runtime, preload and zod), covered-section checks, context assembly, topic label, quote, `actions` entry and Undo label; the save path re-parses and replaces only the target (bytes outside the target `<section>` and `#eli5-model` identical before and after, per 07 §5.5); `sectionHash` is stable across a runtime-only re-render and changes on any section mutation; `baseHash` mismatch fails with `SECTION_CHANGED`; invalid `#eli5-model` is refused; rate limit (11th request in 60 s returns `E_RATE_LIMITED`); `TooManyTabsError` maps to `TOO_MANY_TABS`; `meta.json` patches (`tabs`, `actions`, `retiredIds`); change labels, the busy refusal of undo/redo and the viewer refresh after a swap (§6.7); §5.3 `enclosing` on cross-section and excluded-region selections against 07's markup (jsdom).
- **Cross-browser (Chromium, WebKit):** a real mouse drag across body paragraphs next to a glossary note leaves the note out of the selection and the copied text; a drag that starts inside a note stays in it.
- **E2E (Playwright `_electron`, fake `LLMProvider`):** "ELI5 this selection" adds a topic-labelled tab quoting the selection, with its Undo label; select text, then Expand, then the section is replaced and scrolled into view while other sections are unchanged; a second action on a busy section is refused; section ELI5 tab creation, label, and close; an action inside an ELI5 tab; a failure leaves the file unchanged and shows the inline notice; a script in a document calling `eli5Doc.regenerateSection` without user activation is refused; Undo after a section action restores the original section in the saved file and the viewer, Redo brings the new text back, and a new action after an undo disables Redo.

## Acceptance criteria

- [ ] Selecting at least 3 non-whitespace characters inside a section in any tab shows the inline menu near the selection, with the six actions in the §5.1 order and the optional note field. No modal and no new window appear.
- [ ] A selection that starts in the body never includes glossary notes, visibly, in copied text, or in the text sent with an action; a selection that starts in a note stays inside that note and opens no menu (§5.6). Without JavaScript, and in print, nothing changes.
- [ ] "ELI5 this selection" on a phrase or on several paragraphs (also across sections) adds a tab at the far right labelled `ELI5: <topic>` that quotes the selection and explains only it; it is closable and undoable like a section ELI5 tab, and it is disabled past 12,000 characters (§7.5).
- [ ] Selections in glossary notes, references, the tab bar, the header, or outside any section show no menu. A cross-section selection targets the start section and shows `Applies to: {heading}`.
- [ ] Clicking the note field does not lose the target; the action uses the snapshot taken when the menu opened.
- [ ] The same `index.html` opened in Chrome, Safari, or Edge shows no menu, no close buttons, and no errors.
- [ ] The preload fills `slug` from the URL and refuses action calls made without transient user activation.
- [ ] An in-place action regenerates only the target section through parse → `replaceSection` → `renderDocument`: every byte outside that `<section>` and the embedded `#eli5-model` JSON is identical before and after, the embedded model reflects the new content, and the section keeps its `SectionId`.
- [ ] Every write goes through `library.updateDocument` under `withDocLock`. A failure at any step leaves `index.html` and `meta.json` unchanged.
- [ ] After a successful action, the viewer reloads, activates the right tab, scrolls the section under the tab bar, and briefly highlights it. If the user has switched to another document, the viewer does not reload.
- [ ] A second action on a section with an action in flight is refused with `This section is already being updated`. Actions on different sections of the same document queue and all succeed.
- [ ] A save re-reads and re-parses the file under `withDocLock`, finds the section by ID in the model, and fails with `SECTION_CHANGED` if `sectionHash` differs from the request-time hash.
- [ ] More than 10 section actions per minute on one document are refused with `E_RATE_LIMITED` and the notice `Too many requests; wait a moment`.
- [ ] "Create a separate ELI5 for this section" adds a tab at the far right labeled `ELI5: <heading>` (never a number; collisions resolved per 07 §4.1), with fresh section IDs, and records it in `meta.json.tabs`.
- [ ] Section ELI5 tabs can be deleted with the two-step inline confirm. In-depth and ELI5 tabs cannot be closed. Closing a tab with an in-flight action is refused.
- [ ] All five actions work inside the ELI5 tab and inside section ELI5 tabs, keep ELI5 register there, and never add glossary notes there.
- [ ] Glossary notes of a regenerated in-depth section are kept when their term still appears and dropped otherwise. No other section changes.
- [ ] Busy indicators match main's state after a reload, a viewer crash reload, and an app restart.
- [ ] Every failure in §9 produces the listed status line and inline notice. None of them block other jobs.
- [ ] Undo and Redo in the document header swap the single prior version (§6.7): they are disabled while a section of the document is busy (main refuses with `E_CONFLICT`), a new change after an undo drops the redo, and `meta.json.actions` stores no section content.
