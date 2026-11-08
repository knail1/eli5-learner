# Interactive reading and regenerate-in-place

This file specifies how a finished document is read and refined inside the app. It covers how the viewer embeds a document, the selection-driven inline action menu (a question field with Ask, two grouped popups with six actions, "Edit with my note", and a one-line note, optional except for "Edit with my note"), the bridge that carries an action from the document to the main process, how the enclosing section is found, the regenerate-in-place algorithm (context assembly, LLM call, parse → mutate → render of the document model by `SectionId`, write-back, viewer refresh and scroll), section ELI5 tabs (label, insertion, close/delete), the Ask flow that adds an answer box (§6.8), how the same menu works inside ELI5 tabs, concurrency (one in-flight action per section), failure handling, and the document-side half of versions: change labels, scroll targets and busy refusal for undo, redo and checkout (§6.7). The code lives in `src/doc-runtime/selection/` (menu and selection bridge, inlined into every document), `src/preload/doc.ts` (viewer preload), and `src/main/document/interactive/` (request handling, regenerate, tab add/remove). It implements PRD sections "Interactive reading" (all of it), "Output document" (structural requirement: stable section IDs; section ELI5 tab row), and "Build editions and swap seams" (the feature is identical in both editions).

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [09-library-storage.md](09-library-storage.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Scope and ownership

| This file owns | Owned elsewhere |
| --- | --- |
| Selection detection, action menu UI and behavior, section busy indicators (doc-runtime) | Tab bar, glossary layout, charts inside the doc-runtime ([07](07-output-document.md)) |
| `window.eli5Doc` behavior and message envelope; request validation | Channel names and the viewer `WebContentsView` setup ([01](01-architecture.md) §2, §5) |
| Section job payload, regenerate-in-place, tab add and close | Queue, lanes, job persistence, status strings ([06](06-generation-pipeline.md) §4, §6, §8.2) |
| Context assembly for section actions and Ask | Prompts, `runSectionAction`, `answerSectionQuestion`, `SectionDraft` and `SectionAnswerDraft` schemas ([02](02-llm-provider.md) §9, §10) |
| Orchestration of parse → mutate → render → write for section actions and Ask | `parseDocument`, `getSectionContext`, `replaceSection`, `insertAnswer`, `addSectionEli5Tab`, `removeTab`, `renderDocument`, `SectionId` and answer-box ID minting, tab labels, glossary re-anchoring, the answer-box markup ([07](07-output-document.md) §4, §6.5, §8, §9.3) |
| `meta.json` tab list, action log and ask log fields written by this module | `withDocLock`, `Library.updateDocument` (atomic write, catalog `updatedAt`), `meta.json`/catalog schemas ([09](09-library-storage.md)) |
| Versions, document side: change labels and fork metadata (`DocumentPatch.change`), scroll targets, busy refusal of undo, redo and checkout, the `retiredIds` rule at checkout, viewer refresh (§6.7) | The version store: tree, snapshots, write order, recovery, pruning ([09](09-library-storage.md) §4.1); the header buttons and the Versions panel ([11](11-app-shell-ui.md) §5.3, §5.7) |
| Runtime refresh on open (§5.1) | `renderDocument` and the bundled runtime ([07](07-output-document.md) §5.5) |

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

export type SectionAction = 'expand' | 'reexplain' | 'analogy' | 'deeper' | 'revise';
export type MenuAction = SectionAction | 'eli5-tab' | 'eli5-selection' | 'ask';
/** What last changed a section in place (07 §3 `Section.lastAction`). */
export type SectionChange = SectionAction | 'ask';

/** Request for the five in-place actions. Channel eli5:doc:regenerate-section. */
export interface SectionActionRequest {
  slug: string;              // filled by the doc preload from the loaded URL, never by the page
  tabKey: string;            // tab that contains the section
  sectionId: SectionId;      // "sec-<tabKey>-<8 hex>"
  action: SectionAction;
  selectionText: string;     // 3..4000 chars after normalization (§5.3)
  note?: string;             // 0..200 chars, single line; required (non-blank) for 'revise'
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

/**
 * Channel eli5:doc:ask-section (§6.8). `question` is 3..500 chars on one line after whitespace is
 * collapsed; `selectionText` follows the §5.3 bounds (3..4000).
 */
export interface AskSectionRequest {
  slug: string; tabKey: string; sectionId: SectionId; selectionText: string; question: string;
}

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
  question?: string;         // 'ask' only (§6.8)
  sectionIds?: SectionId[];  // 'eli5-selection' only: every covered section, first = sectionId (§7.5)
  heading: string;           // source section heading at request time, for status strings
  baseHash: string;          // sectionHash(section) at request time (§6.3)
}

/** Main -> viewer events. */
export interface ScrollToEvent {
  sectionId?: SectionId; tabKey?: string;
  anchorId?: string;         // an element inside the tab to land on instead, e.g. an answer box (§7.4)
  flash: boolean; loadSeq: number;
}
export interface SectionBusyEvent {
  busy: { sectionId: SectionId; action: MenuAction }[];
  notices?: { sectionId: SectionId; message: string }[]; // §9 inline notices for jobs that just failed
}
```

`SectionId`, `Tab`, `Section`, `DocumentModel`, and `SectionDraft`/`DocumentDraftTab` are defined in [07](07-output-document.md) §3 and [02](02-llm-provider.md) §10. The `SectionId` regex is not redefined here: `SECTION_ID_RE` is imported from `src/main/document/model.ts`, which holds 07's pattern `/^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/` (07 §3, §4.2). The tab key segment of a `sectionId` must equal `tabKey`.

## 4. Bridge: document to app

### 4.1 Surface

`window.eli5Doc` is the `Eli5DocApi` from [01](01-architecture.md) §5.3, exposed by `src/preload/doc.ts` through `contextBridge.exposeInMainWorld`. This file adds one event subscription and the Ask call:

```ts
// added to Eli5DocApi (contract.ts)
onSectionBusy(cb: (e: SectionBusyEvent) => void): () => void;   // channel eli5:doc:section-busy (M→D)
askQuestion(r: Omit<AskSectionRequest, 'slug'>): Promise<Result<{ jobId: string }>>; // eli5:doc:ask-section
```

New channels, following [01](01-architecture.md) §5.1 conventions:

| Channel | Dir | Owner (main) | Request | Response / event payload |
| --- | --- | --- | --- | --- |
| `eli5:doc:section-busy` | M→D | document | — | `SectionBusyEvent` (full list of busy sections in the loaded document) |
| `eli5:doc:ask-section` | D→M | document | `AskSectionRequest` | `{jobId}` (§6.8) |

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
//                  'ask' {tabKey, sectionId, selectionText, question}
//                  'close-tab' {tabKey}
//                  'open-external' {url}
// host -> runtime: 'scroll-to' ScrollToEvent
//                  'section-busy' SectionBusyEvent
```

**Future Android host (v2, 16 §6.3).** The Android companion's reader is a read-only host: it exposes no bridge at all (no `addJavascriptInterface`, nothing named `eli5Doc`, no `postMessage` channel), so the runtime keeps its plain-browser mode there. Section actions and Ask from the phone are not done in the page; the phone queues an `ask` job for the desktop through the sync inbox (16 §5), and only when the primary desktop lists `ask` in its `accepts`. If a later version gives the phone an in-page menu, it must use the `postMessage` path below with all of its checks, never a JavaScript interface.

**Why not `postMessage` in v1.** Any script in the page can call `postMessage`, and the receiver cannot tell the runtime from other code. The `contextBridge` path lets the preload attach the slug itself and check user activation (§4.3). A future `postMessage` host must apply the same checks: exact `event.origin`, `event.source === frame.contentWindow`, envelope `source` and `v` match, and a per-load nonce issued by the host.

### 4.3 Preload checks (before any IPC is sent)

1. **Slug:** taken from `location.href` (`eli5doc://doc/<slug>/index.html`). Any `slug` in the page's argument is ignored.
2. **User activation:** `act`, `ask` and `close-tab` require `navigator.userActivation.isActive === true` at call time. The menu click and the Enter key both provide transient activation. Without it the call resolves to `E_FORBIDDEN` and no IPC is sent. This stops a script in the document from triggering paid LLM calls on load.
3. **Shape:** the preload applies the same bounds as main's zod schema with plain checks (the sandboxed preload does not bundle `src/main`). Main re-validates anyway ([01](01-architecture.md) §5.1). For `ask` (`eli5Doc.askQuestion`), the question is 3..500 characters with no line break; the page collapses whitespace before sending.
4. **Scroll buffering:** the preload keeps the most recent `scroll-to` event if the runtime has not subscribed yet, and replays it on `onScrollTo` subscription if the event's `loadSeq` matches the current load. The buffer expires after 5 s. `anchorId` is passed through unchanged.

## 5. Selection and the inline action menu

### 5.1 Menu contents

The menu is grouped so it stays short. From top to bottom:

| Row | Control (exact label) | `MenuAction` | Result |
| --- | --- | --- | --- |
| Hint | `Applies to: {heading}` / `Updating…` / `Answering…` (`aria-live`) | — | — |
| Ask | Question field `Ask a question about this…` and button **Ask** | `ask` | Answer box inserted after the selection (§6.8) |
| Note | `Add a note (optional)`, max 200 characters | — | Sent with Explain, ELI5 and Edit actions |
| Toolbar | **Explain ▾** popup: Expand this · This isn't clear, re-explain it · Give me an analogy · Go deeper | `expand` · `reexplain` · `analogy` · `deeper` | Section replaced in place |
| Toolbar | **ELI5 ▾** popup: Create a separate ELI5 for this section · ELI5 this selection | `eli5-tab` · `eli5-selection` | New tab at the right; the selection item explains exactly the selected text (§7.5) |
| Toolbar | **Edit with my note** | `revise` | Section replaced in place, following the note |
| Cap | `Too long to ELI5 as a selection (12,000 characters max)` when it applies | — | — |

`MENU_GROUPS` in `src/doc-runtime/selection/` holds this structure; `MENU_ACTIONS` stays exported as the flattened list of the six popup labels in order, for tests. Constants: `MAX_QUESTION_CHARS = 500`, `MIN_QUESTION_CHARS = 3` (non-space).

Every action except "ELI5 this selection" acts on the start section (§5.3). "ELI5 this selection" acts on the whole selection, which may be one phrase or several paragraphs across sections. When the normalized selection (§7.5) is longer than 12,000 characters, that item is disabled and the cap line shows; the other actions stay available.

**Enable rules** (applied on open, on every input and on busy changes): while busy, every control is disabled and the fields are read-only; Ask is enabled when the question has at least 3 non-space characters; "Edit with my note" is enabled when the note is non-blank; "ELI5 this selection" is disabled when the selection is too long; a popup trigger is disabled when all of its items are.

**Ask.** The question field is separate from the note and always visible. Enter in it submits Ask (when enabled). The question is collapsed to one line and cut to 500 characters. The note is not sent with Ask. See §6.8.

**Runtime refresh on open.** Documents saved by an older build carry an older embedded runtime and so an older menu. When a document is opened in the viewer, main checks the embedded `generator.runtimeVersion`; if it is older than the bundled `DOC_RUNTIME_VERSION` and the library is writable, the document parses and no section job for it is in flight, main re-renders the same model with the bundled runtime (07 §5.5) under `withDocLock` and calls `library.refreshRuntime` (09 §4.1), which keeps the current version node and logs `document.runtime-refreshed`. It runs before the viewer loads the document and never fails the open: any failure is skipped silently and the old runtime keeps working. Every later mutation also renders with the bundled runtime when the stored one is older (§6.4 step 5), and a checkout of an old snapshot is re-rendered the same way (§6.7). A published document then shows "changed since publish" once ([10](10-publishing.md)). The runtime is never swapped at serve time.

**Edit with my note (`revise`).** The note is its only instruction. The action is disabled while the
section is busy or the note is empty or whitespace, and it enables as the note is typed; arrow-key
roving focus skips disabled actions. The note is trimmed, line breaks are collapsed, and it is cut
to 200 characters. The doc preload and main both refuse `revise` without a note as malformed
(`E_BAD_REQUEST`). The dedicated prompt `section-revise` ([02](02-llm-provider.md) §9) tells the
model to apply the note to the selected passage first and to the rest of the section only where
needed; keep everything else; use a fact the reader states but never invent others; make the
smallest change when facts are missing; not repeat neighbouring sections; keep the tone of the tab
kind; the output replaces the section; source text is untrusted data. It runs with temperature 0.3,
effort `medium`, 12,000 output tokens, the `SectionDraft` schema and the same skills as the other
section actions. Every change is a version, so Undo works as for any action (§6.7). The menu is a small floating panel: not a modal, no backdrop, no new window (PRD "Select and act").

### 5.2 Showing the menu

The runtime listens for `mouseup`, `keyup` (Shift plus arrow or Home/End selection), and `selectionchange`, debounced by 150 ms:

1. `sel = document.getSelection()`. If `sel.isCollapsed` or `sel.rangeCount === 0`, hide the menu unless focus is inside it. Stop.
2. `range = sel.getRangeAt(0)`. Find the enclosing section (§5.3). If there is none, hide the menu. Stop.
3. Normalize the text (§5.3). If fewer than 3 non-whitespace characters remain, stop.
4. Take a **selection snapshot**: `{tabKey, sectionId, heading, text, rects: range.getClientRects()}`. The menu operates only on the snapshot, because clicking the note field clears the live selection.
5. Keep the passage visibly marked while the menu is open (`selection/pending.ts`): one box per line box of each selected text run (`Range.getClientRects()` of the run, runs inside excluded regions skipped), in a body-level layer `div.eli5-pending` (`data-eli5-noact`, `aria-hidden`), placed in document coordinates and redrawn on resize. The boxes paint `--highlight` with `mix-blend-mode: darken` (light) or `lighten` (dark), so the text keeps its color and overlapping boxes do not stack. This follows the native selection's geometry in every engine (the CSS Custom Highlight API drifted from it in WebKit next to a drop cap). Remove the boxes when the menu closes.
6. Position the menu in document coordinates (it scrolls with the content), centered on the last rect of the selection, 8 px above it. Flip it below the selection if it would overlap the sticky tab bar or leave the viewport top. Clamp it horizontally with 8 px margins. On narrow widths, the menu is full width minus 16 px.
7. Do not move focus. Focus enters the menu on click, on Tab, or on the shortcut `Cmd+.` (which focuses the note).

**Popups.** The Explain and ELI5 popups (`div.pop[role=menu]`) are in-flow rows below the toolbar, not floating layers, and only one is open at a time. Their triggers are buttons with `aria-haspopup="menu"`, `aria-expanded` and `aria-controls`, and a CSS caret that turns when open (no transition under reduced motion). After any popup toggle, and whenever the hint or cap line changes height, the menu is placed again. `placeMenu` takes an optional `prefer` side: once the menu is placed above the anchor it stays above and grows upward, so opening a popup never covers the selection. No native `<select>` is used. Menu items have a minimum height of 28 px.

The menu is a dark panel in both themes. Its surface, border and shadow come from runtime-only custom properties (`--eli5-menu-bg`, `--eli5-menu-rule`, `--eli5-menu-shadow`, which reach into the shadow root): on dark paper the panel is lifted (`#2c2f35`), with a `#8a8f98` border (≥ 3:1 against the dark paper, WCAG 1.4.11) and a deeper shadow, so its edge stays visible.

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
  closest match of: [data-eli5-noact], nav.tabbar, details.gl-note, details.qa-q,
                    figure.animation, section[data-eli5-actionable='false'],
                    header.doc-head, footer.doc-foot
```

Selectors are the markup emitted by [07](07-output-document.md) §6.1, §7.1 and §9.2 (an animation's frame is a separate sandboxed document the menu never reaches): the tab bar is `nav.tabbar[role=tablist]`, glossary notes are `details.gl-note`, the references section is `section[data-kind='references'][data-eli5-actionable='false']`, and the header and footer are `header.doc-head` and `footer.doc-foot`.

- The target is the innermost `section[data-section-id]` that contains the range start. [07](07-output-document.md) emits flat sections, so nesting is defensive only.
- A selection that spans sections is clipped to the start section. The menu then shows a one-line hint `Applies to: {heading}`.
- Selections inside glossary margin notes, the question reveal of an answer box (`details.qa-q`), the references section, the tab bar, the document header or footer, or the menu itself produce no menu. A selection inside an answer's text (`.qa-a`) is allowed, so the reader can ask a follow-up; its answer is inserted after that box (§6.8). A note is a definition generated from the in-depth text, so rewriting it in place has no meaning; a note selection is for reading and copying only (§5.6).
- **Selected text:** the range's contents without any excluded element (the `isExcluded` list above, so glossary notes never reach the model even when a body selection spans them, §5.6) and without chart SVG marks, with block boundaries as paragraph breaks.
- **Text normalization:** the selected text of the clipped range, collapse whitespace runs to one space, trim, and cut at 4000 characters on a word boundary with a trailing `…`. The note is trimmed, newlines become spaces, and it is cut to 200 characters. Action 6 uses the unclipped selection instead (§7.5).
- `tabKey` comes from the closest `.tabpanel[data-tab-key]` ancestor of the section ([07](07-output-document.md) §6.1). It must equal the tab segment of the `sectionId`, or the menu is not shown.

### 5.4 Interaction

| Where | Input | Behavior |
| --- | --- | --- |
| Anywhere in the page | `Cmd/Ctrl+.` | Focus the note (focus is not moved when the menu opens) |
| Note | Enter | Open Explain and focus "Expand this". It never submits, so a half-typed note never fires the wrong action, and `Cmd+.` → Enter → Enter is Expand this |
| Note | Shift+Tab | Focus the question field |
| Question | Enter | Submit Ask if enabled, otherwise nothing (the keydown gives user activation) |
| Tab order | Tab | Question → Ask → note → toolbar (one roving stop) → the open popup |
| Toolbar | Left/Right, Home/End | Move between Explain, ELI5 and Edit with my note (roving tabindex, `role="toolbar"`, wraps, skips disabled controls) |
| Popup trigger | Enter, Space or Down | Open the popup and focus its first enabled item; Up opens it and focuses the last |
| Popup | Up/Down (wrap), Home/End | Move between items, skipping disabled ones; Enter or Space activates |
| Popup | Left/Right | Close it and move to the adjacent trigger |
| Popup | Tab | Close it |
| Popup | Esc | Close the popup and focus its trigger |
| Menu | Esc | Close the menu and restore the selection from the snapshot |
| Click an action or item | — | Submit `{snapshot, action, note}` (§5.5) |
| Click outside, tab switch, or a new non-empty selection | — | Close (a new selection re-opens the menu for that selection) |
| Window resize or scroll | — | Reposition; close if the anchor rect leaves the viewport |

Accessibility: the panel is `role="group"` labelled "Selection actions"; the toolbar is `role="toolbar"` labelled "Section actions". Each action is a `<button>` or `role="menuitem"` with its exact label as the accessible name. The question input has `aria-label="Your question about this passage"` (max 500, autocomplete off), and the button's accessible name is exactly "Ask". The note input has `aria-label="Note for this action"`. The hint and the busy message use `aria-live="polite"`.

### 5.5 Submit

1. Close the menu and clear the highlight.
2. Mark the section busy locally (optimistic): add `data-eli5-busy="<action>"`, which renders a thin animated left rule plus the label `Updating…`, `Answering…` (Ask) or `Creating ELI5 tab…` (both tab actions). Pulsing is disabled under `prefers-reduced-motion`. "ELI5 this selection" marks the first covered section.
3. Call `eli5Doc.regenerateSection(...)`, `eli5Doc.askQuestion({tabKey, sectionId, selectionText, question})`, or `eli5Doc.createSectionEli5(...)` (with `scope: 'selection'` and `sectionIds` for "ELI5 this selection"). The note is passed when non-empty, never with Ask.
4. On `{ok:false}`, remove the busy mark and show a small inline notice under the section heading with `error.message`. The notice auto-dismisses after 6 s or on click. It is not a modal. For Ask the question text is kept, because the field is cleared only after a successful dispatch.
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

Implemented in `src/main/document/interactive/regenerate.ts`. The five in-place actions, `ask`, `eli5-tab` and `eli5-selection` all run as `kind: 'section'` jobs in the Section lane ([06](06-generation-pipeline.md) §4.1, §8.2) with the reduced stage set `queued → generating → saving → done | failed`.

### 6.1 Request handling (`eli5:doc:regenerate-section`, `eli5:doc:ask-section`, `eli5:doc:create-section-eli5`)

1. Check that the sender is the viewer `webContents` ([01](01-architecture.md) §5.1) and that `req.slug === viewerState.slug`. Otherwise return `E_FORBIDDEN`.
   1a. **Rate limit:** at most 10 section actions per minute per document ([12](12-configuration-security.md), IPC validation rules for `eli5:doc:*`). A sliding 60 s window keyed by `slug` counts accepted requests of all three channels. Excess requests return `E_RATE_LIMITED`; the runtime shows the inline notice `Too many requests; wait a moment`.
2. Validate with zod: `sectionId` matches `SECTION_ID_RE` (imported from 07, §3), its tab segment equals `tabKey`, and the text and note lengths are within §5.3 limits. For `scope: 'selection'` the text may be up to 12,000 characters and `sectionIds` must hold 1 to 40 unique IDs of the same tab starting with `sectionId`; `sectionIds` is refused without that scope. For `ask-section`, the question is collapsed to one line and must be 3..500 characters with no line break. Otherwise return `E_BAD_REQUEST`.
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
2. `ctx = getSectionContext(model, sectionId)` ([07](07-output-document.md) §8). It returns `{tab, section, draft, prev?, next?, outline}`: the target and its neighbors in `SectionDraft` form (figure assets mapped back to labels; an animation ([07](07-output-document.md) §7.1) appears with its title, caption and alt and with `poster` and `js` set to the keep marker `"keep"`, so its code never goes to the model), and the headings of every section in the tab. An unknown ID fails the job with `SECTION_GONE`.
3. Document framing: `model.title`, `model.dek`, and `tabKind = ctx.tab.kind` (`indepth` | `eli5` | `ste` | `section-eli5`).
4. `sourceExcerpt` (only for `deeper`): if [09](09-library-storage.md) retained extracted source text for this document, take up to 6000 characters around the best lexical match for `selectionText`. Otherwise omit it.
5. **Budget:** if the target plus neighbors exceed 60% of the model's input budget (`inputBudget(limitsFor(provider, model), 0, llm.maxOutputTokens)`, [02](02-llm-provider.md) §8, read at request time), shrink each neighbor to its heading plus its first 1500 characters. If the target alone still does not fit, fail with `SECTION_TOO_LARGE` (§9).
6. Call `runSectionAction({action, tabKind, section: ctx.draft, outline: ctx.outline, prev: ctx.prev, next: ctx.next, selection: selectionText, note, sourceExcerpt, signal})`. `eli5-tab` and `eli5-selection` return a `DocumentDraftTab` of kind `section-eli5`; the other five return one `SectionDraft`. Ask calls `answerSectionQuestion` instead (§6.8). The model never returns an ID. A returned animation whose `poster` and `js` are `"keep"` keeps the section's existing animation (new title, caption and alt allowed; 07 §5.2); leaving it out removes it. `eli5-selection` sends `context` (§7.5) instead of `prev`/`next` and skips step 5.

**Register rules by tab kind** (sent as part of the prompt input; prompt text is in [02](02-llm-provider.md)):

| `tabKind` | Rules |
| --- | --- |
| `indepth` | WSJ register; visuals allowed; glossary re-anchoring applies (§6.5) |
| `eli5`, `section-eli5` | Plain words, no jargon, no glossary. "Go deeper" adds depth but stays at ELI5 reading level. "Create a separate ELI5" from an ELI5 tab makes an even more focused explainer of the selected passage |
| `ste` | ASD-STE100 register: short sentences, one instruction each, one meaning per word, active voice; no glossary. Until the `register-ste` prompt fragment ships, the section prompts receive `tabKind = "ste"` with no extra register text |

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
5. `out = renderDocument(next, assets, {runtime: runtimeFor(parsed)})`, where `runtimeFor` returns the bundled runtime (and sets `generator.runtimeVersion`) when the stored one is older than `DOC_RUNTIME_VERSION`, and the stored runtime otherwise (07 §5.5). Every render in this module uses it. With an up-to-date runtime, by 07 §5.5, `out` differs from a re-render of `model` only in the target section's bytes, the embedded `#eli5-model` JSON, and `updatedAt`; everything outside that `<section>` is byte-identical.
6. Post-check: `parseDocument(out)` succeeds, the set of `SectionId`s is unchanged, and the target section equals `next`'s. A failure fails the job with `INTERNAL` (detail `document_corrupt`) and nothing is written.
7. Write back with one call: `library.updateDocument(slug, { html: out, meta: m => ({ ...m, tabs: mirrorTabs(next.tabs), actions: [...(m.actions ?? []), entry] }), label, change })` ([09](09-library-storage.md)). 09 performs the atomic write of `index.html` and `meta.json` and bumps the catalog `updatedAt`, and records the new content as a version whose parent is the current version at commit time (09 §4.1). `label` names the change for Undo and the Versions panel, and `change` carries its fork metadata (§6.7). `entry` is the `actions` record from §6.6. `mirrorTabs` maps each `Tab` to `{key, kind, label, sourceSectionId: origin?.sectionId, createdAt}`.
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
  actions?: { at: string; action: LoggedAction; sectionId: SectionId; tabKey: string;
              sectionIds?: SectionId[];                                // eli5-selection only
              note?: string; jobId: string; resultTabKey?: string }[];  // append-only log, no content
}
```

```ts
// added to the 09 meta schema as an optional, loose field (no META_SCHEMA_VERSION bump, 09 §5.2)
asks?: { at: string; sectionId: SectionId; tabKey: string; question: string; // ≤500, user text like note
         qaId: string; jobId: string }[];                                   // append-only, §6.8
