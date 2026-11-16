// Pure model mutators (07 §8): section context, replace in place, add/remove section ELI5 tabs.
// Every function returns a new model; the caller renders and writes under the document lock.
import { DEEPER_WEB_MAX, DEEPER_WEB_TITLE_MAX, normalizeWebUrl } from '../llm';
import type { DocumentDraftTab, DraftBlock, SectionDraft } from '../llm';
import { buildSections } from './build';
import { DocumentBuildError, DocumentMutationError, TooManyTabsError } from './errors';
import { reanchorSection } from './glossary';
import { capText, collapseWs } from './html';
import { linksToText } from './inline-md';
import { mintDiagramPrefix, mintQaId, qaIdsOf, sectionIdsOf } from './ids';
import { cryptoIdSource, isSectionEli5TabKey, mintSectionEli5TabKey, tabKeyOfSectionId } from './section-id';
import type {
  AnswerReach,
  AnswerSourceMode,
  AnswerWebPage,
  DeepAskDepth,
  DocBlock,
  DocumentModel,
  MutationOptions,
  QaDocBlock,
  Section,
  SectionContext,
  SectionId,
  Tab,
  TabKind,
} from './types';
import { ANIMATION_KEEP } from './animation';
import {
  animationBudget,
  convertBlocks,
  countAnimations,
  countDocAnimations,
  isUserQuestion,
  svgIdPrefix,
} from './validate';

/** 07 §5.4: up to 3 fixed tabs (indepth, eli5, ste) + 20 section ELI5 tabs. */
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

/**
 * DocBlock -> DraftBlock: figure assetId mapped back to its image label (07 §8). Answer boxes are
 * doc-only and have no draft form (null), so the model never sees or echoes them; an animation's
 * code and poster are replaced by the keep marker (ANIMATION_KEEP).
 */
function toDraftBlock(model: DocumentModel, b: DocBlock): DraftBlock | null {
  if (b.type === 'qa') return null;
  if (b.type === 'animation') {
    // 08 §6.2: the model sees an existing animation's text only; returning the keep marker keeps it.
    return {
      type: 'animation',
      title: b.title,
      caption: b.caption,
      alt: b.alt,
      poster: ANIMATION_KEEP,
      js: ANIMATION_KEEP,
    };
  }
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
  const blocks: DraftBlock[] = [];
  for (const b of s.blocks) {
    const d = toDraftBlock(model, b);
    if (d) blocks.push(d);
  }
  return { heading: s.heading, blocks };
}

/** One tab as Deep Ask material (08 §6.9); the same shape as the llm module's DeepAskTab. */
export interface DeepAskTabDraft {
  key: string;
  kind: TabKind;
  label: string;
  sections: SectionDraft[];
}

/**
 * 08 §6.9: every tab in document order, content sections only (references and ELI5 placeholder
 * sections excluded); answer boxes are dropped by sectionToDraft. A tab left with no section is
 * left out.
 */
