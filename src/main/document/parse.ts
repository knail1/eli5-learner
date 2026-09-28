// index.html -> DocumentModel (07 §8): reads the embedded model, asset bytes from <img data-asset-id>,
// the theme and the runtime blocks. Also byte-exact locate/splice primitives for sections (08 §6.4).
import { DocumentFormatError } from './errors';
import { attr, findAll, findById, innerSpan, outerSpan, parseTree, rawInner, textOf, type Span } from './html-tree';
import { fromDataUri } from './images';
import { modelJson, renderSectionHtml } from './render/page';
import { DocumentModelSchema } from './schema';
import { DEFAULT_FOOTER, parseThemeCss } from './theme';
import type { DocTheme, DocumentModel, ParsedDocument } from './types';

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
  return r.data;
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
  const theme: DocTheme = {
    id: model.theme.id,
    version: model.theme.version,
    tokens: parseThemeCss(themeStyle ? textOf(themeStyle) : ''),
    footer: footerText.startsWith(`${DEFAULT_FOOTER} · `)
      ? footerText.slice(DEFAULT_FOOTER.length + 3)
      : DEFAULT_FOOTER,
  };
  if (logo) theme.logoSvg = rawInner(html, logo);

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
  return spliceSpan(spliceSpan(html, first, firstRep), second, secondRep);
}