```

`actions[].action` keeps its strict enum of the seven logged actions (`LoggedAction = Exclude<MenuAction, 'ask'>`); Ask records go in `asks`, so builds that predate Ask still parse `meta.json`. Neither log is version history: they store no previous content. Versions are kept by 09 §4.1 (§6.7).

### 6.7 Versions

Every change to a document's html is a version (09 §4.1): each section action (§6.4, §7.1, §7.5), Ask (§6.8), tab close (§7.2), woven merge (09 §10.6) and runtime refresh (§5.1, which updates the current version rather than adding one). The library keeps a tree of versions per document; the live `index.html` and `meta.json` are always the *current* version (or a detached hand edit), and only they are served, published, edited or parsed. A new change forks from the current version, so a change made after an undo starts a sibling branch and the old future is kept. This section owns the document side: labels, fork metadata, scroll targets, busy refusal and ID retirement. The store is 09's; the header buttons and the Versions panel are 11's.

- **Labels.** Each write passes `label` to `updateDocument`: `expanded '<heading>'`, `re-explained '<heading>'`, `added an analogy to '<heading>'`, `went deeper on '<heading>'`, `edited '<heading>'` (heading of the target section before the change), `asked about '<topic>'` (§6.8), `added ELI5 tab '<label>'`, `added ELI5 tab '<label>' for a selection` (§7.5), `closed tab '<label>'`, and 09's `merged '<source title>' in`. Names are one line and cut to 32 characters with `…`. A change without a label shows `last change`. `ACTION_VERBS.ask = 'asked about'`.
- **Fork metadata.** Each write also passes `change: {kind, topic, heading?, question?, target, undoTarget, jobId?}` (`DocumentPatch.change`, 09 §9). `kind` is the `MenuAction`, `close-tab` or `merge`. `topic` is a short branch title: the section heading for rewrites, the model's topic for Ask, the new tab label for ELI5 tabs, the closed tab's label, or the merge source's title. `target` is where to land when the version is opened, and `undoTarget` where to land when it is undone: rewrites use the section for both; Ask uses `{tabKey, sectionId, anchorId: qaId}` and the section; ELI5 tabs use `{tabKey: newTab}` and the source section; tab close uses the origin section and `{tabKey: closedTab}`. A write without `change` (a hand edit seen later, an older caller) is recorded as `kind: 'outside'`.
- **Service** (`IpcServices.docHistory`, app window only, 01 §5.2):
  - `eli5:doc:history {slug}` returns `DocHistoryState {canUndo, canRedo, undoLabel?, redoLabel?, busy}`, unchanged in shape. `canUndo` means the current version's parent exists and still has a snapshot; `canRedo` means a redo child is available. Both may be true at once.
  - `eli5:doc:undo {slug}` checks out the parent; `eli5:doc:redo {slug}` checks out the redo child: the child you came back from (`forwardId`), else the newest available child. Both return the new state.
  - `eli5:doc:versions {slug}` returns the `DocVersionTree` (01 §5.3) with `busy`, `pending` rows from in-flight jobs (`{sectionId, action, heading}`), `detached`, `readOnly` and `degraded`.
  - `eli5:doc:checkout {slug, versionId}` opens any version. It is lossless: every version is kept, so there is no confirm.
  - An unknown slug returns `E_NOT_FOUND`.
- **Checkout** (also the path of undo and redo): refused while busy (below). Under `library.withDocLock(slug)`: read the target version and parse both it and the live document; compute `retiredIds = (target.retired ∪ live.retired ∪ (liveIds − targetIds)) − targetIds`, so an ID used on one branch is never reused on another (07 §4.3) and no caller has to cooperate; if the target's runtime is older than the bundled one, re-render it with the bundled runtime (same model); then `library.checkout(slug, id, {retiredIds, html?})` (09 §4.1). A target that does not parse is checked out unchanged with `retiredIds = live.retired ∪ target.retired`. Log `document.version-checkout`.
- **Scroll target.** After a checkout main emits `eli5:doc:updated {slug, ...scrollTargetFor(tree, previousId, id)}` (§7.4): when moving back to an ancestor, the `undoTarget` of the first version below it on the path; otherwise the target version's `target`; nothing for the original. So Undo lands on the change it undid. Checking out the current version writes nothing and only scrolls the viewer there (`ViewerRefresh.scrollTo`, with the current `loadSeq`).
- **Refused while busy.** While any section job for the document is queued or running (any `inflight` key for the slug, §8.1), undo, redo and checkout return `E_CONFLICT` "Wait for the section update to finish" and `busy` is true. The busy reservation is taken before any await. With no target, undo and redo return `E_CONFLICT` "Nothing to undo" / "Nothing to redo". A version whose snapshot was pruned returns `E_NOT_FOUND` "That version is no longer available"; an unreadable snapshot returns `E_IO` "That version can't be read" (09 §9).
- **After a checkout** the library's `changed` event updates the Library sidebar and the Tray.
- **`eli5:doc:history-changed {slug, state}`** and **`eli5:doc:versions-changed {slug, tree}`** (M→R) are pushed, in that order and on one serialized chain, after every library `changed` event for the slug and after every change to its `inflight` keys, so the header buttons and the Versions panel follow new changes, checkouts and busy state without polling.
- The Edit menu's "Undo Document Change" / "Redo Document Change" call the same service for the document in the viewer (11 §9).

### 6.8 Ask a question (`ask`)

Ask answers the reader's question about the selected passage and adds the answer to the document as an answer box ([07](07-output-document.md) §6.5) right after the selection. It is fire-and-forget like every other action.

1. **Request** (`eli5:doc:ask-section`, `AskSectionRequest`): handled by the same path as §6.1, as `request({...r, action: 'ask'})`: sender and slug check, the shared rate limit, the busy key `slug#sectionId`, the API-key check, parse, the section check and `baseHash`. The job payload carries `question`.
2. **Generating:** context as §6.2 (no `sourceExcerpt`). Call `answerSectionQuestion({tabKind, section, outline, prev, next, selection, question, signal})` ([02](02-llm-provider.md) §9), which returns `SectionAnswerDraft {topic, paragraphs}`. Paragraphs that read as questions to the user are dropped (07 §8 `isUserQuestion`); if none survive, the job fails with `INTERNAL` (detail `invalid_output`), like any invalid model output.
3. **Saving** (under the lock, `now` read once): re-read and re-parse; the `baseHash` precondition as §6.4 step 3 (`SECTION_CHANGED`). `afterBlock = blockIndexOfSelection(section, selectionText)` (the block holding the end of the selection). `{model: next, qaId} = insertAnswer(model, sectionId, afterBlock, {question, topic, quote, paragraphs}, now)` ([07](07-output-document.md) §8), where `quote` is an excerpt of the selection up to 160 characters. Render with `runtimeFor`, post-check as §6.4 step 6.
4. **Write:** `updateDocument` with `asks: [...(m.asks ?? []), {at, sectionId, tabKey, question, qaId, jobId}]`, label `asked about '<topic>'`, and `change: {kind: 'ask', topic, heading, question, target: {tabKey, sectionId, anchorId: qaId}, undoTarget: {tabKey, sectionId}, jobId}`.
5. **Refresh:** emit `eli5:doc:updated {slug, sectionId, tabKey, anchorId: qaId}`. The viewer lands on the new box with its question open (§7.4).
6. **Idempotence:** a recovered job whose `jobId` is already in `meta.actions` or `meta.asks` is treated as committed and does nothing.