export function tabsForDeepAsk(model: DocumentModel): DeepAskTabDraft[] {
  const out: DeepAskTabDraft[] = [];
  for (const t of model.tabs) {
    const sections = t.sections
      .filter((s) => s.kind === 'content' && s.origin !== 'placeholder')
      .map((s) => sectionToDraft(model, s));
    if (sections.length) out.push({ key: t.key, kind: t.kind, label: t.label, sections });
  }
  return out;
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
function assetResolver(model: DocumentModel, opts: MutationOptions): (label: string) => string | undefined {
  return (label) => {
    const id = model.assets.find((a) => a.label === label)?.id;
    return id !== undefined && (!opts.assets || opts.assets.has(id)) ? id : undefined;
  };
}

/** Drops asset records no figure references any more, so stale labels cannot be resolved later. */
function pruneAssets(model: DocumentModel): DocumentModel {
  const used = new Set<string>();
  for (const t of model.tabs)
    for (const s of t.sections) for (const b of s.blocks) if (b.type === 'figure') used.add(b.assetId);
  const assets = model.assets.filter((a) => used.has(a.id));
  return assets.length === model.assets.length ? model : { ...model, assets };
}

/**
 * 07 §8 / 08 §6.4 step 4: writes `draft` back under the same SectionId, origin 'regenerated',
 * `updatedAt`/`lastAction` set, and re-anchors that section's glossary notes (08 §6.5).
 */
const STE_FIXED_VISUALS: ReadonlySet<DocBlock['type']> = new Set<DocBlock['type']>([
  'chart',
  'diagram',
  'table',
  'figure', // uploaded images and stock photos (audit round 3)
]);

/**
 * 08 §6.3 for an ASD-STE100 section: each chart, diagram, table or figure (image or photo) the model returns is replaced, in
 * order, by the section's own block of that type, unchanged; one beyond those is dropped
 * (`ste-visual-dropped`), and one the model left out is put back at the end (`ste-visual-restored`).
 */
function keepSteVisuals(old: readonly DocBlock[], next: readonly DocBlock[], warn: (w: string) => void): DocBlock[] {
  const pool = new Map<DocBlock['type'], DocBlock[]>();
  for (const b of old) if (STE_FIXED_VISUALS.has(b.type)) pool.set(b.type, [...(pool.get(b.type) ?? []), b]);
  const out: DocBlock[] = [];
  for (const b of next) {
    if (!STE_FIXED_VISUALS.has(b.type)) out.push(b);
    else {
      const own = pool.get(b.type)?.shift();
      if (own) out.push(own);
      else warn('ste-visual-dropped');
    }
  }
  for (const rest of pool.values())
    for (const b of rest) {
      out.push(b);
      warn('ste-visual-restored');
    }
  return out;
}

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
  // 07 §5.2 animation caps, counting every other section of the tab and the document (the STE
  // tab's mirrors excepted). A keep marker in the draft takes the section's own animations back
  // in order (08 §6.2); kept blocks always stay, they are only counted.
  const ownAnimations = hit.section.blocks.filter(
    (b): b is Extract<DocBlock, { type: 'animation' }> => b.type === 'animation',
  );
  const others = (secs: readonly Section[]): number =>
    secs.reduce((n, s) => n + (s.id === id ? 0 : countAnimations(s.blocks)), 0);
  const rawHeading = collapseWs(draft.heading) || hit.section.heading;
  const heading = rawHeading.length > 120 ? rawHeading.slice(0, 119) + '…' : rawHeading;
  // 08 §6.3: the ASD-STE100 tab keeps its charts, diagrams, tables, figures and animations and never adds
  // or changes one; only keep markers bring an animation back.
  const ste = hit.tab.kind === 'ste';
  const converted = convertBlocks(draft.blocks, {
    idSource: opts.idSource ?? cryptoIdSource,
    resolveFigure: assetResolver(model, opts),
    takeAnimation: ste
      ? (kept) => kept === true
      : animationBudget(
          { n: countDocAnimations(model.tabs) - countAnimations(hit.section.blocks) },
          others(hit.tab.sections),
        ),
    keepAnimation: () => ownAnimations.shift(),
    heading,
    warn,
  });
  const blocks = ste ? keepSteVisuals(hit.section.blocks, converted, warn) : converted;
  if (blocks.length === 0) throw new DocumentBuildError('empty_section');
  const { merge, mergeMarker } = hit.section;
  const section: Section = {
    id,
    kind: 'content',
    heading,
    blocks: carryAnswers(hit.section.blocks, blocks),
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
  return { model: pruneAssets({ ...model, tabs, glossary, updatedAt: now }), warnings };
}

/**
 * Answer boxes survive a rewrite (07 §7.1): every qa block of `oldBlocks` that `newBlocks` does not
 * already hold is re-appended, in order, at the end. Ids are kept, so deep links still resolve; the
 * box's quote keeps the context it was asked in.
 */
export function carryAnswers(oldBlocks: readonly DocBlock[], newBlocks: readonly DocBlock[]): DocBlock[] {
  const have = new Set(newBlocks.flatMap((b) => (b.type === 'qa' ? [b.id] : [])));
  const carried = oldBlocks.filter((b): b is QaDocBlock => b.type === 'qa' && !have.has(b.id));
  return carried.length ? [...newBlocks, ...carried] : [...newBlocks];
}

export const MAX_QA_QUESTION = 500;
export const MAX_QA_TOPIC = 48;
export const MAX_QA_QUOTE = 160;
export const MAX_QA_PARAGRAPHS = 4;
export const MAX_QA_PARAGRAPH = 1200;

/** What insertAnswer stores: the reader's question, the model's topic and answer, the selection. */
export interface AnswerInput {
  question: string;
  topic: string;
  /** The selection the question was asked about; cut to MAX_QA_QUOTE for the box. */
  quote: string;
  paragraphs: readonly string[];
  /** 08 §6.9 Ask deep or §6.10 Ask deeper; its inline links are stored as their text. */
  depth?: DeepAskDepth;
  /** Only with depth: the source mode the badge shows. */
  sources?: AnswerSourceMode;
  /** Only with depth 'deeper': how far the answer went (its badge). */
  reach?: AnswerReach;
  /** Only with depth 'deeper': the web pages it used (already checked against the provider's list). */
  web?: readonly AnswerWebPage[];
}

/**
 * 08 §6.10: the stored page list of a deeper box: http(s) URLs only, normalised (no fragment), once
 * each, at most DEEPER_WEB_MAX, titles on one line and capped; a blank title becomes the host.
 */
export function cleanAnswerWeb(web: readonly AnswerWebPage[]): AnswerWebPage[] {
  const out: AnswerWebPage[] = [];
  const seen = new Set<string>();
  for (const w of web) {
    if (out.length >= DEEPER_WEB_MAX) break;
    const url = normalizeWebUrl(w.url);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: capText(collapseWs(w.title), DEEPER_WEB_TITLE_MAX) || new URL(url).host, url });
  }
  return out;
}

