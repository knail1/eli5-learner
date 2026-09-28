/**
 * Woven merges (09 §10.3, 07 §8.1): the document side of a merge accept. The incoming document is
 * serialized for the `merge-weave` prompt (`prepareMergeWeave`), the model returns an edit plan per
 * tab, and `applyMergePlan` rewrites the target in place: revised sections keep their IDs, new
 * sections get fresh ones, and every change is marked deterministically (enhance.ts, 07 §6.4).
 * Re-exported from src/main/document/index.ts by `export *`. The document module may not import
 * library types (01 §3), so the meta and tab record shapes are declared here structurally.
 */
import type { MergePlanBlock, MergePlanDraft, MergeTabPlan, MergeWeaveInput } from '../llm';
import { MAX_HEADING, MAX_SECTIONS_PER_TAB } from './build';
import { enhanceBlocks, type BlockOrigin } from './enhance';
import { DocumentBuildError } from './errors';
import { MAX_GLOSSARY_NOTES, placeGlossary, reanchorSection } from './glossary';
import { capText, collapseWs } from './html';
import { mintDiagramPrefix, sectionIdsOf } from './ids';
import { parseDocument } from './parse';
import { renderDocument } from './render';
import { cryptoIdSource, ELI5_TAB_KEY, INDEPTH_TAB_KEY, mintSectionId, type IdSource } from './section-id';
import type {
  AssetRef,
  DocBlock,
  DocRuntime,
  DocumentModel,
  GlossaryNote,
  ParsedDocument,
  ReferenceEntry,
  Section,
  SectionId,
  Tab,
} from './types';
import { convertBlocks } from './validate';

/** 09 §5.2 TabRecord, structurally. */
export interface MergeTabRecord {
  key: string;
  kind: 'indepth' | 'eli5' | 'section-eli5';
  label: string;
  sectionCount: number;
  sourceSectionId?: SectionId;
  createdAt: string;
}

/** The parts of 09 §5.2 DocumentMeta a merge reads. */
export interface MergeDocMeta {
  id: string;
  title: string;
  retiredIds: readonly string[];
  tabs: readonly MergeTabRecord[];
}

/** The `merge-weave` call (02 §12 `weaveMerge`), injected so this module stays free of providers. */
export type MergePlanner = (input: MergeWeaveInput) => Promise<{ draft: MergePlanDraft; prompt: string }>;

export interface WeaveMergedInput {
  targetHtml: string;
  targetMeta: MergeDocMeta;
  sourceHtml: string;
  sourceMeta: MergeDocMeta;
  mergedAt: string;
  signal?: AbortSignal;
}

export interface WeaveMergedOptions {
  /** Default: crypto (07 §4.2); SeededIdSource in tests. */
  idSource?: IdSource;
  /** Default: the bundled runtime (a merge re-renders with the current runtime, 07 §4.3). */
  runtime?: DocRuntime;
}

export interface WeaveMergedResult {
  html: string;
  /** Tab records in display order, for the target's meta.json. */
  tabs: MergeTabRecord[];
  /** Sections the merge revised or inserted, in-depth first (09 §10.6 step 12 scrolls to the first). */
  markerSectionIds: SectionId[];
  /** The legend id of this merge ('m1', 'm2', …). */
  mergeId: string;
  /** "merge-weave@N", for meta.json generation.prompts. */
  prompt: string;
  /** e.g. 'merge-unknown-section', 'merge-block-dropped'. */
  warnings: string[];
}

/** One document serialized for the prompt, with the alias maps that resolve the plan. */
export interface MergeWeavePrep {
  input: MergeWeaveInput;
  target: ParsedDocument;
  source: ParsedDocument;
  /** Alias ('I1', 'E2') -> target SectionId. */
  targetAliases: ReadonlyMap<string, SectionId>;
  /** Alias ('X1', 'Y2') -> incoming section. */
  sourceAliases: ReadonlyMap<string, Section>;
  /** Figure label the model may use -> [which document, asset id]. */
  figureLabels: ReadonlyMap<string, { from: 'target' | 'source'; assetId: string }>;
}

const DIAGRAM_PREFIX_RE = /\bid="(d[0-9a-f]{8}-)/;
const START = 'START';