Answers stack: a second question about the same passage goes after the earlier boxes that follow that block. A follow-up asked from inside an answer's text goes after that box. Status strings: `Answering a question: {heading}` and `Answered: {heading}` ([06](06-generation-pipeline.md) §6).

## 7. Section ELI5 tabs

### 7.1 Creation (`eli5-tab` action, saving stage)

Under the document lock, with `now` read once:

1. Re-read `index.html` and run `parseDocument`, as in §6.4 step 1. Confirm the source section still exists; if it is gone, fail with `SECTION_GONE`, because `addSectionEli5Tab` derives the tab's origin and label from it. No `baseHash` check is made: the new tab is built from the selection snapshot, so edits to the source section do not invalidate it.
2. `{model: next, tabKey: newKey} = addSectionEli5Tab(model, sectionId, selectionText, draft, now)` ([07](07-output-document.md) §8). 07 mints the tab key (`sx` + 6 hex, 07 §4.1) and a fresh `SectionId` `sec-<newKey>-<8 hex>` for each new section, and appends the tab at the right. If 07 throws `TooManyTabsError` (another `eli5-tab` job won the race after §6.1 step 7), fail with `TOO_MANY_TABS`.
3. **Label** (never a number) is computed by 07 §4.1. The expected result: `"ELI5: " + heading` of the source section, with leading numbering like `3.` or `II.` stripped; the first 6 words of `selectionText` when the heading is empty; cut to 48 characters on a word boundary with `…`, full text in the `title` attribute. Label collisions are resolved by the single rule in 07 §4.1 (currently a ` (2)`, ` (3)` suffix); this file does not define its own.
4. `out = renderDocument(next, assets, {runtime: runtimeFor(parsed)})` (§6.4 step 5). Post-check: `parseDocument(out)` succeeds, the new tab is last, and every pre-existing `SectionId` is unchanged.
5. `library.updateDocument(slug, { html: out, meta: m => ({ ...m, tabs: mirrorTabs(next.tabs), actions: [...(m.actions ?? []), { ...entry, resultTabKey: newKey }] }), label, change })`, with `change.target = {tabKey: newKey}` and `change.undoTarget` the source section (§6.7).
6. Emit `eli5:doc:updated {slug, tabKey: newKey}`. The viewer activates the new tab and scrolls to its top.

