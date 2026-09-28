# Content extraction

This module turns a `ResolvedSource` (format, media type, and payload, produced by a resolver in `03-source-resolvers.md`) into an `ExtractedContent`: a format-neutral tree of `ContentBlock`s plus any images destined for the LLM's vision input. It covers the `Extractor` interface, dispatch on the resolver's already-sniffed `format`, one extractor per supported format (pptx, docx, text PDF, scanned PDF, Markdown/plain text, CSV, images, xlsx), library choices, resource limits, timeouts, and how every failure turns into a `SkippedSource` with a human-readable reason. It does not fetch anything, talk to the LLM, or build prompts beyond a deterministic serializer. It implements the "Inputs and extraction" section of the PRD and the "failed source is skipped and noted" rule from "Processing pipeline". Extraction is identical in both editions, so this file defines no private hooks. Enterprise-only sources (HOOK-SRC-01, HOOK-SRC-02) resolve to ordinary bytes or HTML and then reuse these extractors unchanged.

Related: [01-architecture.md](01-architecture.md) · [02-llm-provider.md](02-llm-provider.md) · [03-source-resolvers.md](03-source-resolvers.md) · [05-url-fetching.md](05-url-fetching.md) · [06-generation-pipeline.md](06-generation-pipeline.md) · [07-output-document.md](07-output-document.md) · [09-library-storage.md](09-library-storage.md) · [12-configuration-security.md](12-configuration-security.md) · [13-testing-quality.md](13-testing-quality.md)

---

## 1. Responsibilities and boundaries

| In scope (this module, `src/main/extract/`) | Out of scope (owner) |
| --- | --- |
| Dispatch on `ResolvedSource.format` and read the payload | Reading files, the clipboard, or URLs, and sniffing the format (`03-source-resolvers.md`) |
| Parse each supported format into `ContentBlock`s | Turning HTML pages into article content with Readability (`05-url-fetching.md`). That module emits `ExtractedContent` through the shared HTML-to-blocks helper in §9.3. |
| Normalize, downscale, and budget images for vision | Sending images to a provider (`02-llm-provider.md`) |
| Render scanned PDF pages to images | Job-level token budgeting and prompt assembly (`06-generation-pipeline.md`) |
| Enforce per-source size, page, row, and time limits | Listing skipped sources in the document's references (`07-output-document.md`) |
| Map every failure to a `SkippedSource` | Persisting sources to `meta.json` (`09-library-storage.md`) |
| Provide `toPromptText()`, a deterministic serializer | |

PRD principle: *preserve structure where it is cheap and high value (slides, Word), and stay minimal where it is rare (Excel).*

---

## 2. Data model

`ExtractedContent` and `ContentBlock` are owned here (`src/main/extract/types.ts`). `SourceFormat`, `ResolvedSource`, `SourcePayload`, `SkippedSource`, and `SkipCode` are owned by `03-source-resolvers.md` and imported, never redefined. This module adds only the extraction-specific `SkipCode` values listed in §8.2.

```ts
import type { SourceFormat, ResolvedSource, SkippedSource, SkipCode } from '../sources/types';
// SourceFormat (03): 'pptx' | 'docx' | 'xlsx' | 'pdf' | 'markdown' | 'text' | 'csv' | 'html'
//                  | 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | 'tiff' | 'bmp'

/** The resolver's format, except that a PDF whose every processed page is image-only is
 *  reported as 'pdf-scanned' (§6.2). 'pdf-scanned' exists only here, never in SourceFormat. */
export type ExtractedFormat = SourceFormat | 'pdf-scanned';

export interface ExtractedContent {
  /** ResolvedSource.id, e.g. "src-03". */
  sourceId: string;
  /** ResolvedSource.ref: the human label used in status and references, e.g. "Q3 board deck.pptx". */
  sourceRef: string;
  /** ResolvedSource.format, or 'pdf-scanned' (§6.2). Page counts are in stats.scannedPages. */
  format: ExtractedFormat;
  /** Best-effort document title (pptx: first slide title; docx: core title or first H1). */
  title?: string;
  blocks: ContentBlock[];
  /** Images referenced by ImageBlock.imageId, already normalized for vision (§7). */
  images: ImageAsset[];
  stats: ExtractStats;
  /** Non-fatal issues ("12 slides had no title", "sheet 'Raw' truncated at 200 rows"). */
  warnings: string[];
  /** True when any cap in §10 cut content. The reason appears in warnings. */
  truncated: boolean;
}

export interface ExtractStats {
  chars: number;          // total text characters across blocks
  approxTokens: number;   // chars / 4, rounded up; pipeline refines per provider
  pages?: number;         // pdf
  scannedPages?: number;  // pdf: pages classified image-only (§6.2), also set for mixed PDFs
  slides?: number;        // pptx
  sheets?: number;        // xlsx
  imagesKept: number;
  imagesDropped: number;
  elapsedMs: number;
}

export type ContentBlock =
  | HeadingBlock | ParagraphBlock | ListBlock | TableBlock
  | SlideBlock | NotesBlock | ImageBlock | PageBlock;

export interface HeadingBlock   { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
export interface ParagraphBlock { kind: 'paragraph'; text: string; style?: 'quote' | 'code' }
export interface ListBlock      { kind: 'list'; ordered: boolean; items: ListItem[] }
export interface ListItem       { text: string; children?: ListItem[] }   // nesting = bullet hierarchy
export interface TableBlock {
  kind: 'table';
  caption?: string;          // xlsx: sheet name; docx: preceding caption paragraph if styled "Caption"
  header?: string[];         // first row when it is recognizably a header
  rows: string[][];          // cell text; merged cells repeat text in the first cell only
  truncated?: { rows?: number; cols?: number };  // how many were dropped
}
export interface SlideBlock {
  kind: 'slide';
  index: number;             // 1-based, presentation order (not file order)
  title?: string;
  hidden?: boolean;          // slide marked hidden in the deck
  blocks: ContentBlock[];    // body: paragraphs, lists, tables, images
  notes?: NotesBlock;
}
export interface NotesBlock     { kind: 'notes'; text: string }           // speaker notes
export interface ImageBlock {
  kind: 'image';
  imageId: string;           // key into ExtractedContent.images
  alt?: string;              // alt text / description from the source, if any
  origin: 'embedded' | 'standalone' | 'page-render';
}
export interface PageBlock      { kind: 'page'; number: number; blocks: ContentBlock[] }  // 1-based

export interface ImageAsset {
  id: string;                          // "<sourceHash8>-img-<n>"
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: Uint8Array;                    // post-normalization bytes (§7)
  width: number;
  height: number;
  byteLength: number;
  distinctColors?: number;             // capped count from §7.1 step 5; 07 uses it to pick PNG vs JPEG
  origin: ImageBlock['origin'];
  pageOrSlide?: number;                // for page renders and slide-embedded images
}
```

**Invariants**

