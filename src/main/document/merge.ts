/**
 * `appendMergedDocument` (09 §10.3, 07 §8.1): the HTML side of a merge accept. Re-exported from
 * src/main/document/index.ts by `export *`. The document module may not import library types
 * (01 §3), so the meta and tab record shapes are declared here structurally; 09's DocumentMeta and
 * TabRecord satisfy them.
 */
import { DocumentBuildError } from './errors';
import { collapseWs } from './html';
import { mintDiagramPrefix, mintNoteId, sectionIdsOf } from './ids';
import { MAX_SECTION_ELI5_TABS } from './mutate';
import { parseDocument } from './parse';
import { formatDate, renderDocument } from './render';
import {
  ELI5_TAB_KEY,
  INDEPTH_TAB_KEY,
  cryptoIdSource,
  mintSectionEli5TabKey,
  mintSectionId,
  tabKeyOfSectionId,
  type IdSource,
} from './section-id';
import type { DocBlock, DocRuntime, DocumentModel, GlossaryNote, Section, SectionId, Tab } from './types';

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

export interface AppendMergedInput {
  targetHtml: string;
  targetMeta: MergeDocMeta;
  sourceHtml: string;
  sourceMeta: MergeDocMeta;
  suggestionId: string;
  mergedAt: string;
}

export interface AppendMergedOptions {
  /** Default: crypto (07 §4.2); SeededIdSource in tests. */
  idSource?: IdSource;
  /** Default: the bundled runtime (a merge re-renders with the current runtime, 07 §4.3). */
  runtime?: DocRuntime;
}

export interface AppendMergedResult {
  html: string;
  /** Tab records in display order, for the target's meta.json. */
  tabs: MergeTabRecord[];
  /** [indepthMarker, eli5Marker?]; [0] is always the in-depth marker (09 §10.6 step 12). */
  markerSectionIds: SectionId[];
  /** Old source SectionId -> new SectionId; used only to re-anchor (07 §4.3). */
  idMap: Record<SectionId, SectionId>;
  /** e.g. 'merge-tabs-dropped' (07 §8.1 step 6). */
  warnings: string[];
}