### 7.2 Close (delete)

- Only `section-eli5` tabs show a close control (`button.tab-close[data-close-tab]`, `aria-label="Close tab {label}"`, 07 §6.1, §12). The in-depth, ELI5 and ASD-STE100 tabs can never be closed. The runtime hides the control for them, and main refuses with `E_FORBIDDEN`.
- **Two-step inline confirm, no modal:** the first click turns the `×` into a `Delete?` pill for 3 s. A second click within that time sends `eli5Doc.closeTab(tabKey)`. Esc or a timeout reverts it.
- **Main (`eli5:doc:close-tab`)**, under the lock, with `now` read once:
  1. Check the sender and slug as in §6.1. Re-read `index.html` and run `parseDocument`. Find the tab in `model.tabs` by `tabKey`; if it is missing, return `E_NOT_FOUND`. Require `kind === 'section-eli5'`, otherwise `E_FORBIDDEN`.
  2. If any in-flight action targets a section inside this tab, return `E_CONFLICT` "Wait for the update in this tab to finish".
  3. `next = removeTab(model, tabKey, now)`, `out = renderDocument(next, assets)`, then `library.updateDocument(slug, { html: out, meta: m => ({ ...m, tabs: mirrorTabs(next.tabs), retiredIds: [...(m.retiredIds ?? []), ...closedIds] }), label: "closed tab '<label>'", change: {kind: 'close-tab', topic: <label>, target: <origin section>, undoTarget: {tabKey}} })`, where `closedIds` are the tab's section IDs (07 §4.3: never reused). The render uses `runtimeFor` (§6.4 step 5).
  4. Emit `eli5:doc:updated {slug, tabKey: <tab to the left>}`.
