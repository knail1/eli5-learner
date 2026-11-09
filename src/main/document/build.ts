// DocumentDraftTab[] + GlossaryDraft + sources -> DocumentModel (07 §5.1).
import type { DocumentDraftTab } from '../llm';
import { DocumentBuildError } from './errors';
import { capText, collapseWs } from './html';
import { placeGlossary } from './glossary';
import { assetIdFor, passThroughNormalizer, sha256Hex } from './images';
import { defaultReferenceFormatter } from './references';
import { DOC_RUNTIME_VERSION } from './runtime-assets';
import { cryptoIdSource, ELI5_TAB_KEY, INDEPTH_TAB_KEY, mintSectionId, STE_TAB_KEY, type IdSource } from './section-id';
import { docThemeRef } from './theme';
import type { AssetCredit, AssetRef, BuildInput, BuildResult, DocBlock, DocumentModel, Section, Tab } from './types';
import { convertBlocks, countAnimations, animationBudget } from './validate';

export const MAX_TITLE = 120;
export const MAX_DEK = 300;
export const MAX_HEADING = 120;
export const MAX_SECTIONS_PER_TAB = 40;
export const APP_NAME = 'ELI5 Learner';
/** 07 §4.1: label of the optional ASD-STE100 tab. */
export const STE_TAB_LABEL = 'ASD-STE100';

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
  /** The heading a blank-titled chart at (draft section index, block index) takes (ConvertContext.chartHeading). */
  chartHeading?(sectionIndex: number, blockIndex: number): string | undefined;
  warn(w: string): void;
  /** Tab and document animation caps (validate.ts animationBudget); absent: per section only. */
  takeAnimation?(force?: boolean): boolean;
  /** A keep marker's animation (validate.ts ConvertContext.keepAnimation); absent: markers drop. */
  keepAnimation?(): Extract<DocBlock, { type: 'animation' }> | undefined;
  /** When given, receives the draft index of each kept section (07 §9.1 step 2 indexes drafts). */
  draftIndices?: number[];
}

/** A draft section heading as the document shows it. */
function sectionHeading(h: string): string {
  return capText(collapseWs(h), MAX_HEADING);
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
    const chartHeading = ctx.chartHeading;
    const heading = sectionHeading(d.heading);
    const blocks = convertBlocks(d.blocks, {
      idSource: ctx.idSource,
      resolveFigure: ctx.resolveFigure,
      ...(resolvePhoto ? { resolvePhoto: (bi: number) => resolvePhoto(di, bi) } : {}),
      ...(chartHeading ? { chartHeading: (bi: number) => chartHeading(di, bi) } : {}),
      ...(ctx.takeAnimation ? { takeAnimation: ctx.takeAnimation } : {}),
      ...(ctx.keepAnimation ? { keepAnimation: ctx.keepAnimation } : {}),
      heading,
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
      heading,
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
  // 07 §4.3: reserved ids (a rebuild's live, retired and older-version ids) are never minted.
  const taken = new Set<string>(input.reservedIds ?? []);

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
  const animations = { n: 0 };
  const indepthSections = buildSections(input.indepth.sections, {
    ...sctx,
    tabKey: INDEPTH_TAB_KEY,
    resolvePhoto: resolvePhotoIn('indepth'),
    takeAnimation: animationBudget(animations),
    draftIndices,
  });
  if (indepthSections.length === 0) throw new DocumentBuildError('empty_indepth');
  const eli5Sections = input.eli5
    ? buildSections(input.eli5.sections, {
        ...sctx,
        tabKey: ELI5_TAB_KEY,
        resolvePhoto: resolvePhotoIn('eli5'),
        takeAnimation: animationBudget(animations),
      })
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

  // ASD-STE100 tab (07 §5, D14): optional, never a placeholder. Kept visuals carry the in-depth
  // origin of their draft block, so a photo slot resolves to the same asset as in In depth. Kept
  // animations mirror In depth ones that already passed the caps, so the tab and document caps
  // neither drop nor count them (a mirror must stay identical to its original; a later
  // regenerate must not lose an animation to its mirror); the tab never holds more animations
  // than In depth does, whatever the draft says.
  let ste: Tab | null = null;
  if (input.ste) {
    const origins = input.ste.origins;
    const fromIndepth = resolvePhotoIn('indepth');
    let steLeft = indepthSections.reduce((n, s) => n + countAnimations(s.blocks), 0);
    const steAnimations = (): boolean => {
      if (steLeft <= 0) return false;
      steLeft--;
      return true;
    };
    const steSections = buildSections(input.ste.tab.sections, {
      ...sctx,
      tabKey: STE_TAB_KEY,
      resolvePhoto: (si, bi) => {
        const o = origins[si]?.[bi];
        return o ? fromIndepth(o.section, o.block) : undefined;
      },
      // A kept chart with a blank title takes its In depth heading, so the copies stay identical (D15).
      chartHeading: (si, bi) => {
        const o = origins[si]?.[bi];
        const src = o ? input.indepth.sections[o.section] : undefined;
        return src ? sectionHeading(src.heading) : undefined;
      },
      takeAnimation: steAnimations,
    });
    if (steSections.length > 0)
      ste = { key: STE_TAB_KEY, kind: 'ste', label: STE_TAB_LABEL, createdAt: now, sections: steSections };
    else warn('ste-omitted');
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
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    generator: {
      app: input.generator?.app ?? APP_NAME,
      version: input.generator?.version ?? '0.0.0',
      edition: input.generator?.edition ?? __ELI5_EDITION__,
      runtimeVersion: input.generator?.runtimeVersion ?? DOC_RUNTIME_VERSION,
    },
    tabs: [indepth, eli5, ...(ste ? [ste] : [])],
    glossary,
    references,
    assets: assetRefs,
    theme: docThemeRef(input.theme, input.themeSource ?? 'default'),
  };
  return { model, warnings, assets };
}
