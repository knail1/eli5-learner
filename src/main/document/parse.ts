// index.html -> DocumentModel (07 §8): reads the embedded model, asset bytes from <img data-asset-id>,
// the theme and the runtime blocks. Also byte-exact locate/splice primitives for sections (08 §6.4).
import { DocumentFormatError } from './errors';
import { attr, findAll, findById, innerSpan, outerSpan, parseTree, rawInner, textOf, type Span } from './html-tree';
import { fromDataUri, sha256Hex } from './images';
import { animationScriptHashes } from './animation';
import { modelJson, renderSectionHtml } from './render/page';
import { PALETTE_RUNTIME_VERSION, compareRuntimeVersions } from './runtime-assets';
import { DocumentModelSchema } from './schema';
import { sanitizeSvg } from './svg-sanitize';
import { DEFAULT_FOOTER, parseThemeCss, parseThemeDarkCss } from './theme';
import type { DocBlock, DocTheme, DocumentModel, ParsedDocument, Section } from './types';
import { checkAnimation, svgIdPrefix } from './validate';

/** The newest `formatVersion` this build understands (07 §3). */
export const FORMAT_VERSION = 1;

/** Reads and validates `#eli5-model` only (no assets); throws DocumentFormatError. */
export function parseModelJson(json: string): DocumentModel {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new DocumentFormatError('invalid_model', 'model JSON does not parse');
  }
  const v = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof v === 'number' && v > FORMAT_VERSION) throw new DocumentFormatError('bad_version', `formatVersion ${v}`);
  const r = DocumentModelSchema.safeParse(raw);
  if (!r.success) throw new DocumentFormatError('invalid_model', r.error.issues[0]?.path.join('.') ?? 'schema');
  resanitizeDiagrams(r.data);
  return r.data;
}

const DIAGRAM_PREFIX_RE = /\bid="(d[0-9a-f]{8}-)/;

/** Stored SVG of a document whose runtime predates the current chart palette (07 §7.3, §11.1). */
function legacyPalette(model: DocumentModel): boolean {
  return compareRuntimeVersions(model.generator.runtimeVersion, PALETTE_RUNTIME_VERSION) < 0;
}

/**
 * The model JSON is file content, not trusted build output: diagram SVG (and every animation, 07
 * §7.1) is re-run through the 07 §7.3 sanitizer (a fixed point for builder output, so round-trips stay byte-exact) and
 * diagrams that do not survive are dropped. SVG stored under the old palette has its theme
 * classes renumbered once (the sanitizer's palette mark stops a second pass).
 */
function resanitizeDiagrams(model: DocumentModel): void {
  const legacy = legacyPalette(model);
  const clean = (sec: Section): void => {
    sec.blocks = sec.blocks.flatMap((b): DocBlock[] => {
      if (b.type === 'animation') {
        // 07 §8: the same checks as at build (poster sanitizer, caps, lint); a fixed point for
        // builder output, so round-trips stay byte-exact. A hand-edited one that fails is dropped.
        const prefix = svgIdPrefix(b.poster) ?? `d${sha256Hex(new TextEncoder().encode(b.poster)).slice(0, 8)}-`;
        const kept = checkAnimation(b, prefix);
        return kept ? [kept] : [];
      }
      if (b.type !== 'diagram') return [b];
      const idPrefix =
        DIAGRAM_PREFIX_RE.exec(b.svg)?.[1] ?? `d${sha256Hex(new TextEncoder().encode(b.svg)).slice(0, 8)}-`;
      const svg = sanitizeSvg(b.svg, {
        idPrefix,
        ariaLabel: b.alt,
        rootClass: 'diagram-svg',
        labelContrast: true,
        legacyPalette: legacy,
      });
      return svg === null ? [] : [{ ...b, svg }];
    });
  };
  for (const tab of model.tabs) for (const sec of tab.sections) clean(sec);
}