- A closed tab can be brought back with Undo, or by opening an earlier version in the Versions panel, at any time (§6.7).

### 7.3 Actions inside ELI5 tabs

The menu, bridge, and algorithm are the same in every tab kind, including section ELI5 tabs. The only differences are the register rules in §6.2 and that §6.5 is skipped. "Create a separate ELI5 for this section" from any tab appends a new tab at the far right.

### 7.4 Viewer refresh and scroll

On `eli5:doc:updated {slug, sectionId?, tabKey?, anchorId?}` in main:

1. Forward the event to the app renderer, which updates the status line and Library ordering ([11](11-app-shell-ui.md)).
2. If `viewerState.slug !== slug`, stop. The user is reading something else, and the new version appears when the document is next opened.
3. If a reload of this document is already pending or loading, coalesce: the most recent target wins.
4. `loadSeq++`, then `webContents.reload()`. On `did-finish-load` with a matching `loadSeq`, send `eli5:doc:scroll-to {sectionId, tabKey, anchorId, flash:true, loadSeq}`, and then send busy state (§8.3).
5. **Runtime `onScrollTo`:** activate `tabKey`, or the tab derived from `sectionId`, using the 07 tab API without adding a history entry. Wait one animation frame, then `el.scrollIntoView({block:'start'})` with `scroll-margin-top` equal to the sticky tab bar height. Flash a background highlight on the section for 1.5 s (a static outline under reduced motion). Then move focus to the section heading (`tabindex="-1"`) for screen readers.
   **Anchor:** if `anchorId` resolves to an element inside the activated tab, land on it instead: `scrollIntoView({block:'center'})`, add the flash class (`.eli5-flash`, generalized from sections), open its `details.qa-q` when it is an answer box, and focus it (`tabIndex = -1`). A missing anchor falls back to the section. Runtimes older than 1.1.0 ignore `anchorId`.
