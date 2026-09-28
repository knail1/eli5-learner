// DocumentDraftTab[] + GlossaryDraft + sources -> DocumentModel (07 §5.1).
import type { DocumentDraftTab } from '../llm';
import { DocumentBuildError } from './errors';
import { capText, collapseWs } from './html';
import { placeGlossary } from './glossary';
import { assetIdFor, passThroughNormalizer, sha256Hex } from './images';
import { defaultReferenceFormatter } from './references';
import { DOC_RUNTIME_VERSION } from './runtime-assets';
import { cryptoIdSource, ELI5_TAB_KEY, INDEPTH_TAB_KEY, mintSectionId, type IdSource } from './section-id';
import { docThemeRef } from './theme';
import type { AssetCredit, AssetRef, BuildInput, BuildResult, DocumentModel, Section, Tab } from './types';
import { convertBlocks } from './validate';

export const MAX_TITLE = 120;
export const MAX_DEK = 300;
export const MAX_HEADING = 120;
export const MAX_SECTIONS_PER_TAB = 40;
export const APP_NAME = 'ELI5 Learner';

/** 06 §7.1 placeholder text for a failed ELI5 step. */
export const ELI5_PLACEHOLDER_HEADING = 'ELI5 version unavailable';
export const ELI5_PLACEHOLDER_TEXT =
  "The ELI5 version could not be generated. Select this text and choose *This isn't clear, re-explain it* to try again.";

/** Key of the draft `photo` block at (tab, section, block) that a StockPhotoInput fills (07 §7.4). */
export function photoSlotKey(tab: 'indepth' | 'eli5', sectionIndex: number, blockIndex: number): string {
  return `${tab}:${sectionIndex}:${blockIndex}`;
}

function httpOnly(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : undefined;
  } catch {
    return undefined;
  }
}