1. `blocks` is in reading order: slide order for pptx, page order for PDF, document order otherwise.
2. `SlideBlock` and `PageBlock` appear only at the top level and are never nested in each other.
3. Every `ImageBlock.imageId` resolves to exactly one entry in `images`, and every entry in `images` is referenced at least once.
4. Text is Unicode NFC. Whitespace runs collapse to one space inside a paragraph, and control characters other than `\n` and `\t` are removed.
5. An `ExtractedContent` with `stats.chars === 0` and `images.length === 0` is never returned. That case becomes a `SkippedSource` with code `empty` (§8.2).

---

## 3. Extractor interface and registry

```ts
export interface ExtractContext {
  signal: AbortSignal;              // aborted on timeout or job cancel
  limits: ExtractLimits;            // §10.1, constants from limits.ts (not settings)
  imageBudget: ImageBudget;         // shared across all sources in one job (§7.4)
  renderPdfPages: PdfPageRenderer;  // injected; hidden render window in prod, fake in tests (§6.3)
  normalizeImage: ImageNormalizer;  // injected; same hidden render window in prod (§7.1)
  log: (msg: string) => void;       // debug log only, never shown in the status line
}

export type ExtractResult =
  | { ok: true; content: ExtractedContent }
  | { ok: false; skipped: SkippedSource };

export interface Extractor {
  readonly id: string;                        // 'pptx', 'docx', ...
  readonly formats: readonly SourceFormat[];
  /** Pure, synchronous check on ResolvedSource.format; no parsing. */
  canHandle(source: ResolvedSource): boolean;
  extract(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult>;
}
```

`ResolvedSource` is defined in `03-source-resolvers.md`. This module uses `id`, `ref`, `location`, `format`, `mediaType`, `title`, `sizeBytes`, and `payload`. The resolver has already sniffed magic bytes, skipped legacy Office files (`legacy-office-format`) and encrypted OOXML (`encrypted`), skipped AVIF/RTF/generic ZIP (`unsupported-type`), and enforced `maxFileBytes` (100 MiB) and `maxImageBytes` (20 MiB). This module does **not** re-sniff.

`src/main/extract/index.ts` exports `extractSource(source, ctx): Promise<ExtractResult>`:

1. Look up the first registered extractor where `canHandle(source)` is true (§4). Registration order is fixed: pptx, docx, pdf, xlsx, csv, image, markdown, text, html. No match is an internal inconsistency with 03: log it and return `unsupported-type`.
2. Apply the per-format input cap from `limits.ts` (§10.1) against `sizeBytes`. Over the cap gives `too-large`.
3. Wrap `extract()` in the timeout (§10.2) and a `try/catch`. Any thrown error becomes `corrupt` (parse errors) or `internal-error` (anything else), with the message sent to the debug log only.
4. Validate invariants (§2). A violation is an extractor bug: log it and return `internal-error`.
5. Fill `stats.elapsedMs` and return.

The registry is static. Editions do not change the set of extractors. Enterprise resolvers under HOOK-SRC-01 and HOOK-SRC-02 map their results onto the same `SourceFormat` values and payload kinds (see HOOK-SRC-01 in `03-source-resolvers.md`), so they reuse these extractors unchanged.

---

## 4. Format dispatch and payload access

The format comes from `ResolvedSource.format`, which 03 set from magic bytes first and extension second. There is no `sniffFormat` in this module.

**Payload access** (`src/main/extract/payload.ts`):

| `payload.kind` | How the extractor gets content |
| --- | --- |
| `path` | Binary formats (pptx, docx, xlsx, pdf, images): the extract worker reads the file itself from `payload.path` (§10.4), lazily, only after dispatch. Text formats: read and decode with §9.2 rules. |
| `text` | Use `payload.text` directly (already UTF-8 decoded by 03). |
| `html` | Use `payload.html` directly, with `payload.baseUrl` for relative links. |

**Dispatch table**

| `format` (03) | Extractor | PRD priority |
| --- | --- | --- |
| `pptx` | §5.1 | High |
| `docx` | §5.2 | High |
| `pdf` | §6.1, with §6.2 deciding per page whether §6.3 rendering is needed. The result's `format` becomes `'pdf-scanned'` only when every processed page is image-only; `stats.scannedPages` counts image-only pages either way. | High (text), Medium (scanned) |
| `markdown` | §9.1 | High |
| `csv` (03 assigns it to `.csv` and `.tsv`) | §8.1 CSV path; the delimiter is tab when `location` ends in `.tsv`, otherwise SheetJS auto-detects | Low |
| `text` | §9.2 | High |
| `png`, `jpeg`, `gif`, `webp`, `bmp` | §7 image extractor, decoded directly in the render window | High |
| `heic`, `tiff` | §7 image extractor, after the §7.1 `sips` pre-conversion to JPEG | High |
| `xlsx` | §8.1 | Low |
| `html` | §9.3. For a `path` payload (a local `.html` file) the file is read and passed through the readability helper from `05-url-fetching.md` first, as 03 specifies; `html` payloads from 03/05 are already readable HTML. | High |

Macro-enabled OOXML (`.pptm`, `.docm`, `.xlsm`) arrives as the base format; macros are never read or run. AVIF, RTF, and legacy Office never reach this module (03 skips them).

---

## 5. Office documents

### 5.1 PowerPoint (.pptx)

PRD: *Preserve slide order, slide titles, bullet hierarchy, speaker notes.*

**Libraries:** `SafeZip` (`zip-safety.ts`, a small central-directory reader on `node:zlib` with pre-inflate size checks and capped inflation; §10.3) and `fast-xml-parser` (pure JS, no native dependencies). We parse the XML parts directly rather than use a high-level pptx library, because none of those libraries keep bullet levels and notes reliably, and the subset of DrawingML we need is small.

**XML parser configuration** (`src/main/extract/ooxml-xml.ts`, shared by all pptx parts and the docx style and text-box scans; SheetJS parses xlsx itself):

```ts
const parser = new XMLParser({
  preserveOrder: true,          // keeps interleaved a:r / a:br / a:fld order and p:spTree shape order
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,        // element names stay "a:p", "p:sp", ...
  processEntities: true,        // decodes &amp; &lt; &gt; &quot; &apos; and numeric references
  htmlEntities: XML_ENTITIES,   // the five XML entities only: fast-xml-parser v5 decodes numeric
                                // references only when this is truthy; no HTML named entities
  allowBooleanAttributes: true,
  trimValues: false,            // keep a:t runs literally, including whitespace-only runs
  parseTagValue: false,         // no "007" -> 7 coercion
  parseAttributeValue: false,
});
```

Before parsing any part, reject it as `corrupt` if its text contains `<!DOCTYPE` or `<!ENTITY` (valid OOXML never has them). That check is the DTD and entity-expansion defense; `processEntities: true` then only ever sees the predefined entities and character references. With `preserveOrder: true` every element is an array entry `{ 'a:p': [...children], ':@': { '@_lvl': '1' } }`, and the walkers below iterate children in array order.

**Algorithm**