6. If the target no longer exists (for example, the tab was closed before the reload finished), activate the first tab and do not scroll.

Scroll position elsewhere in the document is not preserved across a reload. The user asked for this section, so jumping to it is the intended result (PRD "The viewer refreshes and scrolls to the updated section").

### 7.5 ELI5 this selection (`eli5-selection`)

"ELI5 this selection" builds a focused ELI5 tab about exactly the selected text, from one phrase to several paragraphs. It reuses the section ELI5 tab flow: same channel (`createSectionEli5` with `scope: 'selection'`), Section-lane job, busy key, rate limit, tab limit, versions for Undo, cancel and retry from the status line, and the fire-and-forget model.

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
| At most one in-flight action per section, of any kind (the five in-place actions, `ask`, `eli5-tab` and `eli5-selection`, which holds its first covered section) | `inflight: Set<"<slug>#<sectionId>">` in main, checked at request time (§6.1 step 4) |
| Different sections of the same document may have actions queued at the same time | Allowed; they run in Section-lane FIFO order ([06](06-generation-pipeline.md) §4.1) |
| Writes to one document never interleave | `withDocLock(slug)` around every section replace, answer insert, tab add, tab close, woven merge, checkout, runtime refresh, and create-job save |
| A stale view of the file is never written back | Re-read and `parseDocument` inside the lock, find the section by ID in the model, `baseHash` precondition (§6.3, §6.4) |
| Section jobs never wait behind create jobs | Separate Section lane |