/** Re-exported for callers that import it from here (08 §6.9 decision 10). */
export { linksToText };

/**
 * A deep answer paragraph: links stripped, then cut to MAX_QA_PARAGRAPH and stripped again, since a
 * cut can drop the closing backtick of a code span that hid one (08 §6.9 decision 10). The renderer
 * strips links from deep boxes too, so a paragraph that still exceeds the cap after the retries is
 * cut once more and stays safe to show.
 */
function deepParagraph(p: string): string {
  let cur = linksToText(p);
  for (let i = 0; i < 3 && cur.length > MAX_QA_PARAGRAPH; i++) cur = linksToText(capText(cur, MAX_QA_PARAGRAPH));
  return cur.length > MAX_QA_PARAGRAPH ? capText(cur, MAX_QA_PARAGRAPH) : cur;
}

/**
 * 07 §7.1 / 08 Ask: inserts an answer box into a section, after block `afterBlock` and after any
 * answer boxes already following it (so answers stack in the order asked); the end of the section
 * when `afterBlock` is out of range. Glossary anchors and merge marks of later blocks shift by one;
 * marks are kept. Answer paragraphs that ask the reader something are dropped; the question itself
 * is stored as asked. Throws DocumentBuildError('empty_section') when no paragraph is left.
 */
export function insertAnswer(
  model: DocumentModel,
  sectionId: SectionId,
  afterBlock: number | undefined,
  answer: AnswerInput,
  now: string,
  opts: MutationOptions = {},
): { model: DocumentModel; qaId: string } {
  const hit = findSection(model, sectionId);
  if (!hit) throw new DocumentMutationError('unknown_section', sectionId);
  if (hit.section.kind === 'references') throw new DocumentMutationError('references_section', sectionId);
  // Ask deep and Ask deeper both read attacker-controllable text: links are stored as text.
  const deep = answer.depth === 'deep' || answer.depth === 'deeper';
  const deeper = answer.depth === 'deeper';
  const web = deeper && answer.web ? cleanAnswerWeb(answer.web) : [];
  const paragraphs = answer.paragraphs
    .map((p) => (deep ? linksToText(p) : p).trim())
    .filter((p) => collapseWs(p) !== '' && !isUserQuestion(p))
    .slice(0, MAX_QA_PARAGRAPHS)
    .map((p) => (deep ? deepParagraph(p) : p.length > MAX_QA_PARAGRAPH ? capText(p, MAX_QA_PARAGRAPH) : p));
  if (paragraphs.length === 0) throw new DocumentBuildError('empty_section');
  const question = capText(collapseWs(answer.question), MAX_QA_QUESTION);
  if (question === '') throw new DocumentBuildError('empty_section');
  const topic = capText(collapseWs(answer.topic), MAX_QA_TOPIC) || capText(question, MAX_QA_TOPIC);

  const taken = new Set<string>([
    ...sectionIdsOf(model.tabs),
    ...model.glossary.map((n) => n.id),
    ...qaIdsOf(model.tabs),
    ...(opts.retiredIds ?? []),
  ]);
  const qaId = mintQaId(opts.idSource ?? cryptoIdSource, taken);
  const box: QaDocBlock = {
    type: 'qa',
    id: qaId,
    question,
    topic,
    quote: capText(collapseWs(answer.quote), MAX_QA_QUOTE),
    paragraphs,
    askedAt: now,
    ...(deep && answer.depth ? { depth: answer.depth, ...(answer.sources ? { sources: answer.sources } : {}) } : {}),
    ...(deeper && answer.reach ? { reach: answer.reach } : {}),
    ...(web.length > 0 ? { web } : {}),
  };

  const old = hit.section.blocks;
  let k =
    afterBlock !== undefined && Number.isInteger(afterBlock) && afterBlock >= 0 && afterBlock < old.length
      ? afterBlock + 1
      : old.length;
  while (k < old.length && old[k]?.type === 'qa') k++;
  const blocks = [...old.slice(0, k), box, ...old.slice(k)];
  const enh = hit.section.enh
    ? {
        ...hit.section.enh,
        blocks: hit.section.enh.blocks.map((e) => (e.block >= k ? { ...e, block: e.block + 1 } : e)),
      }
    : undefined;
  const section: Section = {
    ...hit.section,
    blocks,
    updatedAt: now,
    lastAction: 'ask',
    ...(enh ? { enh } : {}),
  };
  const tabs = model.tabs.map((t) =>
    t === hit.tab ? { ...t, sections: t.sections.map((s) => (s.id === sectionId ? section : s)) } : t,
  );
  const glossary = model.glossary.map((n) =>
    n.sectionId === sectionId && n.blockIndex >= k ? { ...n, blockIndex: n.blockIndex + 1 } : n,
  );
  return { model: { ...model, tabs, glossary, updatedAt: now }, qaId };
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

/**
 * 08 §7.5: label of an "ELI5 this selection" tab: "ELI5: " + the draft's topic title, or the first 6
 * words of the selection when the title is empty; " (2)", " (3)" on collision.
 */
export function selectionEli5Label(title: string, selection: string, existing: readonly string[]): string {
  const topic = collapseWs(title)
    .replace(/^ELI5:\s*/i, '')
    .trim();
  return sectionEli5Label(topic === '' ? '' : topic, selection, existing);
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
  // The prompt shows the source section's animation as a keep marker (08 §6.2), so a returned
  // marker takes a copy of it, in order (audit round 3). The copy is a new animation in a new tab,
  // so it counts against the tab and document caps like any other (never forced past them).
  const sourceIds = new Set<string>(opts.selectionOf && opts.selectionOf.length > 0 ? opts.selectionOf : [from]);
  const keepPool = model.tabs
    .flatMap((t) => t.sections)
    .filter((s) => sourceIds.has(s.id))
    .flatMap((s) => s.blocks)
    .filter((b): b is Extract<DocBlock, { type: 'animation' }> => b.type === 'animation');
  const budget = animationBudget({ n: countDocAnimations(model.tabs) });
  const sections = buildSections(draft.sections, {
    tabKey,
    now,
    idSource,
    taken,
    resolveFigure: assetResolver(model, opts),
    takeAnimation: () => budget(false),
    keepAnimation: () => {
      const b = keepPool.shift();
      const p = b && svgIdPrefix(b.poster);
      if (!b || !p) return b;
      // A copy: its poster ids get a fresh prefix so the document never holds an id twice (07 §7.3).
      const all = JSON.stringify(model.tabs);
      let next = mintDiagramPrefix(idSource);
      while (all.includes(next)) next = mintDiagramPrefix(idSource);
      return { ...b, poster: b.poster.split(p).join(next) };
    },
    warn: (w) => {
      warnings.push(w);
    },
  });
  if (sections.length === 0) throw new DocumentBuildError('empty_tab');
  const labels = model.tabs.map((t) => t.label);
  const covered = opts.selectionOf;
  let tab: Tab;
  if (covered) {
    // 08 §7.5: paragraph breaks are kept for the quote; runs of spaces collapse.
    const sel = selection
      .split(/\n{2,}/)
      .map(collapseWs)
      .filter((p) => p !== '')
      .join('\n\n');
    tab = {
      key: tabKey,
      kind: 'section-eli5',
      label: selectionEli5Label(draft.title, sel, labels),
      createdAt: now,
      origin: {
        sectionId: from,
        selection: sel.length > MAX_SELECTION ? sel.slice(0, MAX_SELECTION) : sel,
        scope: 'selection',
        sectionIds: covered.length > 0 ? [...covered] : [from],
      },
      sections,
    };
  } else {
    const sel = collapseWs(selection);
    tab = {
      key: tabKey,
      kind: 'section-eli5',
      label: sectionEli5Label(hit.section.heading, sel, labels),
      createdAt: now,
      origin: { sectionId: from, selection: sel.length > MAX_SELECTION ? sel.slice(0, MAX_SELECTION) : sel },
      sections,
    };
  }
  return { model: { ...model, tabs: [...model.tabs, tab], updatedAt: now }, tabKey, warnings };
}

/** 07 §8: removes a section ELI5 tab; `indepth` and `eli5` cannot be removed. */
export function removeTab(model: DocumentModel, tabKey: string, now: string): DocumentModel {
  const tab = model.tabs.find((t) => t.key === tabKey);
  if (!tab) throw new DocumentMutationError('unknown_tab', tabKey);
  if (tab.kind !== 'section-eli5' || !isSectionEli5TabKey(tab.key))
    throw new DocumentMutationError('tab_not_removable', tabKey);
  return pruneAssets({ ...model, tabs: model.tabs.filter((t) => t !== tab), updatedAt: now });
}

/** SectionIds of a tab, for meta.json retiredIds when it is closed (07 §4.3). */
export function sectionIdsOfTab(model: DocumentModel, tabKey: string): SectionId[] {
  return model.tabs.find((t) => t.key === tabKey)?.sections.map((s) => s.id) ?? [];
}
