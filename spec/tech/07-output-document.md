# Output document format

This file specifies the generated learning document: the `DocumentModel` / `Tab` / `Section` types
owned by `src/main/document/`, how a validated `DocumentDraft` from the LLM layer becomes a
`DocumentModel`, and how that model is rendered into one self-contained `index.html` (inlined CSS and
JS from `src/doc-runtime/`, inline SVG charts, embedded images, a CSP meta tag, no network requests at
view time). It also covers the tab bar (In depth, ELI5, Section ELI5 tabs), `SectionId` rules and
their stability guarantees, the WSJ-grade visual component catalogue and how the model asks for each
component, right-margin glossary callouts with responsive collapse, the references section
(including skipped sources), dark and light themes, print, and opening the file in any browser. It
implements PRD "Output document" (tabs, visual quality bar, in-context glossary, references,
structural requirement) and supplies the structural primitives that PRD "Interactive reading" and
"Library, storage, and merge suggestions" depend on. Selection handling and the action menu are
specified in [08](08-interactive-reading.md); this file only defines the markup they rely on.

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [03-source-resolvers.md](03-source-resolvers.md) · [04-extraction.md](04-extraction.md) · [05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [08-interactive-reading.md](08-interactive-reading.md) · [09-library-storage.md](09-library-storage.md) · [10-publishing.md](10-publishing.md) · [11-app-shell-ui.md](11-app-shell-ui.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

## 1. Responsibilities and boundaries

| This file owns | Owned elsewhere |
| --- | --- |
| `DocumentModel`, `Tab`, `Section`, `SectionId`, `DocBlock`, `GlossaryNote`, `ReferenceEntry` | `DocumentDraftTab`, `SectionDraft`, `DraftBlock`, `ChartSpec`, `GlossaryDraft` JSON schemas ([02](02-llm-provider.md) §10) |
| Draft → model conversion, semantic validation, sanitization of SVG and inline markdown | Prompt text, schema validation and repair loop ([02](02-llm-provider.md)) |
| Deterministic rendering model → `index.html`; parsing `index.html` → model | Writing files, locks, staging, atomic rename ([06](06-generation-pipeline.md) §5.7, [09](09-library-storage.md)) |
| Section ID minting, tab add/remove, section replace, merge append primitives | Deciding when to regenerate, merge, or delete a tab ([08](08-interactive-reading.md), [09](09-library-storage.md)) |
| `src/doc-runtime/` tabs, glossary layout, chart enhancement, stepper, theme, print | Selection bridge and action menu inside doc-runtime ([08](08-interactive-reading.md)); `window.eli5Doc` preload ([01](01-architecture.md) §5) |

The model never returns HTML. All markup in `index.html` is produced by the renderer in this module,
so every document is structurally valid and every section ID is app-controlled.

## 2. Source layout

```
src/main/document/
  index.ts            public entry: build, render, parse, mutate (section 8)
  model.ts            DocumentModel and related types
  ids.ts              SectionId / tab key minting and validation
  build.ts            DocumentDraftTab[] + GlossaryDraft + sources -> DocumentModel
  validate.ts         semantic checks, user-question stripping, limits
  inline-md.ts        inline markdown subset -> escaped HTML
  svg-sanitize.ts     allowlist sanitizer for model-supplied diagram SVG
  charts/             ChartSpec -> inline SVG (bar, stacked-bar, line, area, pie, scatter)
  glossary.ts         anchor resolution and placement
  references.ts       ResolvedSource / SkippedSource -> ReferenceEntry[]
  render/             one file per component, plus page.ts (skeleton) and csp.ts
  parse.ts            index.html -> DocumentModel (reads embedded model + assets)
  theme.ts            DocTheme defaults, skill theme input, HOOK-DOC-01 provider lookup
src/doc-runtime/
  index.ts            boot: feature detection, module init order
  tabs.ts  glossary.ts  charts.ts  stepper.ts  figure.ts  theme.ts  print.ts  scroll.ts
  selection.ts        owned by 08
  index.css           all document styles (tokens, layout, components, print)
```

The doc-runtime is built to one IIFE plus one CSS file and imported into main as `?raw` strings
(`DOC_RUNTIME_JS`, `DOC_RUNTIME_CSS`, [01](01-architecture.md) §8.1). It has no imports, no
`fetch`, no `XMLHttpRequest`, no `WebSocket`, no `eval`, and must run unchanged over `file://`,
`eli5doc://`, and `https://`. Budget: JS ≤ 40 KB minified, CSS ≤ 30 KB.

## 3. Types

```ts
// src/main/document/model.ts
export type SectionId = string & { readonly __brand: 'SectionId' };  // /^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/
export type TabKind = 'indepth' | 'eli5' | 'section-eli5';

export interface DocumentModel {
  formatVersion: 1;
  docId: string;                  // CatalogEntry.id (09); UUID v4
  slug: string;                   // topic slug, folder name under docs/
  title: string;                  // <= 120 chars, from the in-depth draft
  dek?: string;                   // one-sentence standfirst, <= 300 chars
  createdAt: string;              // ISO 8601 UTC
  updatedAt: string;              // bumped by every mutation
  generator: { app: string; version: string; edition: Edition; runtimeVersion: string };
  tabs: Tab[];                    // [indepth, eli5, ...section-eli5 in creation order]
  glossary: GlossaryNote[];       // in-depth tab only; [] when the toggle was off
  references: ReferenceEntry[];   // rendered as the last in-depth section
  assets: AssetRef[];             // images used by figure blocks (bytes live in the HTML, 5.6)
  theme: DocThemeRef;             // which theme tokens were applied (section 11)
}

export interface Tab {
  key: string;                    // 'indepth' | 'eli5' | 'sx' + 6 hex (section ELI5)
  kind: TabKind;
  label: string;                  // 'In depth' | 'ELI5' | 'ELI5: <heading>'
  createdAt: string;
  origin?: { sectionId: SectionId; selection: string };   // section-eli5 only
  placeholder?: true;             // ELI5 placeholder after eli5 step failure (06 §7.1)
  sections: Section[];            // 1..40 content sections (+ references section on indepth)
}

export interface Section {
  id: SectionId;
  kind: 'content' | 'references';
  heading: string;                // <= 120 chars
  blocks: DocBlock[];             // references: [] (rendered from DocumentModel.references)
  origin: 'generated' | 'regenerated' | 'merged' | 'merge-marker' | 'placeholder';
  updatedAt: string;
  lastAction?: 'expand' | 'reexplain' | 'analogy' | 'deeper';
  merge?: { fromDocId: string; fromTitle: string; mergedAt: string };   // moved sections -> data-merged-from
  mergeMarker?: { suggestionId: string; fromDocId: string; fromTitle: string; mergedAt: string;
                  sourceRefs: string[] };   // marker sections only -> data-merge-marker (8.1)
}

// DraftBlock (02 §10) with figures resolved to assets; every other variant is identical.
export type DocBlock =
  | Exclude<DraftBlock, { type: 'figure' }>
  | { type: 'figure'; assetId: string; caption: string; alt: string;
      annotations?: { x: number; y: number; text: string }[] };

export interface AssetRef { id: string; mime: 'image/png' | 'image/jpeg' | 'image/webp';
                            width: number; height: number; sha256: string; label: string }

export interface GlossaryNote {
  id: string;                     // 'g-' + 6 hex
  term: string; expansion?: string; explanation: string;   // explanation <= 400 chars
  sectionId: SectionId;           // in-depth section where the term first appears
  blockIndex: number;             // block inside that section holding the anchor
  anchorText: string;             // verbatim text wrapped in <dfn>
}

export interface ReferenceEntry {
  status: 'used' | 'skipped';
  kind: 'file' | 'url' | 'clipboard-text' | 'clipboard-image' | 'org';  // 'org': HOOK-DOC-02
  orgKind?: string;               // kind 'org' only: open string supplied by the HOOK-DOC-02 binding
                                  // (e.g. 'document-system' | 'file-store' | 'observability-system'
                                  //  | 'code-host' | 'ticketing-system'); rendered label per binding
  label: string;                  // file name (never a full path), page title, "Pasted text (412 words)"
  href?: string;                  // http(s) only
  detail?: string;                // e.g. "PowerPoint, 24 slides", "fetched via hidden window"
  reason?: string;                // skipped only: human-readable, from SkippedSource.reason
  addedBy?: { mergeFromTitle: string; mergedAt: string };
}

export interface DocThemeRef { id: string; version: string; source: 'default' | 'skill' | 'overlay' }
```

`Edition` comes from `src/main/editions/registry.ts` ([01](01-architecture.md) §6.2). `SkippedSource {ref, reason}` and
`ResolvedSource` come from [03](03-source-resolvers.md); `DocumentMeta.tabs` in
[09](09-library-storage.md) mirrors `Tab.key/kind/label` from this model.

## 4. Identifiers

### 4.1 Tab keys

| Tab | Key | Label |
| --- | --- | --- |
| In depth | `indepth` | `In depth` |
| ELI5 | `eli5` | `ELI5` |
| Section ELI5 | `sx` + 6 lowercase hex (e.g. `sx4e1a07`) | `ELI5: <source section heading>` |

Section ELI5 labels are truncated to 48 characters with an ellipsis (full text in the `title`
attribute). A label equal to an existing tab label gets a ` (2)`, ` (3)` suffix. Labels never
contain a bare number as the whole name (PRD "Section ELI5 tabs").

### 4.2 SectionId rules

1. Format: `"sec-" + tabKey + "-" + 8 lowercase hex`, for example `sec-indepth-3f9a1c2e`,
   `sec-sx4e1a07-0b77d912`. Validated by the regex in section 3.
2. Minted by `mintSectionId(tabKey, existing)` from `crypto.randomBytes(4)`. On collision with any ID
   already in the document (all tabs), draw again (max 8 draws, then throw `IdExhaustedError`).
3. Emitted twice on each `<section>`: `id="…"` and `data-section-id="…"`, with identical values.
4. The model never supplies or sees IDs ([02](02-llm-provider.md) §9). Section actions pass the
   `SectionId`; the reply is a `SectionDraft` that is written back under the same ID.

### 4.3 Stability guarantees

| Operation | Effect on IDs |
| --- | --- |
| Initial build | Every section gets a fresh ID; the references section gets one too |
| Regenerate section in place ([08](08-interactive-reading.md)) | ID unchanged; `origin='regenerated'`, `updatedAt` bumped |
| Add Section ELI5 tab | New tab key, new IDs for its sections; no existing ID changes |
| Close Section ELI5 tab | Its IDs are removed and never reused in this document (kept in `retiredIds` of `meta.json`, [09](09-library-storage.md)) |
| Merge append ([09](09-library-storage.md) §10.3) | Target IDs unchanged. Every incoming section gets a freshly minted SectionId under the target tab key (`sec-<tabkey>-<8 hex>`), with a collision check against the whole target document. `appendMergedDocument` returns `idMap` (old → new), which is used only to re-anchor glossary notes. Moved sections carry `data-merged-from="<sourceDocId>"`. Each marker section gets its own fresh ID |
| Re-render with a newer runtime | IDs unchanged |
| Glossary re-anchor | IDs unchanged |

An ID never moves to a different section and never changes while its section exists. Deep links
`index.html#sec-indepth-3f9a1c2e` therefore survive every edit.

## 5. Build: drafts → `DocumentModel`

```ts
export interface BuildInput {
  docId: string; slug: string; now: string;
  indepth: DocumentDraftTab;                   // required
  eli5: DocumentDraftTab | null;               // null -> placeholder tab (06 §7.1)
  glossary: GlossaryDraft | null;
  images: { label: string; mime: string; bytes: Uint8Array }[];   // ImageInput labels (02)
  resolved: ResolvedSource[]; skipped: SkippedSource[];
  theme: DocTheme;                             // section 11
}
export function buildDocumentModel(input: BuildInput): { model: DocumentModel; warnings: string[] };
```

### 5.1 Algorithm

1. Take `title` and `dek` from `indepth`. Trim, collapse whitespace, cap lengths (section 3).
2. For each tab draft, in order `indepth`, `eli5`: create the `Tab`, then for each `SectionDraft`
   mint an ID and convert blocks (5.2). Drop sections left with zero blocks after validation.
3. If `indepth` has zero sections after step 2, throw `DocumentBuildError('empty_indepth')`
   ([06](06-generation-pipeline.md) counts it as a retryable invalid output).
4. If `eli5` is null or ends with zero sections, create the placeholder tab: one section, normal
   ID, `origin='placeholder'`, text defined in [06](06-generation-pipeline.md) §6.
5. Resolve images: each `figure.imageLabel` must match an `images[].label`; the image is
   normalized (5.6) and stored once as an `AssetRef`. Unmatched figures are dropped with a warning.
6. Place glossary notes (section 9).
7. Build `references` from `resolved` and `skipped` (section 10), then append the references
   section to the in-depth tab.
8. Run document limits (5.4). Return the model and accumulated warnings.

### 5.2 Block conversion and validation

| Check | Action |
| --- | --- |
| Paragraph that is a question to the reader asking for input: starts with "would you like", "do you want", "shall I", "should I", "let me know", or "can you tell/clarify" and ends with `?` (case-insensitive) | Drop block ([06](06-generation-pipeline.md), clarifying input rule) |
| Inline markdown | Render through `inline-md.ts` only: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`; everything else is escaped text |
| Link URL | Allow `http:`, `https:`, `mailto:`; other schemes render the link text only |
| Chart series length ≠ categories length | Drop block (02 already checks; re-checked here) |
| Chart with > 30 categories | Keep top 29 by first series value, fold the rest into `Other` |
| Pie with negative values or > 6 slices | Convert to horizontal bar, warning `pie-converted` |
| Line/area/scatter with > 6 series | Keep first 6, warning |
| Diagram SVG | Sanitize (section 7). Empty result or > 100 KB after sanitizing: drop |
| Table row width ≠ header width | Pad with empty cells or truncate; warning |
| Table > 200 rows | Keep 200, add caption suffix "(first 200 rows)" |
| Stepper with < 2 steps | Convert to an ordered list |
| Duplicate heading in the same tab | Allowed; `aria-labelledby` uses the ID, not text |

### 5.3 Heading levels

Document title `h1` (header only). Section heading `h2`. Components may use `h3` for their own
titles (chart title, stepper title). The model cannot introduce headings inside a section.

### 5.4 Document limits

| Limit | Value | On exceed |
| --- | --- | --- |
| Tabs | 2 + 20 section ELI5 | `addSectionEli5Tab` throws `TooManyTabsError`; [08](08-interactive-reading.md) shows the message |
| Sections per tab | 40 content | Build keeps first 40, warning |
| Glossary notes | 40 | Keep first 40 by document order |
| Image asset | 1600 px long edge, ≤ 1.5 MB after encode | Downscale / re-encode (5.6) |
| Whole `index.html` | 25 MB | Warning only; logged, surfaced by 06 as a warning |

### 5.5 Determinism

Rendering is a pure function of the model plus `DOC_RUNTIME_JS/CSS` and the theme: fixed
attribute order, fixed whitespace, canonical JSON (sorted keys) for the embedded model, no clock
reads during render. Required properties: `render(parse(render(m))) === render(m)`, and a mutation
of one section changes only that section's bytes, the embedded model JSON, `updatedAt`, and (if
the runtime changed) the runtime blocks.

### 5.6 Images

Images are normalized in main with Electron `nativeImage`: resize to at most 1600 px on the long
edge, encode JPEG q=82 for photos, or PNG when the source is PNG with alpha or ≤ 256 colors. The
bytes appear once, as the `src` data URI of the rendered `<img data-asset-id="…">`. The embedded
model stores only `AssetRef` metadata; `parseDocument` recovers the bytes from the `img` elements.
Figure `alt` defaults to the caption when the model provides none.

## 6. `index.html` structure

### 6.1 Skeleton

```html
<!doctype html>
<html lang="en" data-eli5-format="1" data-theme="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="…see 6.2…">
  <meta name="referrer" content="no-referrer">
  <meta name="generator" content="ELI5 Learner 1.0.0 (public); runtime 1.0.0">
  <title>{title}</title>
  <style id="eli5-css">{DOC_RUNTIME_CSS}</style>
  <style id="eli5-theme">:root{ …token overrides… }</style>
  <script type="application/json" id="eli5-model">{canonical DocumentModel}</script>
</head>
<body>
  <header class="doc-head">
    <p class="kicker">Explainer</p><h1>{title}</h1><p class="dek">{dek}</p>
    <p class="doc-meta">Generated 27 Sep 2026 · 4 sources · 1 skipped</p>
  </header>
  <nav class="tabbar" role="tablist" aria-label="Document views">
    <button role="tab" id="tabbtn-indepth" aria-controls="tab-indepth" aria-selected="true">In depth</button>
    <button role="tab" id="tabbtn-eli5" aria-controls="tab-eli5" aria-selected="false">ELI5</button>
    <span class="tab-sx"><button role="tab" id="tabbtn-sx4e1a07" …>ELI5: Revenue recognition</button>
      <button class="tab-close" data-close-tab="sx4e1a07" aria-label="Close tab ELI5: Revenue recognition" hidden>×</button></span>
    <button class="theme-toggle" aria-label="Switch theme" hidden></button>
  </nav>
  <main>
    <div class="tabpanel" role="tabpanel" id="tab-indepth" data-tab-key="indepth" data-tab-kind="indepth" aria-labelledby="tabbtn-indepth">
      <section id="sec-indepth-3f9a1c2e" data-section-id="sec-indepth-3f9a1c2e" data-origin="generated"
               data-eli5-actionable="true" aria-labelledby="sec-indepth-3f9a1c2e-h">
        <h2 id="sec-indepth-3f9a1c2e-h">Why ad spend is judged by ROAS</h2>
        …blocks, glossary <aside>s…
      </section>
      …
      <section id="sec-indepth-9c01d2aa" data-section-id="sec-indepth-9c01d2aa" data-kind="references"
               data-eli5-actionable="false">…</section>
    </div>
    <div class="tabpanel" role="tabpanel" id="tab-eli5" …>…</div>
  </main>
  <footer class="doc-foot">Made with ELI5 Learner · {edition footer, HOOK-DOC-01}</footer>
  <script id="eli5-runtime">{DOC_RUNTIME_JS}</script>
</body>
</html>
```

Rules:

- All model text is HTML-escaped. The embedded JSON escapes `<` as `\u003c`, and U+2028/U+2029
  as `\u2028`/`\u2029`, so it can never close the script element or break the JS parser.
- No inline event handler attributes (`on*`) anywhere; the runtime binds listeners.
- No `<link>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<form>`, remote `src`/`href` for
  resources. Only anchors may point to remote URLs, and only as user-clicked navigation.
- Section wrappers (`<section>`) are direct children of their tab panel. Nothing else in the file
  carries `data-section-id`. This is the contract [08](08-interactive-reading.md) uses to find the
  enclosing section from a selection (`closest('section[data-section-id]')`).
- `data-eli5-actionable="false"` on the references section and absent on header/footer: the
  selection menu ([08](08-interactive-reading.md)) does not open there.
- Moved (merged) sections carry `data-merged-from="{fromDocId}"` on their `<section>` and no
  banner. The visible "Added from" banner is a separate **marker section** (8.1):
  `<section id=… data-section-id=… data-merge-marker="{suggestionId}" class="merge-marker">` with
  heading "Added from: {fromTitle}" and a line "Merged on {date}. Originally generated from:
  {source refs}". It is an ordinary actionable section.

### 6.2 Content Security Policy

```
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;
script-src 'sha256-{hash of DOC_RUNTIME_JS}'; connect-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'
```

The hash is computed at render time. The JSON model block is not executed (non-script MIME type),
so it needs no hash. `style-src 'unsafe-inline'` is needed for the theme block and chart SVG
presentation attributes; no remote styles are possible. The viewer's protocol-level CSP
([01](01-architecture.md) §2.2) also applies in the app; both policies are enforced, and the
stricter one wins. `frame-ancestors` cannot be set by meta and is not relied on.

### 6.3 Opening in any browser

The same file must work in the app viewer and when double-clicked in Chrome, Safari, and Edge
(PRD "Output document"), including over `file://`:

- The runtime is a classic IIFE script, not an ES module (module scripts fail over `file://`).
- The runtime detects the app with `typeof window.eli5Doc === 'object'`. In a plain browser, the
  selection menu, tab close buttons and in-app scroll hooks stay inactive; everything else works.
- All `localStorage` access is wrapped in `try/catch` (Safari throws on some `file://` pages);
  failure falls back to in-memory state.
- Progressive enhancement: the runtime adds `class="js"` to `<html>`. Without JS, all tab panels
  render stacked with their tab label as a heading, glossary notes render inline, steppers show all
  steps, and charts are already complete SVG. The document is fully readable with JS disabled.
- External links: `target="_blank" rel="noopener noreferrer"`. In the app, the runtime intercepts
  clicks and calls `window.eli5Doc.openExternal(url)`.

## 7. Visual components catalogue

The quality bar is WSJ explanatory journalism (PRD "In depth tab: visual quality bar"). The model
requests components only through `DraftBlock` variants ([02](02-llm-provider.md) §10); skills are
translated into those choices by the prompt, never into raw HTML. Adding a component requires a new
`DraftBlock` variant in 02, a renderer here, runtime behavior if interactive, and fixture tests
([13](13-testing-quality.md)).

### 7.1 Catalogue

| DraftBlock | Rendered as | Model asks for it when | Interactivity |
| --- | --- | --- | --- |
| `paragraph` | `<p>`; first paragraph of the first in-depth section gets a drop cap | Always | None |
| `list` | `<ul>`/`<ol>` | Parallel items, sequences | None |
| `pullquote` | `<figure class="pullquote"><blockquote>…<figcaption>` large serif, rule above and below | A striking line from a source worth remembering; at most 1 per 3 sections | None |
| `callout` | `<aside class="callout callout--{tone}">` with icon (note, warning, key point) | A caveat, risk, or takeaway that must not be missed | None |
| `table` | `<div class="table-wrap"><table>` with caption; numeric columns right-aligned, `tabular-nums` | Exact values the reader may look up | Horizontal scroll inside wrapper on narrow widths |
| `chart` | `<figure class="chart">` with inline SVG built at render time (7.2) | Source has numbers, comparisons, trends, or shares | Hover/focus tooltips, data disclosure |
| `diagram` | `<figure class="diagram">` with sanitized model SVG (7.3) | Structure, flow, architecture, relationships | None |
| `figure` | `<figure class="annotated">` with `<img>` and numbered annotation markers | An input image (screenshot, slide) benefits from callouts | Marker click/focus shows note; list of notes below image |
| `stepper` | `<div class="stepper">` with ordered steps | A process with 3–8 stages | Prev/next buttons and step dots; all steps visible without JS and in print |
| `analogy` | `<aside class="analogy">` with a "Think of it like" label | Mainly ELI5 and "Give me an analogy" actions | None |

Page-level elements the renderer adds (not model blocks): kicker, `h1`, dek, meta line, tab bar,
merge marker sections (8.1), references section, footer.

### 7.2 Charts (`src/main/document/charts/`)

Charts are rendered to static SVG in main at render time, using `d3-scale`, `d3-shape` and
`d3-format` (main-process dependencies only; nothing ships in the document). The runtime only adds
tooltips and the data disclosure. The `ChartSpec` is kept in the embedded model so a chart can be
re-rendered when the runtime or theme changes.

WSJ conventions enforced by the renderer:

1. `title` is displayed as a takeaway headline (the prompt asks for a sentence, e.g. "Paid search
   returns the most per dollar"); `subtitle` carries unit and scope; `source` renders as a small
   "Source:" line under the plot.
2. Bars always start at zero. Line and area y-domains are "nice" rounded extents; area starts at 0.
3. Horizontal gridlines only, light; no chart border, no 3D, no gradients, no drop shadows.
4. Direct labels at line ends when ≤ 4 series; otherwise a compact legend above the plot.
5. Bar charts switch to horizontal when any category label exceeds 14 characters or there are more
   than 8 categories. Value labels are printed on bars when ≤ 12 bars.
6. `highlight.category` gets the accent color and all other marks the muted series color; the note
   is drawn as a leader-line annotation.
7. Pies: ≤ 6 slices, largest first, clockwise from 12 o'clock, labels outside with percentages.
8. `null` values leave a gap in lines and an empty slot in bars (never zero).
9. Number formatting via `d3-format` with SI suffixes (`1.2M`); `unit` prefixes currency symbols and
   suffixes `%`.
10. Size: `viewBox` based, width 100% of the text column, height derived from type (bar: 28 px per
    category horizontal, 320 px vertical; line/area/scatter 320 px; pie 300 px).
11. Color is applied only through classes, never through presentation attributes holding `var()`
    (engines, notably WebKit over `file://`, do not reliably resolve `var()` in SVG presentation
    attributes). Marks get `class="viz-fill-N"` / `viz-stroke-N` (N = 1..8), `viz-fill-muted`,
    `viz-grid`, `viz-ink`; `DOC_RUNTIME_CSS` defines `.viz-fill-1{fill:var(--viz-1)}`,
    `.viz-stroke-1{stroke:var(--viz-1)}` and so on for every token, so marks switch with the theme
    without re-render.

Accessibility: `<svg role="img" aria-labelledby="{t} {d}">` with `<title>` and a generated `<desc>`
summary ("Bar chart, 5 categories, highest: Paid search 4.2"). Each mark carries
`data-label` and `data-value` and `tabindex="0"` for tooltip focus. A `<details class="chart-data">
<summary>Show data</summary><table>…</table></details>` follows every chart.

### 7.3 Diagram SVG sanitizer (`svg-sanitize.ts`)

Parse with `linkedom` in main, walk the tree, keep only allowlisted nodes:

- Elements: `svg g path rect circle ellipse line polyline polygon text tspan title desc defs marker
  linearGradient radialGradient stop clipPath use`.
- Attributes: geometry and presentation attributes (`d x y x1 y1 x2 y2 cx cy r rx ry width height
  points transform viewBox preserveAspectRatio fill stroke stroke-width stroke-dasharray
  stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity font-size font-weight
  text-anchor dominant-baseline marker-start marker-end marker-mid offset stop-color id
  role aria-label`), plus `href`/`xlink:href` on `use` only when it starts with `#`.
- Removed: `script`, `style`, `foreignObject`, `image`, `a`, `animate*`, `set`, every `on*`
  attribute, `style` attributes, any `url(` not of the form `url(#id)`.
- Model `class` attributes are stripped (they could collide with document CSS such as `gl-note` or
  `tab-close`); the only classes in the output are those the sanitizer adds below.
- Colors: every `fill`, `stroke` and `stop-color` value is removed as an attribute and replaced by a
  class. `none` stays as the attribute `fill="none"`/`stroke="none"`; `currentColor` becomes
  `viz-{fill|stroke}-ink`; `var(--viz-N|--ink|--muted|--paper|--rule)` maps to the matching
  `viz-{fill|stroke|stop}-{token}` class; any other color is mapped to the nearest palette token by
  hue and lightness first. `DOC_RUNTIME_CSS` defines every such class (7.2 rule 11), so diagrams
  follow dark and light themes in every engine. The prompt tells the model to use the tokens.
- IDs inside the SVG are prefixed with `d{8 hex}-` (and references rewritten) to avoid clashes
  with section IDs and other diagrams.
- Root gets `role="img"`, `aria-label` from `diagram.alt`, and a `viewBox` if missing (computed
  from `width`/`height`, else the block is dropped).

## 8. Module API (`src/main/document/index.ts`)

```ts
export function buildDocumentModel(input: BuildInput): { model: DocumentModel; warnings: string[] };
export function renderDocument(model: DocumentModel, assets: Map<string, Uint8Array>): string;
export function parseDocument(html: string): { model: DocumentModel; assets: Map<string, Uint8Array> };
export function getSectionContext(model: DocumentModel, id: SectionId): {
  tab: Tab; section: Section; draft: SectionDraft; prev?: SectionDraft; next?: SectionDraft; outline: string[] };
export function replaceSection(model: DocumentModel, id: SectionId, draft: SectionDraft,
  action: Section['lastAction'], now: string): { model: DocumentModel; warnings: string[] };
export function addSectionEli5Tab(model: DocumentModel, from: SectionId, selection: string,
  draft: DocumentDraftTab, now: string): { model: DocumentModel; tabKey: string };
export function removeTab(model: DocumentModel, tabKey: string, now: string): DocumentModel;
// src/main/document/merge.ts (contract required by 09 §10.3; TabRecord and DocumentMeta from 09)
export function appendMergedDocument(input: {
  targetHtml: string; targetMeta: DocumentMeta;
  sourceHtml: string; sourceMeta: DocumentMeta;
  suggestionId: string; mergedAt: string;
}): { html: string; tabs: TabRecord[]; markerSectionIds: SectionId[]; idMap: Record<SectionId, SectionId> };
export class DocumentFormatError extends Error { code: 'no_model' | 'bad_version' | 'invalid_model' }
export class DocumentBuildError extends Error { code: 'empty_indepth' | 'empty_tab' | 'empty_section' | 'invalid_merge' }  // empty_section: replaceSection got a draft with no valid blocks
```

All mutators are pure (return a new model); the caller renders and writes under
`library.withDocLock` ([06](06-generation-pipeline.md) §4). Notes:

- `parseDocument` reads `#eli5-model`, validates it with a zod schema, and checks
  `formatVersion`. A newer `formatVersion` than the app supports throws `bad_version` (the app shows
  "This document was made by a newer version"). Missing or invalid model JSON throws `no_model` /
  `invalid_model`; the document stays viewable but is not editable.
- `getSectionContext` returns the `SectionDraft` form of a section (figure `assetId` mapped back to
  its label) for [02](02-llm-provider.md) section prompts and [08](08-interactive-reading.md).
- `replaceSection` throws on `kind === 'references'` and on unknown IDs. After replacing, it
  re-anchors glossary notes of that section (9.3).
- `removeTab` accepts only `section-eli5` tabs; `indepth` and `eli5` cannot be removed.
- `appendMergedDocument` (called by [09](09-library-storage.md) §10.6 on accept) is not pure over
  models: it takes and returns HTML, and internally uses `parseDocument` and `renderDocument`. See 8.1.

### 8.1 Merge append algorithm (`merge.ts`)

1. `parseDocument(targetHtml)` and `parseDocument(sourceHtml)`. A `DocumentFormatError` on either
   propagates (09 maps it to `MERGE_FAILED`). Assets of both are combined (dedupe by `sha256`).
2. Collect `used` = every SectionId in the target, plus the target's `retiredIds` from
   `targetMeta` (4.3: closed IDs are never reused).
3. For each tab key `k` in (`indepth`, `eli5`): mint a **marker section** ID `sec-<k>-<8 hex>`
   with the 4.1 allocator, checked against `used` (add it to `used`). The marker section has
   `kind='content'`, `origin='merge-marker'`, heading `Added from: {sourceMeta.title}`, one
   paragraph block "Merged on {date}. Originally generated from: {source refs}" (labels from the
   source's used references), and `mergeMarker = {suggestionId, fromDocId, fromTitle, mergedAt,
   sourceRefs}`. It renders with `data-merge-marker="{suggestionId}"` and the runtime's banner style.
4. For each source content section in that tab, in order: mint a **new** ID under the target tab
   key `k` (collision-checked against `used`), record `idMap[oldId] = newId`, set
   `origin='merged'`, `merge = {fromDocId: sourceMeta.id, fromTitle, mergedAt}` (renders
   `data-merged-from`), and keep blocks unchanged.
5. In-depth: insert the marker then the moved sections at the end of the target's in-depth tab,
   **before** its references section. ELI5: append the marker then the moved sections to the target
   ELI5 tab (if the target ELI5 tab is a placeholder, the placeholder section stays; the moved ones
   follow it). If the source ELI5 tab is a placeholder, no ELI5 marker is added.
6. Source section ELI5 tabs are carried over with fresh tab keys (`sx` + 6 hex) and fresh section
   IDs (also recorded in `idMap`); `origin.sectionId` is rewritten through `idMap`; labels get a
   ` (2)` suffix on collision. Tab limit applies (oldest carried tab dropped first, with a warning).
7. Glossary: source notes anchored in moved in-depth sections are rewritten through `idMap`
   (`sectionId`), then re-anchored (9.3). A term already defined in the target
   (case-insensitive) is dropped from the moved copy.
8. References: source used and skipped references are appended with `addedBy`; the references
   section itself keeps its target ID.
9. Set `updatedAt = mergedAt`, `renderDocument(merged, assets)`, and return `{html, tabs:
   TabRecord[] in display order, markerSectionIds: [indepthMarker, eli5Marker?], idMap}`.
   `markerSectionIds[0]` is always the in-depth marker (09 scrolls the viewer to it).

Edge cases: a source with zero content sections in a tab yields no marker for that tab; a source
that is the same `docId` as the target throws `DocumentBuildError('invalid_merge')`; the function
never mutates target section IDs, so deep links into the target survive (4.3).

## 9. Glossary (in-depth tab only)

### 9.1 Placement algorithm

Input: `GlossaryDraft.entries` ([02](02-llm-provider.md): `term, expansion?, explanation,
anchorSectionIndex, anchorText`).

1. Drop entries with empty `term` or `explanation`; dedupe by lowercased `term`, keeping the first.
2. Map `anchorSectionIndex` to the in-depth content section at that index. Out of range: drop.
3. Search that section's text-bearing blocks (`paragraph`, `list` items, `callout`, `analogy`) in
   order for `anchorText`: exact match first, then case-insensitive, then whitespace-normalized.
   Text inside `code` spans and existing links is not matched.
4. Not found in that section: search following sections in order. Still not found: drop with warning
   `glossary-anchor-missing`.
5. If an earlier section also contains the anchor text, move the note to that earliest occurrence
   (PRD: "where it first appears").
6. Record `sectionId`, `blockIndex`, `anchorText`. At most one note per block anchor position; if two
   notes target the same block, both are placed, in anchor order.

### 9.2 Markup and layout

The anchor occurrence is wrapped: `<dfn class="gl-term" id="{noteId}-ref" aria-describedby="{noteId}">ROAS</dfn>`.
The note is rendered immediately after the block that contains the anchor:

```html
<details class="gl-note" id="g-1a2b3c" data-note-for="g-1a2b3c-ref">
  <summary><span class="gl-icon" aria-hidden="true"></span><b>ROAS</b> · return on ad spend</summary>
  <p>Revenue earned for each dollar spent on ads. A ROAS of 4 means $4 back per $1 spent.</p>
</details>
```

- **Wide (viewport ≥ 1100 px):** the page grid is `[text 680px max][gap 48px][margin 260px]`.
  Notes are floated into the margin column (`float:right; clear:right; margin-right:-308px;
  width:260px`) so each note's top aligns with the block that contains its anchor, and stacked
  notes push down without overlapping. The runtime sets `open` on all notes and hides the
  `summary` disclosure marker, so notes read as always-visible textbook sidebars with a lightbulb
  icon (inline SVG in CSS as a data URI), tinted background, and a left rule.
- **Narrow (< 1100 px):** notes render inline, collapsed, below their block as an expandable
  lightbulb chip. Clicking the `dfn` term toggles and focuses its note. The runtime listens to
  `matchMedia('(min-width: 1100px)')` and switches state on change without reload.
- **No JS:** notes are inline `details`, collapsed, still expandable.
- Hovering or focusing a margin note highlights its `dfn` (and vice versa) via a shared class.
- Glossary is never rendered as a list at the end (PRD). ELI5 and section ELI5 tabs never get notes.

### 9.3 After regeneration

When a section is replaced, its notes are re-anchored inside the replaced section only (08 §6.5
rule 2): first by `anchorText`, then by `term`. A note that matches neither is dropped with the
warning `glossary-dropped`. Notes never move to another section, because the byte-diff rule (§5.5)
forbids changing any other section. v1 does not create new notes on regeneration. Notes anchored in
other sections are untouched.

## 10. References section

Built deterministically from sources, never by the model ([02](02-llm-provider.md) §9). It is the
last section of the in-depth tab: heading "Sources", `kind='references'`, a normal `SectionId`,
not actionable.

| Source | `label` | `href` | `detail` |
| --- | --- | --- | --- |
| Local file | File name only (never the full path; documents may be shared) | none | Type and size, e.g. "PowerPoint, 24 slides" |
| Public URL | Page title from extraction, else host + path | The URL | "Fetched page" or "Rendered page" (hidden window) |
| Pasted text | "Pasted text" | none | Word count |
| Pasted image | "Pasted image" | none | Pixel dimensions |
| Organization source (enterprise) | See HOOK-DOC-02 | See HOOK-DOC-02 | See HOOK-DOC-02 |

Layout: an ordered list "Used" in input order, then a list "Skipped" (only if any), each item as
`label — reason`, e.g. "pricing.example.com/login — page required login". Reasons come from
`SkippedSource.reason` codes mapped to human strings by [03](03-source-resolvers.md); unknown codes
render as "could not be read". Merged references appear in a third group "Added by merge". URLs
are shown as text and as a link; label text is escaped.

<!-- hook:HOOK-DOC-02 -->
> **Private hook · HOOK-DOC-02 · References for organization sources.** Public behavior: only `file`, `url`, `clipboard-text` and `clipboard-image` entries exist; `kind='org'` is never produced. Private binding supplies: how sources resolved through the MCP lane (HOOK-SRC-01, HOOK-SRC-02) are labeled per system kind (document system, file store, observability system, code host, ticketing system), including the values of `ReferenceEntry.orgKind` (an open string the binding defines); whether and how the canonical organization URL is linked; display format for ticket identifiers; any fields that must be omitted from references in documents shared organization-wide. Binding lives in the private spec under "HOOK-DOC-02".

## 11. Theme, dark and light

### 11.1 Tokens

`index.css` defines all colors, fonts and spacing as custom properties on `:root`, redefined for
dark mode under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`
and again under `:root[data-theme="dark"]`. The body always has an explicit background.

| Token group | Tokens |
| --- | --- |
| Surface and text | `--paper --paper-2 --ink --ink-2 --muted --rule --link` |
| Accent | `--accent --accent-ink --highlight` |
| Data viz | `--viz-1 … --viz-8` (categorical, checked for contrast in both themes), `--viz-muted`, `--viz-grid` |
| Components | `--callout-note --callout-warning --callout-key --gl-bg --gl-rule --pull-rule` |
| Type | `--font-serif: Charter, "Iowan Old Style", Georgia, serif` (body, headlines, pull quotes); `--font-sans: -apple-system, "Helvetica Neue", Arial, sans-serif` (kicker, tab bar, chart labels, meta, notes) |
| Measure | Body 19 px / 1.6 in the text column (max 680 px); side gutter 16 px on phones |

No web fonts are embedded by default (system fonts only; keeps files small and offline).

### 11.2 Switching

- Default `data-theme="auto"` follows the OS. In the app, Electron's `nativeTheme` drives
  `prefers-color-scheme` in the viewer, so the document follows the app.
- A theme toggle button in the tab bar (hidden until the runtime boots) cycles auto → light → dark
  and stores the choice in `localStorage` key `eli5.theme` (try/catch; per-viewer convenience only).
- Charts and diagrams use tokens via classes (`.viz-fill-1{fill:var(--viz-1)}`, 7.2 rule 11), never
  `var()` inside presentation attributes, so they switch with the theme without re-render in every
  engine. Embedded raster images are unchanged in dark mode; they get a 1 px `--rule`
  border.

### 11.3 Theme inputs

`DocTheme = { id; version; tokens: Record<TokenName, string>; footer?: string; logoSvg?: string }`.
Precedence: default theme < skill theme input (CSS custom properties supplied by the beautiful-doc
skill, [02](02-llm-provider.md) §11) < overlay theme (HOOK-DOC-01). Only known token names are
accepted and values must match `^(#[0-9a-f]{3,8}|rgb\(…\)|hsl\(…\)|oklch\(…\)|[a-z-]+|[0-9.]+(px|rem|em)?|"[^"<>]*"( ?, ?[a-zA-Z "-]+)*)$`;
anything else is dropped with a warning. The theme is written into `#eli5-theme` and recorded in
`DocumentModel.theme`.

<!-- hook:HOOK-DOC-01 -->
> **Private hook · HOOK-DOC-01 · Organization document theme and branding.** Public behavior: neutral default theme, footer "Made with ELI5 Learner", no logo, no classification label; the registry's `docTheme` capability returns the default `DocTheme`. Private binding supplies: organization token overrides (colors, fonts, optionally a data-URI embedded font within a size cap), a logo SVG (sanitized by 7.3 rules) for the header kicker, a footer or data-classification label, whether the theme applies to every document or only to documents published through HOOK-PUB-01 / HOOK-PUB-03, and the theme `id`/`version` for traceability. Registered through the capability registry per HOOK-CFG-02. Binding lives in the private spec under "HOOK-DOC-01".

## 12. Tab bar behavior (`tabs.ts`)

1. Order: In depth, ELI5, then section ELI5 tabs by `createdAt` (new tabs appear to the right).
2. In depth is active on open. `location.hash` wins when present: `#tab=<key>` selects a tab;
   `#sec-…` selects the tab containing that section and scrolls to it.
3. WAI-ARIA tabs pattern: roving `tabindex`, Left/Right/Home/End move focus, Enter/Space
   activates. Inactive panels get `hidden`. Hash is updated with `history.replaceState`.
4. The bar is `position: sticky; top: 0` with a paper background; on narrow widths it scrolls
   horizontally (no wrapping) and the active tab is scrolled into view.
5. Close buttons on section ELI5 tabs are un-hidden only when `window.eli5Doc` exists. Click calls
   `eli5Doc.closeTab(key)`; the document is re-rendered by main and the viewer reloads
   ([08](08-interactive-reading.md)). In a plain browser, tabs cannot be closed.
6. `scroll.ts` handles `eli5Doc.onScrollTo({sectionId?, tabKey?})`; its behavior (scroll offset,
   flash duration, focus move, reduced motion) is owned by [08](08-interactive-reading.md) §7.4.
   07 exposes what 08 needs: `activateTab(key, {history: false})` on the runtime's internal tab
   API (activates without touching `location.hash` history), and the CSS variable
   `--eli5-tabbar-h`, kept equal to the sticky tab bar's rendered height (updated by a
   `ResizeObserver`), which sections use as `scroll-margin-top`.
7. Each section ELI5 tab begins with a small "From: <source heading>" link that jumps to the
   originating section (if it still exists).

## 13. Print (`@media print` + `print.ts`)

- Prints the active tab only, preceded by the document header; tab bar, theme toggle, tab close
  buttons and the selection menu are hidden.
- Forced light palette regardless of theme; backgrounds removed except callouts and notes
  (`print-color-adjust: exact` for charts and callouts).
- Glossary notes print as open, compact boxes after their block (no margin float at print widths).
- Steppers print all steps; chart data disclosures stay closed; tooltips are not printed.
- External links print their URL after the link text (`a[href^="http"]::after`).
- `break-inside: avoid` on figures, charts, tables ≤ 30 rows, callouts, pull quotes; `h2` has
  `break-after: avoid`. Page margins 18 mm, body 11 pt.
- `print.ts` listens to `beforeprint` to open notes and restore state on `afterprint`.

## 14. Runtime boot order (`src/doc-runtime/index.ts`)

1. Add `js` class; read theme preference; apply `data-theme`.
2. `tabs.init()` (resolves hash), `glossary.init()`, `charts.init()`, `stepper.init()`,
   `figure.init()`, `print.init()`.
3. If `window.eli5Doc` exists: `selection.init()` ([08](08-interactive-reading.md)), un-hide close
   buttons, `scroll.init()`, link interception.
4. Every module is wrapped in `try/catch`; a failing module logs to the console and leaves the
   no-JS fallback in place for its components.

## 15. Edge cases and errors

| Situation | Behavior |
| --- | --- |
| ELI5 draft missing | Placeholder tab (5.1 step 4); still a normal, actionable section |
| All in-depth sections invalid | `DocumentBuildError('empty_indepth')`; 06 retries, then fails the job |
| Model text contains `<script>` or HTML | Escaped as text; never interpreted |
| Diagram contains script, external image, or event handler | Stripped by sanitizer; block kept if anything valid remains |
| Figure references an unknown image label | Block dropped with warning |
| Very large image | Downscaled per 5.6 |
| Glossary anchor not found anywhere | Note dropped with warning |
| Regeneration removes a glossary anchor | Note re-anchored later or dropped (9.3) |
| Opening a document with an older `formatVersion` | Rendered as stored; on first mutation the model is migrated and the file re-rendered with the current runtime |
| Opening a document with a newer `formatVersion` | View-only, action menu disabled, message in status area |
| `#eli5-model` hand-edited to invalid JSON | View-only; `DocumentFormatError('invalid_model')` logged |
| `localStorage` unavailable | Theme choice not remembered; no error |
| Two section ELI5 tabs from the same heading | Labels suffixed ` (2)` |
| User closes a tab that has an in-flight section job | [08](08-interactive-reading.md) decides; `replaceSection` on a removed ID throws and nothing is written |
| Document opened in Safari over `file://` | Works; CSP permits only inline, data, and hashed runtime |

## 16. Acceptance criteria

- [ ] `buildDocumentModel` + `renderDocument` produce one `index.html` that loads in Chrome, Safari
      (Playwright WebKit) and Edge over `file://` with zero network requests (asserted by request
      interception) and zero console errors.
- [ ] The CSP meta tag matches 6.2, and the runtime script hash matches its content.
- [ ] Every `<section>` in every tab has `id === data-section-id` matching
      `^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$`, unique across the document.
- [ ] `render(parse(render(m))) === render(m)` for all fixture models.
- [ ] `replaceSection` changes only the target section's bytes, the model JSON and `updatedAt`
      (byte diff test), and the section keeps its ID.
- [ ] Adding and closing section ELI5 tabs never changes any other section's ID; closed IDs are not
      reused.
- [ ] Tab order is In depth, ELI5, then section ELI5 tabs by creation; In depth opens first;
      labels read "ELI5: <heading>".
- [ ] Every `DraftBlock` variant renders per 7.1, and every chart kind renders per 7.2 in both
      themes with a data table disclosure.
- [ ] Sanitizer fixtures: script, `foreignObject`, `on*`, external `href`, `url(http…)`, and
      `style` payloads are all removed.
- [ ] Glossary notes appear in the right margin at ≥ 1100 px aligned with their anchor block, as
      collapsed inline notes below that width, and never as an end-of-document list; ELI5 tabs have
      none.
- [ ] The references section lists every used source and every skipped source with its reason,
      shows file names without paths, and is not actionable.
- [ ] Dark and light themes both pass WCAG AA contrast for body text, and the toggle works without
      reload.
- [ ] Print preview of each tab shows no tab bar, open glossary notes, all stepper steps, and no
      split charts.
- [ ] With JS disabled, all content (all tabs, notes, charts, steps) is readable.
- [ ] Public build output contains no organization branding and no `kind:'org'` references; theme
      and reference rendering for the enterprise edition come only through HOOK-DOC-01 and
      HOOK-DOC-02.
- [ ] `appendMergedDocument` fixture test: target IDs are byte-identical before and after; every
      moved section has a new ID matching the 4.2 pattern with `data-merged-from`; `idMap` covers
      every moved section; one marker section with `data-merge-marker` and heading "Added from:
      {title}" precedes the moved sections in the in-depth tab (before references) and in the ELI5
      tab; `markerSectionIds[0]` is the in-depth marker.
- [ ] Chart and diagram marks in WebKit and Chromium (Playwright, `file://`, both themes) have a
      computed `fill` or `stroke` that is not the default (`rgb(0, 0, 0)` / `none` where a color was
      intended); no output SVG contains `var(` inside an attribute or a model-supplied `class`.