`inflight` is rebuilt from non-terminal `section` job records at launch, so busy state survives a restart.

### 8.2 Interaction with other writers

- **Merge accept** ([09](09-library-storage.md)) that appends to this document takes the lock and adds a new section. It does not change existing sections, so pending actions still pass their precondition. It creates a `merge` version; reverting past it restores the pre-merge document.
- **Merge accept that removes this document** (it was the standalone one): pending section jobs fail with `DOC_GONE` at save. Main refuses new requests for it with `E_NOT_FOUND`. If the viewer is showing it, [11](11-app-shell-ui.md) navigates to the merge target.
- **Undo, redo and checkout** (§6.7) write both files under `withDocLock` and are refused while any section of the document is busy, so no section job ever saves against a checked-out version it did not read. A job requested after a checkout re-reads the file and takes its `baseHash` from the checked-out content; a job enqueued just before one fails with `SECTION_CHANGED` as usual. The parent of the new version is resolved at commit time.
- **Runtime refresh on open** (§5.1) is skipped while any section of the document is busy, and does not change the model, so `baseHash` values stay valid.
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
| Model output invalid after repair, or an Ask answer with no usable paragraph | `runSectionAction`, `answerSectionQuestion`, §6.8 step 2 | `INTERNAL` (detail `invalid_output`) | `Failed: something went wrong` | same as above |
| Question empty, too short, too long or multi-line | §6.1 step 2, preload §4.3 | — (`E_BAD_REQUEST`) | none | none (Ask stays disabled) |
| Target too large for the model | §6.2 step 7 | `SECTION_TOO_LARGE` | `Failed: section too long to rewrite` | `This section is too long to rewrite in one step` |
| Section removed before save | §6.4 step 2, §7.1 step 1 | `SECTION_GONE` | `Failed: section no longer exists` | none (section is gone) |
| Section changed outside the app | §6.4 step 3 | `SECTION_CHANGED` | `Failed: section changed, try again` | `This section changed. Try again` |
| Document deleted or merged away | §6.4 / lock acquisition | `DOC_GONE` | `Failed: document no longer exists` | none |
| Model invalid at save, or post-check failure | §6.4 steps 1 and 6, §7.1 step 4 | `INTERNAL` (detail `document_corrupt`) | `Failed: something went wrong` | same as above |
| Disk write failure | §6.4 step 7 (`updateDocument` throws) | `SAVE_FAILED` | per 06 §6 | `Couldn't save the change` |
| User cancels from the status line | [06](06-generation-pipeline.md) §8.1 | `CANCELLED` | `Cancelled` | busy mark removed, no notice |
| Undo, redo or checkout while a section is busy | §6.7 | — (`E_CONFLICT`) | none | inline in the Versions panel or header: `Wait for the section update to finish` |
| Version snapshot pruned, or unreadable | §6.7, 09 §4.1 | — (`E_NOT_FOUND` / `E_IO`) | none | inline in the Versions panel: `That version is no longer available` / `That version can't be read` |
| Version snapshot could not be saved | 09 §4.1 step 3 | — (the change itself succeeds) | none | Versions panel banner: `Version history couldn't be saved for the last change.` |

`SECTION_TOO_LARGE`, `SECTION_GONE`, `SECTION_CHANGED`, `DOC_GONE`, and `TOO_MANY_TABS` are added to the `JobFailure['code']` union in [06](06-generation-pipeline.md). Retry from the status line re-issues the same `SectionJobPayload` with a fresh `baseHash` taken at retry time. Retry is disabled for `SECTION_GONE`, `DOC_GONE`, and `TOO_MANY_TABS`.