1. Run the ZIP safety check (§10.3) while opening the archive with `SafeZip`.
2. Parse `ppt/presentation.xml`. Read `p:sldIdLst/p:sldId` in document order. Each `r:id` resolves through `ppt/_rels/presentation.xml.rels` to a slide part. **This list is the slide order.** Never sort by file name: `slide10.xml` can come before `slide2.xml`, and reordered decks do not renumber their files.
3. For each slide part (index `i`, 1-based):
   1. Parse the slide XML and its `.rels`. Skip the slide if `show="0"`, unless `limits.pptx.includeHidden` is set. Count skipped hidden slides in `warnings`.
   2. **Shapes in reading order.** Walk `p:spTree` depth-first, flattening `p:grpSp` groups. Sort top-level shapes by `(y, x)` from `a:off` in EMUs, with a 0.5-inch row tolerance, so two-column layouts read left column then right. Placeholder shapes without their own `a:xfrm` inherit position from the layout, and when it cannot be resolved they keep document order.
   3. **Title:** the first shape whose `p:nvPr/p:ph@type` is `title` or `ctrTitle` sets `SlideBlock.title` to its concatenated text. A `subTitle` placeholder becomes a `paragraph`. If there is no title placeholder, the title stays `undefined` and a count of untitled slides goes to `warnings`. The pipeline can still refer to the slide as "Slide N".
   4. **Body text (`p:txBody`):** each `a:p` is one line. Its text is the concatenation, in child order, of `a:r/a:t`, `a:fld/a:t`, and `a:br` (as a space). Its level is `a:pPr@lvl` (0 to 8, default 0).
      - Group consecutive paragraphs that have a bullet into one `ListBlock`, and build nesting from `lvl`. A paragraph at level `n+k` becomes a child of the most recent item at level `n`. A jump of more than one level attaches to the nearest shallower item.
      - A paragraph is bulleted if `a:pPr` has `a:buChar` or `a:buAutoNum`, or if it has no `a:buNone` and sits in a `body` or `obj` placeholder, since the layout supplies the bullet. `a:buAutoNum` makes the list `ordered`.
      - Other paragraphs become `ParagraphBlock`s. Drop empty paragraphs.
   5. **Tables (`a:graphicFrame//a:tbl`):** each `a:tr/a:tc` becomes a cell with its text. `gridSpan`/`hMerge`/`vMerge` continuation cells become `""`. The first row is the `header` when `a:tblPr@firstRow="1"`.
   6. **Charts (`c:chart` relationship):** read the chart part's cached values (`c:cat`, `c:val`, `c:tx`) into a `TableBlock` with `caption = "Chart: <title>"`. This keeps the numbers behind the charts that are common in finance decks. It is cheap because the values are cached in the XML.
   7. **SmartArt (`dgm` relationships):** take the text nodes from the data part (`dgm:pt/dgm:t`) as a flat `ListBlock`.
   8. **Pictures (`p:pic`):** follow `r:embed` to `ppt/media/*`. Each picture is a candidate for vision (§7.3), and pictures are kept or dropped by the embedded-image policy. Alt text comes from `p:cNvPr@descr`.
   9. **Speaker notes:** follow the slide's `notesSlide` relationship. Take text from the `body` placeholder only, which excludes the slide-image placeholder and the slide-number field. Join paragraphs with `\n`. If the result is non-empty, set `SlideBlock.notes = { kind: 'notes', text }`.
4. `ExtractedContent.title` is the core property `dc:title` (`docProps/core.xml`) if present and not a default such as "PowerPoint Presentation". Otherwise it is slide 1's title.

**Edge cases**

| Case | Handling |
| --- | --- |
| Slide text is almost entirely in images (a screenshot deck) | Embedded-image policy (§7.3) prefers these slides for vision |
| Text boxes with the same text on every slide (footers, confidentiality banners) | Remove any line that appears on more than 60% of slides and on at least 3 slides, including `ftr`/`sldNum`/`dt` placeholders. Record the count in `warnings`. |
| Ruby/phonetic text, equations (`a14:m`) | Equations: take the `m:t` text. Anything unknown is ignored. |
| Slide count > `limits.pptx.maxSlides` (default 300) | Keep the first N slides, set `truncated`, and add a warning |
| Broken relationship target | Skip that shape, add a warning, and continue |

### 5.2 Word (.docx)

PRD: *Preserve headings, lists, tables.*

**Library:** `mammoth` (pure JS). It already resolves style inheritance, numbering definitions (`numbering.xml`), and list nesting, which are the hard parts of docx. We call `mammoth.convertToHtml` with a style map, then turn the HTML into blocks with the shared helper (§9.3). Parsing `document.xml` by hand would mean reimplementing numbering resolution. mammoth unzips internally with its own bundled ZIP library, so the `yauzl` safety check (§10.3) runs on the file first and mammoth is only called if it passes.

**Configuration**

- **Heading style pre-scan.** mammoth style maps match style names or style IDs only, not `w:outlineLvl`. So before conversion, read `word/styles.xml` (through `SafeZip` and the §5.1 XML parser) and collect every `w:style[@w:type='paragraph']` whose own or inherited (`w:basedOn` chain, max depth 10) `w:pPr/w:outlineLvl@w:val` is `n` with `0 <= n <= 5`. For each, add `p[style-name='<w:name>'] => h<n+1>:fresh` (mammoth style maps match `style-name` or `p.<StyleId>`, not `style-id`). This covers localized built-in headings (for example `Überschrift 1`, `Titre 1`, `見出し 1`) and custom heading styles without a hard-coded name list.
- `styleMap` (after the generated entries): map `Title` to `h1`. Map `Heading 1`..`Heading 6` by name to `h1`..`h6` as a fallback for styles that lack `w:outlineLvl`. Map `Quote`/`Intense Quote` to `blockquote`. Map `Caption` to `p.caption`.
- `includeDefaultStyleMap: true`, and `ignoreEmptyParagraphs: true`.
- `convertImage`: collect the bytes as image candidates (§7.3) and emit a placeholder `<img data-eli5-img="n">` that becomes an `ImageBlock`. Alt text comes from `descr`.
- Footnotes and endnotes: mammoth renders them as a list at the end. Keep them as a final `HeadingBlock("Notes", 2)` followed by a `ListBlock`.
- Comments and tracked changes: accept insertions, drop deletions (the mammoth default), and ignore comments.

**Post-processing**

1. **Heading fallback:** if the document has no heading blocks, promote any paragraph that is at most 120 characters, entirely bold, and followed by a non-bold paragraph to `h2`. Record the promotion in `warnings`. Many expert-written docs use bold "headings" without heading styles.
2. **Tables:** mammoth emits `<table>` including nested tables. Flatten nested tables into their cell text joined with `; `. A header comes from `<th>` or from `w:tblHeader` on the first row.
3. **Captions:** a `p.caption` right before or after a table becomes that table's `caption`.
4. **Title:** `docProps/core.xml` `dc:title`, else the first `h1`.
5. Surface mammoth's `messages` (unrecognized styles) in the debug log, not in `warnings`, because they are noisy.

**Edge cases:** mammoth (1.13) reads `w:txbxContent` text inline, but not reliably for every shape. Scan `document.xml` for `w:txbxContent`, append only the paragraphs mammoth did not already emit (no duplicated text) at the end under `HeadingBlock("Text boxes", 2)`, and add a warning. SmartArt in docx is not extracted, and a warning records it. Size cap: `limits.maxCharsPerSource` (§10.1).

---

## 6. PDF