/** Credit text comes from the internet: whitespace collapsed, lengths capped, links http(s) only. */
export function sanitizeCredit(c: AssetCredit): AssetCredit {
  const text = (s: string | undefined, max: number): string => capText(collapseWs(s ?? ''), max);
  const creator = text(c.creator, 120);
  const version = text(c.licenseVersion, 10);
  const licenseUrl = httpOnly(c.licenseUrl);
  const sourceUrl = httpOnly(c.sourceUrl);
  const via = text(c.via, 60);
  return {
    kind: 'stock-photo',
    title: text(c.title, 200) || 'Untitled',
    ...(creator ? { creator } : {}),
    license: c.license,
    ...(version ? { licenseVersion: version } : {}),
    ...(licenseUrl ? { licenseUrl } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    sourceName: text(c.sourceName, 60) || 'unknown source',
    ...(via ? { via } : {}),
  };
}

export interface SectionBuildContext {
  tabKey: string;
  now: string;
  idSource: IdSource;
  taken: Set<string>;
  resolveFigure(label: string): string | undefined;
  /** Stock photo slot at (draft section index, block index) -> asset (07 §7.4). */
  resolvePhoto?(
    sectionIndex: number,
    blockIndex: number,
  ): { assetId: string; alt: string; caption: string } | undefined;
  warn(w: string): void;
  /** When given, receives the draft index of each kept section (07 §9.1 step 2 indexes drafts). */
  draftIndices?: number[];
}

/** Converts section drafts for one tab, minting an id per kept section (07 §5.1 step 2). */
export function buildSections(drafts: DocumentDraftTab['sections'], ctx: SectionBuildContext): Section[] {
  const out: Section[] = [];
  for (const [di, d] of drafts.entries()) {
    if (out.length >= MAX_SECTIONS_PER_TAB) {
      ctx.warn('sections-capped');
      break;
    }
    const resolvePhoto = ctx.resolvePhoto;
    const blocks = convertBlocks(d.blocks, {
      idSource: ctx.idSource,
      resolveFigure: ctx.resolveFigure,
      ...(resolvePhoto ? { resolvePhoto: (bi: number) => resolvePhoto(di, bi) } : {}),
      warn: ctx.warn,
    });
    if (blocks.length === 0) {
      ctx.warn('section-dropped-empty');
      continue;
    }
    const id = mintSectionId(ctx.tabKey, ctx.idSource, ctx.taken);
    ctx.taken.add(id);
    ctx.draftIndices?.push(di);
    out.push({
      id,
      kind: 'content',
      heading: capText(collapseWs(d.heading), MAX_HEADING),
      blocks,
      origin: 'generated',
      updatedAt: ctx.now,
    });
  }
  return out;
}

export function buildDocumentModel(input: BuildInput): BuildResult {
  const warnings: string[] = [];
  const warn = (w: string): void => {
    warnings.push(w);
  };
  const idSource = input.idSource ?? cryptoIdSource;
  const normalize = input.normalizeImage;
  const now = input.now;
  const taken = new Set<string>();

  // Step 5 (resolved lazily so only referenced images are embedded, each once).
  const assets = new Map<string, Uint8Array>();
  const assetRefs: AssetRef[] = [];
  const byLabel = new Map<string, string | null>();
  const resolveFigure = (label: string): string | undefined => {
    if (byLabel.has(label)) return byLabel.get(label) ?? undefined;
    const img = input.images.find((i) => i.label === label);
    const norm = img ? normalize(img) : null;
    if (img && !norm) warn('image-not-normalized');
    if (!norm) {
      byLabel.set(label, null);
      return undefined;
    }
    const sha = sha256Hex(norm.bytes);
    const id = assetIdFor(sha);
    if (!assets.has(id)) {
      assets.set(id, norm.bytes);
      assetRefs.push({ id, mime: norm.mime, width: norm.width, height: norm.height, sha256: sha, label });
    }
    byLabel.set(label, id);
    return id;
  };

  // 07 §7.4: resolved stock photo slots become credited assets (bytes already downscaled by 06).
  const photosBySlot = new Map((input.photos ?? []).map((p) => [p.slot, p]));
  const resolvePhotoIn =
    (tab: 'indepth' | 'eli5') =>
    (si: number, bi: number): { assetId: string; alt: string; caption: string } | undefined => {
      const p = photosBySlot.get(photoSlotKey(tab, si, bi));
      if (!p) return undefined;
      const norm = passThroughNormalizer({ label: p.slot, mime: p.mime, bytes: p.bytes });
      if (!norm) {
        warn('image-not-normalized');
        return undefined;
      }
      const sha = sha256Hex(norm.bytes);
      const id = assetIdFor(sha);
      if (!assets.has(id)) {
        assets.set(id, norm.bytes);
        assetRefs.push({
          id,
          mime: norm.mime,
          width: norm.width,
          height: norm.height,
          sha256: sha,
          label: `stock-photo-${sha.slice(0, 12)}`,
          credit: sanitizeCredit(p.credit),
        });
      }
      return { assetId: id, alt: p.alt, caption: p.caption };
    };

  // Steps 1-3.
  const title = capText(collapseWs(input.indepth.title), MAX_TITLE) || 'Untitled';
  const dek = input.indepth.dek ? capText(collapseWs(input.indepth.dek), MAX_DEK) : '';
  const sctx = { now, idSource, taken, resolveFigure, warn };
  const draftIndices: number[] = [];
  const indepthSections = buildSections(input.indepth.sections, {
    ...sctx,
    tabKey: INDEPTH_TAB_KEY,
    resolvePhoto: resolvePhotoIn('indepth'),
    draftIndices,
  });
  if (indepthSections.length === 0) throw new DocumentBuildError('empty_indepth');
  const eli5Sections = input.eli5
    ? buildSections(input.eli5.sections, { ...sctx, tabKey: ELI5_TAB_KEY, resolvePhoto: resolvePhotoIn('eli5') })
    : [];

  const indepth: Tab = {
    key: INDEPTH_TAB_KEY,
    kind: 'indepth',
    label: 'In depth',
    createdAt: now,
    sections: indepthSections,
  };
  let eli5: Tab;
  if (eli5Sections.length > 0) {
    eli5 = { key: ELI5_TAB_KEY, kind: 'eli5', label: 'ELI5', createdAt: now, sections: eli5Sections };
  } else {
    // Step 4: placeholder tab (06 §7.1).
    warn('eli5-placeholder');
    const id = mintSectionId(ELI5_TAB_KEY, idSource, taken);
    taken.add(id);
    eli5 = {
      key: ELI5_TAB_KEY,
      kind: 'eli5',
      label: 'ELI5',
      createdAt: now,
      placeholder: true,
      sections: [
        {
          id,
          kind: 'content',
          heading: ELI5_PLACEHOLDER_HEADING,
          blocks: [{ type: 'paragraph', md: ELI5_PLACEHOLDER_TEXT }],
          origin: 'placeholder',
          updatedAt: now,
        },
      ],
    };
  }

  // Step 6: glossary notes (in-depth only), ids unique against every id minted so far.
  const glossary = placeGlossary(
    {
      draft: input.glossary,
      sections: indepthSections,
      draftIndices,
      draftSectionCount: input.indepth.sections.length,
      idSource,
      taken,
    },
    warn,
  );

  // Step 7: references section, last in the in-depth tab (07 §10).
  const formatter = input.referenceFormatter ?? defaultReferenceFormatter;
  const references = formatter({ resolved: input.resolved, skipped: input.skipped });
  const refId = mintSectionId(INDEPTH_TAB_KEY, idSource, taken);
  taken.add(refId);
  indepth.sections.push({
    id: refId,
    kind: 'references',
    heading: 'Sources',
    blocks: [],
    origin: 'generated',
    updatedAt: now,
  });

  const model: DocumentModel = {
    formatVersion: 1,
    docId: input.docId,
    slug: input.slug,
    title,
    ...(dek ? { dek } : {}),
    createdAt: now,
    updatedAt: now,
    generator: {
      app: input.generator?.app ?? APP_NAME,
      version: input.generator?.version ?? '0.0.0',
      edition: input.generator?.edition ?? __ELI5_EDITION__,
      runtimeVersion: input.generator?.runtimeVersion ?? DOC_RUNTIME_VERSION,
    },
    tabs: [indepth, eli5],
    glossary,
    references,
    assets: assetRefs,
    theme: docThemeRef(input.theme, input.themeSource ?? 'default'),
  };
  return { model, warnings, assets };
}