Status strings for running section jobs come from [06](06-generation-pipeline.md) §6: `Updating section: {heading}` and `Updated: {heading}`, and for Ask `Answering a question: {heading}` and `Answered: {heading}`. This file proposes two more for `eli5-tab`: `Adding ELI5 tab: {heading}` and `Added tab: {label}`, and `Adding ELI5 tab for a selection: {heading}` for `eli5-selection` (which also ends with `Added tab: {label}`).

## 10. Out of scope (v1)

- **Diffs between versions.** Versions can be opened and stepped through (§6.7), but there is no side-by-side diff (PRD "Future enhancements"). The `actions` and `asks` logs in `meta.json` store no content.
- Editing or deleting a single answer box. A box goes away only by opening an earlier version.
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
| 4 | `parseDocument`, `getSectionContext`, `replaceSection`, `insertAnswer`, `addSectionEli5Tab`, `removeTab`, `renderDocument` are exported, pure, and deterministic; `SECTION_ID_RE` is exported from `model.ts` | §3, §8 |
| 5 | A section mutation changes only that section's bytes, the embedded model JSON, and `updatedAt` (when the stored runtime is current; an older one is upgraded, §5.5) | §5.5 |
| 6 | Tab bar is `nav.tabbar[role=tablist]`; section ELI5 close controls are `button.tab-close[data-close-tab]`, hidden unless `window.eli5Doc` exists | §6.1, §12 |
| 7 | Excluded regions: `details.gl-note`, `details.qa-q`, `section[data-kind='references'][data-eli5-actionable='false']`, `header.doc-head`, `footer.doc-foot` | §6.1, §9.2 |
| 8 | The doc-runtime tab API activates a tab without a history entry and handles `onScrollTo` (07 §12 items 3 and 6) | §12 |
| 9 | Tab labels and label collisions follow one rule, owned by 07 | §4.1 |
| 10 | Answer boxes are `aside.qa[id^=q-]` inside a section, with the question in `details.qa-q`; they carry no `data-section-id` and are never sent to the model | §6.5, §8 |

## 12. Testing notes

Details are owned by [13](13-testing-quality.md). Minimum coverage for this module:

- **Unit (Vitest):** selection zones (§5.6: zone switching, clamping, copy without notes, Select All) and the menu text without notes; "ELI5 this selection" request bounds (runtime, preload and zod), covered-section checks, context assembly, topic label, quote, `actions` entry and Undo label; the save path re-parses and replaces only the target (bytes outside the target `<section>` and `#eli5-model` identical before and after, per 07 §5.5); `sectionHash` is stable across a runtime-only re-render and changes on any section mutation; `baseHash` mismatch fails with `SECTION_CHANGED`; invalid `#eli5-model` is refused; rate limit (11th request in 60 s returns `E_RATE_LIMITED`); `TooManyTabsError` maps to `TOO_MANY_TABS`; `meta.json` patches (`tabs`, `actions`, `retiredIds`); change labels and fork metadata, the busy refusal of undo/redo/checkout, the `retiredIds` rule, scroll targets and the viewer refresh after a checkout (§6.7); the Ask branch (asks entry, `anchorId` event, label, `SECTION_CHANGED`, idempotence by `jobId`) and the `runtimeFor` rule; runtime refresh on open skips busy, read-only and unparseable documents; the grouped menu (triggers, items in order, enable rules, keyboard table §5.4, Esc layering, `placeMenu` `prefer`); `anchorId` scroll opens and focuses an answer box; §5.3 `enclosing` on cross-section and excluded-region selections against 07's markup (jsdom).
- **Cross-browser (Chromium, WebKit):** a real mouse drag across body paragraphs next to a glossary note leaves the note out of the selection and the copied text; a drag that starts inside a note stays in it.
- **E2E (Playwright `_electron`, fake `LLMProvider`):** "ELI5 this selection" adds a topic-labelled tab quoting the selection, with its Undo label; select text, then Expand, then the section is replaced and scrolled into view while other sections are unchanged; a second action on a busy section is refused; section ELI5 tab creation, label, and close; an action inside an ELI5 tab; a failure leaves the file unchanged and shows the inline notice; a script in a document calling `eli5Doc.regenerateSection` without user activation is refused; Undo after a section action restores the original section in the saved file and the viewer, Redo brings the new text back; Ask adds an answer box and lands on it (E19); a new action after an undo creates a branch shown in the Versions panel (E20); opening an older version lands on the change (E21); Forward follows the last-visited child (E22); checkout while busy is refused inline (E23); an older document gets the new menu after open (E24) ([13](13-testing-quality.md) §8.2).

## Acceptance criteria

- [ ] Selecting at least 3 non-whitespace characters inside a section in any tab shows the inline menu near the selection, grouped as in §5.1: the question field with Ask, the optional note field, and the toolbar Explain ▾, ELI5 ▾ and Edit with my note, whose popups list the six actions in order. "Edit with my note" is disabled until the note has non-blank text, and `revise` without a note is refused with `E_BAD_REQUEST`. No modal and no new window appear, and opening a popup never covers the selection.
- [ ] Every control is reachable from the keyboard per §5.4; `Cmd+.` → Enter → Enter runs Expand this.
- [ ] Asking a question inserts an answer box after the selected passage and changes nothing else in the document (when the runtime is current); the viewer lands on it with the question open; `meta.json.asks` records it; questions shorter than 3 or longer than 500 characters are refused (§6.8).
- [ ] Opening a document saved with an older runtime gives it the current menu without changing its model (§5.1).
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
- [ ] The five in-place actions and `eli5-tab` work inside the ELI5 tab and inside section ELI5 tabs, keep ELI5 register there, and never add glossary notes there.
- [ ] Glossary notes of a regenerated in-depth section are kept when their term still appears and dropped otherwise. No other section changes.
- [ ] Busy indicators match main's state after a reload, a viewer crash reload, and an app restart.
- [ ] Every failure in §9 produces the listed status line and inline notice. None of them block other jobs.
- [ ] Every change is a version (§6.7): Undo and Redo step through them and land on the change; a new change after an undo starts a branch and keeps the old one; any version can be opened from the Versions panel; undo, redo and checkout are refused with `E_CONFLICT` while a section of the document is busy; section IDs are never reused across branches; and `meta.json.actions` and `asks` store no section content.