**Library:** `pdfjs-dist` (Mozilla pdf.js, pure JS), with the major version pinned in `package.json` (for example `"pdfjs-dist": "~4.x.y"`, exact pin chosen in `01-architecture.md` §7), because its module paths and worker contract change between majors. We do not use `pdf-parse` (an unmaintained wrapper around an old pdf.js) or any poppler/mupdf binary (native, licensing burden).

**Integration in the extract worker (text extraction):**

- pdf.js v4+ is ESM-only. The worker imports `pdfjs-dist/legacy/build/pdf.mjs` with a dynamic `import()`, and electron-vite marks `pdfjs-dist` as external for the utility-process entry so it is not re-bundled into CJS.
- In Node, pdf.js runs a "fake worker" that dynamically imports its worker module. Bundling breaks that lookup, so the worker sets `GlobalWorkerOptions.workerSrc = pathToFileURL(resourcePath('pdfjs/pdf.worker.mjs')).href` before the first `getDocument`. `pdf.worker.mjs` (and the matching `pdf.mjs` for §6.3) is copied from `node_modules/pdfjs-dist/legacy/build/` into the app's resources by electron-builder `extraResources`. `resourcePath()` resolves to `process.resourcesPath` when packaged and to the repo's build output in development.
- `getDocument` options: `disableFontFace: true`, `isEvalSupported: false`, `useSystemFonts: false`, `disableAutoFetch: true`, `disableStream: true`, and `data` read from `payload.path`.

### 6.1 Text PDFs

PRD: *Extract text with page order.*

1. Load with `getDocument({ data, password: '' })`. A `PasswordException` gives `encrypted`. PDFs encrypted with an empty owner password (print-restricted) open normally.
2. `pages = min(numPages, limits.pdf.maxPages)` (default 500). For each page `p` in `1..pages`:
   1. `page.getTextContent({ includeMarkedContent: false })`.
   2. **Line assembly:** group items by baseline `transform[5]`, with a tolerance of 0.5 × the median item height. Sort lines top to bottom and items left to right. Insert a space between items when the horizontal gap is more than 0.15 × the font height. Use `item.hasEOL` as a line break hint.
   3. **Columns:** if items cluster into two or more x-bands with a vertical gutter wider than 5% of the page width that holds on at least 60% of lines, read each band top to bottom, left band first.
   4. **Paragraphs:** join consecutive lines. Start a new paragraph when the vertical gap is more than 1.5 × the line height, or when the indent changes. Remove end-of-line hyphenation (`-\n` followed by a lowercase letter).
   5. **Headings (cheap heuristic):** a line whose median font height is at least 1.3 × the document's median body height and that is 120 characters or shorter becomes a `HeadingBlock`. Level 1 is for the largest size class and level 2 for the next. The heuristic stays conservative, and a wrong guess only affects structure hints.
   6. **Lists:** lines starting with `•`, `◦`, `▪`, `–`, `-`, `*`, `\d+[.)]`, or `[a-z][.)]` become list items. Indentation sets nesting.
   7. Emit `PageBlock { number: p, blocks }`.
3. **Running headers and footers:** remove a line that appears (after normalizing digits to `#`) in the top or bottom 8% of the page on more than 50% of pages and on at least 3 pages.
4. Tables are **not** reconstructed from PDFs, because that is expensive and unreliable. Tabular text comes through as lines, which LLMs handle well.
5. `title`: the `Title` field in the PDF info dictionary or XMP metadata if it is non-empty and not a file name. Otherwise the first heading on page 1.
6. Scanned-page check (§6.2) runs on the page statistics collected here.

### 6.2 Scanned PDF detection

A page is **image-only** if its extracted text has fewer than `limits.pdf.minCharsPerPage` (default 40) non-whitespace characters **and** its operator list (`page.getOperatorList()`) contains at least one `paintImageXObject`/`paintInlineImageXObject` covering 50% or more of the page area. The coverage comes from the current transform matrix.

Classification over the processed pages:

| Condition | Result |
| --- | --- |
| No image-only pages | Text PDF: §6.1 output only |
| Every page image-only | `format = 'pdf-scanned'`, `stats.scannedPages = pages`: render all pages (§6.3) |
| Some pages image-only (mixed, e.g. signed scans appended) | Keep text pages as §6.1 `PageBlock`s. Render only the image-only pages and give each an `ImageBlock` inside its `PageBlock`. `stats.scannedPages` = count of image-only pages. |
| Text present but garbage (more than 30% of characters in the Private Use Area or U+FFFD, typical of broken font encodings) | Treat those pages as image-only |

OCR text layers from scanners ("searchable PDFs") count as text, so no render is needed.

### 6.3 Page rendering for vision

PRD: *Render pages to images, send to vision.* There is no OCR engine in any edition.

Rendering needs a canvas. Node has no canvas without a native module (`canvas`, `@napi-rs/canvas`). In keeping with the PRD rule of no extra browser dependency, pages are rendered with pdf.js **inside a hidden, sandboxed Electron renderer** (the "extract render window"). That reuses Chromium's canvas and the same pattern as the URL-fetch fallback in `05-url-fetching.md`. The same window also performs image normalization (§7.1), so decoding and resizing never block the main process event loop.

```ts
export type PdfPageRenderer = (
  pdf: Uint8Array,
  pages: number[],                 // 1-based
  opts: { targetLongEdgePx: number; signal: AbortSignal }
) => Promise<Array<{ page: number; png: Uint8Array; width: number; height: number } | { page: number; error: string }>>;
```

Implementation (`src/main/extract/pdf-render-window.ts`, named per 01 §2):

1. **Scheme.** Before `app.whenReady()`, main calls `protocol.registerSchemesAsPrivileged([{ scheme: 'eli5res', privileges: { standard: true, secure: true, supportFetchAPI: true } }])`, and on the render session registers `session.protocol.handle('eli5res', ...)` serving only files under `resources/pdf-render/` and `resources/pdfjs/`. The page is loaded from `eli5res://pdf-render/render.html`, **not** `file://`, because Chromium refuses module workers from `file://` origins and pdf.js needs its `pdf.worker.mjs` as a module worker. The page sets `GlobalWorkerOptions.workerSrc = 'eli5res://pdfjs/pdf.worker.mjs'`.
2. **Window.** One hidden `BrowserWindow` per job that needs rendering or image normalization, created lazily, reused for every source in that job, and destroyed at job end. Settings: `show: false`, `webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: <pdf-render/preload.cjs>, partition: 'eli5-pdf-render' }`. `backgroundThrottling: false` is required because a hidden window is otherwise throttled and timers and `requestAnimationFrame` stall. `session.webRequest.onBeforeRequest` cancels every request whose scheme is not `eli5res:`, `blob:`, or `data:`, so the page has no network.
3. **Channel.** Main creates a `MessageChannelMain` and sends one end with `webContents.postMessage('eli5:extract:render-port', null, [port])`. That message arrives at `ipcRenderer`, which exists only in the preload, so the preload is minimal: it listens once for `eli5:extract:render-port` and forwards the port to the page with `window.postMessage('eli5-render-port', '*', [port])`. It exposes nothing on `window` and handles no other channel. The page then speaks a small request/response protocol over the port: `{ op: 'render-pdf', id, pdf, pages, targetLongEdgePx }` and `{ op: 'normalize-image', id, bytes, mediaType, opts }`. Bytes are structured-cloned across the port.
4. **Rendering.** The page renders each requested page to an `OffscreenCanvas` at `scale = targetLongEdgePx / max(viewport.width, viewport.height)` and returns `convertToBlob({ type: 'image/png' })` bytes.
5. Pages render one at a time, which keeps memory bounded. Each page has its own timeout of `limits.pdf.renderPageTimeoutMs` (default 15 s). If one page fails, it gets an `error` entry and the others continue. If the window's renderer process crashes (`render-process-gone`), outstanding requests fail and the window is recreated once for the next request.
6. `targetLongEdgePx` defaults to 1568 (§7.1), and the result then goes through the normal image normalization.

