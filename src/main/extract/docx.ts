/**
 * Word (04 §5.2): mammoth converts to HTML (it resolves style inheritance and numbering), then the
 * shared HTML-to-blocks helper builds blocks. A w:outlineLvl pre-scan of styles.xml maps localized
 * and custom heading styles. The ZIP is checked and test-inflated before mammoth unzips it.
 */
import mammoth from 'mammoth';
import type { ResolvedSource } from '../sources';
import { domToBlocks, parseBody, type DomNode } from './html-to-blocks';
import { imageIdGen, processEmbeddedImages, type EmbeddedCandidate, type SipsConverter } from './images';
import { attr, child, children, coreTitle, descendants, leafText, parseRels, parseXml, rootEl } from './ooxml-xml';
import { readSourceBytes } from './payload';
import { ExtractError } from './skip';
import { cleanInline, countChars, newContent } from './text-util';
import type { ContentBlock, ExtractContext, ExtractResult, Extractor } from './types';
import { SafeZip } from './zip-safety';

/**
 * Paragraph styles whose own or inherited (w:basedOn, max depth 10) outline level is 0..5, keyed
 * by style name (04 §5.2 heading style pre-scan). mammoth selects styles by name
 * (`p[style-name='...']`) or by an identifier-shaped id (`p.Id`); names always work.
 */
export function headingStylesFromStylesXml(xml: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (xml === undefined) return out;
  const styles = rootEl(parseXml(xml), 'w:styles');
  const byId = new Map<string, { name: string; basedOn?: string; lvl?: number }>();
  for (const s of children(styles, 'w:style')) {
    if (attr(s, 'w:type') !== 'paragraph') continue;
    const id = attr(s, 'w:styleId');
    if (!id) continue;
    const lvlAttr = attr(child(child(s, 'w:pPr'), 'w:outlineLvl'), 'w:val');
    const basedOn = attr(child(s, 'w:basedOn'), 'w:val');
    byId.set(id, {
      name: attr(child(s, 'w:name'), 'w:val') ?? id,
      ...(basedOn ? { basedOn } : {}),
      ...(lvlAttr !== undefined && Number.isInteger(Number(lvlAttr)) ? { lvl: Number(lvlAttr) } : {}),
    });
  }
  for (const id of byId.keys()) {
    let cur: string | undefined = id;
    for (let depth = 0; cur && depth <= 10; depth++) {
      const s = byId.get(cur);
      if (!s) break;
      if (s.lvl !== undefined) {
        if (s.lvl >= 0 && s.lvl <= 5) out.set(byId.get(id)!.name, s.lvl);
        break;
      }
      cur = s.basedOn;
    }
  }
  return out;
}

function styleMapFor(headingStyles: ReadonlyMap<string, number>): string[] {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const map = [...headingStyles].map(([name, lvl]) => `p[style-name='${esc(name)}'] => h${lvl + 1}:fresh`);
  map.push("p[style-name='Title'] => h1:fresh");
  for (let i = 1; i <= 6; i++) map.push(`p[style-name='Heading ${i}'] => h${i}:fresh`);
  map.push("p[style-name='Quote'] => blockquote:fresh", "p[style-name='Intense Quote'] => blockquote:fresh");
  map.push("p[style-name='Caption'] => p.caption:fresh");
  return map;
}

// ---- DOM pre-pass (captions, footnotes, bold pseudo-headings) ----

interface El extends DomNode {
  tagName: string;
  parentNode: El | null;
  nextElementSibling: El | null;
  previousElementSibling: El | null;
  children: ArrayLike<El>;
  querySelectorAll(sel: string): ArrayLike<El>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
  replaceWith(n: El): void;
  insertBefore(n: El, ref: El): void;
  ownerDocument: { createElement(tag: string): El };
  textContent: string | null;
}

function fullyBold(p: El): boolean {
  const text = cleanInline(p.textContent ?? '');
  if (!text) return false;
  const bold = Array.from(p.querySelectorAll('strong, b'))
    .filter((b) => !['STRONG', 'B'].includes(b.parentNode?.tagName ?? ''))
    .map((b) => b.textContent ?? '')
    .join('');
  return cleanInline(bold) === text;
}

/** 04 §5.2 post-processing on the DOM before blocks are built. Returns the promotion count. */
function prepareDom(body: El): { promoted: number } {
  // Captions right before or after a table become its caption.
  for (const cap of Array.from(body.querySelectorAll('p.caption'))) {
    const next = cap.nextElementSibling;
    const prev = cap.previousElementSibling;
    const table = next?.tagName === 'TABLE' ? next : prev?.tagName === 'TABLE' ? prev : undefined;
    if (table && !table.getAttribute('data-caption')) {
      table.setAttribute('data-caption', cleanInline(cap.textContent ?? ''));
      cap.remove();
    }
  }
  // Footnote/endnote back-links ("↑") are navigation, not content.
  for (const a of Array.from(body.querySelectorAll('a[href^="#footnote-ref"], a[href^="#endnote-ref"]'))) a.remove();
  // Footnotes and endnotes: a final "Notes" heading before mammoth's trailing list.
  const notesLists = Array.from(body.querySelectorAll('ol')).filter((ol) =>
    Array.from(ol.children).some((li) => /^(footnote|endnote)-/.test(li.getAttribute('id') ?? '')),
  );
  const firstNotes = notesLists[0];
  if (firstNotes) {
    const h = firstNotes.ownerDocument.createElement('h2');
    h.textContent = 'Notes';
    firstNotes.parentNode?.insertBefore(h, firstNotes);
  }
  // Heading fallback: bold pseudo-headings only when no real heading exists.
  let promoted = 0;
  if (body.querySelectorAll('h1, h2, h3, h4, h5, h6').length === 0) {
    for (const p of Array.from(body.children)) {
      if (p.tagName !== 'P') continue;
      const text = cleanInline(p.textContent ?? '');
      const next = p.nextElementSibling;
      if (!text || text.length > 120 || !fullyBold(p)) continue;
      if (!next || next.tagName !== 'P' || fullyBold(next)) continue;
      const h = p.ownerDocument.createElement('h2');
      h.textContent = text;
      p.replaceWith(h);
      promoted++;
    }
  }
  return { promoted };
}