const contentSections = (tab: Tab | undefined): Section[] => (tab?.sections ?? []).filter((s) => s.kind === 'content');
const findTab = (m: DocumentModel, key: string): Tab | undefined => m.tabs.find((t) => t.key === key);

// ---- prompt serialization ----

function one(s: string): string {
  return collapseWs(s);
}

/** One block as a prompt line (the model reuses visuals by number rather than retyping them). */
function blockLine(b: DocBlock, i: number, label: (assetId: string) => string): string {
  const at = `b${i}`;
  switch (b.type) {
    case 'paragraph':
      return `${at} paragraph: ${b.md}`;
    case 'callout':
      return `${at} callout (${b.tone}): ${b.md}`;
    case 'analogy':
      return `${at} analogy: ${b.md}`;
    case 'list':
      return [`${at} list (${b.ordered ? 'ordered' : 'unordered'}):`, ...b.items.map((x) => `  - ${x}`)].join('\n');
    case 'pullquote':
      return `${at} pullquote: "${one(b.text)}"${b.attribution ? ` (${one(b.attribution)})` : ''}`;
    case 'table':
      return [
        `${at} table${b.caption ? `: ${one(b.caption)}` : ''}`,
        `  | ${b.header.join(' | ')} |`,
        ...b.rows.map((r) => `  | ${r.join(' | ')} |`),
      ].join('\n');
    case 'chart': {
      const c = b.chart;
      const series = c.series.map((s) => `${s.name}: ${s.values.map((v) => (v === null ? '-' : v)).join(', ')}`);
      return `${at} chart (${c.kind}): "${one(c.title)}"; categories: ${c.categories.join(', ')}; ${series.join('; ')}`;
    }
    case 'diagram':
      return `${at} diagram: "${one(b.title)}" (${one(b.alt)})`;
    case 'figure':
      return `${at} figure [${label(b.assetId)}]: ${one(b.caption)}`;
    case 'stepper':
      return [
        `${at} stepper: "${one(b.title)}"`,
        ...b.steps.map((s, k) => `  ${k + 1}. ${one(s.label)}: ${s.md}`),
      ].join('\n');
    default:
      return `${at} ${(b as { type: string }).type}: ${JSON.stringify(b).slice(0, 400)}`;
  }
}

function sectionText(alias: string, s: Section, label: (assetId: string) => string): string {
  return [`### ${alias} · ${one(s.heading)}`, ...s.blocks.map((b, i) => blockLine(b, i, label))].join('\n');
}

function referencesText(refs: readonly ReferenceEntry[]): string {
  const used = refs.filter((r) => r.status === 'used');
  return used.length
    ? used.map((r) => `- ${r.label}${r.href && r.href !== r.label ? ` (${r.href})` : ''}`).join('\n')
    : '(none)';
}

/**
 * 07 §8.1 step 1: parses both documents and serializes them for `merge-weave`. Target sections are
 * I1… (in depth) and E1… (ELI5); incoming ones X1… and Y1…; blocks are b0, b1, … inside each.
 */