The PDF bytes for rendering are read by the extract worker (§10.4), returned to main by structured clone, and posted to the render window. The extract worker cannot talk to the window directly.

**Page caps for rendering:** at most `limits.pdf.maxRenderedPages` (default 30) pages per source, still bounded by the job-wide image budget (§7.4). If more pages are image-only, render pages `1..N`, set `truncated`, and add the warning "Rendered first 30 of 84 scanned pages". If no page renders, return `skipped` with `scan-render-failed`.

---

## 7. Images

PRD: *Send directly to the LLM's vision input. No OCR engine.* Also: *paste a screenshot of something complex someone wrote and ask the app to explain it.*

### 7.1 Limits and normalization

**Where it runs.** Normalization runs in the extract render window (§6.3), not in main. Electron `nativeImage` is not used: it only guarantees PNG and JPEG from `createFromBuffer`, has no EXIF orientation API and no header-only dimension read, and its calls are synchronous, so decoding a 50 MP image in main would freeze IPC, the tray, and the UI. Chromium in the hidden window decodes PNG, JPEG, GIF (first frame), WebP, and BMP off the main process. Chromium cannot decode HEIC or TIFF. `sharp` was rejected as a native module that adds packaging and notarization cost for no gain here.

**Formats.** Standalone sources arrive as `png`, `jpeg`, `gif`, `webp`, `bmp`, `heic`, or `tiff` (03 §5, `sniff()`). `heic` and `tiff` are first converted in the extract worker with the built-in macOS tool: `execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', <in>, '--out', <tmp>.jpg])`, with no shell, a 15 s timeout, input and output in a private temp directory (`ExtractContext` carries no staging directory), and that directory deleted afterwards. `sips` keeps the EXIF orientation tag in the JPEG, and step 2 applies it. A non-zero exit or missing output gives `corrupt`. The JPEG then goes through the normal steps below. Embedded images inside pptx/docx follow the same rules by their sniffed type (TIFF and HEIC through `sips`); EMF and WMF are not converted and are dropped under the §7.3 placeholder rule with the warning "N embedded vector images (EMF/WMF) omitted".

**Header dimensions** are read in the extract worker by `image-header.ts` (a header-only parser for PNG, JPEG with EXIF orientation, GIF, WebP, BMP, TIFF, HEIC, EMF and WMF; no dependency) before any bytes are sent for decoding.

```ts
export type ImageNormalizer = (
  bytes: Uint8Array,
  mediaType: string,
  opts: { origin: ImageBlock['origin']; signal: AbortSignal }
) => Promise<{ ok: true; assets: ImageAsset[] } | { ok: false; code: 'image-too-large' | 'corrupt' }>;
```

`assets` has one entry, or several for tiled tall screenshots (§7.2). `07-output-document.md` §5.6 and `02-llm-provider.md` §8.3 call this same normalizer (with their own size targets) instead of `nativeImage`.

| Limit | Default | Rationale |
| --- | --- | --- |
| `images.maxInputBytes` | 20 MiB | Same as 03's `maxImageBytes`, which is applied first at resolve time. Here it also bounds embedded images. |
| `images.maxInputPixels` | 50 MP | Decompression-bomb guard; check the header dimensions before a full decode |
| `images.targetLongEdgePx` | 1568 | Largest size that current vision APIs use without server-side downscaling. Larger sizes add cost with no benefit. |
| `images.minShortEdgePx` | 200 | Below this, keep the original size (do not upscale) |
| `images.maxOutputBytes` | 3.75 MB | Keeps base64 payload under 5 MB, the strictest per-image cap among supported providers (see `02-llm-provider.md`) |
| `images.maxAspect` | 1:8 | Very tall screenshots are split (§7.2) |

Normalization algorithm (steps 2 to 6 run in the render window page, `resources/pdf-render/normalize.js`):

1. In the extract worker: read the dimensions with `image-header.ts`. Unreadable header gives `corrupt`. If `width × height` exceeds `maxInputPixels`, return `image-too-large` without decoding.
2. Decode with `createImageBitmap(new Blob([bytes], { type: mediaType }), { imageOrientation: 'from-image' })`. `'from-image'` applies EXIF orientation, so phone photos and rotated JPEGs come out upright. A rejected promise gives `corrupt`.
3. Compute the target size: if the long edge is more than `targetLongEdgePx`, scale to it; never upscale. The resize is done by `createImageBitmap`'s `resizeWidth`/`resizeHeight` with `resizeQuality: 'high'`.
4. Draw onto an `OffscreenCanvas`. For JPEG output, first fill it with white so transparent pixels are flattened onto white.
5. Choose the encoding. Sample up to 65,536 pixels with `getImageData` and count distinct colors, stopping at 4,097; store the result as `ImageAsset.distinctColors`. Keep PNG when the image has any alpha below 255 or 4,096 colors or fewer (screenshots, diagrams); otherwise JPEG quality 0.85. Encode with `OffscreenCanvas.convertToBlob({ type, quality })`.
6. If the output exceeds `maxOutputBytes`, re-encode as JPEG at quality 0.75, then 0.60, then scale down by 0.8 and repeat. Stop after 4 attempts with `image-too-large`.
7. The bitmap is `close()`d after each attempt so memory is released between images. The whole call is bounded by the 15 s image timeout (§10.2).

### 7.2 Tall screenshots

A clipboard screenshot of a long thread or page can be taller than 8 times its width. Downscaling it to a 1568 px long edge would make the text unreadable. When the aspect ratio exceeds `maxAspect`, split the image vertically into tiles of height `1.4 × width` with a 5% overlap, up to 6 tiles. Each tile is its own `ImageAsset` and `ImageBlock`, and the alt text says "part k of n". Anything past 6 tiles is dropped with a warning.

### 7.3 Embedded images (pptx, docx)

Documents can contain dozens of logos and decorative images. Policy:

1. Drop images smaller than 64×64 px, and images whose bytes hash-match an image seen more than twice in the same source (logos, template art).
2. Rank what remains: first images on slides or pages with less than 80 characters of text (diagram or screenshot slides), then by pixel area, largest first.
3. Keep up to `limits.embeddedImagesPerSource` (default 8), subject to the job budget. For dropped images, put `[image omitted: <alt or "figure">]` as a `ParagraphBlock` in their place so the text flow stays intact.

### 7.4 Job-wide image budget

