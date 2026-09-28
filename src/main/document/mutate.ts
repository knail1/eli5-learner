// Pure model mutators (07 §8): section context, replace in place, add/remove section ELI5 tabs.
// Every function returns a new model; the caller renders and writes under the document lock.
import type { DocumentDraftTab, DraftBlock, SectionDraft } from '../llm';
import { buildSections } from './build';
import { DocumentBuildError, DocumentMutationError, TooManyTabsError } from './errors';
import { reanchorSection } from './glossary';
import { collapseWs } from './html';
import { sectionIdsOf } from './ids';
import { cryptoIdSource, isSectionEli5TabKey, mintSectionEli5TabKey, tabKeyOfSectionId } from './section-id';
import type { DocBlock, DocumentModel, MutationOptions, Section, SectionContext, SectionId, Tab } from './types';
import { convertBlocks } from './validate';

/** 07 §5.4: 2 fixed tabs + 20 section ELI5 tabs. */
export const MAX_SECTION_ELI5_TABS = 20;
export const MAX_SELECTION = 4000;

function findSection(model: DocumentModel, id: SectionId): { tab: Tab; section: Section; index: number } | undefined {
  for (const tab of model.tabs) {
    const index = tab.sections.findIndex((s) => s.id === id);
    const section = tab.sections[index];
    if (section) return { tab, section, index };
  }
  return undefined;
}

/** DocBlock -> DraftBlock: figure assetId mapped back to its image label (07 §8). */
function toDraftBlock(model: DocumentModel, b: DocBlock): DraftBlock {
  if (b.type !== 'figure') return b;
  const label = model.assets.find((a) => a.id === b.assetId)?.label ?? b.assetId;
  return {
    type: 'figure',
    imageLabel: label,
    caption: b.caption,
    ...(b.annotations ? { annotations: b.annotations } : {}),
  };
}

export function sectionToDraft(model: DocumentModel, s: Section): SectionDraft {
  return { heading: s.heading, blocks: s.blocks.map((b) => toDraftBlock(model, b)) };
}

export function getSectionContext(model: DocumentModel, id: SectionId): SectionContext {
  const hit = findSection(model, id);
  if (!hit) throw new DocumentMutationError('unknown_section', id);
  const content = hit.tab.sections.filter((s) => s.kind === 'content');
  const i = content.findIndex((s) => s.id === id);
  const prev = i > 0 ? content[i - 1] : undefined;
  const next = i >= 0 ? content[i + 1] : undefined;
  return {
    tab: hit.tab,
    section: hit.section,
    draft: sectionToDraft(model, hit.section),
    ...(prev ? { prev: sectionToDraft(model, prev) } : {}),
    ...(next ? { next: sectionToDraft(model, next) } : {}),
    outline: content.map((s) => s.heading),
  };
}

/** Figures in regenerated drafts may only reference images already embedded in the document. */
function assetResolver(model: DocumentModel): (label: string) => string | undefined {
  return (label) => model.assets.find((a) => a.label === label)?.id;
}

/**
 * 07 §8 / 08 §6.4 step 4: writes `draft` back under the same SectionId, origin 'regenerated',
 * `updatedAt`/`lastAction` set, and re-anchors that section's glossary notes (08 §6.5).
 */
export function replaceSection(
  model: DocumentModel,
  id: SectionId,
  draft: SectionDraft,
  action: Section['lastAction'],
  now: string,
  opts: MutationOptions = {},
): { model: DocumentModel; warnings: string[] } {
  const hit = findSection(model, id);
  if (!hit) throw new DocumentMutationError('unknown_section', id);
  if (hit.section.kind === 'references') throw new DocumentMutationError('references_section', id);
  const warnings: string[] = [];
  const warn = (w: string): void => {
    warnings.push(w);
  };
  const blocks = convertBlocks(draft.blocks, {
    idSource: opts.idSource ?? cryptoIdSource,
    resolveFigure: assetResolver(model),
    warn,
  });
  if (blocks.length === 0) throw new DocumentBuildError('empty_section');
  const heading = collapseWs(draft.heading) || hit.section.heading;
  const { merge, mergeMarker } = hit.section;
  const section: Section = {
    id,
    kind: 'content',
    heading: heading.length > 120 ? heading.slice(0, 119) + '…' : heading,
    blocks,
    origin: 'regenerated',
    updatedAt: now,
    ...(action ? { lastAction: action } : {}),
    ...(merge ? { merge } : {}),
    ...(mergeMarker ? { mergeMarker } : {}),
  };
  const tabs = model.tabs.map((t) => {
    if (t !== hit.tab) return t;
    const sections = t.sections.map((s) => (s.id === id ? section : s));
    // The placeholder ELI5 tab stops being a placeholder once its section is regenerated.
    const { placeholder: _p, ...rest } = t;
    return t.placeholder && hit.section.origin === 'placeholder' ? { ...rest, sections } : { ...t, sections };
  });
  const order = tabs.find((t) => t.kind === 'indepth')?.sections.map((s) => s.id as string) ?? [];
  const glossary = hit.tab.kind === 'indepth' ? reanchorSection(model.glossary, section, order, warn) : model.glossary;
  return { model: { ...model, tabs, glossary, updatedAt: now }, warnings };
}