/** Paragraph texts inside w:txbxContent (text boxes), in document order. */
function textBoxParagraphs(documentXml: string | undefined): string[] {
  if (documentXml === undefined) return [];
  const doc = rootEl(parseXml(documentXml), 'w:document');
  const out: string[] = [];
  for (const box of descendants(doc, 'w:txbxContent')) {
    for (const p of descendants(box, 'w:p')) {
      const t = cleanInline(descendants(p, 'w:t').map(leafText).join(''));
      if (t) out.push(t);
    }
  }
  return out;
}

function blockTexts(blocks: readonly ContentBlock[], out: Set<string>): void {
  for (const b of blocks) {
    if (b.kind === 'paragraph' || b.kind === 'heading') out.add(b.text);
    else if (b.kind === 'list') {
      const walk = (its: typeof b.items): void =>
        its.forEach((i) => {
          out.add(i.text);
          if (i.children) walk(i.children);
        });
      walk(b.items);
    } else if (b.kind === 'table') for (const r of b.rows) for (const c of r) out.add(c);
  }
}

export function createDocxExtractor(deps: { sips?: SipsConverter } = {}): Extractor {
  return {
    id: 'docx',
    formats: ['docx'],
    canHandle: (s) => s.format === 'docx',
    extract: (source, ctx) => extractDocx(source, ctx, deps.sips),
  };
}

async function extractDocx(source: ResolvedSource, ctx: ExtractContext, sips?: SipsConverter): Promise<ExtractResult> {
  const bytes = await readSourceBytes(source);
  const zip = SafeZip.open(bytes);
  zip.verifyAll();
  const documentXml = zip.readText('word/document.xml');
  if (documentXml === undefined) throw new ExtractError('corrupt', 'docx: no document part');
  // Guards every part mammoth will parse against DTD/entity declarations (04 §10.3).
  for (const e of zip.entries) {
    if (/\.(xml|rels)$/i.test(e.name)) {
      const xml = zip.readText(e.name) ?? '';
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ExtractError('corrupt', 'xml: DOCTYPE or ENTITY declaration');
    }
  }
  const headingStyles = headingStylesFromStylesXml(zip.readText('word/styles.xml'));

  const candidates: EmbeddedCandidate[] = [];
  let result: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      {
        styleMap: styleMapFor(headingStyles),
        includeDefaultStyleMap: true,
        includeEmbeddedStyleMap: false,
        ignoreEmptyParagraphs: true,
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          const key = `docx-img:${candidates.length}`;
          const data = new Uint8Array(await image.readAsBuffer());
          candidates.push({ key, bytes: data, containerChars: 0 });
          return { src: '', 'data-eli5-img': key } as { src: string };
        }),
      },
    );
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError('corrupt', 'docx: conversion failed');
  }
  // mammoth's messages (unrecognized styles) are noisy: debug log only, as a count (04 §5.2 step 5).
  if (result.messages.length) ctx.log(`docx: ${result.messages.length} converter messages`);

  const body = parseBody(result.value) as El;
  const { promoted } = prepareDom(body);
  const { blocks, imageRefs } = domToBlocks(body);
  const warnings: string[] = [];
  if (promoted) warnings.push(`No heading styles found; ${promoted} bold lines treated as headings`);

  // Alt text comes from mammoth's alt attribute on the placeholder.
  for (const ref of imageRefs) {
    const c = candidates.find((x) => x.key === ref.ref);
    if (c && ref.alt) c.alt = ref.alt;
  }
  const chars = countChars(blocks);
  for (const c of candidates) c.containerChars = chars;

  // Text boxes: mammoth reads w:txbxContent inline; append only what it did not already emit.
  const seen = new Set<string>();
  blockTexts(blocks, seen);
  const missing = textBoxParagraphs(documentXml).filter((t) => !seen.has(t));
  if (missing.length) {
    blocks.push({ kind: 'heading', level: 2, text: 'Text boxes' });
    for (const t of missing) blocks.push({ kind: 'paragraph', text: t });
    warnings.push('Text box content was appended at the end');
  }
  const rels = parseRels(zip.readText('word/_rels/document.xml.rels'));
  if ([...rels.values()].some((r) => /\/diagram(Data|Layout)$/.test(r.type))) {
    warnings.push('SmartArt graphics were not extracted');
  }
  if ([...rels.values()].some((r) => /\/oleObject$/.test(r.type))) warnings.push('Embedded objects (OLE) were ignored');

  const emb = await processEmbeddedImages(candidates, ctx, imageIdGen(source), sips);
  const replaced = blocks.flatMap((b) =>
    b.kind === 'image' && emb.blocks.has(b.imageId) ? emb.blocks.get(b.imageId)! : [b],
  );
  warnings.push(...emb.warnings);

  const core = coreTitle(zip.readText('docProps/core.xml'));
  const firstH1 = replaced.find((b) => b.kind === 'heading' && b.level === 1);
  const title = core ? cleanInline(core) : firstH1?.kind === 'heading' ? firstH1.text : undefined;
  const content = newContent(source, { blocks: replaced, images: emb.images, warnings, ...(title ? { title } : {}) });
  content.stats.imagesKept = emb.kept;
  content.stats.imagesDropped = emb.dropped;
  return { ok: true, content };
}