```ts
export interface ImageBudget {
  readonly maxImages: number;      // default 20 per job
  readonly maxTotalBytes: number;  // default 20 MB per job, post-normalization
  tryReserve(bytes: number, priority: 'standalone' | 'page-render' | 'embedded'): boolean;
}
```

Standalone images (dropped or pasted by the user) always have priority. The pipeline (`06-generation-pipeline.md`) reserves budget for every standalone image before extracting other sources. After that, page renders and embedded images take budget first come, first served. When the budget runs out, an image is dropped with a warning. It never causes the whole source to be skipped. A standalone image that cannot fit at all (only possible when the user drops more than 20) is skipped with `image-budget-exceeded`.

### 7.5 Standalone image output

A standalone image source produces `blocks: [ImageBlock]` (or several tiles), `images: [asset]`, and `stats.chars: 0`. That is valid under invariant 5 because an image is present. `title` is left undefined. The LLM names the topic.

---

## 8. Spreadsheets, and failures

### 8.1 Excel (.xlsx) and CSV

PRD: *Simple text or table dump. Do not over engineer.*

**Library:** SheetJS Community Edition (`xlsx`), pure JS. It is installed from the SheetJS CDN tarball pinned by version and integrity hash, because the npm registry copy is outdated. `exceljs` was rejected as heavier and streaming-oriented, which we do not need. CSV/TSV sources (`format: 'csv'`) use the same library (`XLSX.read(text, { type: 'string', FS: isTsv ? '\t' : undefined })`, text decoded with the §9.2 rules), so one code path produces tables.

Read options: `{ type: 'array', cellFormula: false, cellHTML: false, cellStyles: false, sheetRows: limits.xlsx.maxRows + 1, dense: true }`. `sheetRows` bounds parse work on huge sheets.

Algorithm:

1. Take visible sheets in workbook order (`Workbook.Sheets[i].Hidden === 0`), up to `limits.xlsx.maxSheets` (default 10). Record skipped hidden and extra sheets in `warnings`.
2. For each sheet, `sheet_to_json(ws, { header: 1, raw: false, blankrows: false, defval: '' })`. That gives formatted display strings, so dates and currency read the way the author saw them.
3. Trim empty trailing columns and rows. Detect the used rectangle, since many sheets have stray formatting far out.
4. Cap rows at `maxRows` (default 200) and columns at `maxCols` (default 30). Cap each cell at 200 characters with an ellipsis. Record the dropped counts in `TableBlock.truncated`.
5. Header: row 1 if every non-empty cell is non-numeric text and row 2 contains at least one number or date. Otherwise no header.
6. Emit `HeadingBlock(sheetName, 2)` followed by `TableBlock { caption: sheetName, ... }`.
7. Charts, pivots, formulas, comments, and formatting are ignored.

A workbook with no non-empty cells gives `empty`.

### 8.2 Skip reasons

Every failure produces `SkippedSource { ref, reason, code }` (shape and `SkipCode` union owned by `03-source-resolvers.md` §2). `ref` is `ResolvedSource.ref`. `code` is required and is always a member of 03's `SkipCode`; this module emits only the subset below. `reason` is the human sentence from the template below, shown in the document's references section. Both are persisted to `meta.json` by `09-library-storage.md` as the `SkippedSource` fields; there is no separate `reasonCode`.

```ts
/** The SkipCode values extraction may emit. A subset of 03's SkipCode, not a new union. */
export type ExtractSkipCode = Extract<SkipCode,
  | 'unsupported-type' | 'encrypted' | 'corrupt' | 'empty'
  | 'too-large' | 'zip-bomb' | 'timeout' | 'image-too-large'
  | 'image-budget-exceeded' | 'scan-render-failed' | 'internal-error'>;
```

| Code | `reason` text (template) | Typical cause |
| --- | --- | --- |
| `unsupported-type` | Unsupported file type (`.{ext}`) | Defensive only: no registered extractor for the resolver's format, or an embedded-only format reached as a source |
| `encrypted` | File is password protected | User-password PDF (encrypted OOXML is already skipped by 03) |
| `corrupt` | File could not be read (damaged or not a valid {format}) | Parse error |
| `empty` | No readable content found | Blank doc, image-free empty PDF |
| `too-large` | File too large ({size}; limit {limit}) | Over the per-format cap in §10.1, or worker out of memory |
| `zip-bomb` | File expands to an unsafe size | §10.3 |
| `timeout` | Took too long to read (over {n}s) | §10.2 |
| `image-too-large` | Image too large to send | §7.1 |
| `image-budget-exceeded` | Too many images in one job (limit {n}) | §7.4 |
| `scan-render-failed` | Scanned PDF pages could not be rendered | §6.3 |
| `internal-error` | Unexpected error while reading this file | Bug; details in the debug log |

Rules:

- Truncation is **never** a skip. Partial content comes back with `truncated: true` and a warning that `07-output-document.md` may surface next to the reference entry.
- Reason text contains no stack traces, absolute paths outside the user's own file name, or library names.
- A skip never throws out of `extractSource`. The pipeline decides whether a job with zero usable sources is a total failure (`06-generation-pipeline.md`).

---

## 9. Markdown, plain text, and HTML

### 9.1 Markdown

PRD: *Read as is.* "As is" means the text is preserved verbatim. We still parse it cheaply so that headings become section hints.

**Library:** `marked` lexer only (`marked.lexer(src, { gfm: true })`), which is pure JS, fast, and needs no HTML rendering. Token mapping: `heading` gives `HeadingBlock`, `paragraph`/`text` give `ParagraphBlock`, `list` gives `ListBlock` (nested through `items[].tokens`), `table` gives `TableBlock`, `blockquote` gives `ParagraphBlock{style:'quote'}`, `code` gives `ParagraphBlock{style:'code'}`, and `html` has its tags stripped to text. Front matter (`---` YAML at the top) is removed, and its `title` field sets `title`. Image references `![alt](src)` become `[image: alt]` text. Local image files are not followed.

### 9.2 Plain text

1. Decode: BOM-directed UTF-8/UTF-16 decoding. Without a BOM, use UTF-8, falling back to `windows-1252` via `TextDecoder` when UTF-8 produces more than 1% replacement characters.
2. Normalize line endings to `\n`.
3. Split on blank lines into `ParagraphBlock`s. Lines that look like bullets become `ListBlock`s using the §6.1 bullet patterns.
4. `.json`, `.yaml`, `.xml`, and `.log` files are wrapped whole as one `ParagraphBlock{style:'code'}` per 4,000-character chunk.
5. Clipboard plain text uses the same path. `displayName` is `"Pasted text (N words)"`.

### 9.3 HTML to blocks (shared helper)

`htmlToBlocks(html: string, baseUrl?: string): { blocks, imageRefs }` is used by docx (§5.2), by rich-text clipboard pastes, and by `05-url-fetching.md` after Readability.

