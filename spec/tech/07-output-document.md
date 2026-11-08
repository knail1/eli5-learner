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
| Section ID minting, tab add/remove, section replace, woven merge (apply a merge plan, enhancement marks) | Deciding when to regenerate, merge, or delete a tab ([08](08-interactive-reading.md), [09](09-library-storage.md)) |
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
  animation/          AI-authored animation block (7.1): limits, lint, frame shell, srcdoc + CSP,
                      figure renderer, frame validity
  glossary.ts         anchor resolution and placement
  references.ts       ResolvedSource / SkippedSource -> ReferenceEntry[]
  render/             one file per component, plus page.ts (skeleton) and csp.ts
  parse.ts            index.html -> DocumentModel (reads embedded model + assets)
  theme.ts            DocTheme defaults, skill theme input, HOOK-DOC-01 provider lookup
  render/credit.ts    stock photo credit line and license names (7.4)
src/main/photos/      stock photos (7.4): providers, query guard, slot resolution, sizing
src/doc-runtime/
  index.ts            boot: feature detection, module init order
  tabs.ts  glossary.ts  charts.ts  stepper.ts  figure.ts  theme.ts  print.ts  scroll.ts
  animation.ts        animation frames: theme in, height out (7.1)
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
export type TabKind = 'indepth' | 'eli5' | 'ste' | 'section-eli5';   // TAB_KINDS in src/preload/contract.ts

export interface DocumentModel {
  formatVersion: 1;
  docId: string;                  // CatalogEntry.id (09); UUID v4
  slug: string;                   // topic slug, folder name under docs/
  title: string;                  // <= 120 chars, from the in-depth draft
  dek?: string;                   // one-sentence standfirst, <= 300 chars
  createdAt: string;              // ISO 8601 UTC
  updatedAt: string;              // bumped by every mutation
  generator: { app: string; version: string; edition: Edition; runtimeVersion: string };
  tabs: Tab[];                    // [indepth, eli5, ste?, ...section-eli5 in creation order] (12)
  glossary: GlossaryNote[];       // in-depth tab only; [] when the toggle was off
  references: ReferenceEntry[];   // rendered as the last in-depth section
  assets: AssetRef[];             // images used by figure blocks (bytes live in the HTML, 5.6)
  theme: DocThemeRef;             // which theme tokens were applied (section 11)
  merges?: MergeLegendEntry[];    // woven merges, oldest first: one legend line each (6.4)
}

export interface MergeLegendEntry { id: string; fromTitle: string; mergedAt: string }  // id 'm1', 'm2', …

/** 'selection': an "ELI5 this selection" tab (08 §7.5); sectionIds = covered sections, first = sectionId. */
export interface TabOrigin { sectionId: SectionId; selection: string; scope?: 'selection'; sectionIds?: SectionId[] }

export interface Tab {
  key: string;                    // 'indepth' | 'eli5' | 'ste' | 'sx' + 6 hex (section ELI5)
  kind: TabKind;
  label: string;                  // 'In depth' | 'ELI5' | 'ASD-STE100' | 'ELI5: <heading>'
  createdAt: string;
  origin?: TabOrigin;             // section-eli5 only
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
  lastAction?: SectionChange;     // 'expand' | 'reexplain' | 'analogy' | 'deeper' | 'revise' | 'ask' (08 §3)
  merge?: { fromDocId: string; fromTitle: string; mergedAt: string };   // sections a merge inserted -> data-merged-from
  enh?: SectionEnhancement;       // woven-merge highlights (6.4); dropped when the section is regenerated
  mergeMarker?: { suggestionId: string; fromDocId: string; fromTitle: string; mergedAt: string;
                  sourceRefs: string[] };   // legacy appended merges only (rendered, never created)
}

// 6.4: inserted text as [start, end) offsets into the plain text (inlineText) of one inline string.
export interface EnhRange { merge: string; start: number; end: number }
export type BlockEnhancement =
  | { block: number; kind: 'new' | 'updated'; merge: string }      // whole block added / visual changed
  | { block: number; kind: 'text'; parts: EnhRange[][] };           // per inline string of the block
export interface SectionEnhancement { added?: string; blocks: BlockEnhancement[] }  // added: whole section new

// DraftBlock (02 §10) with figures resolved to assets, plus the doc-only answer box; every other
// variant is identical. Photos become figures at build time (7.4). An `animation` block keeps the
// draft shape { type, title, caption, alt, poster, html?, css?, js } with the poster sanitized and
// the code checked at build time (5.2, 7.1).
export type DocBlock =
  | Exclude<DraftBlock, { type: 'figure' } | { type: 'photo' }>
  | FigureDocBlock               // { type: 'figure'; assetId; caption; alt; annotations? }
  | QaDocBlock;

/** A reader's question and its answer (08 §6.8, 6.5). Never a DraftBlock: the model cannot emit it. */
export interface QaDocBlock {
  type: 'qa';
  id: string;                     // 'q-' + 8 hex (4.2)
  question: string;               // the reader's question, one line, 1..500 chars
  topic: string;                  // 1..48 chars, a short name for what was asked (from the model)
  quote: string;                  // <= 160 chars, excerpt of the selection it answers
  paragraphs: string[];           // 1..4 inline-markdown paragraphs, each <= 1200 chars
  askedAt: string;
}

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
  addedBy?: { mergeFromTitle: string; mergedAt: string; mergeId?: string };
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
| ASD-STE100 (optional) | `ste` | `ASD-STE100` |
| Section ELI5 | `sx` + 6 lowercase hex (e.g. `sx4e1a07`) | `ELI5: <source section heading>` |

One canonical pattern, `TAB_KEY_RE = /^(?:indepth|eli5|ste|sx[0-9a-f]{6})$/`, and the `TAB_KINDS`
list live in `src/preload/contract.ts`; the document, library, draft and preload checks import
them. The sync protocol keeps its older pattern on purpose ([16](16-android-companion.md) §4.4).

The ASD-STE100 tab is optional and fixed: it exists only when its generation step succeeded (never
a placeholder), it is never closable, In depth stays the default tab, and the glossary and the
references stay in the in-depth tab. Its panel starts with a hint, `TAB_HINTS.ste` in
`render/page.ts`, rendered after the panel title as
`<p class="tab-hint" id="tab-hint-ste" data-eli5-noact>`; the tab button carries
`aria-describedby="tab-hint-ste"` and the same text as its `title`:

> ASD-STE100 is Simplified Technical English, a writing standard that began in aerospace
> maintenance manuals in the late 1970s. Sentences are short (instructions at most 20 words,
> descriptions at most 25), each sentence gives one instruction, one word keeps one meaning, and
> verbs are in the active voice.

The hint is plain HTML, so it shows without JavaScript, in print (13) and on Android.

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
5. Answer boxes (6.5) get `"q-" + 8 lowercase hex` from `mintQaId(src, taken)`, where `taken` is
   every section ID, glossary note ID, answer-box ID and `retiredIds` entry of the document. The ID
   is the box's `id` attribute, so `index.html#q-1a2b3c4d` deep-links to it. It never carries
   `data-section-id`.

### 4.3 Stability guarantees

| Operation | Effect on IDs |
| --- | --- |
| Initial build | Every section gets a fresh ID; the references section gets one too |
| Regenerate section in place ([08](08-interactive-reading.md)) | ID unchanged; `origin='regenerated'`, `updatedAt` bumped |
| Add Section ELI5 tab | New tab key, new IDs for its sections; no existing ID changes |
| Close Section ELI5 tab | Its IDs are removed and never reused in this document (kept in `retiredIds` of `meta.json`, [09](09-library-storage.md)) |
| Woven merge, target with an ASD-STE100 tab | The merge output drops the `ste` tab; its IDs go to `retiredIds` ([09](09-library-storage.md) §10.3) |
| Woven merge ([09](09-library-storage.md) §10.3) | Target IDs unchanged: a revised section keeps its ID. Every inserted section gets a freshly minted SectionId under the target tab key (`sec-<tabkey>-<8 hex>`), checked against the whole target document and its `retiredIds`, and carries `data-merged-from="<sourceDocId>"`. Source SectionIds never enter the target |
| Re-render with a newer runtime | IDs unchanged |
| Glossary re-anchor | IDs unchanged |
| Ask ([08](08-interactive-reading.md) §6.8) | Section ID unchanged; a new answer-box ID (4.2 rule 5) |
| Section rewritten after an Ask | Answer boxes keep their IDs; they move to the end of the section (8) |
| Checkout of another version ([09](09-library-storage.md) §4.1) | The checked-out version's IDs are restored; every ID that exists in the live document or either version's `retiredIds` but not in the target is added to `retiredIds`, so an ID is never reused across branches ([08](08-interactive-reading.md) §6.7) |

An ID never moves to a different section and never changes while its section exists. Deep links
`index.html#sec-indepth-3f9a1c2e` therefore survive every edit.

## 5. Build: drafts → `DocumentModel`

```ts
export interface BuildInput {
  docId: string; slug: string; now: string;
  indepth: DocumentDraftTab;                   // required
  eli5: DocumentDraftTab | null;               // null -> placeholder tab (06 §7.1)
  ste?: { tab: DocumentDraftTab;               // optional ASD-STE100 tab (kind 'ste'); absent/null -> no tab
          origins: (KeepOrigin | null)[][] } | null;  // per STE block: its in-depth draft {section, block}, null for STE text
  reservedIds?: Iterable<SectionId>;           // never minted (a rebuild: live, retired and older-version IDs)
  createdAt?: string;                          // model.createdAt override (a rebuild keeps the original); default now
  glossary: GlossaryDraft | null;
  images: { label: string; mime: string; bytes: Uint8Array }[];   // ImageInput labels (02)
  photos?: StockPhotoInput[];                  // resolved stock photo slots (7.4)
  resolved: ResolvedSource[]; skipped: SkippedSource[];
  theme: DocTheme;                             // section 11
}
export interface KeepOrigin { section: number; block: number }
export function buildDocumentModel(input: BuildInput): { model: DocumentModel; warnings: string[] };
```

### 5.1 Algorithm