export function prepareMergeWeave(input: {
  targetHtml: string;
  targetMeta: MergeDocMeta;
  sourceHtml: string;
  sourceMeta: MergeDocMeta;
}): MergeWeavePrep {
  const target = parseDocument(input.targetHtml);
  const source = parseDocument(input.sourceHtml);
  const t = target.model;
  const s = source.model;
  if (input.sourceMeta.id === input.targetMeta.id || s.docId === t.docId) {
    throw new DocumentBuildError('invalid_merge');
  }

  // Figure labels: target labels as they are; incoming ones renamed when they collide.
  const figureLabels = new Map<string, { from: 'target' | 'source'; assetId: string }>();
  const targetLabel = new Map<string, string>();
  for (const a of t.assets) {
    figureLabels.set(a.label, { from: 'target', assetId: a.id });
    targetLabel.set(a.id, a.label);
  }
  const sourceLabel = new Map<string, string>();
  for (const a of s.assets) {
    const same = t.assets.find((x) => x.sha256 === a.sha256);
    if (same) {
      sourceLabel.set(a.id, same.label);
      continue;
    }
    let label = a.label;
    for (let n = 2; figureLabels.has(label); n++) label = `${a.label} (incoming${n > 2 ? ` ${n - 1}` : ''})`;
    figureLabels.set(label, { from: 'source', assetId: a.id });
    sourceLabel.set(a.id, label);
  }

  const targetAliases = new Map<string, SectionId>();
  const sourceAliases = new Map<string, Section>();
  const tabText = (
    m: DocumentModel,
    key: string,
    prefix: string,
    label: Map<string, string>,
    record: (alias: string, sec: Section) => void,
  ): string => {
    const tab = findTab(m, key);
    if (!tab || tab.placeholder) return '(not available: leave this tab without edits)';
    const out = contentSections(tab).map((sec, i) => {
      const alias = `${prefix}${i + 1}`;
      record(alias, sec);
      return sectionText(alias, sec, (id) => label.get(id) ?? id);
    });
    return out.length ? out.join('\n\n') : '(empty)';
  };
  const recordTarget = (alias: string, sec: Section): void => {
    targetAliases.set(alias, sec.id);
  };
  const recordSource = (alias: string, sec: Section): void => {
    sourceAliases.set(alias, sec);
  };

  const terms = t.glossary.map((n) => n.term);
  const target_ = [
    `# ${one(t.title)}`,
    ...(t.dek ? [one(t.dek)] : []),
    '',
    '## In depth tab',
    tabText(t, INDEPTH_TAB_KEY, 'I', targetLabel, recordTarget),
    '',
    '## ELI5 tab',
    tabText(t, ELI5_TAB_KEY, 'E', targetLabel, recordTarget),
    '',
    `## Glossary terms already defined\n${terms.length ? terms.join(', ') : '(none)'}`,
    '',
    `## Sources\n${referencesText(t.references)}`,
  ].join('\n');
  const incoming = [
    `# ${one(s.title)}`,
    ...(s.dek ? [one(s.dek)] : []),
    '',
    '## In depth',
    tabText(s, INDEPTH_TAB_KEY, 'X', sourceLabel, recordSource),
    '',
    '## ELI5',
    tabText(s, ELI5_TAB_KEY, 'Y', sourceLabel, recordSource),
    '',
    `## Sources\n${referencesText(s.references)}`,
  ].join('\n');

  return {
    input: {
      targetTitle: t.title,
      incomingTitle: s.title,
      target: target_,
      incoming,
      imageLabels: [...figureLabels.keys()],
    },
    target,
    source,
    targetAliases,
    sourceAliases,
    figureLabels,
  };
}

// ---- applying the plan ----

export interface ApplyMergePlanOptions {
  fromDocId: string;
  fromTitle: string;
  mergedAt: string;
  retiredIds?: readonly string[];
  idSource?: IdSource;
}

export interface ApplyMergePlanResult {
  model: DocumentModel;
  assets: Map<string, Uint8Array>;
  mergeId: string;
  /** Revised or inserted sections, in-depth first, in document order. */
  enhancedSectionIds: SectionId[];
  warnings: string[];
}

/** 'm' + the next free number, in legend order. */
function nextMergeId(model: DocumentModel): string {
  const taken = new Set((model.merges ?? []).map((m) => m.id));
  let n = taken.size + 1;
  while (taken.has(`m${n}`)) n++;
  return `m${n}`;
}

/** True when the section carries a mark of merge `id`. */
function marksMerge(s: Section, id: string): boolean {
  const e = s.enh;
  if (!e) return false;
  if (e.added === id) return true;
  return e.blocks.some((b) =>
    b.kind === 'text' ? b.parts.some((p) => p.some((r) => r.merge === id)) : b.merge === id,
  );
}

const refKey = (r: ReferenceEntry): string => `${r.status}\0${r.label}\0${r.href ?? ''}`;

/**
 * 07 §8.1 steps 2-9: applies a `merge-weave` plan to the target. Never mutates the target's
 * SectionIds; unknown aliases and invalid blocks are skipped with a warning. Pure and deterministic
 * for a given IdSource (golden documents use it directly).
 */