export function parseDocument(html: string): ParsedDocument {
  const { doc } = parseTree(html);
  const script = findById(doc, 'eli5-model');
  if (!script || script.tagName !== 'script') throw new DocumentFormatError('no_model');
  const model = parseModelJson(textOf(script));

  const assets = new Map<string, Uint8Array>();
  for (const img of findAll(doc, (el) => el.tagName === 'img' && attr(el, 'data-asset-id') !== undefined)) {
    const id = attr(img, 'data-asset-id') ?? '';
    const data = fromDataUri(attr(img, 'src') ?? '');
    if (data && !assets.has(id)) assets.set(id, data.bytes);
  }

  const themeStyle = findById(doc, 'eli5-theme');
  const footer = findAll(doc, (el) => el.tagName === 'footer' && attr(el, 'class') === 'doc-foot')[0];
  const footerText = footer ? textOf(footer).trim() : DEFAULT_FOOTER;
  const logo = findAll(doc, (el) => el.tagName === 'span' && attr(el, 'class') === 'doc-logo')[0];
  const themeText = themeStyle ? textOf(themeStyle) : '';
  const darkTokens = parseThemeDarkCss(themeText);
  const theme: DocTheme = {
    id: model.theme.id,
    version: model.theme.version,
    tokens: parseThemeCss(themeText),
    ...(darkTokens ? { darkTokens } : {}),
    footer: footerText.startsWith(`${DEFAULT_FOOTER} · `)
      ? footerText.slice(DEFAULT_FOOTER.length + 3)
      : DEFAULT_FOOTER,
  };
  // The logo bytes are file content too: re-sanitize (idempotent for theme.ts output) or drop.
  const logoSvg = logo
    ? sanitizeSvg(rawInner(html, logo), {
        idPrefix: 'logo-',
        ariaLabel: 'Logo',
        rootClass: 'doc-logo-svg',
        legacyPalette: legacyPalette(model),
      })
    : null;
  if (logoSvg) theme.logoSvg = logoSvg;

  const js = findById(doc, 'eli5-runtime');
  const css = findById(doc, 'eli5-css');
  return {
    model,
    assets,
    theme,
    runtime: { js: js ? textOf(js) : '', css: css ? textOf(css) : '' },
  };
}

/** Offsets of `<section id="…">…</section>` in the file, or undefined. */
export function locateSection(html: string, sectionId: string): Span | undefined {
  const { doc } = parseTree(html);
  const el = findById(doc, sectionId);
  if (!el || el.tagName !== 'section' || attr(el, 'data-section-id') !== sectionId) return undefined;
  return outerSpan(el);
}

/** Offsets of the `#eli5-model` JSON body. */
export function locateModelJson(html: string): Span | undefined {
  const { doc } = parseTree(html);
  const el = findById(doc, 'eli5-model');
  return el ? innerSpan(el) : undefined;
}

export function spliceSpan(html: string, span: Span, replacement: string): string {
  return html.slice(0, span.start) + replacement + html.slice(span.end);
}

/**
 * Replaces one section's bytes and the embedded model JSON in `html`, leaving every other byte
 * unchanged (07 §5.5, 08 §6.4). `model` is the mutated model; the result equals a full
 * renderDocument of it when nothing outside that section changed.
 */
export function spliceSection(
  html: string,
  model: DocumentModel,
  sectionId: string,
  assets: ReadonlyMap<string, Uint8Array>,
): string {
  const sec = locateSection(html, sectionId);
  const json = locateModelJson(html);
  if (!sec || !json) throw new DocumentFormatError('no_model', `section ${sectionId} or model not found`);
  const sectionHtml = renderSectionHtml(model, sectionId, assets);
  const newJson = modelJson(model);
  // Apply the later span first so the earlier offsets stay valid.
  const [first, second] = sec.start > json.start ? [sec, json] : [json, sec];
  const firstRep = first === sec ? sectionHtml : newJson;
  const secondRep = second === sec ? sectionHtml : newJson;
  return withFrameHashes(spliceSpan(spliceSpan(html, first, firstRep), second, secondRep), model);
}

const CSP_META_RE = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src '[^' ]+')([^;"]*)/;

/**
 * The head CSP admits the runtime and every animation frame's scripts (07 §6.2): after a splice
 * that adds or removes an animation, the frame hashes after the runtime hash are rewritten, so the
 * file still equals a full render. Every other byte stays.
 */
function withFrameHashes(html: string, model: DocumentModel): string {
  const blocks = model.tabs.flatMap((t) =>
    t.sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === 'animation' ? [b] : []))),
  );
  const tail = animationScriptHashes(blocks)
    .map((h) => ` ${h}`)
    .join('');
  return html.replace(CSP_META_RE, (_m, head: string) => head + tail);
}