1. Take `title` and `dek` from `indepth`. Trim, collapse whitespace, cap lengths (section 3).
2. For each tab draft, in order `indepth`, `eli5`, `ste`: create the `Tab`, then for each
   `SectionDraft` mint an ID (never one in `reservedIds`) and convert blocks (5.2). Drop sections
   left with zero blocks after validation. A kept visual in the `ste` tab resolves its stock photo
   slot through its origin, `photoSlotKey('indepth', section, block)`, so it shows the in-depth
   asset; its kept animations mirror in-depth ones and are counted but not dropped by the tab and
   document caps, and the tab never holds more animations than the in-depth tab.
   An `ste` tab left with zero sections is omitted with warning `ste-omitted` (no placeholder).
3. If `indepth` has zero sections after step 2, throw `DocumentBuildError('empty_indepth')`
   ([06](06-generation-pipeline.md) counts it as a retryable invalid output).
4. If `eli5` is null or ends with zero sections, create the placeholder tab: one section, normal
   ID, `origin='placeholder'`, text defined in [06](06-generation-pipeline.md) §6.
5. Resolve images: each `figure.imageLabel` must match an `images[].label`; the image is
   normalized (5.6) and stored once as an `AssetRef`. Unmatched figures are dropped with a warning.
   Resolved `photo` slots become credited figures; unresolved ones are dropped (7.4).
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
| Chart text (`charts/normalize.ts`) | Strip inline emphasis; ALL CAPS to sentence case, acronyms kept (§7.2 rule 13) |
| Chart category repeated (after text normalization), not scatter | Merge into the first occurrence: bar, stacked bar and pie sum each series (an all-null group stays null); line and area keep the first non-null value; the footnote names the combined categories ("Repeated A and B combined (values added)." or "(first value shown)."); warning `chart-categories-merged`. Never a repair call or a drop |
| Chart title blank | Derive it from the section heading, else the y-axis label, else the first series name, else "Chart" (capped at 120 characters, like a heading); warning `chart-title-derived`. Never a repair call or a drop |
| Chart with > 30 categories | Keep top 29 by first series value, fold the rest into `Other` |
| Chart series missing > 20 % of its values (and more than one), not scatter | Drop the series and name it in the note, warning `chart-series-sparse`; when every series drops, the block becomes a table (title as caption, "No data" cells), warning `chart-sparse-tabled` |
| Pie with negative values | Convert to horizontal bar, warning `pie-converted` |
| Pie with > 5 slices | Keep the 4 largest, fold the rest into `Other`, warning `pie-slices-folded` |
| Line/area/scatter with > 4 series; bar with > 4 series | Lines: keep the 4 largest by mean \|value\| (a highlight names a category, never a series); grouped bars: the 4 largest totals; stacked bars: 3 largest plus an `Other` series; note "N more series not shown." (not for stacked); warning `chart-series-capped` |
| Chart `order: "value"` | Sort bar and stacked-bar categories largest first; lines keep their order |
| Chart annotations | Keep up to 3 on known categories, one per category, text ≤ 80 characters; warning `chart-annotations-dropped` |
| Chart footnote | Keep ≤ 200 characters; append "No data for A, B." for remaining gaps |
| Diagram SVG | Sanitize (section 7). Empty result or > 100 KB after sanitizing: drop |
| Table row width ≠ header width | Pad with empty cells or truncate; warning |
| Table > 200 rows | Keep 200, add caption suffix "(first 200 rows)" |
| Stepper with < 2 steps | Convert to an ordered list |
| Animation without a title or alt, with a poster that does not survive the diagram sanitizer (7.3, ≤ 64 KB after it), with empty `js`, with `js` > 16 KiB, `html` > 4 KiB or `css` > 4 KiB (UTF-8), or with a lint hit (7.1 animation lint) | Drop block, warning `animation-dropped`; never a repair request (02 §10.1) |
| Animation text and code | Title ≤ 90, caption ≤ 300, alt ≤ 400 characters (word-boundary cut); control characters stripped and CR normalized in `html`, `css` and `js` (attribute escaping would otherwise change the code its hash pins); empty `html`/`css` omitted |
| Animation keep marker (`poster` and `js` both `"keep"`, 8) | In a regenerated section: the section's own animation in order, with the new title, caption and alt when given; anywhere else, or with none left: drop, warning `animation-dropped` |
| More than 1 animation per section, 2 per tab or 4 per document | Keep the first ones in build order (a regenerated section counts the tab's other sections; a merge counts what the target holds, minus the animations of each section it revises, and kept blocks always stay), drop the rest, warning `animation-dropped` |
| Duplicate heading in the same tab | Allowed; `aria-labelledby` uses the ID, not text |

### 5.3 Heading levels

Document title `h1` (header only). Section heading `h2`. Components may use `h3` for their own
titles (chart title, stepper title). The model cannot introduce headings inside a section.

### 5.4 Document limits

| Limit | Value | On exceed |
| --- | --- | --- |
| Tabs | 2 or 3 fixed (`indepth`, `eli5`, optional `ste`) + 20 section ELI5 | `addSectionEli5Tab` throws `TooManyTabsError`; [08](08-interactive-reading.md) shows the message |
| Sections per tab | 40 content | Build keeps first 40, warning |
| Glossary notes | 40 | Keep first 40 by document order |
| Image asset | 1600 px long edge, ≤ 1.5 MB after encode | Downscale / re-encode (5.6) |
| Stock photos | 6 per document, ≤ 1200 px, ≤ 450 KB each, ≤ 1.5 MB in total | Enforced when resolving (7.4) |
| Whole `index.html` | 25 MB | Warning only; logged, surfaced by 06 as a warning |

### 5.5 Determinism

Rendering is a pure function of the model plus `DOC_RUNTIME_JS/CSS` and the theme: fixed
attribute order, fixed whitespace, canonical JSON (sorted keys) for the embedded model, no clock
reads during render. Required properties: `render(parse(render(m))) === render(m)`, and a mutation
of one section changes only that section's bytes, the embedded model JSON, `updatedAt`, and (if
the runtime changed) the runtime blocks.

**Runtime upgrades.** A document keeps its embedded runtime (`generator.runtimeVersion`, the
`eli5-css` and `eli5-runtime` blocks) until one of these explicit exceptions re-renders the same
model with the bundled runtime (`bundledDocRuntime()`, `DOC_RUNTIME_VERSION`, currently `1.3.1`, the shared chart palette of 11.1; `1.3.0` was the first runtime with animation frames, 7.1; `1.2.0` was an unreleased runtime with declarative explorables, now removed):

1. **On open** ([08](08-interactive-reading.md) §5.1): when a document with an older runtime is
   opened in the app's viewer, the library is writable, the document parses and nothing in it is
   busy. Same model, same version node ([09](09-library-storage.md) §4.1 `refreshRuntime`).
2. **On mutation**: every mutation in 08 renders with `runtimeFor(parsed)`, which picks the bundled
   runtime (and sets `generator.runtimeVersion`) when the stored one is older.
3. **On checkout** of an older version snapshot (08 §6.7).

The runtime is never swapped at serve time and never by string surgery: always parse → render.
A refreshed published document reads as "changed since publish" once ([10](10-publishing.md)).
Documents that hold an answer box (6.5) fail model validation in builds older than the `qa` block
(`invalid_model`): they stay viewable there but are not editable. `formatVersion` stays 1.
A document with an ASD-STE100 tab (`kind: 'ste'`) also fails model validation in builds before it,
and its `meta.json` fails too, so a 0.3.0 desktop leaves it out of the library without touching the
files ([09](09-library-storage.md) §5.2 downgrade note). Run the newer build before opening one.

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
    <button class="theme-toggle" aria-label="Switch theme" hidden></button>  <!-- not in the tablist: a tablist owns only tabs -->
    <p class="kicker">Explainer</p><h1>{title}</h1><p class="dek">{dek}</p>
    <p class="doc-meta">Generated 27 Sep 2026 · 4 sources · 1 skipped</p>
  </header>
  <nav class="tabbar" role="tablist" aria-label="Document views">
    <button role="tab" id="tabbtn-indepth" aria-controls="tab-indepth" aria-selected="true">In depth</button>
    <button role="tab" id="tabbtn-eli5" aria-controls="tab-eli5" aria-selected="false">ELI5</button>
    <button role="tab" id="tabbtn-ste" aria-controls="tab-ste" aria-selected="false" title="{hint}"
            aria-describedby="tab-hint-ste">ASD-STE100</button>   <!-- only when the tab exists (4.1) -->
    <span class="tab-sx"><button role="tab" id="tabbtn-sx4e1a07" …>ELI5: Revenue recognition</button>
      <button class="tab-close" data-close-tab="sx4e1a07" aria-label="Close tab ELI5: Revenue recognition" hidden>×</button></span>
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
    <div class="tabpanel" role="tabpanel" id="tab-ste" data-tab-key="ste" data-tab-kind="ste" …>
      <h2 class="panel-title">ASD-STE100</h2>
      <p class="tab-hint" id="tab-hint-ste" data-eli5-noact>{hint, 4.1}</p>
      <section id="sec-ste-…" …>…</section>
    </div>
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
- Sections a merge inserted carry `data-merged-from="{fromDocId}"` on their `<section>`.
  Enhancement marks and the legend follow 6.4. Documents written before woven merges may contain
  legacy marker sections (`data-merge-marker`, class `merge-marker`, heading "Added from: …"); they
  still render, and no new ones are created.

### 6.2 Content Security Policy

```
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;
script-src 'sha256-{hash of DOC_RUNTIME_JS}'; connect-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'
```

The hash is computed at render time. The JSON model block is not executed (non-script MIME type),
so it needs no hash. `style-src 'unsafe-inline'` is needed for the theme block and chart SVG
presentation attributes; no remote styles are possible.

**Animation frames (7.1).** A document with animations admits, after the runtime hash, the two
script hashes of each animation frame (the trusted shell, then the model's code; deduplicated, in
document order): an `about:srcdoc` document inherits this policy in Chromium (Electron, Android
WebView), WebKit and Firefox, so a frame script runs only if both this policy and the frame's own
allow it. Nothing else changes: `frame-src 'none'` stays and still lets a srcdoc frame load in all
three engines, while any network navigation of the frame (a frame re-navigating itself) is blocked
by it; no `child-src` is added (`frame-src` governs frames and there are no workers). A document
without animations carries exactly the policy above, byte for byte. Validity (13 §7.1) checks that
no inline script of the document itself has a frame hash. After a section splice that adds or removes
an animation, the frame hashes in this policy are rewritten so the file still equals a full render
(8, `spliceSection`). The viewer's protocol-level CSP
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
  steps, charts are already complete SVG, and an animation shows its poster, title and caption
  (its frame is hidden). The document is fully readable with JS disabled.