export function applyMergePlan(
  prep: MergeWeavePrep,
  plan: MergePlanDraft,
  opts: ApplyMergePlanOptions,
): ApplyMergePlanResult {
  const idSource = opts.idSource ?? cryptoIdSource;
  const t = prep.target.model;
  const s = prep.source.model;
  const { mergedAt } = opts;
  const mergeId = nextMergeId(t);
  const warnings: string[] = [];
  const warn = (w: string): void => {
    warnings.push(w);
  };

  const used = new Set<string>([...sectionIdsOf(t.tabs), ...(opts.retiredIds ?? [])]);
  const assets = new Map(prep.target.assets);
  const assetRefs: AssetRef[] = [...t.assets];
  const sourceAssetRefs = new Map(s.assets.map((a) => [a.id, a]));
  /** Incoming asset id -> id in the target (added on first use, deduplicated by sha256). */
  const importAsset = (id: string): string | undefined => {
    const ref = sourceAssetRefs.get(id);
    if (!ref) return undefined;
    const same = assetRefs.find((a) => a.sha256 === ref.sha256);
    if (same) return same.id;
    const bytes = prep.source.assets.get(id);
    if (!bytes) return undefined;
    assets.set(id, bytes);
    assetRefs.push(ref);
    return id;
  };

  const diagramPrefixes = new Set<string>();
  for (const tab of t.tabs)
    for (const sec of tab.sections)
      for (const b of sec.blocks) {
        const p = b.type === 'diagram' ? DIAGRAM_PREFIX_RE.exec(b.svg)?.[1] : undefined;
        if (p) diagramPrefixes.add(p);
      }
  /** An incoming block moved into the target: figures re-pointed, colliding diagram ids re-minted. */
  const moveIncoming = (b: DocBlock): DocBlock | undefined => {
    if (b.type === 'figure') {
      const assetId = importAsset(b.assetId);
      return assetId ? { ...b, assetId } : undefined;
    }
    if (b.type === 'diagram') {
      const p = DIAGRAM_PREFIX_RE.exec(b.svg)?.[1];
      if (!p) return b;
      if (!diagramPrefixes.has(p)) {
        diagramPrefixes.add(p);
        return b;
      }
      let next = mintDiagramPrefix(idSource);
      while (diagramPrefixes.has(next)) next = mintDiagramPrefix(idSource);
      diagramPrefixes.add(next);
      return { ...b, svg: b.svg.split(p).join(next) };
    }
    return b;
  };
  const resolveFigure = (label: string): string | undefined => {
    const hit = prep.figureLabels.get(label);
    if (!hit) return undefined;
    return hit.from === 'target' ? hit.assetId : importAsset(hit.assetId);
  };

  /** Plan blocks -> DocBlocks with their origins; `old` is the section being revised. */
  const resolveBlocks = (
    blocks: readonly MergePlanBlock[],
    old: Section | undefined,
  ): { blocks: DocBlock[]; origins: BlockOrigin[] } => {
    const out: DocBlock[] = [];
    const origins: BlockOrigin[] = [];
    for (const b of blocks) {
      if (b.type === 'keep') {
        const kept = old?.blocks[b.block];
        if (!kept) {
          warn('merge-block-dropped');
          continue;
        }
        out.push(kept);
        origins.push({ kind: 'keep', index: b.block });
        continue;
      }
      if (b.type === 'incoming') {
        const from = prep.sourceAliases.get(b.section.trim().toUpperCase())?.blocks[b.block];
        const moved = from ? moveIncoming(from) : undefined;
        if (!moved) {
          warn('merge-block-dropped');
          continue;
        }
        out.push(moved);
        origins.push({ kind: 'incoming' });
        continue;
      }
      for (const c of convertBlocks([b], { idSource, resolveFigure, warn })) {
        out.push(c);
        origins.push({ kind: 'written' });
      }
    }
    return { blocks: out, origins };
  };

  const heading = (h: string, fallback: string): string => capText(collapseWs(h), MAX_HEADING) || fallback;
  const enhanced: SectionId[] = [];
  const revisedIndepth: Section[] = [];
  const insertedIndepth = new Set<string>();

  const weaveTab = (tab: Tab, tp: MergeTabPlan): Tab => {
    if (tab.placeholder && tp.revise.length === 0 && tp.insert.length === 0) return tab;
    const byId = new Map(tab.sections.map((x) => [x.id as string, x]));
    const aliasOf = (alias: string): SectionId | undefined => {
      const id = prep.targetAliases.get(alias.trim().toUpperCase());
      return id && byId.has(id) ? id : undefined;
    };
    let placeholderGone = false;

    // Revisions: same SectionId, marks diffed against the old blocks.
    const revised = new Map<string, Section>();
    for (const r of tp.revise) {
      const id = aliasOf(r.section);
      const old = id ? byId.get(id) : undefined;
      if (!id || !old || old.kind !== 'content' || revised.has(id)) {
        warn('merge-unknown-section');
        continue;
      }
      const { blocks, origins } = resolveBlocks(r.blocks, old);
      if (blocks.length === 0) {
        warn('merge-section-empty');
        continue;
      }
      const wasPlaceholder = old.origin === 'placeholder';
      if (wasPlaceholder) placeholderGone = true;
      const marks = wasPlaceholder
        ? { added: mergeId, blocks: [] }
        : {
            blocks: enhanceBlocks({
              oldBlocks: old.blocks,
              ...(old.enh ? { oldEnh: old.enh } : {}),
              newBlocks: blocks,
              origins,
              merge: mergeId,
            }),
            ...(old.enh?.added ? { added: old.enh.added } : {}),
          };
      const { enh: _old, lastAction: _a, ...rest } = old;
      const section: Section = {
        ...rest,
        heading: heading(r.heading, old.heading),
        blocks,
        ...(wasPlaceholder ? { origin: 'merged' as const } : {}),
        updatedAt: mergedAt,
        ...(marks.added || marks.blocks.length ? { enh: marks } : {}),
      };
      revised.set(id, section);
      if (tab.kind === 'indepth') revisedIndepth.push(section);
    }

    // Insertions after an alias (or at the start); several after one anchor keep plan order.
    const after = new Map<string, Section[]>();
    let count = tab.sections.filter((x) => x.kind === 'content').length;
    for (const ins of tp.insert) {
      if (count >= MAX_SECTIONS_PER_TAB) {
        warn('sections-capped');
        break;
      }
      const { blocks } = resolveBlocks(ins.blocks, undefined);
      if (blocks.length === 0) {
        warn('merge-section-empty');
        continue;
      }
      const anchorAlias = ins.after.trim().toUpperCase();
      let anchor: string = START;
      if (anchorAlias !== START) {
        const id = aliasOf(anchorAlias);
        if (id) anchor = id;
        else {
          warn('merge-unknown-section');
          const lastContent = [...tab.sections].reverse().find((x) => x.kind === 'content');
          anchor = lastContent?.id ?? START;
        }
      }
      const id = mintSectionId(tab.key, idSource, used);
      used.add(id);
      const section: Section = {
        id,
        kind: 'content',
        heading: heading(ins.heading, 'More on this'),
        blocks,
        origin: 'merged',
        updatedAt: mergedAt,
        merge: { fromDocId: opts.fromDocId, fromTitle: opts.fromTitle, mergedAt },
        enh: { added: mergeId, blocks: [] },
      };
      after.set(anchor, [...(after.get(anchor) ?? []), section]);
      if (tab.kind === 'indepth') insertedIndepth.add(id);
      count++;
    }

    const sections: Section[] = [...(after.get(START) ?? [])];
    for (const sec of tab.sections) {
      // A replaced ELI5 placeholder leaves; inserted sections never follow the references section.
      const next = revised.get(sec.id) ?? sec;
      sections.push(next);
      sections.push(...(after.get(sec.id) ?? []));
    }
    const refsAt = sections.findIndex((x) => x.kind === 'references');
    if (refsAt !== -1 && refsAt !== sections.length - 1) {
      const [refs] = sections.splice(refsAt, 1);
      if (refs) sections.push(refs);
    }
    for (const sec of sections) if (marksMerge(sec, mergeId)) enhanced.push(sec.id);
    const { placeholder: _p, ...rest } = tab;
    return placeholderGone ? { ...rest, sections } : { ...tab, sections };
  };

  const tabs = t.tabs.map((tab) => {
    if (tab.key === INDEPTH_TAB_KEY) return weaveTab(tab, plan.indepth);
    if (tab.key === ELI5_TAB_KEY) return weaveTab(tab, plan.eli5);
    return tab;
  });

  // Glossary: notes of revised sections re-anchored; new terms placed in changed in-depth sections.
  const indepth = tabs.find((x) => x.key === INDEPTH_TAB_KEY);
  const order = indepth?.sections.map((x) => x.id as string) ?? [];
  let glossary: GlossaryNote[] = [...t.glossary];
  for (const sec of revisedIndepth) glossary = reanchorSection(glossary, sec, order, warn);
  const changed = (indepth?.sections ?? []).filter(
    (x) => insertedIndepth.has(x.id) || revisedIndepth.some((r) => r.id === x.id),
  );
  const known = new Set(glossary.map((n) => n.term.toLowerCase()));
  const entries = plan.glossary.filter((e) => !known.has(collapseWs(e.term).toLowerCase()));
  if (changed.length > 0 && entries.length > 0 && glossary.length < MAX_GLOSSARY_NOTES) {
    const noteIds = new Set(glossary.map((n) => n.id));
    const placed = placeGlossary(
      {
        draft: { entries: entries.map((e) => ({ ...e, anchorSectionIndex: 0 })) },
        sections: changed,
        idSource,
        taken: { has: (id) => noteIds.has(id) || used.has(id) },
      },
      warn,
    ).filter(
      // An anchor inside text an existing note already anchors would not render; skip it.
      (n) =>
        !glossary.some(
          (o) =>
            o.sectionId === n.sectionId &&
            o.blockIndex === n.blockIndex &&
            (o.anchorText.includes(n.anchorText) || n.anchorText.includes(o.anchorText)),
        ),
    );
    const room = MAX_GLOSSARY_NOTES - glossary.length;
    const all = [...glossary, ...placed.slice(0, room)];
    const pos = (n: GlossaryNote): number => order.indexOf(n.sectionId);
    glossary = all
      .map((n, i) => ({ n, i }))
      .sort((a, b) => pos(a.n) - pos(b.n) || a.n.blockIndex - b.n.blockIndex || a.i - b.i)
      .map((x) => x.n);
  }

  // References: incoming sources listed as added by this merge (07 §10).
  const have = new Set(t.references.map(refKey));
  const references: ReferenceEntry[] = [...t.references];
  for (const r of s.references) {
    if (have.has(refKey(r))) continue;
    have.add(refKey(r));
    const { addedBy: _a, ...rest } = r;
    references.push({ ...rest, addedBy: { mergeFromTitle: opts.fromTitle, mergedAt, mergeId } });
  }

  const model: DocumentModel = {
    ...t,
    tabs,
    glossary,
    references,
    assets: assetRefs,
    updatedAt: mergedAt,
    merges: [...(t.merges ?? []), { id: mergeId, fromTitle: opts.fromTitle, mergedAt }],
  };
  const indepthIds = new Set(indepth?.sections.map((x) => x.id as string) ?? []);
  const enhancedSectionIds = [
    ...enhanced.filter((id) => indepthIds.has(id)),
    ...enhanced.filter((id) => !indepthIds.has(id)),
  ];
  return { model, assets, mergeId, enhancedSectionIds, warnings };
}