const NUMBERING_RE = /^\s*(?:\d+(?:\.\d+)*|[ivxlcdm]+|[a-z])[.)](?:\s+|$)/i;

/**
 * Section ELI5 tab label (07 §4.1, 08 §7.1 step 3): "ELI5: " + source heading without leading
 * numbering, or the first 6 words of the selection; " (2)", " (3)" on collision. The full label
 * is stored; renderers cut it to 48 characters for display.
 */
export function sectionEli5Label(heading: string, selection: string, existing: readonly string[]): string {
  let base = collapseWs(heading).replace(NUMBERING_RE, '').trim();
  if (base === '' || /^\d+$/.test(base)) {
    base = collapseWs(selection).split(' ').slice(0, 6).join(' ');
  }
  if (base === '' || /^\d+$/.test(base)) base = 'Section';
  const label = `ELI5: ${base}`;
  const taken = new Set(existing);
  if (!taken.has(label)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 07 §8 / 08 §7.1: appends a section ELI5 tab at the right with a fresh key and fresh SectionIds. */
export function addSectionEli5Tab(
  model: DocumentModel,
  from: SectionId,
  selection: string,
  draft: DocumentDraftTab,
  now: string,
  opts: MutationOptions = {},
): { model: DocumentModel; tabKey: string; warnings: string[] } {
  const hit = findSection(model, from);
  if (!hit) throw new DocumentMutationError('unknown_section', from);
  const sxCount = model.tabs.filter((t) => t.kind === 'section-eli5').length;
  if (sxCount >= MAX_SECTION_ELI5_TABS) throw new TooManyTabsError(MAX_SECTION_ELI5_TABS);
  const idSource = opts.idSource ?? cryptoIdSource;
  const retired = opts.retiredIds ?? [];
  const takenKeys = new Set<string>([
    ...model.tabs.map((t) => t.key),
    ...retired.map((id) => tabKeyOfSectionId(id as SectionId)),
  ]);
  const tabKey = mintSectionEli5TabKey(idSource, takenKeys);
  const taken = new Set<string>([...sectionIdsOf(model.tabs), ...retired]);
  const warnings: string[] = [];
  const sections = buildSections(draft.sections, {
    tabKey,
    now,
    idSource,
    taken,
    resolveFigure: assetResolver(model),
    warn: (w) => {
      warnings.push(w);
    },
  });
  if (sections.length === 0) throw new DocumentBuildError('empty_tab');
  const sel = collapseWs(selection);
  const tab: Tab = {
    key: tabKey,
    kind: 'section-eli5',
    label: sectionEli5Label(
      hit.section.heading,
      sel,
      model.tabs.map((t) => t.label),
    ),
    createdAt: now,
    origin: { sectionId: from, selection: sel.length > MAX_SELECTION ? sel.slice(0, MAX_SELECTION) : sel },
    sections,
  };
  return { model: { ...model, tabs: [...model.tabs, tab], updatedAt: now }, tabKey, warnings };
}

/** 07 §8: removes a section ELI5 tab; `indepth` and `eli5` cannot be removed. */
export function removeTab(model: DocumentModel, tabKey: string, now: string): DocumentModel {
  const tab = model.tabs.find((t) => t.key === tabKey);
  if (!tab) throw new DocumentMutationError('unknown_tab', tabKey);
  if (tab.kind !== 'section-eli5' || !isSectionEli5TabKey(tab.key))
    throw new DocumentMutationError('tab_not_removable', tabKey);
  return { ...model, tabs: model.tabs.filter((t) => t !== tab), updatedAt: now };
}

/** SectionIds of a tab, for meta.json retiredIds when it is closed (07 §4.3). */
export function sectionIdsOfTab(model: DocumentModel, tabKey: string): SectionId[] {
  return model.tabs.find((t) => t.key === tabKey)?.sections.map((s) => s.id) ?? [];
}