const DIAGRAM_PREFIX_RE = /\bid="(d[0-9a-f]{8}-)/;
const LABEL_SUFFIX_RE = / \(\d+\)$/;
/** Characters the inline parser treats as markup (07 §5.2); escaped so titles stay literal. */
const MD_SPECIAL_RE = /[\\`*[\]()_]/g;

const escapeMd = (s: string): string => s.replace(MD_SPECIAL_RE, (c) => `\\${c}`);

/** `label`, or `base (n)` for the first free n ≥ 2 (07 §4.1, 09 §10.3). */
function uniqueLabel(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label;
  const base = label.replace(LABEL_SUFFIX_RE, '');
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 07 §8.1: appends the source document to the target behind marker sections. Never mutates target IDs. */
export function appendMergedDocument(input: AppendMergedInput, opts: AppendMergedOptions = {}): AppendMergedResult {
  const idSource = opts.idSource ?? cryptoIdSource;
  const { mergedAt, suggestionId } = input;

  // Step 1: parse both (DocumentFormatError propagates; 09 maps it to MERGE_FAILED).
  const target = parseDocument(input.targetHtml);
  const source = parseDocument(input.sourceHtml);
  const t = target.model;
  const s = source.model;
  if (input.sourceMeta.id === input.targetMeta.id || s.docId === t.docId) {
    throw new DocumentBuildError('invalid_merge');
  }
  const fromTitle = input.sourceMeta.title;
  const warnings: string[] = [];

  // Step 1: combine assets, deduplicated by sha256; source figures are re-pointed.
  const assets = new Map(target.assets);
  const assetRefs = [...t.assets];
  const assetMap = new Map<string, string>();
  for (const a of s.assets) {
    const same = assetRefs.find((x) => x.sha256 === a.sha256);
    if (same) {
      assetMap.set(a.id, same.id);
      continue;
    }
    const bytes = source.assets.get(a.id);
    if (!bytes || assets.has(a.id)) continue;
    assets.set(a.id, bytes);
    assetRefs.push(a);
    assetMap.set(a.id, a.id);
  }

  // Step 2: every ID in the target plus its retired ones.
  const used = new Set<string>([...sectionIdsOf(t.tabs), ...input.targetMeta.retiredIds]);
  const idMap: Record<SectionId, SectionId> = {};
  const diagramPrefixes = new Set<string>();
  for (const tab of t.tabs)
    for (const sec of tab.sections)
      for (const b of sec.blocks) {
        const p = b.type === 'diagram' ? DIAGRAM_PREFIX_RE.exec(b.svg)?.[1] : undefined;
        if (p) diagramPrefixes.add(p);
      }

  /** Figures re-pointed to the combined assets; colliding diagram id prefixes re-minted (unique HTML ids). */
  const moveBlock = (b: DocBlock): DocBlock | undefined => {
    if (b.type === 'figure') {
      const assetId = assetMap.get(b.assetId);
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

  // Step 4: a moved section gets a fresh ID under the target tab key.
  const moveSection = (sec: Section, key: string): Section => {
    const id = mintSectionId(key, idSource, used);
    used.add(id);
    idMap[sec.id] = id;
    const blocks = sec.blocks.map(moveBlock).filter((b): b is DocBlock => b !== undefined);
    return {
      ...sec,
      id,
      blocks,
      origin: 'merged',
      merge: { fromDocId: input.sourceMeta.id, fromTitle, mergedAt },
    };
  };

  // Step 3: the marker section for one tab.
  const sourceRefs = s.references.filter((r) => r.status === 'used').map((r) => r.label);
  const markerText =
    `Merged on ${formatDate(mergedAt)}.` +
    (sourceRefs.length ? ` Originally generated from: ${sourceRefs.map(escapeMd).join(', ')}` : '');
  const marker = (key: string): Section => {
    const id = mintSectionId(key, idSource, used);
    used.add(id);
    return {
      id,
      kind: 'content',
      heading: `Added from: ${collapseWs(fromTitle)}`,
      blocks: [{ type: 'paragraph', md: markerText }],
      origin: 'merge-marker',
      updatedAt: mergedAt,
      mergeMarker: { suggestionId, fromDocId: input.sourceMeta.id, fromTitle, mergedAt, sourceRefs },
    };
  };

  const markerSectionIds: SectionId[] = [];
  const findTab = (m: DocumentModel, key: string): Tab | undefined => m.tabs.find((x) => x.key === key);

  // Step 5, in-depth: marker then moved sections, before the references section.
  const tIndepth = findTab(t, INDEPTH_TAB_KEY);
  const sIndepth = findTab(s, INDEPTH_TAB_KEY);
  const sIndepthContent = sIndepth?.sections.filter((x) => x.kind === 'content' && x.origin !== 'placeholder') ?? [];
  let indepthSections = tIndepth?.sections ?? [];
  if (sIndepthContent.length > 0) {
    const m = marker(INDEPTH_TAB_KEY);
    markerSectionIds.push(m.id);
    const moved = sIndepthContent.map((x) => moveSection(x, INDEPTH_TAB_KEY));
    const refsAt = indepthSections.findIndex((x) => x.kind === 'references');
    const at = refsAt === -1 ? indepthSections.length : refsAt;
    indepthSections = [...indepthSections.slice(0, at), m, ...moved, ...indepthSections.slice(at)];
  }

  // Step 5, ELI5: no marker when the source ELI5 tab is a placeholder or empty.
  const tEli5 = findTab(t, ELI5_TAB_KEY);
  const sEli5 = findTab(s, ELI5_TAB_KEY);
  const sEli5Content =
    sEli5 && !sEli5.placeholder ? sEli5.sections.filter((x) => x.kind === 'content' && x.origin !== 'placeholder') : [];
  let eli5Sections = tEli5?.sections ?? [];
  if (sEli5Content.length > 0) {
    const m = marker(ELI5_TAB_KEY);
    markerSectionIds.push(m.id);
    eli5Sections = [...eli5Sections, m, ...sEli5Content.map((x) => moveSection(x, ELI5_TAB_KEY))];
  }

  // Step 6: carried section ELI5 tabs; the oldest ones are dropped past the tab limit.
  const tSx = t.tabs.filter((x) => x.kind === 'section-eli5');
  let sSx = s.tabs.filter((x) => x.kind === 'section-eli5');
  const room = Math.max(0, MAX_SECTION_ELI5_TABS - tSx.length);
  if (sSx.length > room) {
    sSx = sSx.slice(sSx.length - room);
    warnings.push('merge-tabs-dropped');
  }
  const takenKeys = new Set<string>([
    ...t.tabs.map((x) => x.key),
    ...input.targetMeta.retiredIds.map((id) => tabKeyOfSectionId(id as SectionId)),
  ]);
  const labels = new Set(t.tabs.map((x) => x.label));
  const carried: Tab[] = sSx.map((tab) => {
    const key = mintSectionEli5TabKey(idSource, takenKeys);
    takenKeys.add(key);
    const label = uniqueLabel(tab.label, labels);
    labels.add(label);
    const sections = tab.sections.map((x) => moveSection(x, key));
    const from = tab.origin ? (idMap[tab.origin.sectionId] ?? markerSectionIds[0]) : undefined;
    return {
      key,
      kind: 'section-eli5',
      label,
      createdAt: mergedAt,
      ...(tab.origin && from ? { origin: { sectionId: from, selection: tab.origin.selection } } : {}),
      sections,
    };
  });

  // Step 7: glossary notes of moved sections, through idMap; target terms win.
  const terms = new Set(t.glossary.map((n) => n.term.toLowerCase()));
  const noteIds = new Set(t.glossary.map((n) => n.id));
  const glossary: GlossaryNote[] = [...t.glossary];
  for (const n of s.glossary) {
    const sectionId = idMap[n.sectionId];
    const key = n.term.toLowerCase();
    if (!sectionId || terms.has(key)) continue;
    terms.add(key);
    const id = noteIds.has(n.id) ? mintNoteId(idSource, noteIds) : n.id;
    noteIds.add(id);
    glossary.push({ ...n, id, sectionId });
  }

  // Step 8: source references appended with addedBy.
  const references = [
    ...t.references,
    ...s.references.map((r) => ({ ...r, addedBy: { mergeFromTitle: fromTitle, mergedAt } })),
  ];

  const tabs: Tab[] = t.tabs.map((tab) => {
    if (tab.key === INDEPTH_TAB_KEY) return { ...tab, sections: indepthSections };
    if (tab.key === ELI5_TAB_KEY) return { ...tab, sections: eli5Sections };
    return tab;
  });
  tabs.push(...carried);

  // Step 9.
  const merged: DocumentModel = { ...t, tabs, glossary, references, assets: assetRefs, updatedAt: mergedAt };
  const html = renderDocument(merged, assets, {
    theme: target.theme,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
  });
  const createdAt = new Map(input.targetMeta.tabs.map((r) => [r.key, r.createdAt]));
  const records: MergeTabRecord[] = tabs.map((tab) => ({
    key: tab.key,
    kind: tab.kind,
    label: tab.label,
    sectionCount: tab.sections.length,
    ...(tab.origin ? { sourceSectionId: tab.origin.sectionId } : {}),
    createdAt: createdAt.get(tab.key) ?? tab.createdAt,
  }));
  return { html, tabs: records, markerSectionIds, idMap, warnings };
}