- **Parser:** `linkedom` (pure JS DOM, no scripts executed), chosen over `jsdom` for its size and speed.
- **Mapping:** `h1`–`h6` to heading. `p` and `div` holding only text to paragraph. `ul`/`ol` to list (nested). `table` to table (`thead`/`th` becomes header, `colspan` is repeated as `""`). `blockquote` to quote. `pre` to code. `img` to an image ref (docx placeholder only; remote web images are not fetched in v1, and their alt text is kept inline). `figure > figcaption` to a paragraph. `script`, `style`, `nav`, `svg`, and `form` are dropped.
- Inline elements are reduced to text, and link text is kept. `a[href]` URLs are dropped from body text, except that bare autolinks stay.

---

## 10. Limits, timeouts, isolation

### 10.1 Size limits (constants in `src/main/extract/limits.ts`)

Limits are **not** user settings. `12-configuration-security.md` declares no `extract.*` namespace, and its schema is strict. `limits.ts` exports `DEFAULT_EXTRACT_LIMITS: Readonly<ExtractLimits>`, which the pipeline passes as `ctx.limits`. Tests may pass smaller values; production never changes them at runtime.

**Order of size checks.** 03 applies `maxFileBytes` (100 MiB) and, for images, `maxImageBytes` (20 MiB) at resolve time, so nothing larger ever reaches this module. The per-format caps below are applied second, in `extractSource` step 2, and are all at or below the resolver's cap.