/**
 * 09 §10.6 step 6: weaves the source document into the target with one `merge-weave` call. Throws
 * on any failure (LLM error, budget exhausted, unreadable document); nothing is written here.
 */
export async function weaveMergedDocument(
  input: WeaveMergedInput,
  planner: MergePlanner,
  opts: WeaveMergedOptions = {},
): Promise<WeaveMergedResult> {
  const prep = prepareMergeWeave(input);
  const { draft, prompt } = await planner({ ...prep.input, ...(input.signal ? { signal: input.signal } : {}) });
  const applied = applyMergePlan(prep, draft, {
    fromDocId: input.sourceMeta.id,
    fromTitle: input.sourceMeta.title,
    mergedAt: input.mergedAt,
    retiredIds: input.targetMeta.retiredIds,
    ...(opts.idSource ? { idSource: opts.idSource } : {}),
  });
  const html = renderDocument(applied.model, applied.assets, {
    theme: prep.target.theme,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
  });
  const createdAt = new Map(input.targetMeta.tabs.map((r) => [r.key, r.createdAt]));
  const tabs: MergeTabRecord[] = applied.model.tabs.map((tab) => ({
    key: tab.key,
    kind: tab.kind,
    label: tab.label,
    sectionCount: tab.sections.length,
    ...(tab.origin ? { sourceSectionId: tab.origin.sectionId } : {}),
    createdAt: createdAt.get(tab.key) ?? tab.createdAt,
  }));
  return {
    html,
    tabs,
    markerSectionIds: applied.enhancedSectionIds,
    mergeId: applied.mergeId,
    prompt,
    warnings: applied.warnings,
  };
}
