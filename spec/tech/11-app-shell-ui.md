# App shell and UI

This file specifies everything the user sees and touches outside the generated document itself:
the main window lifecycle (closing hides, quitting happens only from the menu bar item), the menu
bar (Tray) item with the last three finished documents, the main window layout (Library sidebar,
viewer slot, input zone, status area, suggestions area), the settings screen, the native macOS
completion notification (§14), keyboard shortcuts, empty states, and accessibility. It fixes the
renderer component tree in `src/renderer/`, the window, Tray, and notification code in
`src/main/shell/`, and the gating of enterprise-only UI (HOOK-UI-01). It
does not cover the content or runtime of the document shown in the viewer (07, 08), how inputs are
resolved (03), or how status strings are produced (06).

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) ·
[03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) ·
[05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) ·
[07-output-document.md](07-output-document.md) · [08-interactive-reading.md](08-interactive-reading.md) ·
[09-library-storage.md](09-library-storage.md) · [10-publishing.md](10-publishing.md) ·
[12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

PRD sections implemented: *App shell and layout* (all of it), *Processing pipeline* (status line
presentation, "no modals", completion notification), *Library, storage, and merge
suggestions* (sidebar and suggestions presentation), *Build editions and swap seams* (enterprise UI
hidden in the public build), *Configuration, scope, and open items* (settings screen).

## 1. Principles

1. **Fire and forget.** Nothing in the ingest and generation flow opens a modal, sheet, alert,
   or secondary window. Every message is inline in the window (PRD *App shell and layout*,
   *Processing pipeline*). The single exception outside the window is one native macOS notification
   when a create job finishes and a new document is in the Library (§14). It never takes focus and
   is off when the user disables it in Settings > Notifications. Failures, section regenerations,
   merges, and publishes stay inline.
2. **The app outlives its window.** The Tray item is the app's anchor. Jobs keep running while the
   window is hidden.
3. **The renderer is a view.** It holds only view state (route, draft inputs, focus). Documents,
   jobs, suggestions, and settings come from main over the IPC channels in 01 §5.2 and are
   re-rendered on the matching change events.
4. **No raw HTML.** The viewer shows the rendered document only (PRD *Main area, Viewer*).
5. **Keyboard first, accessible by default.** Every action is reachable without a pointer.
6. **Typed input only.** No audio input or speech to text in any edition (PRD *App shell and
   layout*; out of scope). The input zone has no microphone control, the app requests no microphone
   permission (the session permission handler denies `media`, 12 §7.3), and the packaged Info.plist
   omits `NSMicrophoneUsageDescription`. Clarifying input is typed only.

## 2. Code layout

| Path | Process | Contents |
| --- | --- | --- |
| `src/main/shell/window.ts` | main | Main `BrowserWindow` creation, close-to-hide, bounds persistence, Dock visibility |
| `src/main/shell/tray.ts` | main | Tray item, menu model, rebuild on change events |
| `src/main/shell/app-menu.ts` | main | macOS application menu and accelerators |
| `src/main/shell/lifecycle.ts` | main | Single-instance lock, `activate`, quit flag |
| `src/main/shell/viewer.ts` | main | The `WebContentsView` viewer: bounds, visibility, load by slug |
| `src/main/shell/notifications.ts` | main | Completion notification: `createNotifier`, click routing, reference retention (§14) |
| `src/main/shell/find.ts` | main | Find in document: `findInPage` on the viewer, results and resets to the app (§5.3) |
| `src/renderer/App.tsx` | renderer | Top-level layout grid and route switch |
| `src/renderer/library/` | renderer | `LibrarySidebar`, `LibraryItem`, `LibraryFilter` |
| `src/renderer/viewer/` | renderer | `ViewerSlot`, `DocHeader`, `HistoryButtons`, `FindBar`, `ViewerEmpty`, `VersionTreePanel`, `version-tree-layout.ts` (pure tree layout), `PanelHandle` |
| `src/renderer/input/` | renderer | `InputZone`, `DropBox`, `SourceChip`, `UrlField`, `ClarifyField`, `GlossaryToggle` |
| `src/renderer/status/` | renderer | `StatusArea`, `JobLine` |
| `src/renderer/suggestions/` | renderer | `SuggestionsPanel`, `SuggestionCard` |
| `src/renderer/settings/` | renderer | `SettingsScreen` and its sections |
| `src/renderer/edition/` | renderer | `useEdition()`, `<FeatureGate>` (HOOK-UI-01) |
| `src/renderer/a11y/` | renderer | Focus regions, live region announcer, shortcut registry |

## 3. Window lifecycle

### 3.1 Main window

```ts
// src/main/shell/window.ts
export interface WindowState {
  x?: number; y?: number;
  width: number;            // default 1280, min 900
  height: number;           // default 820, min 600
  maximized: boolean;
  sidebarWidth: number;     // default 272, clamp 200..420
  sidebarCollapsed: boolean;
}
```

- Created once at startup (01 §6.3 step 6), after IPC handlers are registered. Options: `show:
  false`, `titleBarStyle: 'hiddenInset'`, `backgroundColor` matching the current theme, security
  baseline from 01 §2.2. Shown on `ready-to-show` to avoid a white flash.
- Bounds and sidebar state persist to `<userData>/window-state.json` (debounced 500 ms on
  `resize`, `move`, and sidebar changes). This is view state, not `Settings`. On load, if the saved
  rectangle does not intersect any current display's work area by at least 100×100 px, fall back to
  the default size centered on the primary display. A corrupt file is ignored and overwritten.
- There is exactly one main window. The app never opens a second app window (settings is an
  in-window screen, §7).

### 3.2 Close hides, quit only from the menu bar item

The flag `shell.isQuitting` (module-level boolean, initially `false`) decides whether a window close
is a hide or a real close.

1. **Window `close` event.** If `isQuitting` is `false`: `event.preventDefault()`, `win.hide()`,
   then `app.dock.hide()`. Jobs are unaffected (06 §4.3).
2. **`window-all-closed`.** Handler present and empty, so Electron never auto-quits.
3. **Tray > Quit.** Set `isQuitting = true`, then `app.quit()`. No confirmation (06 §4.3); active
   jobs resume on next launch and the label says so (§4.2).
4. **`before-quit`.** Set `isQuitting = true`. This covers terminations the OS starts (log out,
   restart, shut down, an installer). The app never calls `preventDefault()` on `before-quit`,
   so it never blocks a system shutdown.
5. **Application menu.** The standard `role: 'quit'` item is **omitted**. `Cmd+Q` is bound to *Close
   Window* (hide), with the menu label "Close Window" and a secondary hint "Quit from the menu bar
   icon" shown as a disabled item beneath it. `Cmd+W` does the same.
6. **Show.** `showMainWindow()` calls `app.dock.show()`, then `win.show()` and `win.focus()`. It is
   called from Tray *Open ELI5 Learner*, a Tray document entry, a clicked Dock icon (`activate`),
   `second-instance`, and a clicked completion notification (§14.4). If the window was destroyed
   (for example after a renderer crash recovery), it is recreated first.
7. **Single instance.** `app.requestSingleInstanceLock()`. If the lock fails, exit immediately. The
   running instance receives `second-instance` and shows its window.
8. **First launch.** The window is shown. Later launches also show the window, because launching
   the app is an explicit request to see it. Launch at login is out of scope for v1.

Edge cases:

- **Dock icon Quit while the window is visible.** macOS routes it through `before-quit`, which the
  app does not block (step 4). This is the only non-Tray user quit path. It is accepted so the app
  never interferes with OS-level termination. The Dock icon is hidden whenever the window is hidden,
  which makes this path rare.
- **Keychain prompt in dev builds.** Unsigned or ad-hoc signed dev builds trigger a macOS Keychain
  access dialog after each rebuild, which would be a modal mid-job. Dev builds therefore default to
  `ELI5_KEYSTORE=memory` or sign locally with a stable development identity (12 §6.2). Packaged
  builds are signed, so the prompt does not recur.
- **Hidden window and viewer.** The viewer `WebContentsView` stays attached while hidden, so
  reopening is instant and scroll position is kept.
- **Renderer crash** (`render-process-gone`): reload the renderer once. A second crash within 60 s
  shows an inline error page in the window ("Something went wrong. Reload"). Jobs in main are
  unaffected. The page is a script-free `data:` page; a fragment link never navigates there, so
  Reload links to the sentinel `https://eli5-learner.invalid/reload`, which every navigation guard
  refuses and main turns into a reload. A second viewer crash within 60 s shows "Could not
  display this document." with a Retry link back to the document (§8).

## 4. Menu bar item (Tray)

### 4.1 Menu model

```ts
// src/main/shell/tray.ts
export interface TrayEntry { slug: string; label: string }   // label truncated to 40 chars + "…"
export interface TrayModel {
  recent: TrayEntry[];          // 0..3, finished documents only, newest first
  activeJobs: number;           // queued + running, create and section jobs
}
export function buildTrayMenu(m: TrayModel, edition: EditionInfo): Electron.Menu;
```

Menu, top to bottom:

| Item | Present when | Action |
| --- | --- | --- |
| Up to 3 recent documents (catalog `title`) | `recent.length > 0` | `showMainWindow()`, then `viewer.open(slug)` and emit `eli5:app:navigate {route: {view:'doc', slug}}` |
| "No documents yet" (disabled) | `recent.length === 0` | none |
| separator | always | |
| "{n} job(s) running" (disabled) | `activeJobs > 0` | none |
| Open ELI5 Learner | always | `showMainWindow()` |
| Settings… | always | `showMainWindow()` + navigate to `{view:'settings'}` |
| separator | always | |
| Quit / Quit ({n} jobs will resume) | always | §3.2 step 3 |

- `recent` is the first three `CatalogEntry` items of the catalog in Library order (§5.2) that are
  not archived (09 §4.2, from the `eli5:library:organization-changed` placements). Only finished
  documents are in the catalog (09), so sessions, sources, failed jobs and trashed documents never
  appear (PRD *Menu bar item*).
- Icon: a monochrome template image (`trayTemplate.png`, `@2x`) so macOS tints it for light and dark
  menu bars: "eli5" in a thin font inside a thin oval, 32×18 pt. While `activeJobs > 0` the icon swaps
  to `trayBusyTemplate.png` (the same mark with a dot on the oval's upper right). Regenerate both
  with `npx electron scripts/generate-tray-icons.cjs`. This is the only "busy" signal outside the
  window. The only native notification is the completion notification for a finished document
  (§14); there is none for jobs starting or running.
- Tooltip: "ELI5 Learner" or "ELI5 Learner — {n} job(s) running".
- Clicking the icon opens the menu (`tray.setContextMenu`). There is no separate click action.

### 4.2 Rebuild triggers

Rebuild the menu (it is cheap and synchronous) on `eli5:library:changed`,
`eli5:library:organization-changed` (archive and unarchive), on `eli5:jobs:changed` when the active
count changes, and at startup. A newly finished document appears automatically
because the pipeline emits `eli5:library:changed` on `done` (06 §5). A merge accept that removes a
standalone document (09) also rebuilds, so a removed document never lingers in the menu.

Edge cases: a Tray entry whose slug no longer exists (race with a merge) opens the window and shows
the "document not found" viewer state (§8). Titles with control or bidi characters are stripped
before display.

## 5. Main window layout

### 5.1 Regions

```
┌─────────────────┬────────────────────────────────────────────────────┐
│ LIBRARY         │ DocHeader: title · ↶ ↷ Versions · Reveal · [pub]*  │
│ [filter      ]  ├──────────────────────────────────┬─────────────────┤
│ ● Topic A  2m   │                                  ┆ VERSIONS (opt.) │
│   Topic B  3d   │   ViewerSlot (WebContentsView)   ┆ ● Original      │
│   Topic C  1w   │                                  ┆ │ Expanded …    │
│   …             │                                  ┆ ├ Asked …       │
│─────────────────│                                  ┆                 │
│ SUGGESTIONS (1) ├──────────────────────────────────┬─────────────────┤
│ Related to X…   │ INPUT ZONE                       │ STATUS          │
│ [Merge in][Keep]│ [chip][chip]  drop / paste here  │ ◌ Reading (2/5) │
│─────────────────│ URL: [                        ]  │ ✓ Done: Topic A │
│ ⚙ Settings      │ Specifics: [                  ]  │                 │
│ [signed-in]*    │ [x] Explain terms [Clear][Start] │                 │
└─────────────────┴──────────────────────────────────┴─────────────────┘
(the line above the input zone and status area is the resize handle; the top-status holder sits at
 the top right of the title strip; ┆ is the Versions panel's resize handle, shown only while the
 panel is open)
* rendered only when HOOK-UI-01 features are enabled
```

CSS grid: `grid-template-columns: var(--sidebar-w) 1fr; grid-template-rows: auto 1fr auto`. The
main column has three rows: viewer, the resize handle, and the bottom panel. The bottom panel is
itself a two-column grid: input zone `1fr`, status area `minmax(260px, 30%)`, which keeps the
status area in the lower right (PRD *Status area*).

**Resizable bottom panel.** The line above the input zone and status area is a keyboard-focusable
separator (`role="separator"`, horizontal, `aria-valuemin` 0, `aria-valuemax` 100).

- Allowed height: at least the panel's natural height, at most `min(2 × natural, 80% of the window
  height)`. Requests are clamped and rounded to whole pixels.
- Value: 0 at natural, 100 at the cap, linear between; 0 when there is no room to grow.
- Drag up grows, drag down shrinks; Arrow Up / Arrow Down step 16 px; double-click resets to natural.
- Persisted in renderer `localStorage` under `eli5.bottomPanel` as `{height, natural}`. Missing,
  malformed or non-positive values are ignored. On restore the chosen growth over natural is
  re-applied to the current natural height and clamped.
- The viewer slot shrinks or grows with it and reports its new rect (below).

**Top-status holder.** A shared holder at the top right of the title strip, absolutely positioned
and not draggable, that moves no other layout. It holds the LLM credential bar (02 §14) and the
publisher account items (10 §5.4); both render nothing in the public build.

**Native layer constraint.** The viewer is a `WebContentsView` layered above the renderer (01 §2.1),
so renderer DOM can never draw over the viewer rectangle. Therefore:

- No renderer popover, tooltip, or menu may extend into the viewer rectangle. Tooltips in the status
  area open upward/leftward and are clamped to the bottom row. The library item context menu is a
  native menu (`eli5:app:context-menu`, §10).
- When a route other than `doc` is active (settings, welcome, not found), the renderer calls
  `eli5:viewer:set-visible {visible:false}` and main removes the view from the window's content
  view. Returning to `doc` re-adds it and re-sends bounds.
- `ViewerSlot` reports its rect via `eli5:viewer:set-bounds` on mount, on `ResizeObserver` changes,
  on sidebar drag (throttled to one per animation frame), and after the window's `resize`.
- The find bar (§5.3) is a row between the document header and `ViewerSlot`, never an overlay: the
  slot shrinks while the bar is open and reports its new rect.
- The Versions panel (§5.7) is a right-hand layout column, never an overlay. `App.tsx` wraps the slot
  in `div.viewer-body` (`display: flex; flex: 1; min-height: 0`) holding `ViewerSlot`, a
  `PanelHandle` and the panel; the find bar stays a row above it. Opening the panel shrinks the
  slot, which reports its new rect; the layout key includes the panel width. Opening it never
  collapses the Library sidebar or any other panel.

### 5.2 Library sidebar

- Lists `CatalogEntry[]` from `eli5:library:list`, then live from `eli5:library:changed`.
- **Order: newest first** by `createdAt` descending; ties broken by `title` ascending. Regeneration
  updates `updatedAt` but does not reorder (a stable list is easier to scan). The same order feeds
  the Tray.
- Each item shows the topic title (one line, ellipsis) and a relative date ("2m", "3d", "Mar 4").
  The catalog summary is the item's accessible description and its native tooltip.
- Click or Enter opens the document in the viewer (`eli5:library:open {slug}`) and marks it
  selected. The selected item is `aria-current="page"`.
- A newly finished document slides in at the top with a 150 ms highlight (disabled under reduced
  motion). It does not steal the selection or change the viewer.
- Filter field at the top: case-insensitive substring match on title and summary, client side.
  Escape clears it.
- Context menu (right click, `Shift+F10`, or the context-menu key): Open, Reveal in Finder
  (`eli5:library:reveal`), **Move to ▸** (No folder, then each folder; the current one disabled),
  **Archive**, **Move to Trash**, and, only when enabled by HOOK-UI-01, the enterprise publish items.
  The menu is native; main performs the move and the library's `moved` event reaches the toast below.
- Collapsible (`Cmd+\`) and resizable by a drag handle that is also a keyboard `separator`
  (`aria-valuenow`, arrow keys move 16 px).

**Folders, Archive and Trash** (PRD *Organizing the Library*, 09 §4.2). State comes from
`eli5:library:organization` and follows `eli5:library:organization-changed`.

- Order in the list: unfiled documents, then user folders by name, then the built-in **Archive**;
  the **Trash** row (with its count) sits at the bottom of the Library, above Suggestions.
- **+ New folder** beside the LIBRARY heading shows an inline name field (Enter creates, Escape
  cancels). Folders are one level, collapsible (a disclosure button with `aria-expanded` and a
  count), and renamable (the pencil button, double click, or `F2`; inline field). The × button
  deletes a folder; its documents go to the Trash, and a toast says how many. Which folders are
  open is a per-viewer convenience in `localStorage`. The Archive cannot be renamed or deleted.
- The filter searches inside folders and the Archive: folders with a match (or whose name matches)
  open, others hide while filtering.
- **Move** by dragging a row onto a folder header, the Archive, the Trash row, or the unfiled list
  (a pointer drag that starts vertically; a ghost label follows the pointer and the target is
  outlined), or with the context menu. `Cmd+Backspace` on a focused row moves it to the Trash.
- **Swipe** a row with a two-finger trackpad swipe (horizontal `wheel` deltas; vertical ones still
  scroll) or a horizontal pointer drag. Left slides the row to reveal **Archive** (olive) on the
  right; right reveals **Move to Trash** (rust) on the left. Released past half the row width
  (at least 120 px) it commits; past 28 px it rests with the 76 px action button showing to click;
  shorter snaps back. Escape or a click elsewhere closes an open row. Momentum wheel events for
  350 ms after a gesture are ignored. The thresholds are pure functions in `library/swipe.ts`.
  Under reduced motion the row does not animate.
- **Undo toast:** every move (including the native menu's) shows "Moved to Archive · Undo",
  "Moved to Trash · Undo" or "Moved to “Folder” · Undo" for 5 s, announced politely. Undo moves the
  document back (`eli5:library:move` with `undo: true`, which shows no new toast) or, for the Trash,
  puts it back. `Cmd+Z` precedence is in §9.
- **Trash view** (route `{view: 'trash'}`, opened from the Trash row) in the viewer area: each item
  with its title and "Deleted 3d ago · from “Folder”" or "Merged into “X” 2d ago"; **Put Back** and
  **Delete Permanently**, and **Empty Trash** in the header. Delete Permanently and Empty Trash each
  ask once in an inline confirmation (focus on Cancel, Escape cancels; never a modal). A line says
  how long the Trash keeps documents (`trashRetentionDays`).

### 5.3 Viewer and document header

- `DocHeader` shows the title, "Updated {relative}", **Undo** and **Redo** icon buttons, the
  **Versions** toggle, a **Reveal in Finder** button, and the publish slot. In the public build the publish slot contains only the local-kind buttons
  **Export copy** and **Export Markdown**, shown when `eli5:publish:targets {slug}` returns the
  `local` and `markdown` targets (10 §5.1, §5.2). Each calls
  `eli5:publish:run {slug, targetId:'local'|'markdown'}` with no picker: the destination is
  `publish.local.dir` and reveal-after-export is `publish.local.revealAfter` (10 §4). The button
  becomes a spinner, then 10's inline result chip (10 §7) appears under the header. The export
  folder is chosen in Settings > Publishing (§7).
- **Undo / Redo** (`viewer/HistoryButtons.tsx`, 09 §4.1, 08 §6.7) sit left of the Versions toggle,
  Reveal in Finder and Export copy. They are small inline SVG curved arrows (↶ and its mirror ↷) drawn in
  `currentColor` in the normal button style, with `aria-label` "Undo" / "Redo". Tooltips:
  `Undo: <label> (⌘Z)` / `Redo: <label> (⇧⌘Z)`, "Nothing to undo" / "Nothing to redo" when
  unavailable, "Wait for the section update to finish" while busy. Each is disabled (greyed) when
  unavailable, while the document has a busy section, and while a checkout is in flight. State comes
  from `eli5:doc:history {slug}` on open and follows `eli5:doc:history-changed`; a click calls
  `eli5:doc:undo` / `eli5:doc:redo` and shows the returned state. Undo opens the previous version
  and Redo the next one on the branch last visited (08 §6.7). Main reloads the viewer after a
  checkout and scrolls to the change that was undone or redone (08 §7.4), and the Library sidebar
  updates from `eli5:library:changed`. A refusal shows its message inline. Both buttons may be
  enabled at once: a version can have both a parent and a child.
- **Versions toggle** (after the history buttons): a small branch glyph and the text "Versions",
  with a count badge when the document has more than one version. It has `aria-expanded`,
  `aria-controls="version-panel"` and `aria-keyshortcuts="Meta+Y"`, and toggles the panel (§5.7),
  as do `Cmd+Y` and View > **Show Versions** (§9). When the window is too narrow for the panel
  (below), the toggle does not open it and shows an inline hint under the header instead: "Widen the
  window or hide the library to show versions."
- The document's own tabs (In depth, ELI5, ASD-STE100 when the document has it, section ELI5
  tabs) render inside the viewer (07, 08). The ASD-STE100 tab is fixed (no close control) and starts
  with a short hint on what ASD-STE100 is (07 §4.1).
  The shell adds no tab strip.
- On `eli5:doc:updated {slug, sectionId?, tabKey?, anchorId?}` for the open document, main reloads
  the viewer and sends `eli5:doc:scroll-to` (08 §7.4). If the updated slug is not the open document, the shell does
  nothing beyond the Library update.
- **Find in document** (`viewer/FindBar.tsx`, `src/main/shell/find.ts`). `Cmd+F` (Edit > Find >
  Find in Document…) with a document shown opens a find bar above the viewer slot (it takes layout
  space; the slot shrinks). It holds a search field, the match count, previous / next icon buttons
  (inline SVG chevrons, `aria-label` "Previous match" / "Next match") and **Done**. The bar is
  `role="search"` ("Find in document"); the count is a polite live region reading "3 of 12" or
  "No matches".
  - The field is focused on open. Reopening shows the previous query selected and searches it
    again. `Cmd+F` while the bar is open refocuses the field and selects its text.
  - Search as you type, debounced 150 ms, case-insensitive: `eli5:viewer:find {text}` starts a new
    search. `Enter` / `Cmd+G` go to the next match and `Shift+Enter` / `Shift+Cmd+G` to the
    previous one (`{text, forward, again: true}`); `Enter` before the debounce fires searches at
    once. Clearing the field ends the search.
  - `Escape` (anywhere in the bar) or **Done** closes it: `eli5:viewer:stop-find` clears the
    highlight (`stopFindInPage('clearSelection')`) and focus returns to the viewer.
  - Main runs `webContents.findInPage` on the viewer and forwards each `found-in-page` result of the
    latest request as `eli5:viewer:find-result {kind: 'result', activeMatchOrdinal, matches,
    finalUpdate}`; results of superseded or stopped requests are dropped.
  - While a search is active, a reload of the viewer (section update, Ask, undo, checkout, merge) sends
    `{kind: 'reset', reason: 'reload'}`: the bar clears its count and the next `Enter` starts a new
    search, so the post-update scroll to the changed section is not overridden. A switch between
    the document's tabs (the runtime's `#tab=<key>` in-page navigation) sends `{kind: 'reset',
    reason: 'tab'}` and the bar searches again, so the count covers the tab now shown.
  - Opening another document, or any other route, closes the bar. With no document shown (welcome,
    not found, Trash, Settings), `Cmd+F` focuses the Library filter instead.
  - The field is a text field, so `Cmd+Z` in it undoes typing, not the document (§9).
- Drops onto the viewer are ignored: the doc preload cancels `dragover`/`drop` so a dropped file
  never navigates the viewer. Users drop onto the input zone or the sidebar (both accept drops).

### 5.4 Input zone

```ts
// src/renderer/input/types.ts
export interface InputDraft {
  draftId: string;           // "draft-" + 8 hex; new one after every clear (after a start, see step 5)
  inputs: SourceInput[];     // chips, in the order added: what the next Start sends
  lastRun: SourceInput[];    // URL inputs of the last successful start (the dimmed Last run row)
  urlText: string;           // uncommitted text in the URL field
  clarifying: string;        // optional specifics
  glossary: boolean;         // initialised from settings glossary.defaultOn
}
```

Parts (PRD *Input zone*):

1. **Drop box.** Accepts drag and drop of files and folders anywhere over the input zone or sidebar;
   while dragging over the window, the input zone shows a dashed "Drop to add" overlay. File paths
   come from `window.eli5.files.pathFor(file)`. Each becomes a `{kind:'file', origin:'drop'}` chip.
   Dragged text without files goes through `eli5:sources:stage-text` (03). Dragged links become URL
   chips.
2. **Paste.** `Cmd+V` while focus is in the window but not in a text field (URL field and specifics
   field paste as normal text, 03 §6) calls `eli5:sources:read-clipboard {draftId}`; returned inputs
   become chips labelled by their `preview` ("Pasted image 14:02"). An empty or unsupported
   clipboard shows the inline hint "Nothing to paste" under the drop box for 3 s.
3. **URL field.** Single line, with an **Add** button beside it. Plain `Enter` in the field (no
   Shift, Cmd, Ctrl or Alt, and not during IME composition) turns every valid web address in the
   text into a chip and starts nothing; several space-separated addresses each become a chip.
   Invalid tokens stay in the field with the inline URL error. `Enter` on an empty field starts a
   run. **Add** does the same as `Enter` with text, is disabled while the field is empty, and
   returns focus to the field. The renderer commits `http`/`https` URLs directly. Any other token is sent to
   main with `eli5:sources:classify-text {text}` → `{kind: 'url'|'bare'|'invalid'; label: string}`,
   which asks the lane router (`LaneRouter.routeBare()`, 03) whether it is a bare identifier (for
   example a ticket key) that a registered resolver accepts. `url` and `bare` become chips
   (`bare` chips use the returned `label`). `invalid` shows the inline error under the field and
   the text is kept for editing. In the public build no bare-identifier resolver is registered,
   so non-URL text always classifies as `invalid` and the behavior matches a URL-only field
   (HOOK-SRC-02, HOOK-SRC-03). Placeholder: "https://…" in the public build; the enterprise hint
   text comes from HOOK-UI-01.
4. **Chips.** Show icon by kind, label, and a remove button (`eli5:sources:discard` for staged
   pastes; `eli5:sources:release-drops` for a file chip when no other chip names the same file,
   06 §11). Chips are a `list`; Backspace on a focused chip removes it. A URL chip also has an
   icon-only copy button, and `Cmd+C` on a focused URL chip copies its full URL.
   **Last run row.** After a start, the sent URLs show as a "Last run" group of dimmed chips with no
   remove buttons, and a **Use again** button that appends them to the chips with fresh ids and
   empties the last run.
5. **Clarifying specifics.** Auto-growing textarea, 1 to 6 lines, placeholder "Optional: what do
   you want to understand? What do you already know?". `Shift+Enter` inserts a newline.
6. **Glossary toggle.** Checkbox "Explain domain specific terms", initialised from
   `glossary.defaultOn` (12) for every new draft.
7. **Primary button**, hint "⌘⏎". It reads "Start" (sends the chips; typed URL text is committed
   first) when there are chips or typed text. Otherwise, when a last run exists, it reads
   "Run again" with the tooltip "Send the last run's links again": it re-sends the last run's URLs
   with fresh ids. Otherwise it reads "Start" with the usual hint.
8. **Clear button.** "Clear", left of the primary button, enabled when anything is in the draft
   (chips, last run, URL text or specifics). It is disabled while a start is in flight, and the
   programmatic clear (`Cmd+N`) does nothing then. It clears everything, the last run included:
   `eli5:sources:discard-draft` for staged pastes, `eli5:sources:release-drops` for its file chips,
   a new `draftId`, glossary back to default, messages cleared. Focus moves to the drop box.

**Start algorithm** (`Cmd/Ctrl+Enter` anywhere in the zone; plain `Enter` on an empty URL field,
in Specifics, on the glossary toggle or on the drop box; or clicking the primary button):

1. If the URL field holds text, try to commit it as chips. If it is invalid, show the inline error,
   do not start, and keep focus on the field.
2. If `inputs.length === 0`, do nothing and show the inline hint "Add a file, paste, or URL first".
   Clarifying text alone never starts a job (06 §5.1).
3. If no API key is stored for the selected provider (`eli5:settings:has-api-key`), do not start.
   Show the inline hint "Add an API key in Settings to start" with a link to Settings.
4. Call `eli5:jobs:start {inputs, options: {clarifyingInput: draft.clarifying, glossary:
   draft.glossary}}` (`JobOptions`, 06).
5. On `ok`: every sent input leaves the chips. The sent URLs become the last run (when none of
   the sent inputs were URLs, the previous last run is kept). Specifics and the glossary choice
   stay. Inputs added while the start was in flight stay as chips. If unsent staged pastes remain,
   the draft keeps its `draftId` (their staging lives under it); otherwise it gets a new one.
   Announce "Started" in the live region and show a transient hint ("Started", or "Started again
   with the last run" for Run again). The status area shows the new line. A start never cancels an
   earlier run; each start creates its own document (PRD *Concurrency*). The earlier Restart
   button, which cancelled the running job, is gone.
6. On error: keep the draft intact and show `error.message` inline
   under the Start button. For `E_NOT_AVAILABLE_IN_EDITION` the message is "Requires the enterprise
   edition" (01 §6.4).

The start action is debounced for 400 ms against double Enter or a double click, Start and Run
again alike. A draft survives hiding the window and any number of starts, but not an app restart: it lives
only in the window's memory. Its staging left on disk at quit is removed by the next launch's sweep
(03 §6.1 step 6).

### 5.5 Status area

- One `JobLine` per job from `eli5:jobs:list` and live `eli5:jobs:changed`, newest at the bottom.
  At most 5 lines are visible; older ones scroll.
- The label string comes verbatim from the pipeline (06 §6). The shell never composes status text.
  Leading glyph: spinner (queued/running), check (done), cross (failed); glyphs are `aria-hidden`
  and the status is in the text.
- Actions per line (inline buttons, never modals): **Cancel** on non-terminal lines
  (`eli5:jobs:cancel`), **Retry** and **Dismiss** on failed lines (`eli5:jobs:retry`,
  `eli5:jobs:dismiss`), **Dismiss** on done lines. Clicking a done line opens its document.
  Auto-hide rules (done: 10 min) are the pipeline's (06 §6).
- Skipped-source tooltip lists `ref: reason` pairs, clamped to the bottom row (§5.1).
- A `failed` line with "Check Settings" in its label (`LLM_AUTH`) renders "Settings" as a link.
- Empty: the area shows nothing but keeps its column width, so the layout does not jump.

### 5.6 Suggestions area

- Lives at the bottom of the sidebar, under a "Suggestions (n)" heading, hidden when `n === 0`.
- One `SuggestionCard` per `MergeSuggestion` (09): text "This looks related to *{target title}*.
  Merge it in or keep it separate?", the new document's title, and two buttons: **Merge in**
  (`eli5:suggestions:accept`) and **Keep separate** (`eli5:suggestions:dismiss`). Both titles are
  links that open the document, set inline in the sentence (left-aligned prose, the period attached;
  the "New:" line clamps a long title with an ellipsis). 09 §10.4 owns the suggestion copy and button labels; this file
  only places them.
- On accept, the card shows "Merging…" until `eli5:suggestions:changed`. The viewer then opens the
  target document scrolled to the appended section if the removed document was open.
- Suggestions never interrupt: no focus steal, no sound, only a polite live-region announcement
  "New suggestion" and the count badge.

### 5.7 Versions panel

`viewer/VersionTreePanel.tsx` shows the open document's versions as a tree (PRD *Versions*, 09 §4.1,
08 §6.7). It is `<aside id="version-panel" data-region="versions" aria-label="Versions">`, the right
column of `div.viewer-body` (§5.1).

- **Size and state.** Closed by default, 300 px wide, clamped to 220..420 px, persisted in
  `localStorage` under `eli5.versionPanel` as `{open, width}` (access in try/catch; malformed values
  ignored). The `PanelHandle` before it is a `role="separator"` with `aria-orientation="vertical"`,
  Arrow Left/Right step 16 px, and pointer drag (as the sidebar handle). The width clamps so the
  viewer slot keeps at least 360 px; if even 220 px does not fit, the toggle shows the narrow-window
  hint (§5.3) and the panel stays closed. No other panel is collapsed automatically.
- **Header:** "Versions" (`h2`), **← Back** and **Forward →** (the same actions as Undo and Redo,
  accessible names "Back to previous version" / "Forward to next version", the version labels in
  their tooltips, disabled at the ends), and **Close**.
- **Tree:** `ul role="tree" aria-label="Document versions"`, laid out by the pure
  `layoutVersionTree(tree, collapsed)` in `viewer/version-tree-layout.ts`: chronological top to
  bottom with the original first; children sorted by `createdAt`; the oldest child continues its
  parent's lane and each later child starts an indented branch (a nested `role="group"`). Branches
  that contain the current version are always expanded. Each row is an `li role="treeitem"` with
  `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded` on branch points only,
  `aria-current="true"` on the current version, and `aria-disabled` while busy or when the snapshot
  was removed.
- **Row:** a CSS rail and dot (a solid accent rail on the path from the original to the current
  version, dashed on other branches, a filled dot with a ring for the current one). Line 1: the
  topic (2-line clamp). Line 2: verb · relative time, with the verbs Expanded, Re-explained, Analogy
  added, Went deeper, Edited with note, Asked, ELI5 tab, ELI5 of a selection, Closed tab, Merged,
  Changed outside the app, Original (`VERSION_VERBS`). A rebuild (kind `outside` with a label that
  starts with `Rebuilt`, 09 §4.1) shows **Rebuilt with new prompts** (`versionVerb()` in
  `viewer/version-tree-layout.ts`). An Ask deep (kind `ask` with `depth: 'deep'`, 08 §6.9) shows
  **Asked (deep)** (`versionVerb()` takes `depth`), and its Undo and Redo tooltips use the main-side
  label `asked (deep) about '…'`; an Ask deeper (`depth: 'deeper'`, 08 §6.10) shows **Asked
  (deeper)** with the label `asked (deeper) about '…'`; an unknown `depth` shows plain **Asked**.
  Line 3, for every Ask: the question in quotes (1-line clamp). Chips:
  **Current**, **Published** (10 §4), **(snapshot removed)**. A detail strip at the panel foot
  shows the focused row's full label, heading and question; native `title` tooltips are not used.
- **Pending rows.** While a section job runs, a muted provisional row appears under the current
  version (for example "Answering… · Pricing", "Answering in depth… · Pricing" when the pending
  row has `depth: 'deep'`, or "Searching further… · Pricing" with `depth: 'deeper'`, in the row and in its text alternative), from `tree.pending`; the real row replaces it when
  `eli5:doc:versions-changed` arrives. New rows fade in over 1 s (none under reduced motion).
- **Banners** (inline, polite live region): `detached` → "This document changed outside the app;
  it will be saved as a version on the next change." `degraded` → "Version history couldn't be saved
  for the last change."
- **Interaction.** Click, Enter or Space on a row calls `eli5:doc:checkout {slug, versionId}`; the
  row shows a spinner while it runs. Main reloads the viewer and lands on where that version changed
  (08 §6.7); the current row only scrolls there. While busy every row is disabled with the inline
  line "Wait for the update to finish". Refusals and errors ("That version is no longer available",
  "That version can't be read") show inline in the panel footer. There are no confirms and no
  modals: every version is kept, so opening one is lossless. With a read-only library the rows and
  Back/Forward are disabled.
- **Keyboard** (WAI-ARIA tree): Up/Down move, Right expands or moves to the first child, Left
  collapses or moves to the parent, Home/End, type-ahead on the topic.
- **Data.** `eli5:doc:versions {slug}` on open and on slug change, then `eli5:doc:versions-changed`
  filtered by the open slug; responses for a previous slug are dropped (the `HistoryButtons`
  pattern).

## 6. Routes

```ts
// src/renderer/App.tsx
export type UiRoute =
  | { view: 'welcome' }                 // no document selected, or empty Library
  | { view: 'doc'; slug: string }
  | { view: 'not-found'; slug: string }
  | { view: 'trash' }                   // the Trash (§5.2)
  | { view: 'settings'; section?: SettingsSection };