- External links: `target="_blank" rel="noopener noreferrer"`. In the app, the runtime intercepts
  clicks and calls `window.eli5Doc.openExternal(url)`.

**WebView host contract (v2, Android companion, 16 §6.3).** The phone reader is a third host, next
to the app viewer and a plain browser. It must keep working with no change to the runtime:

- It serves the file over `https://appassets.androidplatform.net/docs/<docId>/<sha>.html`
  (`WebViewAssetLoader`), never `file://`, `data:` or `loadData`. The meta CSP in §6.2 still applies,
  and the host adds the same policy as a response header, with `script-src` pinned to the hashes of
  the document's inline scripts only when the file is a valid ELI5 document (it has the
  `eli5-model` JSON block and its meta CSP pins the same hashes). Any other HTML is served with
  `script-src 'none'`.
- It exposes no JavaScript interface and nothing named `eli5Doc`, so the runtime stays in its
  plain-browser mode: tabs, glossary, charts, stepper, theme and print work; the selection menu,
  tab close buttons and in-app scroll hooks stay inactive.
- `localStorage` is available (DOM storage on), so the theme choice persists per document origin.
- External links open in a Custom Tab only on a user gesture; other navigation is dropped.
- The runtime must therefore keep the rules above: classic IIFE, `window.eli5Doc` feature check,
  wrapped storage access, no network request of its own, and a layout that works at phone widths
  (13 §7.4 adds doc-runtime visual cases at 360 px and 412 px).

### 6.4 Merge enhancements: highlights, legend, references

A woven merge ([09](09-library-storage.md) §10.3) marks what it changed. The model never marks
spans; `enhance.ts` computes the marks when the plan is applied (8.1):

- **Diff granularity.** A revised section's blocks are paired with the blocks they replace: `keep`
  blocks by index, written blocks by text similarity (Dice over the word LCS, at least 0.35) with
  an identical block counting as unchanged. Text blocks are diffed word by word over their plain
  text (`inlineText`, so markup changes never count) per inline string: paragraph, callout and
  analogy (one string), list (one per item, items aligned by similarity), stepper (one per step
  body). Inserted runs become `EnhRange`s; runs of only punctuation are dropped and edge
  punctuation is trimmed. A diff larger than 250,000 cells marks the middle as wholly new.
- **Block and section marks.** An `incoming` block or a written block with no counterpart is
  `kind: 'new'`; a changed non-text block (table, chart, figure, diagram, pullquote) is
  `'updated'`; an inserted section has `enh.added`.
- **Several merges.** Each merge has a legend id (`m1`, `m2`, … in `DocumentModel.merges`). The
  ranges of earlier merges are carried through the words a later merge left unchanged, so every
  mark keeps its own merge id. Regenerating a section (08) drops its marks; that is accepted.

Markup (all attributes in fixed order; everything passes 13 §7 validity, the CSP and axe):

- Inserted text: `<ins class="enh" data-merge="m1" title="Enhanced on 28 Sep 2026 with material
  from {title}">…</ins>`, split at `<dfn>`, bold and italic boundaries; a code span or link that
  overlaps a range is wrapped whole.
- Whole block: `data-enh="new"|"updated" data-merge="m1" title="…"` on the block's root element.
- Inserted section: `data-enh="new" data-merge="m1"` on the `<section>`.
- Legend, in the header after the meta line (so it shows above every tab), only when `merges` is
  not empty: `<div class="enh-legend" data-doc-id="{docId}">`, one `<p class="enh-legend-line"
  data-merge="m1">` per merge with a swatch `<span class="enh-swatch" aria-hidden="true">` and the
  text "Enhanced on {date} with material from <cite>{title}</cite>", then
  `<button type="button" class="enh-toggle" aria-pressed="false" hidden>Hide highlights</button>`.
- References: merged sources (7.1 "Added by merge") carry `data-merge` and a swatch with
  "Added in merge on {date} from {title}" (10).

Style (`index.css`, runtime-only tokens, not themeable): `--enh` violet (`#5e2596` light,
`#d7b6ff` dark) and `--enh-bg` (`#e9dbfa` / `#35274c`); text on the tint is at least 7:1 in both
themes. The hue is distinct from the accent and link (blue), glossary (gold), highlight (yellow)
and callout colors. Color is never the only cue: inserted text is also underlined and tinted, and
block and section marks add a left rule plus a "New" / "Updated" text tag (CSS generated). Print
keeps the marks (`print-color-adjust: exact`) and hides the toggle. Highlights are visible without
JS; the runtime shows the toggle, which sets `data-hide-enh` on `<html>` and remembers the choice
per document in `localStorage` (`eli5.enh.<docId>`, access wrapped in try/catch).

### 6.5 Answer boxes (reader questions)

An Ask ([08](08-interactive-reading.md) §6.8) adds a `QaDocBlock` to the section, after the block
that holds the end of the selection. It is static markup: no script, no handlers, CSP-safe, and it
works without JS and in print. Rendered by `render/blocks.ts` (`case 'qa'`), fixed attribute order,
every text escaped, the answer paragraphs through `renderInline` (the question is escaped plain
text; markdown in it is not rendered):

```html
<aside class="qa" id="q-1a2b3c4d" aria-label="Answer to a reader question">
  <details class="qa-q"><summary class="qa-chip"><span class="qa-mark" aria-hidden="true">?</span><span class="qa-cap">You asked</span></summary>
    <p class="qa-q-text">{question}</p><p class="qa-q-about">About: “{quote}”</p></details>
  <div class="qa-a"><p>…</p><p>…</p></div>
</aside>
```

- No `data-section-id` ([08](08-interactive-reading.md) §11 contract), a unique `id`, not `data-eli5-noact`, so it prints.
  Merge block marks (6.4) still apply to it like any block.
- **Style** (`index.css`, "Reader questions", after the enhancements). No new color tokens: it
  reuses `--rule`, `--paper`, `--paper-2`, `--muted` and `--accent`, so dark mode needs no extra
  selectors. The box has a 1 px `--rule` border, 10 px radius and a `--paper-2` tint mixed toward
  `--paper`. The chip is the perimeter affordance: absolutely placed on the top border at the right,
  a pill on `--paper` that notches the border like a fieldset legend, at least 24 px hit area, no
  disclosure marker. At rest it shows only `?`; on hover, focus-visible and open the "You asked"
  caption widens (a `max-width` transition, none under `prefers-reduced-motion`). Open adds the
  accent color and a ▾ glyph, so color is never the only cue; focus shows a 2 px ring. The open
  question is an italic strip with a 3 px accent left rule; the "About" line is muted and small.
- **Flash:** the runtime's landing flash is the class `.eli5-flash` (generalized from sections),
  a static outline under reduced motion.
- **No JS:** the `<details>` works natively; the answer is always visible.
- **Print:** the question shows as a static "You asked: …" line (the `<details>` content is
  forced visible and the chip is hidden); `.qa` keeps its tint (`print-color-adjust: exact`).
- "Hide highlights" (6.4) does not hide answers; they are content.
- The drop-cap rule (`section:first-of-type > p:first-of-type`) matches direct children only, so
  answer paragraphs never get one.

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
| `diagram` | `<figure class="diagram">` with sanitized model SVG (7.3) | Structure, flow, architecture, relationships: at most 5 labeled shapes, labels inside their shapes, never people, buildings or scenes | None |
| `figure` | `<figure class="annotated">` with `<img>` and numbered annotation markers (layout below) | An input image (screenshot, slide) benefits from callouts | Marker click/focus shows note; list of notes below image |
| `photo` | A credited `<figure class="annotated stock-photo">` (7.4), or nothing when no photo fits | A real-world scene: people, places, objects, what an experience looks like; never data or structure | Credit links open in a new tab |
| `stepper` | `<div class="stepper">` with ordered steps | A process with 3–8 stages | Prev/next buttons and step dots; all steps visible without JS and in print |
| `analogy` | `<aside class="analogy">` with a "Think of it like" label | Mainly ELI5 and "Give me an analogy" actions | None |
| `animation` | `<figure class="animation">`: title, an SVG poster, the sandboxed frame running the model's code over it, and the caption the frame is described by (below) | The topic has a mechanism, process, trade-off or dynamic that motion or a control makes clearer than a static chart; at most 1 per section, 2 per tab, 4 per document | Whatever the model wrote, inside the frame: sliders, buttons, readouts through the shell's `ELI5.*` helpers; poster without JS and in print |
| `qa` (doc-only, not a DraftBlock) | `<aside class="qa">` answer box with a question reveal (6.5) | Never: only the reader's Ask adds it | Native `<details>`; opened when the app lands on it |

Page-level elements the renderer adds (not model blocks): kicker, `h1`, dek, meta line, merge
legend (6.4), tab bar, references section, footer.

Annotation markers (`render/blocks.ts` `layoutMarkers`): the diameter is 45% of the shown image's
short side, clamped to 18–24 px (the image counted at most 680 px wide, the text column), written as
`--fm` in the marker's `style` when below 24 px; the number is `max(10px, --fm / 2)`. Each center is
kept inside the image (half a diameter from every edge). Markers are placed in annotation order; a
marker whose center is closer than a diameter plus 2 px to an earlier one moves directly away from
it to that distance (coincident centers move right, or down at the right edge), up to 8 times, so
the layout is deterministic and the first marker never moves.

**Animations** (`src/main/document/animation/`, `src/doc-runtime/animation.ts`; design addendum
2026-11-08). There are no fixed animation kinds: the model designs and writes a small, topic-specific
interactive (`html`, `css`, `js`, about 150 lines at most) whenever motion or a control the reader can
drag clearly helps understanding of THAT document's topic, plus an SVG `poster` still frame of the
key insight. Gradient descent's learning rate is only an example of the style; the prompt fragment
`animation-rules` (02 §9) gives the guidance and the helper API, and tells the model never to reuse an
example unless the topic is that example.