| `ExtractLimits` key | Default | Applies to |
| --- | --- | --- |
| `maxInputBytes.office` | 100 MiB (equal to 03's `maxFileBytes`, so effectively the resolver cap) | pptx/docx (media-heavy decks are large) |
| `maxInputBytes.pdf` | 100 MiB (equal to 03's `maxFileBytes`) | pdf |
| `maxInputBytes.text` | 10 MiB | markdown/text/csv/html, including `text`/`html` payloads (measured as UTF-8 bytes) |
| `maxInputBytes.xlsx` | 50 MiB | xlsx |
| `maxCharsPerSource` | 400,000 | All. Text past this is cut at a block boundary, `truncated` |
| `pptx.maxSlides` / `pptx.includeHidden` | 300 / false | pptx |
| `pdf.maxPages` / `pdf.minCharsPerPage` | 500 / 40 | pdf |
| `pdf.maxRenderedPages` / `pdf.renderPageTimeoutMs` | 30 / 15,000 | scanned pages |
| `xlsx.maxSheets` / `maxRows` / `maxCols` | 10 / 200 / 30 | xlsx, csv |
| `embeddedImagesPerSource` | 8 | pptx, docx |
| `images.*` | see §7.1 | images |

Job-level token budgeting across sources is **not** done here. `stats.approxTokens` is reported, and the pipeline trims or summarizes (`06-generation-pipeline.md`). None of these values are touched by HOOK-CFG-01.

### 10.2 Timeouts

| Format | Default timeout |
| --- | --- |
| text, markdown, csv | 10 s |
| docx, xlsx | 30 s |
| pptx | 45 s |
| text PDF | 60 s |
| scanned PDF (incl. rendering) | 120 s, plus a per-page 15 s |
| image normalization | 15 s |

On timeout, the `AbortSignal` fires. Extractors check `signal.aborted` between slides, pages, and sheets. For operations that cannot be interrupted, the work runs in the extraction worker (§10.4), which is terminated. The result is `timeout`, unless partial output exists for a page or slide format. In that case, return what was collected with `truncated: true` and the warning "Stopped after N of M pages (timeout)".

### 10.3 Archive and parser safety

- **ZIP (OOXML), `src/main/extract/zip-safety.ts`:** all OOXML reads go through `SafeZip`, a small reader of the ZIP central directory built on `node:zlib` (no ZIP library dependency; `jszip`, already in 01 §7, has no pre-inflate size checks and is used only by the fixture generators, alongside a raw ZIP writer for the hostile fixtures). mammoth and SheetJS receive an archive only after every entry has been test-inflated under these limits.
  1. **Before inflating anything:** read the entry count and each entry's central-directory `uncompressedSize`. Refuse with `zip-bomb` if `entryCount > 10,000`, if the sum of declared `uncompressedSize` exceeds 1 GiB, or if any single `.xml`/`.rels` part declares more than 100 MiB. Also refuse entry names containing `..`, absolute paths or backslashes.
  2. **While inflating:** inflate each needed part with an output cap equal to its declared `uncompressedSize`, so a part that inflates past it fails (sizes can lie). On top of that, an archive-wide byte counter fails once the running total passes 1 GiB. Either error gives `zip-bomb`.
  3. Only the parts an extractor asks for are inflated; media parts are inflated too, because the §7.3 size, repetition and ranking rules need their dimensions and hashes; every inflate is still capped.
- **XML:** the §5.1 `fast-xml-parser` configuration with `processEntities: true` and `htmlEntities` limited to the five XML entities, so `&amp; &lt; &gt; &quot; &apos;` and numeric character references decode correctly. Any part containing `<!DOCTYPE` or `<!ENTITY` is refused as `corrupt` before parsing, so there is no DTD processing, entity expansion, or external entity.
- **PDF:** `isEvalSupported: false`, no JS execution, no font loading from the system, no network (`disableAutoFetch`, `disableStream`).
- Content is never executed: no macros, OLE objects, embedded fonts, or scripts. Embedded OLE objects (for example, a workbook inside a deck) are ignored, with a warning.

### 10.4 Process isolation

Parsing untrusted files runs in an Electron `utilityProcess` ("extract worker", `src/main/extract/worker.ts`), not in the main process. That keeps the UI and menu bar responsive, and a parser crash or runaway allocation cannot take down the app.

- **Input:** main sends `{ sourceId, format, payload, sizeBytes, location, limits }` with `child.postMessage`. For `path` payloads only the path crosses the boundary and the worker reads the file itself. `text`/`html` payloads are structured-cloned. Nothing is "transferred": `utilityProcess` `postMessage` can transfer only `MessagePortMain` objects, and all other data, including `Uint8Array`, is copied by structured clone.
- **Output:** the worker returns a serialized `ExtractResult`. `ImageAsset.data` is structured-cloned back to main, which is acceptable because the §7.4 budget caps it at 20 MB per job.
- **Round trips for rendering.** When the worker needs scanned pages rendered or an image normalized, it sends a request to main (bytes copied), main forwards it to the extract render window (§6.3), and the reply returns the same way. The worker never touches Electron window APIs.
- One worker is shared per job, running sources in that job one at a time. Jobs run in parallel with separate workers, and at most 2 workers run at once. Other jobs wait (`06-generation-pipeline.md` owns queueing).
- The worker heap is capped (`execArgv: ['--max-old-space-size=1024']`). If the worker exits unexpectedly, the source is skipped with `internal-error` (or `too-large` if the exit was out-of-memory), and a fresh worker is started for the next source.
- Main-process work for extraction is limited to message routing. Image decoding, resizing, and PDF page rendering run in the sandboxed render window (§6.3, §7.1), and `sips` runs as a child process spawned by the worker, so no synchronous image work happens on the main event loop.

---

## 11. Prompt serialization

`toPromptText(content: ExtractedContent, opts?: { imageMarker?: (b: ImageBlock) => string }): string` produces a deterministic, structure-preserving text form used by `06-generation-pipeline.md` through 02. Images are referenced by marker and attached separately through `LLMProvider` (see `02-llm-provider.md`); 02 passes `imageMarker` so the marker names the vision label the model sees. `blocksToPromptText(blocks, opts?)` renders a run of blocks the same way (02 uses it per block when chunking, 02 §8.4).

This module renders only the body. The untrusted-content delimiter `<source ...>` and its escaping belong to 02 (02 §9 "Untrusted content"), which wraps the body with `ref` plus the attributes from `promptAttributes(content)`: `format`, then `slides`, `pages`, `scanned-pages`, `sheets` when present, then `truncated`. Put together by 02, a source reads:

```
<source ref="Q3 board deck.pptx" format="pptx" slides="24" truncated="false">
## Slide 3: Revenue bridge
- Net revenue up 12% YoY
  - Driven by enterprise renewals
| Region | Q2 | Q3 |
| --- | --- | --- |
| NA | 41 | 46 |
[image #a1b2c3d4-img-2: "waterfall chart"]
> Speaker notes: Emphasize that churn is flat...
</source>
```

The golden files hold the body only (no delimiter lines).

Rules: slides render as `## Slide N: <title>` (or `## Slide N` without a title). Pages render as `--- Page N ---`. Headings use `#` by level, offset by 2 inside slides. Lists are indented 2 spaces per level. Tables are pipe tables with `|` escaped. Notes are prefixed with `> Speaker notes:`. Code blocks are fenced. Attribute values are escaped by 02. Output for identical input is byte-identical, which golden tests rely on (`13-testing-quality.md`).

---

## 12. Module layout

```
src/main/extract/
  index.ts              extractSource(), registry, invariant checks
  types.ts              ExtractedContent, ExtractedFormat, ContentBlock, ImageAsset, ExtractSkipCode, ExtractLimits
  limits.ts             DEFAULT_EXTRACT_LIMITS (§10.1)
  payload.ts            payload access by kind (§4)
  zip-safety.ts         SafeZip reader + checks (§10.3)
  ooxml-xml.ts          shared XMLParser config + DOCTYPE/ENTITY guard (§5.1)
  pptx.ts  docx.ts  pdf.ts  xlsx.ts  markdown.ts  text.ts
  html-to-blocks.ts     §9.3 (shared with fetch/)
  images.ts             header check (image-header.ts), sips pre-conversion, tiling, ImageBudget (§7)
  pdf-render-window.ts  extract render window: PdfPageRenderer + ImageNormalizer (§6.3, §7.1)
resources/pdf-render/  render.html, render.js, normalize.js, preload.cjs (served via eli5res://)
resources/pdfjs/           pdf.mjs, pdf.worker.mjs (copied from pdfjs-dist by extraResources)
  serialize.ts          toPromptText(), blocksToPromptText(), promptAttributes() (§11)
  worker.ts             utilityProcess entry (§10.4)
  skip.ts               code → reason text (§8.2)
```

Dependencies added by this module: `fast-xml-parser`, `mammoth`, `pdfjs-dist` (major version pinned), `xlsx` (SheetJS CE, from the CDN tarball), `marked`, `linkedom`; `jszip` and dev-only `exceljs` for fixtures. ZIP reading and image headers use in-repo code (`zip-safety.ts`, `image-header.ts`). All are pure JS. `sips` is part of macOS, not a dependency. None are native modules, so there is no rebuild step for Electron's ABI and nothing extra to sign or notarize.

---

## Acceptance criteria

- [ ] `extractSource` dispatches on `ResolvedSource.format` with no re-sniffing, and reads `path` payloads lazily and `text`/`html` payloads directly. `SourceFormat`, `ResolvedSource`, `SkippedSource`, and `SkipCode` are imported from `src/main/sources/types.ts`, not redefined.
- [ ] User-password PDFs are skipped with code `encrypted` and "File is password protected". Every `SkippedSource` from this module has a `code` in `ExtractSkipCode`, and no `reasonCode` field exists.
- [ ] A file over a per-format cap in `limits.ts` is skipped as `too-large`; no cap exceeds 03's `maxFileBytes`, and no `extract.*` settings key exists.
- [ ] pptx: slides come out in `sldIdLst` order, including a fixture whose file names are out of order. Titles come from title placeholders. Bullet nesting matches `lvl` to at least 3 levels. Speaker notes are attached to the correct slide and exclude slide-number fields. A slide containing `R&D <50%` extracts that literal text (entities decoded), and a paragraph with interleaved runs, a line break, and a field keeps their order. Repeated footer text is removed. Chart cached values appear as tables.
- [ ] docx: `Heading 1..6` map to heading levels, and a fixture with localized heading styles (for example `Überschrift 1`, `Titre 1`) maps through the `w:outlineLvl` pre-scan. Numbered and bulleted lists keep nesting. Tables keep rows and columns, with header detection. Bold pseudo-headings are promoted only when no real headings exist.
- [ ] Text PDF: text is in page order with `PageBlock` numbers matching the PDF. Two-column fixtures read column by column. Running headers and footers are removed. De-hyphenation works.
- [ ] Scanned PDF: an image-only fixture is detected, and at most 30 pages are rendered at a 1568 px long edge through the hidden window with no network access. The window loads over `eli5res://`, has `backgroundThrottling: false`, and receives its `MessagePort` through the minimal preload. pdf.js text extraction works in a packaged build with `workerSrc` pointing at the copied `pdf.worker.mjs`. A mixed PDF renders only the image-only pages. No OCR library is present in the dependency tree.
- [ ] Images: PNG/JPEG/GIF/WebP/BMP inputs, and HEIC/TIFF via `sips`, are normalized under 3.75 MB with a long edge of 1568 px or less. EXIF rotation is applied. A 1000×12000 screenshot is tiled into readable parts. A 60 MP image is refused from its header (via `image-header.ts`) before any decode. No `nativeImage` call is made during extraction, and the main process event loop never blocks for more than 50 ms while normalizing a 48 MP JPEG.
- [ ] Standalone images always get budget ahead of embedded images and page renders. Exceeding the job image budget drops embedded images with a warning and does not skip their source.
- [ ] xlsx/csv: visible sheets only, with caps of 10 sheets, 200 rows, and 30 columns applied and reported in `TableBlock.truncated`. Values are formatted display strings.
- [ ] Markdown keeps the text verbatim, with headings, lists, and tables mapped. Plain text in windows-1252 decodes correctly.
- [ ] Every failure path returns `SkippedSource` with a human reason from §8.2. No extractor exception escapes `extractSource`. Truncation never causes a skip.
- [ ] ZIP bomb fixtures (entry count, declared size, lying sizes) are refused as `zip-bomb` through `SafeZip` within 1 s without large memory growth. XML parts containing `<!DOCTYPE` or `<!ENTITY` are refused as `corrupt`.
- [ ] Extraction runs in a `utilityProcess`. A parser crash or timeout in one source leaves the app responsive and the rest of the job running.
- [ ] `toPromptText` output is byte-identical across runs for all golden fixtures.
- [ ] Every dependency is pure JS. `electron-builder` packaging needs no native rebuild for this module.
- [ ] This file contains no private hook definitions. Extraction behaves identically in public and enterprise builds.