export interface AppNavigateEvent { route: UiRoute }   // payload of eli5:app:navigate
```

Startup route: the most recently opened document (remembered in renderer `localStorage`, wrapped in
try/catch) if it still exists, else `welcome`. Escape in settings returns to the previous route.

## 7. Settings screen

An in-window route, not a window or modal. It replaces the viewer area (viewer hidden, §5.1); the
sidebar, input zone, and status area stay usable so a job can be started from settings. Opened by
`Cmd+,`, the sidebar gear, or Tray > Settings….

```ts
export type SettingsSection =
  'ai' | 'documents' | 'library' | 'publishing' | 'notifications' | 'sync' | 'about' | 'enterprise';
```

| Section | Controls | Backing |
| --- | --- | --- |
| AI provider | Provider radio: Claude, "ChatGPT (OpenAI)". Providers with `available:false` in `EditionInfo.llmProviders` are **not shown** (so the dormant `bedrock` value never appears in the public build) | `llm.provider` |
| API key | Password field + **Save**, state "Key saved in Keychain" or "No key", **Remove**, **Test connection** | `eli5:settings:set-api-key`, `has-api-key`, `clear-api-key`, `eli5:llm:test-connection` |
| Model | Dropdown "Model" (rules below) | `llm.model`, `eli5:llm:models` |
| Documents | "Explain domain specific terms by default" switch; "Use stock photos for real-world scenes" switch with a one-line privacy note (07 §7.4); "Documents generated at once" (1 to 3, 06 §4.1) | `glossary.defaultOn`, `images.stockPhotos`, `pipeline.maxConcurrentJobs` |
| Library | Location (read only), document count, read-only reason if any, + **Reveal in Finder** | `eli5:library:info` (09), `eli5:library:reveal-root` |
| Publishing | Export folder (read-only path + **Choose…**, which opens a native open panel for directories), "Reveal in Finder after export" switch, link "How to set up a Pages repository" (10 §8); one account item per available publisher that declares an account (10 §5.4; none in the public build) | `publish.local.dir`, `publish.local.revealAfter` (10, 12); `eli5:publish:account-status`, `eli5:publish:account-action` |
| Notifications | See "Notifications section" below | `notifications.enabled`, `notifications.clickAction`, `notifications.preferredLink` (12 §3); `eli5:app:test-notification`, `eli5:app:open-notification-settings` |
| Sync (v2, optional) | See "Sync section" below (16 §8) | `sync.*` (12 §3); `eli5:sync:*` (01 §5.2) |
| About | Version (`EditionInfo.version`), edition name, links to README and help docs (HOOK-UI-02) | `eli5:edition:info` |
| Enterprise | Rendered only when HOOK-UI-01 enables it | HOOK-UI-01, HOOK-CFG-01 |

Rules:

- Non-secret settings save on change (debounced 300 ms) via `eli5:settings:set`; the saved state is
  confirmed by a quiet "Saved" text next to the control. Validation errors from main render inline.
- Form layout: labeled fields (API key, Model) share one label column (`.field`: a 72 px label
  column, then the control), so their inputs start at the same x; the key state and its buttons sit
  in the control column under the key field.
- The API key field never shows a stored key and is cleared after save. Keys go only to the
  Keychain (12). The renderer never receives a stored key.
- The Publishing folder chooser is the only native panel the app uses. It is user-initiated from
  Settings, outside the ingest flow. Main validates the chosen path (10 §4 step 1) and a rejection
  renders inline.
- **Test connection** shows a spinner then "Connected ({model})" or the returned message inline.
- **Model picker.** A dropdown labelled "Model" lists the provider's suggested models (the default
  marked "(default)"), then "Custom…". The selection is the saved model if it is listed; the
  provider default if nothing is saved; Custom if the saved id is not in a non-empty list, or the
  user chose Custom. Custom reveals a text field "Custom model ID" with the default as placeholder;
  Custom stays selected while the typed id is empty or equals a listed one. Picking a listed model
  saves at once; typing saves debounced. While the field has focus, echoes of earlier saves do not
  overwrite newer typing; external changes apply when it is not focused. Switching provider reloads
  the list and leaves Custom. Locked settings disable both controls.
- Dormant keys (`sources.mcp.url`, `publish.drive.*`, `publish.github.*`) have no controls in the
  public build. They are documented in 12 and remain editable only in the settings file.
- Changing provider or model affects jobs started afterwards; running jobs keep their provider (06).

**Notifications section** (`section: 'notifications'`, backing detail in §14):

- Switch "Notify me when a document is ready" (`notifications.enabled`, default on).
- Radio group "When I click a notification" (`notifications.clickAction`):
  - "Open it in ELI5 Learner" (`'app'`, default).
  - "Open its published link in my browser" (`'published-link'`), with a select for which link:
    "Most recent" / "Cloud drive" / "GitHub Pages" (`notifications.preferredLink`: `'most-recent'`
    default, `'drive'`, `'site'`). The select is enabled only when this radio is chosen and a remote
    publisher is available.
  - A remote publisher is available when any `EditionInfo.publishers` entry (01 §6.2) other than
    the local publishers `local` (Export copy) and `markdown` (Export Markdown) reports
    `available:true`. Registered stubs report `available:false` and do not count
    (10). In the public edition none is available, so the second radio and the select are
    disabled with the explanation "Available when documents can be published to a cloud drive or
    GitHub Pages". A hand-set `'published-link'` value is shown selected but disabled and behaves as
    `'app'` through the fallback (§14.4).
- Button **Send test notification** (`eli5:app:test-notification`). Result inline: "Sent. If
  nothing appeared, check macOS notification settings." for `shown:true`,
  "Notifications are turned off" for `reason:'disabled'`, the unsupported text below for
  `reason:'unsupported'`.
- Permission line: "macOS asks for permission the first time ELI5 Learner shows a notification. If
  you don't see them, allow them in System Settings > Notifications > ELI5 Learner > Allow
  notifications." with the button **Open macOS notification settings**
  (`eli5:app:open-notification-settings`).
- When `Notification.isSupported()` is false, the section shows "Notifications aren't supported on
  this system" and the switch and radios are disabled. The renderer learns this from a
  `reason:'unsupported'` result of `eli5:app:test-notification`, which in that case posts nothing.
  On supported macOS versions this state is defensive only.
- All three keys are hidden or locked like any other key when an overlay marks them managed
  (HOOK-CFG-01, HOOK-UI-03).

**Sync section** (`section: 'sync'`, v2, optional; behavior in 16;
`src/renderer/src/settings/sections/SyncSection.tsx`). Absent when the sync policy says sync is not
allowed (HOOK-SYNC-01): `eli5:sync:status` then answers `E_NOT_AVAILABLE_IN_EDITION`.

- Privacy line at the top, always shown: "Turning this on copies your learnings (not your sources or
  notes) to a hidden folder in your Google Drive. Google can read them."
- Switch "Sync with my Google Drive" (`sync.enabled`, default off). It comes first because sign-in
  needs it on: nothing reaches Google while it is off.
- "Google client" field: paste the downloaded Desktop client JSON or drop the file on it, then
  **Save client**. It is write-only: after saving it shows "Client saved in Keychain" and **Remove**,
  never the values (`eli5:sync:set-client`, `clear-client`; HOOK-SYNC-02). A malformed JSON is
  rejected inline and the text stays for correction.
- **Connect Google Drive** (opens the consent page in the system browser, never in a window;
  disabled with "Save your Google client first" or "Turn on Sync first"), then "Connected as
  <email>" and **Disconnect** (`eli5:sync:sign-in`, `sign-out`).
- A choice "Versions to sync": Current only, Recent (10 newest, default), All (`sync.history`).
- Switch "Accept jobs from phone" (`sync.inbox.enabled`, default off), with the phones seen and
  their last-seen time.
- **Sync now**, "Last synced <relative time>", pending uploads.
- Devices list; on a mirror Mac, **Make this Mac the primary** (`eli5:sync:make-primary`).
- **Delete cloud copy** with one inline confirmation (no dialog; `eli5:sync:delete-remote`). It
  deletes the store and turns Sync off; the local library is not touched. Shown only while signed in
  with Sync on; disabled with "Sync is managed by your organization" when `sync.enabled` is locked.
- Error lines use the 16 §10 texts ("Sign in again to keep syncing", "Your Google Drive is full",
  "Update ELI5 Learner to keep syncing").

**Sync indicator** (v2; `src/renderer/src/sync/SyncIndicator.tsx`). When `sync.enabled` is true,
the sidebar footer shows a small cloud icon with three states: synced (`idle`, `mirror`), syncing,
and offline or error (`error`, `signed-out`, `not-configured`, `paused-read-only`). Its accessible
name says which ("Sync: up to date", "Sync: Your Google Drive is full", ...). It opens Settings >
Sync. It is absent when sync is off or not allowed. Inbox jobs carry a "From phone" chip in the status area (§5.5); a finished one posts
the normal completion notification (§14).

## 8. Empty and error states

| State | Where | Content |
| --- | --- | --- |
| First run, no API key | Viewer area (welcome) | "Turn anything into an explainer." Three steps: add a key (links to Settings > AI), drop a source, press Enter |
| Key present, Library empty | Viewer area (welcome) | "Drop files, paste a screenshot, or enter a URL below, then press Enter" with an arrow toward the input zone |
| Library empty | Sidebar | "Your finished documents will appear here" |
| Filter matches nothing | Sidebar | "No documents match '{q}'" + Clear |
| No suggestions | Sidebar | Section hidden |
| No jobs | Status area | Blank (§5.5) |
| Document files missing | Viewer area (`not-found`) | "This document's files are missing." + Reveal Library folder |
| Document is in the Trash (opened from a notification, the tray or a stale route) | Viewer area (`not-found` with a Trash item for the slug) | "This document is in the Trash." + where it came from + **Put Back** (then it opens) |
| Trash empty | Viewer area (`trash`) | "The Trash is empty"; Empty Trash disabled |
| Viewer load failure | Viewer area | "Could not display this document." + Retry (reload) |
| Enterprise overlay failed to load | Error window (01 §6.3) | Owned by 01 |

No state uses a modal. No empty state blocks the input zone.

## 9. Keyboard shortcuts

Defined once in `src/renderer/a11y/shortcuts.ts` and mirrored as application menu accelerators
where a menu item exists, so they appear in the Help menu search.

| Shortcut | Action | Scope |
| --- | --- | --- |
| `Cmd+Enter` / `Ctrl+Enter` | Start the job, or Run again (§5.4) | Anywhere in the input zone |
| `Enter` | In the URL field with text: turn it into chips, start nothing. Elsewhere in the zone (empty URL field, specifics, toggle, drop box): start (§5.4) | Input zone (not in specifics when `Shift` held) |
| `Shift+Enter` | Newline | Specifics field |
| `Cmd+V` | Paste as source | Window, outside text fields |
| `Cmd+L` | Focus URL field | Window |
| `Cmd+N` | Focus drop box and clear the draft (same as Clear, §5.4) | Window |
| `Cmd+,` | Open Settings | Window |
| `Cmd+\` | Toggle sidebar | Window |
| `Cmd+F` | Find in document: open the find bar (§5.3), or refocus it; focuses the Library filter when no document is shown | Window |
| `Cmd+G` / `Shift+Cmd+G` | Next / previous match of the find bar's query (opens the bar when closed) | Window, and the viewer (Edit > Find menu) |
| `Enter` / `Shift+Enter` | Next / previous match | Find field |
| `Option+Cmd+F` | Focus Library filter (Find in Library) | Window |
| `Cmd+[` / `Cmd+]` | Previous / next document in Library order | Window |
| `Cmd+1`…`Cmd+9` | Open the nth Library document | Window |
| `F6` / `Shift+F6` | Cycle focus regions: sidebar → viewer → versions (when open) → input zone → status → suggestions | Window |
| `Cmd+Y` | Show or hide the Versions panel (§5.7); View > **Show Versions** | Window, and the viewer (menu accelerator) |
| `Cmd+W`, `Cmd+Q` | Close window (hide) | Window (§3.2) |
| `Escape` | Clear filter / close the find bar / leave settings / close inline hint | Context |
| `Cmd+R` | Reload viewer (not the app) | Viewer focused |
| `Cmd+Z` / `Shift+Cmd+Z` | Undo / redo the open document's last change: back to the previous version, forward along the last-visited branch (09 §4.1); `Cmd+Z` first undoes a pending Library move (below) | Window, outside text fields |
| `Cmd+Backspace` | Move the focused Library row to the Trash (§5.2) | Library row |

The find shortcuts are items of the Edit menu's **Find** submenu (macOS convention): **Find in
Document…** `Cmd+F`, **Find Next** `Cmd+G`, **Find Previous** `Shift+Cmd+G`, then **Find in
Library** `Option+Cmd+F`. When the app renderer has focus it handles the keys itself and prevents
the default, as for the other shortcuts. While the viewer has focus the keys are not handled by the
document or the viewer's `before-input-event` handoff, so the menu items fire; they send
`eli5:app:find-command {command}` to the app renderer (not a forwarded key, because Option changes
the key an Option+Cmd+F event reports). Find in Document and Find in Library bring the window
forward and focus the app renderer; Find Next and Find Previous leave focus where it is.

**Show Versions** (`Cmd+Y`) is a View menu item in `app-menu.ts`, mirrored like Toggle Sidebar: a
`MenuShortcutId` (`toggle-versions`, key `Y`) that shows the window and forwards the key to the app
renderer, so it works while the viewer has focus. `shortcuts.ts` maps it to the same toggle as the
header button. No new IPC channel is needed.

`Cmd+R` never reloads the React app in production builds; the default `reload` role is not in the
application menu. Shortcuts inside the document (selection menu) are owned by 08.

`Cmd+Z` / `Shift+Cmd+Z` keep the Edit menu's `undo` / `redo` roles, so text fields (URL field,
specifics, filter, settings) undo their own typing. The app renderer handles the keys first: when
focus is not in an `input` (text-like types), `textarea`, `select` or `contenteditable`, it
prevents the default and undoes or redoes the document instead; inside a text field it does
nothing and the role acts. The Edit menu also has **Undo Document Change** and **Redo Document
Change** items with no accelerator (so they never take `Cmd+Z` from text fields); they act on the
document in the viewer from anywhere. While the viewer itself has focus, `Cmd+Z` stays with the
document page (no document change is undone); the header buttons and the Edit menu items work.

`Cmd+Z` precedence outside text fields: (1) while a Library move's Undo toast is showing, or while
focus is in the Library and its last move can still be undone, `Cmd+Z` undoes that move; (2)
otherwise it undoes the open document's last change. The Library listens in the capture phase and
prevents the default; the document's handler skips prevented events. The rule is
`libraryUndoWins()` in `shortcuts.ts`. `Shift+Cmd+Z` is always the document's redo.

## 10. IPC added by this file

Additions to the 01 §5.2 baseline, same conventions (`IpcResult<T>`, zod validation, sender check).

| Channel | Dir | Owner | Request | Response / payload |
| --- | --- | --- | --- | --- |
| `eli5:app:navigate` | M→R | shell | — | `AppNavigateEvent` |
| `eli5:app:context-menu` | R→M | shell | `{kind: 'library-item'; slug: string}` | `void` (main shows a native menu; choices act in main or emit `eli5:app:navigate`; Move to / Archive / Move to Trash call the library, whose `eli5:library:moved` event drives the toast) |
| `eli5:viewer:set-visible` | R→M | shell/viewer | `{visible: boolean}` | `void` |
| `eli5:viewer:focus` | R→M | shell/viewer | — | `void` (focuses the attached viewer view, §12) |
| `eli5:app:cycle-region` | M→R | shell | — | `CycleRegionEvent {dir: 1 \| -1}` (F6 / Shift+F6 pressed in the viewer, §12) |
| `eli5:viewer:find` | R→M | shell/find | `FindInDocumentRequest {text: string (1–200 chars); forward?: boolean; again?: boolean}` | `void` (`findInPage` on the attached viewer, case-insensitive; without `again` a new search). App window only |
| `eli5:viewer:stop-find` | R→M | shell/find | — | `void` (`stopFindInPage('clearSelection')`). App window only |
| `eli5:viewer:find-result` | M→R | shell/find | — | `FindResultEvent`: `{kind: 'result'; activeMatchOrdinal; matches; finalUpdate}` for the latest request, or `{kind: 'reset'; reason: 'reload' \| 'tab'}` (§5.3) |
| `eli5:app:find-command` | M→R | shell | — | `FindCommandEvent {command: 'find' \| 'find-next' \| 'find-previous' \| 'find-in-library'}` (Edit > Find menu items, §9) |
| `eli5:sources:classify-text` | R→M | sources (03) | `{text: string}` (≤ 2048 chars) | `{kind: 'url' \| 'bare' \| 'invalid'; label: string}` |
| `eli5:settings:choose-folder` | R→M | shell | `{key: 'publish.local.dir'}` | `{path: string} \| {cancelled: true}` (main shows the open panel, validates, and saves the key) |
| `eli5:settings:open-help` | R→M | shell | `{topic: 'readme' \| 'publish-pages' \| 'licenses'}` | `void` (main maps the topic to the public README URL, `resources/help/publish-github-pages.html` or `resources/skills/THIRD_PARTY.md` and opens it with the default app; a missing file is `E_NOT_FOUND`). The renderer never names a path or URL |
| `eli5:library:reveal-root` | R→M | shell/library | — | `void` (Finder shows the Library root; Settings > Library **Reveal in Finder**) |
| `eli5:app:test-notification` | R→M | shell/notifications | — | `{shown: boolean; reason?: 'disabled' \| 'unsupported'}` (§14.7) |
| `eli5:app:open-notification-settings` | R→M | shell/notifications | — | `void` (main opens the fixed System Settings URL, §14.6) |

All of these channels are in the 01 §5.2 IPC table and their constants are in `contract.ts`. The
Versions panel uses 08's app-only channels `eli5:doc:versions`, `eli5:doc:checkout` and the
`eli5:doc:versions-changed` event (08 §6.7, 01 §5.2), exposed as `window.eli5.doc.versions(slug)`,
`doc.checkout(slug, versionId)` and `doc.onVersionsChanged(cb)`. The
folders, Archive and Trash channels (`eli5:library:organization`, `create-folder`, `rename-folder`,
`delete-folder`, `move`, `put-back`, `delete-permanently`, `empty-trash`, and the
`organization-changed` and `moved` events) are owned by 09 §11.

`window.eli5` gains `app: { onNavigate(cb): Unsubscribe; contextMenu(p); testNotification();
openNotificationSettings(); onCycleRegion(cb): Unsubscribe; onFindCommand(cb): Unsubscribe }`,
`viewer.setVisible(v)`, `viewer.focus()`, `viewer.find(text, {forward?, again?})`, `viewer.stopFind()`,
`viewer.onFindResult(cb)`, `sources.classifyText(t)`, `library.revealRoot()`, `settings.chooseFolder(k)`, and `settings.openHelp(topic)`. There is deliberately no renderer channel to quit the app (§3.2).

## 11. Enterprise-only UI

The renderer bundle is identical in both editions. Enterprise UI components are generic public code
that render from data main already returns (`PublishTarget` labels, auth status); they are mounted
only when the matching `UiFeature` is enabled. No organization-specific string or asset ships in the
renderer.

```tsx
// src/renderer/edition/FeatureGate.tsx
export function FeatureGate(p: { feature: UiFeature; children: React.ReactNode }) {
  const info = useEdition();                 // cached eli5:edition:info, fetched once at startup
  return info?.uiFeatures.includes(p.feature) ? <>{p.children}</> : null;
}
```

| Feature flag (`UiFeature`, 01 §6.2) | Mount points |
| --- | --- |
| `publish.drive` | DocHeader publish slot, Library context menu, Tray (none) |
| `publish.git` | DocHeader publish slot, Library context menu |
| `auth.signIn` | Sidebar footer sign-in indicator, Settings > Enterprise |

Behavior when enabled (generic, public code): a publish button calls `eli5:publish:run {slug,
targetId}`; the button becomes a spinner, then an inline result row under the header with the
returned link, **Copy link** and **Open** (`eli5:publish:open-link` via main). This is the same
result chip as Export copy; 10 §7 owns the chip layout and button labels. Failures render inline. The sign-in indicator shows `eli5:auth:status` (and updates on `eli5:auth:changed`, 03) as
"Signed in", "Sign in", or "Session expired · Sign in"; clicking calls `eli5:auth:sign-in`. The
sign-in lifecycle itself is HOOK-AUTH-01; publishers are HOOK-PUB-01..04.

<!-- hook:HOOK-UI-01 -->
> **Private hook · HOOK-UI-01 · Enterprise-only UI (publish buttons, sign-in state).**
> Public behavior: `EditionInfo.uiFeatures` is empty, so every `<FeatureGate>` renders nothing: no cloud
> drive or git publish buttons, no publish items in the Library context menu, no sign-in indicator,
> no Settings > Enterprise section. Elements are absent from the DOM and accessibility tree, not
> disabled. The only publish controls are **Export copy** and **Export Markdown** (the local-kind `local` and `markdown` targets), and the URL field
> placeholder is "https://…". A forged IPC call
> still fails with `E_NOT_AVAILABLE_IN_EDITION`. Private binding supplies: which `UiFeature` flags the
> overlay enables via `enableUiFeatures`; the button labels and ordering carried in each enterprise
> `PublishTarget` (label, short description, icon hint from a fixed generic set); whether publishing
> requires an inline confirmation step (for example before an organization-wide share, HOOK-PUB-02)
> and its wording; how the returned link is presented (copy, open, or both); the sign-in indicator
> copy for each auth state; the URL field placeholder and hint text for bare identifiers such as
> ticket keys accepted through HOOK-SRC-02 and HOOK-SRC-03; the fields shown in Settings > Enterprise and which dormant keys they
> edit (HOOK-CFG-01). Binding lives in the private spec under "HOOK-UI-01".

<!-- hook:HOOK-UI-02 -->
> **Private hook · HOOK-UI-02 · Edition branding and help links.** Public behavior: Settings >
> About shows "ELI5 Learner", the version, "Public edition", and links to the public README and the
> publishing help page (the GitHub Actions setup guide from 10). The window title is always "ELI5
> Learner". Private binding supplies: the edition display name (via `EditionInfo.overlayName`), the
> internal help and support URLs and their labels, and any extra About text such as a data-handling
> note. Values arrive through the overlay's settings extension (HOOK-CFG-01), never as renderer
> constants. Binding lives in the private spec under "HOOK-UI-02".

## 12. Accessibility

- **Landmarks.** Sidebar `nav` ("Library"), viewer region `main`, Versions panel `complementary`
  ("Versions", when open), input zone `form` ("New explainer"), status area `region` ("Jobs"),
  suggestions `region` ("Suggestions"). F6 cycles them (§9), with the Versions panel after the
  viewer while it is open. The version tree follows the WAI-ARIA tree pattern (§5.7). The find bar, when open, is a `search` landmark ("Find in document") inside the viewer
  region, with its match count as a polite live region (§5.3).
- **Live regions.** One polite announcer (`aria-live="polite"`) for: job started, job done ("Done:
  {title}"), job failed (assertive only for `failed`), new suggestion. Intermediate stage changes are
  **not** announced, to avoid chatter; the status text is still readable on focus.
- **Viewer focus handoff.** F6 into the viewer (with a document shown) sends `eli5:viewer:focus`;
  main calls `webContents.focus()` on the view and the doc runtime (08) moves focus to the active
  tab when nothing in the document has focus. Keys pressed in the viewer never reach the app
  renderer, so main watches the view's `before-input-event`: F6 / Shift+F6 focus the app and send
  `eli5:app:cycle-region {dir}` (the app cycles on from the viewer region), and Cmd+1…9 are
  forwarded to the app like the menu shortcuts. Every other key stays with the document.
- **Controls.** All controls are native elements or follow WAI-ARIA patterns (combobox for model,
  switch for glossary, listbox for chips). Visible focus ring (2 px, `--focus` token) on everything.
  Hit targets ≥ 24×24 px.
- **Contrast and themes.** Colors are CSS tokens with light and dark values following
  `nativeTheme.shouldUseDarkColors`; text contrast ≥ 4.5:1, UI boundaries ≥ 3:1. Respect "Increase
  contrast" (`prefers-contrast: more`) with stronger borders.
- **Motion.** All animation off under `prefers-reduced-motion: reduce`. Spinners become a static
  "…" glyph.
- **Text size.** Layout survives 200% zoom (`Cmd+=` on the app renderer, persisted in window state)
  with the sidebar auto-collapsing below 1000 CSS px of width.
- **Tray.** Menu items are native, so VoiceOver reads them. The busy icon has an accessible
  description via the tooltip.
- **Tab hints.** A document tab whose kind needs explaining (today only ASD-STE100) carries a hint
  paragraph at the top of its panel, visible without JavaScript and in print; the tab button names
  it with `aria-describedby` and repeats it as its `title` (07 §4.1).
- **No time limits.** Nothing requiring action disappears on a timer; the 10-minute done-line hide
  (06) applies only to informational lines, and the document stays in the Library.

## 13. Error handling summary

| Failure | Handling |
| --- | --- |
| IPC call returns `ok:false` | Inline message next to the triggering control; never a modal |
| `eli5:library:list` fails at startup | Sidebar shows "Could not load the Library" + Retry |
| Change event arrives for unknown job/slug | Refetch the full list (`jobs:list`, `library:list`) |
| Viewer `did-fail-load` | Viewer load failure state (§8) |
| Window state file unreadable | Defaults, overwrite on next save |
| Tray creation fails | Log, keep running with the window; close then quits the app, because without a Tray there is no way back |
| Notification unsupported or `show()` throws (a macOS denial is invisible to the app) | No notification; log `notification.fallback`; never a modal or inline error outside Settings (§14.6) |
| Notification click finds no published link or `openExternal` fails | Fall back to opening the document in the app (§14.4) |

## 14. Completion notifications

When a create job finishes, main posts one native macOS notification. Clicking it brings the user
back to the new document, either in the app (default) or, by setting, at the document's published
link in the default browser. This is the only native notification the app posts (§1, §4.1).

### 14.1 Module and API

```ts
// src/main/shell/notifications.ts
export interface DocumentReadyEvent { slug: string; docId: string; title: string }