Markup, attributes in this fixed order:

```html
<figure class="animation"><h3 class="chart-title">TITLE</h3><div class="anim-stage">
<div class="anim-poster">POSTER SVG</div><iframe sandbox="allow-scripts" srcdoc="…" title="TITLE"
referrerpolicy="no-referrer" loading="lazy" aria-describedby="{idBase}-cap"></iframe></div>
<figcaption class="anim-cap" id="{idBase}-cap">CAPTION</figcaption></figure>
```

(one line in the file). The sandbox is exactly `allow-scripts`: no `allow-same-origin`, forms,
popups, modals, top navigation, downloads, pointer lock or presentation, so the frame has an opaque
origin, cannot read the parent (`top.document` throws) and cannot navigate the top window. The
srcdoc is one exact skeleton:

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
content="default-src 'none'; script-src 'sha256-<shell>' 'sha256-<model js>'; style-src 'unsafe-inline';
img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none';
worker-src 'none'; form-action 'none'; base-uri 'none'"><meta http-equiv="x-dns-prefetch-control"
content="off"><meta name="viewport" …><style id="eli5-anim-shell">
SHELL CSS</style><style>MODEL CSS</style></head><body><main id="eli5-anim">MODEL HTML</main>
<script>SHELL JS</script><script>MODEL JS</script></body></html>
```

**Shell** (`animation/shell.ts`, frozen; a change adds a version next to it so older documents
still validate and round-trip, and bumps `DOC_RUNTIME_VERSION`; `ANIMATION_SHELLS` holds version 2,
runtime 1.3.1, and version 1, runtime 1.3.0, which differs only in its series colours). Before the model's code runs it
captures the parent window, then makes `fetch`, `XMLHttpRequest`, `WebSocket`, `WebTransport`,
`EventSource`, `RTCPeerConnection` (and the `webkit` form and data channels), `Worker`,
`SharedWorker`, `BroadcastChannel`, `MessageChannel`, `importScripts`, `open`, `opener`, `parent`,
`frameElement`, storage, `caches`, `Notification` and `navigator.sendBeacon`/`serviceWorker`
undefined (defense in depth; the CSP is the boundary). It also closes the ways to a second realm or
to markup the lint cannot see: `contentWindow`/`contentDocument`/`getSVGDocument` of frame-like
elements return null, `createElement`/`createElementNS` throw for `iframe`, `frame`, `frameset`,
`object`, `embed`, `portal`, `fencedframe`, `link`, `meta`, `base`, `form`, `a`, `area` and
`script`, and the HTML-string sinks (`innerHTML`/`outerHTML` setters, `insertAdjacentHTML`,
`setHTMLUnsafe`, `document.write`, `execCommand`, `createContextualFragment`, `DOMParser`,
`XSLTProcessor`) throw or are undefined. It sets theme tokens as CSS variables (light,
dark by `prefers-color-scheme`, overridden by `data-theme` from the parent), measures the body and
posts `{type:'eli5-anim-height', h}` to the parent on load, on resize (deduplicated) and in answer
to a theme message, but only once the model's code has run: an uncaught error or rejection before
`load` means no height message ever, so the poster stays in place of a broken frame, and accepts only `{type:'eli5-anim-theme', theme:'light'|'dark'}` from the
parent window. Animation loops pause while the document is hidden (`visibilitychange`) or the frame
is off screen (IntersectionObserver against the top-level viewport, so a hidden tab panel pauses
too). Helper API, frozen as `window.ELI5`: `slider(label, min, max, step, value, onChange, into?)`
(a labelled native range input, a visible `<output>` and `aria-valuetext` "label value"),
`button(label, onClick, into?)`, `readout(label, into?)` (a polite live region), `canvas(w, h, into?)`
(device-pixel scaled, responsive, `aria-hidden`), `svg(w, h, into?)`, `el(name, attrs, parent?)`
(an allowlist of SVG shapes and text and simple HTML; `on…`, `href`, `src`, `srcdoc`, `rel`,
`http-equiv`, `action`, `formaction`, `ping`, `background`, `poster` and `data` attributes throw),
`raf(fn)` (`fn(dtMs, tMs)` each frame until it returns false; with `prefers-reduced-motion: reduce`
it runs to the end at once, at most 5000 steps, so the final state shows), `rng(seed)` (seeded, so
the animation matches its caption), `palette` (the chart palette, 7.2 rule 11, for the current
theme), `onTheme(fn)`, `reducedMotion`, `theme`, `stage`. Controls go in a row under the stage and
work at 320 px wide.

**Lint** (`animation/lint.ts`, at build, at parse and in validity; defense in depth, a hit drops the
block). Word rules run on the code with strings, template text, regular expression literals and
comments removed, so label text ("Cookies left", "cost of import") and ordinary variable names never
hit; a quote or `/` that does not close on its line is kept as code, so a confused scanner never hides
the rest of a line. On that code: `fetch`, `Worker`, `import`, `eval`, `Function(`, `.cookie`,
storage, `BroadcastChannel`/`MessageChannel`, `navigator`, `.constructor`, `Reflect`, `atob`,
computed access on `window`/`globalThis`/`self`/`frames`/`top`/`parent`/`document`/`this`, bare
`window`/`globalThis`/`frames` not followed by a member (aliasing), `contentWindow`,
`contentDocument`, `getSVGDocument`, `defaultView`, the HTML-string sinks, `location` (after any
receiver too), `open(`, `opener`, `frameElement`, `top`/`parent` through a global (`window.top`,
`self.parent`) or followed by a window-only member (`top.document`, `parent.postMessage`), and bare
`top`/`parent`/`self` unless the code declares a binding of that name (a margin variable or a
parameter; object keys are not references). On the raw `js`: `XMLHttpRequest`, `WebSocket`,
`WebTransport`, `EventSource`, `sendBeacon`, `RTC…`/`PeerConnection`, `SharedWorker`/`serviceWorker`,
`importScripts`, `postMessage`, `setTimeout`/`setInterval` with a string, `['constructor`, computed
keys built by string concatenation (`x['fe' + 'tch']`), creating a banned element by name
(`createElement`, `createElementNS`, `ELI5.el`), a string holding an external URL (`//host`, any
scheme; the SVG namespace is allowed), `</script` and `<!--`. In `js`, `html` and `css`: `<iframe`,
`<frame`, `<form`, `<a href`, `<meta`, `<base`, `<script src`, `<link`, `<object`/`<embed`/`<portal`,
`javascript:` and `url(` with anything but `data:`; in `html` also `<script`, inline `on…=` handlers and
any `src`/`href`/`action` … that is not `data:` or a fragment; in `css` also `@import`, `</style` and
`expression(`. A block whose `js` is the keep marker outside a regenerated section is dropped too.
The lint cannot close every alias (a declared `top` that is later assigned the real one, indexed
child windows reached through an event's `view`); the shell and the sandbox cover those (12 §9).

**Parent side** (`safe('animation')`, §14). Sends each frame `{type:'eli5-anim-theme', theme}` (the
document's `data-theme`, else the system scheme) on boot, on the frame's load and on every change,
with target `'*'` (an opaque origin cannot be targeted; the message holds only the theme). It
accepts exactly one message shape, `{type:'eli5-anim-height', h:number}` with no other keys, and
only when `event.source` is one of its own frames' windows; the height is clamped to 120–800 px and
set on the stage, and the figure gets `anim-live`. Before that the frame sits over the poster in a
16:10 box (max 560 px tall, 720 px wide) at opacity 0, so the poster shows until the frame has run.
Without JS the frame is hidden (`html:not(.js)`). `figure.animation` is outside the select-and-act
menu (08 §5.6). Budget: the parent side ≤ 2 KiB minified JS and ≤ 1.5 KiB CSS; the shell ≤ 12 KiB JS
and 2.5 KiB CSS (golden test).

**Validity** (13 §7.1, `checkAnimationFrame`): the only allowed `<iframe>` is inside
`figure.animation`, has exactly the attributes above in that order with the exact sandbox, and a
srcdoc that is exactly the skeleton around a known shell version, whose CSP is exactly the policy
above with the hashes of its two scripts, and whose code passes the lint; the document's own CSP
must admit both hashes. Anything else is an `animation-frame` error.

**Model, regenerate, merge.** The model JSON stores the block as canonical JSON (5.5) and parse
re-runs every check (poster sanitizer with its existing id prefix, caps, lint), so
render(parse(html)) is byte-identical and a hand-edited block that fails is dropped. When a section is
sent back to the model (08 §6.2) its animation is shown with `poster` and `js` equal to `"keep"`;
returning that marker keeps the animation (new text allowed), leaving it out removes it. Merges keep
animations with `keep` blocks like other visuals (a colliding poster id prefix is re-minted, as for
diagrams); the ASD-STE100 tab keeps In depth's animations; an ELI5 tab may have its own simpler one.

### 7.2 Charts (`src/main/document/charts/`)

Charts are rendered to static SVG in main at render time, using `d3-scale`, `d3-shape` and
`d3-format` (main-process dependencies only; nothing ships in the document). The runtime only adds
tooltips and the data disclosure. The `ChartSpec` is kept in the embedded model so a chart can be
re-rendered when the runtime or theme changes.

WSJ conventions (Dona M. Wong, *The Wall Street Journal Guide to Information Graphics*) enforced
by the renderer and by build-time normalization (§5.2). Validation in [02](02-llm-provider.md)
§10.1 checks chart structure only; every rule below is applied quietly with a build warning and
never triggers a repair call.

1. `title` is displayed as a takeaway headline (the prompt asks for a sentence, e.g. "Paid search
   returns the most per dollar"); `subtitle` carries unit and scope; `source` renders as a small
   "Source:" line under the plot. The only other text is annotations (rule 14) and the note
   (rule 15).
2. Every numeric axis uses `niceScale(lo, hi, count, zero)` (`charts/common.ts`): a natural step of
   1, 2 or 5 × 10ⁿ (2.5 × 10ⁿ only when the step is a whole 25, 250, …; never 0.25 or 2.5) giving
   at most `count` intervals (6 on vertical axes, 5 on horizontal bars, 3 or 4 in the compact
   layout), and a domain of whole steps that always contains every value, so the first and last
   gridlines sit at or beyond the data. Ticks are every step from end to end. A y-axis title gets
   30 units above the plot so it never meets the top tick label.
   - Bars and areas always start at zero.
   - Lines (a product decision the owner can reverse with `LINE_ZERO_RATIO` in `line.ts`):
     a line whose values sit on one side of zero starts at zero when the smaller magnitude is at
     most half of the larger (all values ≥ 0 and min ≤ 0.5 × max). A line crossing zero uses the
     plain nice extent. Otherwise the domain is padded by a quarter of the data range on each side
     (the data fills about two thirds of the plot height) before rounding; when that domain leaves
     out zero, an axis-break mark (two short slanted strokes, `path.viz-axis-break`) sits at the
     bottom of the y axis and the renderer appends "The vertical axis does not start at zero." to
     the note (rule 15). The model's title and subtitle are never rewritten for this.
3. Horizontal gridlines only, light; no chart border, no 3D, no gradients, no patterns, no drop
   shadows. Labels are always horizontal: chart SVG never contains `rotate(`.
4. Lines with two to four series are labelled directly at their ends and get no legend; with the
   cap of rule 16 that is every new multi-line chart. A stored chart from before the cap with more
   lines falls back to a compact legend above the plot. Bars with several series use a legend above
   the plot.
5. Bar charts switch to horizontal when any category label exceeds 14 characters or there are more
   than 8 categories. Value labels are printed on bars when ≤ 12 bars.
6. `highlight.category` gets the accent color and all other marks the muted series color; the note
   is drawn as a leader-line annotation (`annotate.ts`). A single series without a highlight uses
   `--viz-1`; the accent is reserved for the highlight.
7. Pies: ≤ 5 slices (the smallest folded into "Other" at build time), largest first, clockwise from
   12 o'clock, labels outside with percentages. A pie with a negative value becomes a bar chart.
8. `null` values leave a gap in lines and an empty slot in bars (never zero). An empty bar slot
   shows a muted italic "No data" (`n/a` when the slot is too narrow) just above the zero line, or
   beside the axis in a horizontal chart; it is a focusable `text.viz-nodata` mark with
   `data-value="No data"`, so the tooltip and focus treat it like a bar. In a stacked chart only a
   category with no value in any series gets it. The data table shows "No data" in that cell and
   the `<desc>` summary ends with `no data: {category}` (`{category} · {series}` with several series;
   the first three, then "and N more"). Build-time normalization also names the gaps in the note:
   "No data for A, B." (five names, then "and N more"). A series missing more than 20 % of its
   values (and more than one value) is not charted (§5.2).
9. Number formatting via `d3-format` with SI suffixes (`1.2M`); `unit` prefixes currency symbols and
   suffixes `%`.
10. Size: `viewBox` based, width 100% of the text column, height derived from type (bar: 28 px per
    category horizontal, 320 px vertical; line/area/scatter 320 px; pie 300 px). Bars are about
    twice as wide as the gaps between them (`paddingInner` 1/3, `BAR_GAP` in `bar.ts`).
11. Color is applied only through classes, never through presentation attributes holding `var()`
    (engines, notably WebKit over `file://`, do not reliably resolve `var()` in SVG presentation
    attributes). Marks get `class="viz-fill-N"` / `viz-stroke-N` (N = 1..8), `viz-fill-muted`,
    `viz-grid`, `viz-ink`; `DOC_RUNTIME_CSS` defines `.viz-fill-1{fill:var(--viz-1)}`,
    `.viz-stroke-1{stroke:var(--viz-1)}` and so on for every token, so marks switch with the theme
    without re-render. The palette is one shared high-contrast set that no theme overrides (§11.1).
12. Narrow widths: `renderChartFigure` emits the chart twice, the regular SVG (`viewBox` 640 wide)
    and a compact one (`class="viz viz--compact"`, 380 wide, ids `{idBase}-c-t`/`-c-d`). `figure.chart`
    is an inline-size container; below 560 px the compact SVG replaces the regular one
    (`display:none` on the other, so it also leaves the accessibility tree). 12-unit chart text thus
    stays at 10.5 px or more down to a 368 px column. The compact layout switches bars to horizontal
    whenever a category label would not fit under its bar, truncates category and series labels
    sooner, uses fewer ticks, and shrinks the pie. Without container query support only the regular
    SVG shows.
13. Text: sentence case, never bold and italic together. Normalization strips inline-Markdown
    emphasis (`**a**`, `*a*`, `__a__`, `_a_`) from every chart string, and a string with two or more
    all-caps words of four or more letters goes to sentence case (`unshout` in `normalize.ts`).
    Acronyms survive: common short words (FOR, THE, WHY) never count as acronyms; in mixed-case
    text all-caps tokens of up to five characters are kept, and in fully shouted text tokens of up
    to three characters and tokens of up to five characters with a digit or no vowel (GDP, MCMC, Q3)
    are kept. This applies to the title, subtitle, axis labels, categories, series names, highlight
    and annotations, so references to a category stay in step. CSS sets the chart title bold only;
    no bold element is italic.
14. Annotations (`ChartSpec.annotations`, at most three, text at most 80 characters, on known
    categories only; others are removed at build time with warning `chart-annotations-dropped`):
    the annotated category's label carries a superscript number (`¹ ² ³`, after a thin space) in the
    SVG, and the note is printed under the plot as `<p class="chart-foot chart-ann">¹ Category:
    text</p>`. Line charts always label an annotated category, hiding thinned-out labels that would
    collide with it. Markers never compete with marks, value labels or the highlight note for
    space (the highlight keeps the leader-line note of rule 6).
15. Note: `<p class="chart-foot">Note: …</p>` under the annotations and above the source line. It
    joins the model's `footnote` (at most 200 characters kept), the build-time notes (dropped
    series, gaps) and the renderer's own axis-break sentence (rule 2), which is computed at render
    time and never stored.
16. Series and order (build time, §5.2): at most four lines, areas or scatter groups (the largest
    by mean |value|; the highlight names a category, so it never picks a series; "N more series
    not shown."),
    at most four grouped bar series (largest totals), stacked bars fold the rest into an "Other"
    series; warning `chart-series-capped`. `order: "value"` sorts bar and stacked-bar categories
    largest first (stacked: by total, nulls last); line and area charts keep the given (time)
    order; the default is `"given"`.
17. Prompt-only rules, not enforced by code: pictograms, saying mean or median, doing the math for
    the reader (charting change or share), and the five-second test live in the `chart-rules`
    prompt fragment ([02](02-llm-provider.md) §9).

Accessibility: `<svg role="img" aria-labelledby="{t} {d}">` with `<title>` and a generated `<desc>`
summary ("Bar chart, 5 categories, highest: Paid search 4.2, no data: Affiliate"). Each mark carries
`data-label` and `data-value` and `tabindex="0"` for tooltip focus. A `<details class="chart-data">
<summary>Show data</summary><table>…</table></details>` follows every chart.

### 7.3 Diagram SVG sanitizer (`svg-sanitize.ts`)

Parse with `linkedom` in main, walk the tree, keep only allowlisted nodes:

- Elements: `svg g path rect circle ellipse line polyline polygon text tspan title desc defs marker
  clipPath use`. No gradients, patterns or decorative shading (Wong): `linearGradient`,
  `radialGradient`, `stop` and `pattern` are removed.
- Attributes: geometry and presentation attributes (`d x y x1 y1 x2 y2 cx cy r rx ry width height
  points transform viewBox preserveAspectRatio fill stroke stroke-width stroke-dasharray
  stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity font-size font-weight
  text-anchor dominant-baseline paint-order marker-start marker-end marker-mid id role aria-label`,
  marker and clipPath geometry), plus `href`/`xlink:href` on `use` only when it starts with `#`.
- Flat paint: before anything else, a `fill` or `stroke` (attribute or style) of `url(#id)`
  pointing at a gradient or pattern is rewritten to the colour of the paint server's first `stop`
  (`stop-color` attribute or style, or the `viz-stop-*` class of a stored diagram; one gradient's
  `href` to another is followed), which the colour mapping below turns into a theme class. A paint
  server without a readable colour gives a muted fill and no stroke. Label contrast (below) then
  judges the flat colour.
- Removed: `script`, `style`, `foreignObject`, `image`, `a`, `animate*`, `set`, every `on*`
  attribute, `style` attributes, any `url(` not of the form `url(#id)`.
- Model `class` attributes are stripped (they could collide with document CSS such as `gl-note` or
  `tab-close`); the only classes in the output are those the sanitizer adds below.
- Colors: every `fill` and `stroke` value is removed as an attribute and replaced by a class. `none` stays as the attribute `fill="none"`/`stroke="none"`; `currentColor` becomes
  `viz-{fill|stroke}-ink`; `var(--viz-N|--ink|--muted|--paper|--rule)` maps to the matching
  `viz-{fill|stroke}-{token}` class; any other color is mapped by lightness and saturation to ink,
  muted, rule or paper when it is a grey, otherwise to the nearest chromatic palette hue (`VIZ_HUES`:
  blue 1, vermillion 2, purple 3, teal 5, green 6, violet 7, ochre 8; the graphite slot is not a
  hue target; a test derives each hue from the light palette). `DOC_RUNTIME_CSS` defines every such class (7.2 rule 11), so diagrams
  follow dark and light themes in every engine. The prompt tells the model to use the tokens.
- IDs inside the SVG are prefixed with `d{8 hex}-` (and references rewritten) to avoid clashes
  with section IDs and other diagrams.
- Root gets `role="img"`, `aria-label` from `diagram.alt`, a `viewBox` if missing (computed
  from `width`/`height`, else the block is dropped), and the palette mark class `viz-pal-2` (its
  theme classes are numbered for the §11.1 palette).

**Stored diagrams are re-sanitized.** `parseModelJson` (`parse.ts`) runs every stored diagram
through this sanitizer again (the model JSON is file content, not trusted build output), so every
parse, and therefore every re-render after a refresh, regeneration or merge, applies the current
rules: an old diagram loses its gradients and gets flat fills the next time its document is
opened and saved. For diagrams already built by this sanitizer the pass is a fixed point. A
document whose `generator.runtimeVersion` is older than `PALETTE_RUNTIME_VERSION` (`1.1.1`, the
first runtime with the §11.1 palette) has its diagram and logo theme classes renumbered first, so
each keeps its hue under the new palette: old slots 1 to 8 (blue, orange, green, magenta, violet,
gold, teal, red) become 1, 2, 6, 3, 7, 8, 5, 2. SVG that already carries `viz-pal-2` is never
renumbered again, and a document saved by a newer runtime is never renumbered (an older app that
re-sanitizes drops the mark but keeps the newer `runtimeVersion`). Stored
charts are not re-normalized: they re-render from their `ChartSpec` with the current renderer
rules (§7.2 rules 2, 3, 10, 11), while the build-time rules of §5.2 apply to new and regenerated
sections only.

**Label contrast.** Every diagram sanitize (new and stored diagrams, so a stored document gets it
the next time it is saved; never the theme logo) fixes text that would be hard to read on its
backdrop:

1. Walk the SVG in paint order and judge each `text` with explicit numeric `x` and `y`.
2. Its backdrop is the last solid `rect`, `circle` or `ellipse` painted before it that contains its
   anchor point. Only `translate` transforms are followed; any other transform on the text or its
   backdrop leaves the text unjudged. A shape with fill opacity or element opacity under 0.5 counts
   as no shape. No containing shape means the page.
3. Palette classes: ink, paper, and the accent fills `viz-1..8`. Muted and rule backdrops are left
   alone.

| Backdrop | Text | Result |
| --- | --- | --- |
| paper, or none (the page) | paper-coloured | ink |
| paper, or none | anything else | unchanged |
| ink | anything but paper | paper |
| accent (`viz-1..8`) | anything but paper | ink, with a 3 px round paper outline painted behind the glyphs (`viz-stroke-paper`, `stroke-width="3"`, `stroke-linejoin="round"`, `paint-order="stroke"`) |
| accent | paper | unchanged |

Recoloured text and its nested `tspan`s first lose their existing fill and stroke colours
(attributes, style, theme classes). Faint fills, unjudged transforms and already-correct text are
untouched, so the pass is idempotent and existing golden diagrams do not change.

### 7.4 Stock photos (`src/main/photos/`, HOOK-DOC-03)

Hand-drawn SVG pictures of people, places and scenes read as crude (blocky figures, labels
overflowing shapes). Real-world scenes therefore use open-licensed stock photos, and SVG is kept for
structured diagrams (7.3, and the prompt rules in [02](02-llm-provider.md) §9).

**Draft block.** The writing prompts may emit `{ type: 'photo', query, purpose, alt, caption?,
sensitive? }` ([02](02-llm-provider.md) §10) for a real-world scene: people, places, objects in the
world, what an experience looks like. `query` is 2 to 5 lowercase generic words ("courthouse
exterior", "person worried looking at laptop"); `purpose` says what the photo should show; `alt` is
the ideal photo in plain words; `sensitive: true` marks crime, victims, abuse, health or grief.
The ELI5 prompt asks for at most one per section; the in-depth prompt for at most two per tab and
never for data or structure. With `images.stockPhotos` off ([12](12-configuration-security.md) §3.2)
or a stub provider registered, the prompts say not to use `photo` blocks.

**Resolution** (generating stage, after the summary, [06](06-generation-pipeline.md) §5.4):

1. `collectPhotoSlots` takes the photo blocks, ELI5 first, within the limits below. Each query goes
   through `sanitizePhotoQuery`: URLs, e-mail addresses, quoted text, digits, acronyms, camelCase,
   runs of capitalized words and words the drafts use as proper nouns are removed; at most 6 words
   and 60 characters; a query with nothing generic left drops the slot. Only this sanitized query
   leaves the machine.
2. The registered `StockImageProvider` searches. Public: Openverse (`api.openverse.org`, anonymous,
   `license=cc0,pdm,by,by-sa`, `mature=false`), topped up from Wikimedia Commons (`filetype:bitmap`,
   `License` metadata mapped to the same four licenses) when Openverse has fewer than 2 results or
   fails. NC and ND licenses, mature or sensitivity-flagged results, non-https URLs, SVG files and
   titles naming logos, screenshots, maps or diagrams are dropped. No API key is used.
3. Up to 4 candidates per slot are downloaded at thumbnail size (Wikimedia and Flickr sized URLs, so
   the anonymous Openverse rate limit is spent on searches only) and re-encoded to 384 px JPEG.
4. One `photo-pick` vision call ([02](02-llm-provider.md) §12) sees every slot's purpose, alt,
   sensitivity and labeled thumbnails (`s1-c1` …) and answers a candidate number or 0 (none fits)
   per slot. Batches hold at most 6 slots and the model's per-request image limit. It prefers no
   identifiable faces for sensitive topics and rejects brand-led, text-heavy or graphic photos.
5. The chosen image is downloaded (about 1280 px where the host can size it), downscaled with
   `nativeImage` to at most 1200 px on the long edge, JPEG q80 (then 70, 60) up to 450 KB, and kept
   while the document's photos stay within 1.5 MB. A failed full download falls back to the
   thumbnail source. A photo is never used twice.
6. The result (`gen/photos.json`) is a list of `StockPhotoInput` keyed by
   `photoSlotKey(tab, sectionIndex, blockIndex)`.

Every step is fire-and-forget: a network error, rate limit, failed pick call or empty result
leaves the slot unresolved, with no job warning and no mid-job question. Only cancellation escapes.

**Build.** A resolved slot becomes a `figure` block backed by an `AssetRef` whose `label` is
`stock-photo-<sha12>` and whose `credit` (`AssetCredit`: title, creator, license and version,
license URL, source page, source name, search service) is sanitized: whitespace collapsed, lengths
capped, links kept only for `http(s)`. An unresolved `photo` block is dropped (warning
`photo-unresolved`); structured concepts already have diagrams, so no picture replaces it. Section
rewrites ([08](08-interactive-reading.md)) never search for photos: an existing photo figure
round-trips through its asset label and keeps its credit; new `photo` blocks are dropped.

**Render.** `<figure class="annotated stock-photo">` with the `<img>` as a data URI (5.6) and a
`<figcaption>` holding the caption and `<span class="fig-credit">Illustrative stock photo:
<cite>title</cite> by creator, <a class="fig-license">CC BY 2.0</a>, from <a class="fig-source">
Flickr</a> via Openverse. Resized.</span>`. Links open in a new tab (`target="_blank"
rel="noopener noreferrer"`); nothing is fetched at view time, so the CSP (6.2) is unchanged. The
references section lists the same credits under "Image credits" (section 10). The validity rule
`photo-credit` ([13](13-testing-quality.md) §7) fails a stock photo without its credit and license.

**Taste and safety.** The caption always says "Illustrative stock photo", so no pictured person is
read as part of the story; sensitive slots prefer photos without identifiable faces; the pick call
rejects logos and brands; `alt` is always set.

| Limit | Value |
| --- | --- |
| Photos per ELI5 section / in-depth tab / document | 1 / 2 / 6 |
| Candidates per slot shown to the pick call | 4 |
| Slots per pick call | 6 (fewer when the model takes fewer images per request) |
| Thumbnail for the pick call | 384 px long edge, JPEG q70 |
| Embedded photo | ≤ 1200 px long edge, JPEG q80 (then 70, 60), ≤ 450 KB |
| Embedded photos per document | ≤ 1.5 MB in total |
| Download caps | JSON 1 MB, thumbnail 3 MB, full image 15 MB |
| Query | ≤ 6 words, ≤ 60 characters, lowercase letters only |

<!-- hook:HOOK-DOC-03 -->
> **Private hook · HOOK-DOC-03 · Organization-approved image library.** Public behavior: `registerStockImageProvider` holds `FallbackStockImages` (Openverse, then Wikimedia Commons, no API key); only sanitized generic queries leave the machine; `approved-library.stub.ts` is documented but not registered, and any provider with `stub: true` turns stock photos off so documents use diagrams only. Private binding supplies: the approved image library's search and download endpoints (or the decision to turn photos off), its authentication inside the overlay, the license and credit text its images carry, whether search terms may leave the organization and any extra query rules, and whether `images.stockPhotos` is locked through HOOK-CFG-01. Binding lives in the private spec under "HOOK-DOC-03".

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
  draft: DocumentDraftTab, now: string,
  opts?: MutationOptions & { selectionOf?: SectionId[] }): { model: DocumentModel; tabKey: string };
  // selectionOf: an "ELI5 this selection" tab (08 §7.5): labelled "ELI5: " + draft.title (first 6
  // words of the selection when empty), origin gets scope 'selection' and sectionIds.
export function removeTab(model: DocumentModel, tabKey: string, now: string): DocumentModel;
export function insertAnswer(model: DocumentModel, id: SectionId, afterBlock: number | null,
  answer: { question: string; topic: string; quote: string; paragraphs: string[] }, now: string,
  opts?: MutationOptions): { model: DocumentModel; qaId: string };
export function mintQaId(src: IdSource, taken: TakenIds): string;    // 'q-' + 8 hex (4.2)
// src/main/document/merge.ts (contract required by 09 §10.3; TabRecord and DocumentMeta from 09)
export function prepareMergeWeave(input: { targetHtml; targetMeta; sourceHtml; sourceMeta }): MergeWeavePrep;
export function applyMergePlan(prep: MergeWeavePrep, plan: MergePlanDraft, opts: {
  fromDocId: string; fromTitle: string; mergedAt: string; retiredIds?: readonly string[]; idSource?: IdSource;
}): { model: DocumentModel; assets: Map<string, Uint8Array>; mergeId: string;
      enhancedSectionIds: SectionId[]; warnings: string[] };
export function weaveMergedDocument(input: {
  targetHtml: string; targetMeta: DocumentMeta;
  sourceHtml: string; sourceMeta: DocumentMeta;
  mergedAt: string; signal?: AbortSignal;
}, planner: MergePlanner, opts?: { idSource?: IdSource; runtime?: DocRuntime }): Promise<{
  html: string; tabs: TabRecord[]; markerSectionIds: SectionId[]; mergeId: string; prompt: string;
  warnings: string[] }>;
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
- `insertAnswer` (08 §6.8) is pure. It inserts a `qa` block after `afterBlock`, skipping any answer
  boxes that already follow it, so answers stack in the order asked; with no `afterBlock` it goes
  at the end of the section. Paragraphs are filtered with `isUserQuestion` (5.2, exported from
  `validate.ts`); the question never is. It shifts `glossary[].blockIndex` (same section, at or
  after the insertion point) and `enh.blocks[].block` by one and keeps `enh`, sets the section's
  `updatedAt` and `lastAction: 'ask'` and the model's `updatedAt`, and leaves `origin` and the
  `SectionId` unchanged.
- `toDraftBlock`, `sectionToDraft` and `getSectionContext` omit `qa` blocks, so the model never
  sees or echoes earlier answers. Glossary placement and merge enhancement diffs skip them.
- `carryAnswers(old, newBlocks)` re-appends a section's answer boxes, in order and with their IDs,
  at the end of its new blocks. `replaceSection` and the woven merge (8.1) use it, so a rewrite
  never drops an answer and deep links survive; the box's `quote` keeps its context. In the merge
  serialization a box is the line `Reader Q&A: <topic>`, and boxes the plan drops are re-appended.
- `weaveMergedDocument` (called by [09](09-library-storage.md) §10.6 on accept) takes and returns
  HTML and makes the one `merge-weave` call through the injected planner. `prepareMergeWeave` and
  `applyMergePlan` are its pure halves (golden documents use them directly). See 8.1.

### 8.1 Woven merge algorithm (`merge.ts`)

1. `prepareMergeWeave`: `parseDocument` both files (a `DocumentFormatError` propagates; 09 maps it
   to `MERGE_FAILED`); the same `docId` throws `DocumentBuildError('invalid_merge')`. Serialize
   both documents for [02](02-llm-provider.md) `merge-weave`: target sections as `I1…` (in depth)
   and `E1…` (ELI5), source sections as `X1…` and `Y1…`, each block as a numbered line (`b0`,
   `b1`, …; charts with their data, tables with their rows, figures with their label), plus the
   target's glossary terms and both documents' used sources. Section IDs never reach the prompt. A
   placeholder ELI5 tab is marked "not available". Figure labels of the source that collide with
   target labels are renamed; all labels are passed as the valid `figure` labels.
2. The planner returns a `MergePlanDraft` (02 §10).
3. `applyMergePlan`, per tab: each `revise` entry resolves its alias to a target content section
   (unknown or duplicate → skipped, warning `merge-unknown-section`), turns its blocks into
   `DocBlock`s (`keep` → the section's own block, `incoming` → the source block moved in with
   figures re-pointed to the combined assets and colliding diagram id prefixes re-minted, written
   blocks → 5.2 conversion), and replaces the section under the **same ID** with `updatedAt =
   mergedAt` and the marks of 6.4. A revised ELI5 placeholder stops being one.
4. Each `insert` entry gets a new ID under the tab key, checked against every target ID and
   `retiredIds`, `origin='merged'`, `merge = {fromDocId, fromTitle, mergedAt}` and `enh.added`. It
   goes after its anchor (plan order kept for one anchor; an unknown anchor means after the last
   content section), never after the references section; the 40-section limit applies.
5. Glossary: notes of revised in-depth sections are re-anchored (9.3); new plan terms not already
   defined are placed (9.1) in the revised and inserted in-depth sections only, skipping anchors
   that overlap an existing note; the 40-note cap applies.
6. References: every source reference not already listed (same status, label and link) is appended
   with `addedBy {mergeFromTitle, mergedAt, mergeId}`; the references section keeps its ID.
7. `merges` gains `{id, fromTitle, mergedAt}`; `updatedAt = mergedAt`. Section ELI5 tabs of the
   source are not carried over.
8. `weaveMergedDocument` renders with the current runtime and returns the tab records in display
   order and `markerSectionIds` = the revised and inserted sections, in-depth first (09 scrolls the
   viewer to the first).

Edge cases: a plan that changes nothing still records the merge (legend, references); a failed
planner call rejects and nothing is rendered; the function never mutates target section IDs, so
deep links into the target survive (4.3).

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
- **Selection:** with JS, a selection that starts in the body never includes a note, and one that
  starts in a note stays inside it ([08](08-interactive-reading.md) §5.6).
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
render as "could not be read". Merged references appear in a third group "Added by merge", each
with the enhancement swatch and "Added in merge on {date} from {title}" (6.4). A URL is printed
once: when the label is only the address (with or without scheme, `www.` or trailing slash, or
containing the URL), the link text is the readable host + path and the full URL is the link's
`title`; otherwise the title is the link (`title` = the URL) followed by the host + path once as
subtle `.ref-url` text. Label text is escaped. When the document shows stock photos, a
last group "Image credits" lists each one's credit (7.4) in asset order.

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
| Data viz | `--viz-1 … --viz-8` (categorical, see below), `--viz-muted`, `--viz-grid` |
| Components | `--callout-note --callout-warning --callout-key --gl-bg --gl-rule --pull-rule` |
| Type | `--font-serif: Charter, "Iowan Old Style", Georgia, serif` (body, headlines, pull quotes); `--font-sans: -apple-system, "Helvetica Neue", Arial, sans-serif` (kicker, tab bar, chart labels, meta, notes) |
| Measure | Body 19 px / 1.6 in the text column (max 680 px); side gutter 16 px on phones |

No web fonts are embedded by default (system fonts only; keeps files small and offline).

**Chart palette.** One shared, high-contrast palette for every theme: a theme (skill or overlay,
§11.3) cannot set `--viz-1 … --viz-8`, so a themed document never swaps in a low-contrast set.
Comprehension comes first; colour-vision simulation is not a requirement. Slots keep their hue
identity across palette revisions (in runtime 1.3.1, 5 moved from sky to teal and 7 from grey to
violet, so all eight slots stay apart), so stored diagrams keep their meaning without renumbering.

| Slot | Light | Dark | Name |
| --- | --- | --- | --- |
| `--viz-1` | `#0067a5` | `#56b4e9` | blue |
| `--viz-2` | `#b84c00` | `#f28e52` | vermillion |
| `--viz-3` | `#a12a7e` | `#d48ac4` | purple |
| `--viz-4` | `#4a4a4a` | `#cbcbcb` | graphite |
| `--viz-5` | `#047c74` | `#2ed3c6` | teal |
| `--viz-6` | `#2e7514` | `#86d45a` | green |
| `--viz-7` | `#5a32e0` | `#8474ff` | violet |
| `--viz-8` | `#7e6600` | `#d8c040` | ochre |

Hard rules, in both themes and for every theme file (the runtime and the bundled beautiful-doc
theme), held by `test/unit/main/document/palette.test.ts`:

- Every slot is at least 4.5:1 on the paper, so marks are clearly visible and series-coloured
  text (line direct labels, diagram labels) is readable; the highlight accent is at least 3:1.
- Text on any fill reaches 4.5:1: paper-coloured text on a slot fill, or ink with the 3 px paper
  outline (§7.3).
- Never same-hue text on a fill: a label in a slot's colour on that slot's shape becomes outlined
  ink (§7.3).
- Every pair of slots differs by CIEDE2000 > 20 for normal vision (charts show at most five slots,
  but diagrams and animations may use all eight together).
- The accent sits next to a slot colour only in the highlight rule (7.2 rule 6), where every other
  mark is muted (bar, line, pie and scatter alike); the animation prompt tells the model the same.
- Callout and analogy rules (warning `--viz-2`, key point `--viz-6`, analogy `--viz-3`, note
  `--accent`) are at least 3:1 on their backgrounds.

The runtime CSS, its print block, `color.ts` (`RUNTIME_LIGHT`, `RUNTIME_DARK`) and the animation
shell's `palette` carry the same values (tested). The runtime palette applies to every document
whose CSS is re-rendered (§5.5); this palette bumped `DOC_RUNTIME_VERSION` to `1.3.1`, so a
1.3.0 document takes it on open. An earlier palette change bumped `DOC_RUNTIME_VERSION` to `1.1.1`
and renumbered stored diagrams at parse (§7.3) so a diagram painted with the old green slot 3 stays
green.

### 11.2 Switching

- Default `data-theme="auto"` follows the OS. In the app, Electron's `nativeTheme` drives
  `prefers-color-scheme` in the viewer, so the document follows the app. This holds for themed
  documents too (11.4).
- A theme toggle button in the tab bar (hidden until the runtime boots) cycles auto → light → dark
  and stores the choice in `localStorage` key `eli5.theme` (try/catch; per-viewer convenience only).
- Charts and diagrams use tokens via classes (`.viz-fill-1{fill:var(--viz-1)}`, 7.2 rule 11), never
  `var()` inside presentation attributes, so they switch with the theme without re-render in every
  engine. Embedded raster images are unchanged in dark mode; they get a 1 px `--rule`
  border.

### 11.3 Theme inputs

`DocTheme = { id; version; tokens: Record<TokenName, string>; footer?: string; logoSvg?: string }`.
Precedence: default theme < skill theme input (CSS custom properties supplied by the beautiful-doc
skill, [02](02-llm-provider.md) §11) < overlay theme (HOOK-DOC-01). The chart slots `--viz-1 …
--viz-8` are fixed (§11.1): any layer that sets one, light or dark, has it dropped with warning
`theme-token-chart-fixed:<token>`, and `themeCss` never writes one, so a stored theme that set one
gets the shared palette on its next re-render. Only known token names are accepted and values must
match `^(#[0-9a-f]{3,8}|rgb\(…\)|hsl\(…\)|oklch\(…\)|[a-z-]+|[0-9.]+(px|rem|em)?|"[^"<>]*"( ?, ?[a-zA-Z "-]+)*)$`;
anything else is dropped with a warning. The theme is written into `#eli5-theme` and recorded in
`DocumentModel.theme`. `DocTheme.darkTokens?` optionally carries explicit dark values (11.4); a
skill supplies them in a `@media (prefers-color-scheme: dark)` block of its CSS. When a higher layer
sets a token's light value without a dark one, the dark value from the layers below is dropped.

### 11.4 Theme dark variants

A theme's light tokens must not freeze a document in light mode. `#eli5-theme` holds three rules:

```css
:root:root:root{ light tokens }                                                     /* (0,3,0) */
@media (prefers-color-scheme: dark){:root:root:root:not([data-theme="light"]){ dark tokens }}
:root:root:root[data-theme="dark"]{ dark tokens }                                   /* (0,4,0) */
```

The light rule outranks every runtime token rule; the dark rules outrank the light rule under the
same guards as the runtime's own dark palette, so auto follows the system, and the toggle's light
and dark win either way. The print palette is `:root:root:root:root:root` (0,5,0) inside
`@media print`, above both.

Dark tokens (`color.ts` `deriveDarkTokens`): for every color token the theme sets, the explicit dark
value when given, else a derived one. Surfaces (`--paper`, `--paper-2`, `--rule`, `--highlight`,
callouts, `--gl-bg`, `--viz-muted`, `--viz-grid`) keep the light color's hue and chroma at the
runtime dark palette's lightness for that token. Text and marks keep their hue and move lightness
up from their light value (body text: from the inverted lightness) until they reach WCAG contrast on
the dark paper: `--ink` 7:1 (and 4.5:1 on every surface it sits on), `--ink-2`, `--muted`, `--link`
and `--accent` (kicker, tab underline) 4.5:1, `--gl-rule`, `--pull-rule` and `--viz-1…8` 3:1 (large
text and UI). `--accent-ink` becomes a dark tint of its hue with 4.5:1 on the dark accent. Values
that are not a parseable color (`#hex`, `rgb()`, `hsl()`, `oklch()`) take the runtime dark value;
fonts are not repeated. The neutral default theme writes nothing, so the runtime palette applies.
`parseDocument` keeps the dark block as `darkTokens` only when it differs from the derivation, so a
re-render is byte-identical.

Documents rendered before dark variants have only the light rule. The viewer's `eli5doc://`
handler adds the derived rules when it serves such a document (`upgradeThemeBlock`); the file on
disk changes at its next re-render.

<!-- hook:HOOK-DOC-01 -->
> **Private hook · HOOK-DOC-01 · Organization document theme and branding.** Public behavior: neutral default theme, footer "Made with ELI5 Learner", no logo, no classification label; the registry's `docTheme` capability returns the default `DocTheme`. Private binding supplies: organization token overrides (colors other than the fixed chart slots of 11.1, fonts, optionally a data-URI embedded font within a size cap), optionally explicit dark values for those colors (`DocTheme.darkTokens`; otherwise derived per 11.4), a logo SVG (sanitized by 7.3 rules) for the header kicker, a footer or data-classification label, whether the theme applies to every document or only to documents published through HOOK-PUB-01 / HOOK-PUB-03, and the theme `id`/`version` for traceability. Registered through the capability registry per HOOK-CFG-02. Binding lives in the private spec under "HOOK-DOC-01".

## 12. Tab bar behavior (`tabs.ts`)

1. Order: In depth, ELI5, ASD-STE100 when present, then section ELI5 tabs by `createdAt` (new
   tabs appear to the right). Validity rule `tab-order` ([13](13-testing-quality.md) §7): `ste`,
   when present, directly follows `eli5` and precedes every section ELI5 tab.
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
   originating section (if it still exists). An "ELI5 this selection" tab (`origin.scope ===
   'selection'`, [08](08-interactive-reading.md) §7.5) follows it with the quote
   `<blockquote class="tab-asked"><p><span class="tab-asked-label">You asked about:</span> “…”</p></blockquote>`,
   the selection on one line cut to 240 characters on a word boundary with `…`.
8. Selection zones ([08](08-interactive-reading.md) §5.6, `selection/zones.ts`, in-app and in a
   plain browser): with `html.js`, glossary notes are `user-select: none` unless the selection
   started inside one (`html.eli5-sel-note`, the active note carries `data-eli5-sel` and everything
   else is `user-select: none`). A copy of a body selection leaves the notes out. No print rules
   change.

## 13. Print (`@media print` + `print.ts`)

- Prints the active tab only, preceded by the document header; tab bar, theme toggle, tab close
  buttons and the selection menu are hidden.
- Forced light palette regardless of theme; backgrounds removed except callouts and notes
  (`print-color-adjust: exact` for charts and callouts).
- Glossary notes print as open, compact boxes after their block (no margin float at print widths).
- Steppers print all steps; chart data disclosures stay closed; tooltips are not printed.
- The ASD-STE100 hint (4.1) prints although it carries `data-eli5-noact`
  (`.tab-hint[data-eli5-noact] { display: block !important }`).
- Animations print their poster, title and caption; the frame is never printed. The figure never
  carries `data-eli5-noact`.
- External links print their URL after the link text (`a[href^="http"]::after`).
- `break-inside: avoid` on figures, charts, tables ≤ 30 rows, callouts, pull quotes; `h2` has
  `break-after: avoid`. Page margins 18 mm, body 11 pt.
- `print.ts` listens to `beforeprint` to open notes (`details.gl-note`) and answer-box questions
  (`details.qa-q`) and restore state on `afterprint`. Answer boxes print with their question (6.5).

## 14. Runtime boot order (`src/doc-runtime/index.ts`)

1. Add `js` class; read theme preference; apply `data-theme`.
2. `tabs.init()` (resolves hash), `glossary.init()`, `charts.init()`, `stepper.init()`,
   `figure.init()`, `animation.init()` (7.1; only when the document has an animation), `print.init()`,
   theme toggle, `enhancements.init()` (6.4 Hide highlights).
3. If `window.eli5Doc` exists: `selection.init()` ([08](08-interactive-reading.md)), un-hide close
   buttons, `scroll.init()`, link interception.
4. Every module is wrapped in `try/catch`; a failing module logs to the console and leaves the
   no-JS fallback in place for its components.

The order is unchanged by answer boxes and the grouped menu: answer boxes need no module (their
open-on-landing is part of `scroll.init()`, 08 §7.4), and the menu is part of `selection.init()`.

## 15. Edge cases and errors

| Situation | Behavior |
| --- | --- |
| ELI5 draft missing | Placeholder tab (5.1 step 4); still a normal, actionable section |
| All in-depth sections invalid | `DocumentBuildError('empty_indepth')`; 06 retries, then fails the job |
| Model text contains `<script>` or HTML | Escaped as text; never interpreted |
| Diagram contains script, external image, or event handler | Stripped by sanitizer; block kept if anything valid remains |
| Figure references an unknown image label | Block dropped with warning |
| Very large image | Downscaled per 5.6 |
| Stock photo search offline, rate-limited or empty | Slot dropped quietly; the job still succeeds (7.4) |
| Stock photo candidate title contains instructions | Delimited as untrusted data in the pick call; the credit text is escaped |
| Glossary anchor not found anywhere | Note dropped with warning |
| Regeneration removes a glossary anchor | Note re-anchored later or dropped (9.3) |
| Opening a document with an older `formatVersion` | Rendered as stored; on first mutation the model is migrated and the file re-rendered with the current runtime |
| Opening a document with a newer `formatVersion` | View-only, action menu disabled, message in status area |
| `#eli5-model` hand-edited to invalid JSON | View-only; `DocumentFormatError('invalid_model')` logged |
| Document with an answer box opened by a build older than `qa` | View-only there (`invalid_model`); the box still renders and prints (5.5) |
| Document with an older embedded runtime opened in the app | Re-rendered once with the bundled runtime, same model (5.5) |
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
      reused, also across version branches (4.3).
- [ ] `insertAnswer` adds one `aside.qa` after the selected block (stacking after earlier boxes),
      changes only that section's bytes, the model JSON and `updatedAt`, keeps the `SectionId`,
      shifts glossary and enhancement indexes, and mints a unique `q-` ID; the question is escaped
      and its markdown is not rendered; a later `replaceSection` keeps the box at the section's end.
- [ ] An answer box is readable without JS, prints with its question, passes axe in both themes,
      and is never sent to the model in section context.
- [ ] Opening, mutating or checking out a document with an older runtime re-renders it with the
      bundled runtime via parse → render (5.5), never by string replacement.
- [ ] Tab order is In depth, ELI5, ASD-STE100 (when present), then section ELI5 tabs by creation;
      In depth opens first; labels read "ELI5: <heading>". A document with an `ste` tab round-trips
      byte-identically, its hint shows without JS, in print and in Markdown, the tab has no close
      button, and two-tab documents stay valid.
- [ ] Every `DraftBlock` variant renders per 7.1, and every chart kind renders per 7.2 in both
      themes with a data table disclosure.
- [ ] An animation renders the exact sandboxed frame (sandbox `allow-scripts` only, srcdoc, no src)
      whose own CSP hashes match its shell and model scripts, and the document CSP adds exactly
      those hashes (a document without animations keeps the old policy byte for byte); the lint
      drops each listed API and obfuscated form; a missing poster or alt, a size cap or the caps
      1/2/4 drop it; in Chromium, WebKit and Firefox over `file://` and in the Electron viewer the
      slider updates the readout inside the frame, `top.document` throws, network loads are blocked,
      navigation goes nowhere, reduced motion shows the final state, and print shows the poster.
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
- [ ] A resolved `photo` slot renders as a stock photo with "Illustrative stock photo", title,
      creator, license name linked to its deed, and source; the references list it under "Image
      credits"; the document still makes zero network requests. Unresolved slots leave no trace
      besides the `photo-unresolved` build warning.
- [ ] Only sanitized queries reach the photo search (no names, digits, URLs, e-mail addresses or
      quoted text); with `images.stockPhotos` off or a stub provider, no search runs and the prompts
      ask for diagrams only.
- [ ] Public build output contains no organization branding and no `kind:'org'` references; theme
      and reference rendering for the enterprise edition come only through HOOK-DOC-01 and
      HOOK-DOC-02.
- [ ] Woven merge fixture test: every target ID survives; revised sections keep their IDs and
      inserted ones get new IDs matching 4.2 with `data-merged-from`, before the references
      section; both tabs change; inserted words (and only those) are wrapped in `<ins class="enh">`,
      new blocks and sections carry `data-enh`; the legend and merged references render; a second
      merge gets `m2` and keeps the `m1` marks; the result validates and round-trips. A `merged`
      golden covers the markup in the cross-browser and axe runs.
- [ ] Chart and diagram marks in WebKit and Chromium (Playwright, `file://`, both themes) have a
      computed `fill` or `stroke` that is not the default (`rgb(0, 0, 0)` / `none` where a color was
      intended); no output SVG contains `var(` inside an attribute or a model-supplied `class`.