export interface NotifierDeps {
  Notification: NotificationClass;                  // Electron's main-process Notification (injected for tests)
  isSupported: () => boolean;                       // Electron Notification.isSupported()
  now: () => number;
  showMainWindow: () => void;                       // §3.2 step 6, recreating the window if needed
  openInApp: (slug: string) => void;                // §14.4 'app' route: viewer open + navigate {view:'doc'}
  navigate: (route: UiRoute) => void;               // eli5:app:navigate (not-found, Settings > Notifications)
  openExternal: (url: string) => Promise<void>;     // safeOpenExternal (12 §7.5) with one fixed main sender id; rejects on refusal
  getMeta: (slug: string) => Promise<DocumentMeta | null>;  // 09; null when the document is gone
  settings: () => Settings['notifications'];        // read live, never cached
  policy: () => NotificationPolicy;                 // registry.notificationPolicy() (HOOK-UI-03), read at post time
}

export interface Notifier {
  documentReady(e: DocumentReadyEvent): void;
  test(): { shown: boolean; reason?: 'disabled' | 'unsupported' };
  liveCount(): number;                              // retained notifications (§14.5); tests, diagnostics
}

export function createNotifier(deps: NotifierDeps): Notifier;
```

The module uses Electron's main-process `Notification` class. It never imports the pipeline (01
dependency rule: nothing depends on the pipeline except ipc, and shell does not depend on it
either). Bootstrap (`src/main/index.ts`) wires the two together (§14.2). The body policy comes from
`registry.notificationPolicy()` (HOOK-UI-03, 01 §6.2).

### 14.2 Trigger and wiring

- Bootstrap subscribes to the job queue's `done` event and, for jobs of kind `'create'` only, calls
  `notifier.documentReady({slug, docId, title})` with the new document's catalog values (06 §5.7
  step 5).
- One notification per finished document. None for `failed` or cancelled jobs, section
  regenerations (08), section ELI5 tabs, merges (09), or publishes (10); those stay inline in the
  window as before.
- The notification is posted whenever `notifications.enabled` is true, even if the main window is
  visible and focused (the user may be reading another document). There is no focus check.
- `documentReady` does nothing when `notifications.enabled` is false or `isSupported()` is false.

### 14.3 Content

| Field | Value |
| --- | --- |
| `title` | "Document ready" |
| `body` | The document title, control and bidi characters stripped (as in §4.1), truncated to 120 chars + "…". When `notificationPolicy().hideTitle` is true: "Your document is ready" |
| `silent` | `true`. macOS Focus and Do Not Disturb are applied by the OS |
| other | No actions, reply field, image, or source content |

### 14.4 Click routing

The click is resolved **at click time**, not at post time, so a document published after it
finished (or auto-published) can be opened at its link.

- **`notifications.clickAction: 'app'`** (default): `showMainWindow()` (§3.2 step 6, recreating the
  window if needed), then `getMeta(slug)`. If the document exists: `viewer.open(slug)` (the same
  path as `eli5:library:open`) and emit `eli5:app:navigate {route: {view:'doc', slug}}`. If not
  (deleted or merged away): emit `eli5:app:navigate {route: {view:'not-found', slug}}` (§8).
- **`notifications.clickAction: 'published-link'`**: resolve a link from
  `DocumentMeta.publications` (10 §3.2), then `openExternal(url)`:
  1. Candidates are records whose `primaryUrl` is `https:`. Local exports (`kind:'local'`,
     `file:` links) never count.
  2. Preferred kind by `notifications.preferredLink`: `'drive'` = records of publisher kind
     `'drive'` (primary link is the organization cloud drive share link, `PublishLink` kind
     `share`); `'site'` = records of publisher kind `'git'` (primary link is the GitHub Pages link,
     `PublishLink` kind `site`); `'most-recent'` = any candidate. Pick the newest by `publishedAt`.
  3. If the preferred kind has no record, take the newest candidate of any kind.
  4. If there is no candidate, the document is gone, or `openExternal` rejects (invalid URL, rate
     limit, refused scheme), fall back to the `'app'` behavior and log `notification.fallback`.
- A just-finished document is usually unpublished, so the fallback is the common case. In the public
  edition no remote publisher exists, so a hand-set `'published-link'` always behaves as `'app'`.
- A click on a stale notification delivered after the app quit and relaunched is not delivered by
  Electron and needs no handling. While the app runs (it is a menu bar app that outlives its
  window, §3.2), clicks always arrive.

### 14.5 Reference retention

An unreferenced `Notification` can be garbage collected and lose its `click` handler. The notifier
keeps each live notification in a `Map<string, Notification>` (key: `slug` + post time) until its
`click` or `close` event, then deletes the entry. The map holds at most 20 entries; posting a 21st
calls `close()` on the oldest and removes it first.

### 14.6 Permissions and unsupported systems

- macOS asks the user for permission the first time the app posts a notification. Electron cannot
  read the authorization state, so if the user denied it, notifications silently do not appear.
  This is not an error. Settings > Notifications (§7) explains how to allow them: System Settings >
  Notifications > ELI5 Learner > Allow notifications.
- **Open macOS notification settings** (`eli5:app:open-notification-settings`) calls
  `shell.openExternal` with the fixed constant
  `x-apple.systempreferences:com.apple.Notifications-Settings.extension`, with the app's bundle id
  appended as the `id` query when available. This is the documented, narrow exception to the scheme
  rule in 12 §7.5: the URL is a main-process constant and never renderer-supplied.
- Unsigned or ad-hoc signed dev builds may not be allowed to post notifications. This is documented
  for developers, not an error.
- `Notification.isSupported()` false: no notification is ever created, and Settings shows
  "Notifications aren't supported on this system" with the controls disabled (§7).
- The web Notifications API stays denied in every renderer session (12 §7.3). Neither documents nor
  the app renderer can post notifications; only main does.

### 14.7 Test notification

`eli5:app:test-notification` calls `notifier.test()`: `{shown:false, reason:'unsupported'}` when
unsupported, `{shown:false, reason:'disabled'}` when `notifications.enabled` is false, otherwise it
posts "Document ready" with body "This is a test notification" and returns `{shown:true}`.
`shown:true` means the app asked macOS to show it; a denial by macOS is invisible to the app. A test
click shows the main window on Settings > Notifications.

### 14.8 Logging and privacy

- Log events `notification.shown`, `notification.clicked`, and `notification.fallback` with the
  fields `slug` and `kind` only. `kind` is defined per event: `notification.shown` is `'ready'` or
  `'test'`; `notification.clicked` is the resolved action, `'app'` or `'published-link'`;
  `notification.fallback` is always `'app'`. The title is never logged, because it is derived from source
  content.
- The body contains only the document title. The title comes from the model and can reflect private
  source material, so an overlay may replace it with a generic body (HOOK-UI-03).

<!-- hook:HOOK-UI-03 -->
> **Private hook · HOOK-UI-03 · Completion notification defaults.** Public behavior: notifications
> are enabled by default (`notifications.enabled: true`), a click opens the document in the app
> (`notifications.clickAction: 'app'`), the "Open its published link in my browser" option is
> disabled in Settings because no remote publisher is registered, and the body shows the document
> title (`notificationPolicy()` returns `{hideTitle:false}`). Private binding supplies: the
> organization default for `notifications.clickAction` and `notifications.preferredLink` (for
> example preferring the organization cloud drive share link), whether these keys are managed or
> locked, whether the notification body must hide the document title (generic "Your document is
> ready"), and any organization rule about notifications for documents built from organization
> sources. Key values arrive through `registerSettingsExtension` (HOOK-CFG-01) defaults and managed
> keys; the body policy arrives through the single-slot `registerNotificationPolicy(p:
> NotificationPolicy)`. Binding lives in the private spec under "HOOK-UI-03".

## Acceptance criteria

- [ ] Closing the main window (red button, `Cmd+W`, `Cmd+Q`) hides it and hides the Dock icon; the
      process, Tray item, and running jobs continue.
- [ ] Tray > Quit exits the app without confirmation; with active jobs its label reads
      "Quit ({n} jobs will resume)".
- [ ] OS log out / shut down is never blocked by the app: a `before-quit` from Dock > Quit or a
      system logout exits the process within 5 s, with or without active jobs.
- [ ] Launching the app again or clicking a Tray entry shows the existing window (single instance).
- [ ] Tray shows at most the 3 newest finished documents; a newly finished document appears without
      user action; clicking one opens it in the viewer, reopening the window if hidden.
- [ ] Library lists every finished document newest first by `createdAt`; clicking renders it in the
      viewer; raw HTML is never shown.
- [ ] Documents can be filed in one-level folders (create, rename, collapse, delete to Trash),
      archived, and trashed by drag, the context menu, `Cmd+Backspace` or a swipe (left Archive, right
      Trash); every move offers Undo; the Trash view puts documents back and empties with one inline
      confirmation; archived and trashed documents leave the Tray recents.
- [ ] Files can be dropped, clipboard content pasted with `Cmd+V`, and URLs entered, all combined
      into one job; Enter in the URL field turns addresses into chips and starts nothing; Cmd+Enter
      (or Enter outside the URL field) starts; sent inputs leave the chips and their URLs show as the
      Last run, which Run again re-sends and Use again returns to the chips; Clear (or `Cmd+N`)
      empties everything and is disabled while a start is in flight.
- [ ] The bottom panel resizes by drag and Arrow keys between its natural height and
      `min(2 × natural, 80%)` of the window, resets on double-click, and restores from `eli5.bottomPanel`.
- [ ] Start with no sources, an invalid URL, or no API key does not start a job and shows an inline
      hint; no modal, alert, or sheet appears anywhere in ingest and generation, and the only native
      notification is the completion notification (§14).
- [ ] Status area sits in the lower right, shows one pipeline-supplied line per job, and offers
      Cancel, Retry, and Dismiss inline.
- [ ] Merge suggestions appear in the sidebar Suggestions area with **Merge in** and **Keep
      separate** (09 §10.4 copy) and never steal focus.
- [ ] Settings is an in-window screen; provider, model, API key (Keychain), and glossary default work;
      unavailable providers and dormant keys have no controls in the public build.
- [ ] Settings > Library shows the root from `eli5:library:info`; Settings > Publishing sets
      `publish.local.dir` via the folder chooser, toggles `publish.local.revealAfter`, and links the
      Pages setup help page.
- [ ] **Export copy** calls `eli5:publish:run {slug, targetId:'local'}` without any picker and shows
      the 10 §7 result chip (**Copy link**, **Open**, **Show in Finder**); **Export Markdown** does
      the same for `targetId:'markdown'` and its "Open Markdown" link.
- [ ] **Undo** and **Redo** icon buttons sit left of the Versions toggle and Reveal in Finder, show
      the change label in their tooltip, may both be enabled at once, are disabled when unavailable
      or while a section of the document is busy, and `Cmd+Z` / `Shift+Cmd+Z` undo and redo the
      document only when focus is outside text fields; the viewer lands on the change undone.
- [ ] The Versions panel opens from the header toggle, `Cmd+Y` (also while the viewer has focus) and
      View > Show Versions; it shrinks the viewer (never overlaps it, never collapses another
      panel), persists its width and open state, and shows the narrow-window hint when it cannot fit.
- [ ] The panel lists every version as a tree with branches, the current, Published and snapshot
      removed chips, pending rows while a job runs, and the detached and degraded banners; clicking
      or pressing Enter on a version opens it and lands on its change with no confirm or modal;
      rows are disabled while busy; the tree is fully keyboard operable (§5.7) and passes axe in
      both themes.
- [ ] With a document open, `Cmd+F` opens the find bar above the viewer (the viewer shrinks), typing
      shows "x of y" or "No matches", `Cmd+G` / `Shift+Cmd+G` and `Enter` / `Shift+Enter` step
      through matches, `Escape` closes the bar, clears the highlight and focuses the viewer; the Edit
      > Find items work while the viewer has focus; `Option+Cmd+F`, and `Cmd+F` with no document
      shown, focus the Library filter.
- [ ] `eli5:jobs:start` is sent as `{inputs, options: {clarifyingInput, glossary}}`.
- [ ] In the public build, non-URL text in the URL field classifies as `invalid` and shows the inline
      error; no job starts.
- [ ] No microphone control exists in the UI, the `media` permission is denied, and the packaged
      Info.plist has no `NSMicrophoneUsageDescription`.
- [ ] No renderer element is ever drawn under the viewer; the viewer is detached on non-doc routes.
- [ ] In the public build, no publish (other than Export copy and Export Markdown), sign-in, or enterprise settings
      element exists in the DOM (HOOK-UI-01); About shows "Public edition" (HOOK-UI-02).
- [ ] Every shortcut in §9 works; all regions are reachable with F6; axe-core reports no serious or
      critical violations on each route in light and dark themes (13).
- [ ] Reduced motion, increased contrast, and 200% zoom are honored without layout breakage.
- [ ] When a create job reaches `done` with notifications enabled, exactly one native notification
      "Document ready" with the document title (≤ 120 chars) as body is posted, even if the window
      is focused; none is posted for failed jobs, section regenerations, section ELI5 tabs, merges,
      or publishes, or when `notifications.enabled` is false or notifications are unsupported.
- [ ] Clicking the notification with `clickAction: 'app'` shows the main window (recreating it if
      needed) and opens the document in the viewer; a deleted document shows the `not-found` route.
- [ ] With `clickAction: 'published-link'`, the click opens the newest `https` link of the preferred
      kind, else the newest remote link, else falls back to the app; local exports never count, and
      an invalid or refused URL falls back to the app.
- [ ] Live notifications are retained in a map of at most 20 (oldest closed first) and released on
      click or close.
- [ ] Settings > Notifications shows the enable switch, the click-action radios with the link
      select, **Send test notification**, the permission explanation, and **Open macOS notification
      settings**; in the public build the published-link option is disabled with the explanation text.
- [ ] Renderer sessions cannot post web notifications; logs for notification events carry only
      `slug` and `kind`, never the title; with HOOK-UI-03 `hideTitle:true` the body is "Your document
      is ready".
