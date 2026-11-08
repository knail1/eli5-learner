// export-sync-schema.ts: writes the shared sync contract (16 §12) from src/main/sync/protocol.ts.
//
//   npm run gen:sync-schema [-- --check]
//
// Output, all under test/contracts/sync/:
// - `<type>.schema.json`: JSON Schema (draft 2020-12) for each protocol file type. Cross-field rules
//   (`superRefine`) are not expressible there; the fixtures cover them.
// - `fixtures/layout.<name>.json`: version-tree layout cases. The input is a remote `VersionTree`
//   plus the collapsed branch points; the expected rows come from the desktop's own
//   `layoutVersionTree` (src/renderer/src/viewer/version-tree-layout.ts), so the Android port is
//   tested against the real layout.
// - `patterns.json`: every id pattern, limit and enum of the protocol, so the Android tests can check
//   that `Models.kt` repeats them character for character.
// - `section-hashes.json`: the 08 §6.3 `sectionHash` of every section of the built document fixtures
//   (test/fixtures/documents/build), plus canonical-JSON edge cases, so the phone's Ask sheet sends
//   the same hash the desktop computes (16 §5.1 `ask.sectionHash`).
// - `fixtures/index.json`: every fixture file with its type and whether it must parse, so the
//   Android tests need no directory listing. Hand-written fixtures follow `<type>.valid.<name>.json`
//   and `<type>.invalid.<name>.json`.
//
// `--check` writes nothing and exits 1 when any output differs from what is on disk, or when a
// generated file (a schema or layout fixture) no longer has a source (CI drift check). Without it,
// such orphans are deleted.
// Exit 2 on a usage error.

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { z } from 'zod';
import { canonicalJson } from '../src/main/document/canonical-json';
import { sectionHash } from '../src/main/document/interactive/hash';
import type { Section } from '../src/main/document/types';
import type { DocVersionNode } from '../src/preload/contract';
import { layoutVersionTree } from '../src/renderer/src/viewer/version-tree-layout';
import {
  ANCHOR_ID_RE,
  ATTACHMENT_MIME_TYPES,
  ATTACHMENT_NAME_RE,
  BLANK_RE,
  DEVICE_ID_RE,
  DOC_ID_RE,
  ERROR_CODE_RE,
  FOCUS_CHIPS,
  FOLDER_ID_RE,
  HTTP_URL_RE,
  JOB_ID_RE,
  JOB_KINDS,
  JOB_STATES,
  LIMITS,
  ONE_LINE_RE,
  PROTOCOL_VERSION,
  SECTION_ID_RE,
  SHA256_RE,
  SYNC_FORMAT_VERSION,
  SYNC_SCHEMAS,
  TAB_KEY_RE,
  VERSION_CHANGE_KINDS,
  VERSION_ID_RE,
  VersionTreeSchema,
} from '../src/main/sync/protocol';
import type { SyncFileType, VersionTree } from '../src/main/sync/protocol';

export const CONTRACT_DIR = 'test/contracts/sync';
export const FIXTURE_DIR = `${CONTRACT_DIR}/fixtures`;
const FIXTURE_NAME = /^([a-z-]+)\.(valid|invalid)\.([a-z0-9-]+)\.json$/;
const LAYOUT_NAME = /^layout\.([a-z0-9-]+)\.json$/;
export const SECTION_HASHES = `${CONTRACT_DIR}/section-hashes.json`;
const DOCUMENT_FIXTURES = 'test/fixtures/documents/build';

// ------------------------------------------------------------------------- version-tree layout

/** One laid-out row, without `isRedo` (the remote tree has no redo pointer, 16 §4.4). */
export interface LayoutRow {
  id: string;
  level: number;
  groupId: string | null;
  isCurrent: boolean;
  onCurrentPath: boolean;
  hasChildren: boolean;
  expanded: boolean;
  forced: boolean;
  branchStart: boolean;
  laneEnd: boolean;
  setsize: number;
  posinset: number;
}

export interface LayoutCase {
  tree: VersionTree;
  collapsed: string[];
}

/** Lays out a remote tree with the desktop's layout; the inverse mapping the phone will port. */
export function layoutRemoteTree(tree: VersionTree, collapsed: readonly string[]): LayoutRow[] {
  const nodes: DocVersionNode[] = tree.nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    createdAt: n.createdAt,
    kind: n.kind,
    label: n.label,
    topic: '',
    available: n.sha !== null,
    published: false,
  }));
  return layoutVersionTree({ nodes, currentId: tree.currentId }, new Set(collapsed)).map((r) => ({
    id: r.node.id,
    level: r.level,
    groupId: r.groupId,
    isCurrent: r.isCurrent,
    onCurrentPath: r.onCurrentPath,
    hasChildren: r.hasChildren,
    expanded: r.expanded,
    forced: r.forced,
    branchStart: r.branchStart,
    laneEnd: r.laneEnd,
    setsize: r.setsize,
    posinset: r.posinset,
  }));
}

const DOC = '3f2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b';
const sha = (c: string) => c.repeat(64);
const vid = (n: number) => `v-${n.toString(16).padStart(12, '0')}`;
const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString();

type NodeSpec = [n: number, parent: number | null, kind: VersionTree['nodes'][number]['kind'], min: number];

function tree(specs: NodeSpec[], current: number, seq = 1): VersionTree {
  return VersionTreeSchema.parse({
    v: 1,
    docId: DOC,
    seq,
    currentId: vid(current),
    nodes: specs.map(([n, parent, kind, min]) => ({
      id: vid(n),
      parentId: parent === null ? null : vid(parent),
      kind,
      label: kind === 'initial' ? 'Original' : `${kind} ${n}`,
      createdAt: at(min),
      sha: sha((n % 16).toString(16)),
      uploaded: n % 3 !== 0,
    })),
  });
}

/** The layout cases (11 §5.7): lanes, branches, collapse, forced expansion, damaged trees. */
export const LAYOUT_CASES: Readonly<Record<string, LayoutCase>> = Object.freeze({
  single: { tree: tree([[1, null, 'initial', 0]], 1), collapsed: [] },
  linear: {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 1, 'expand', 1],
        [3, 2, 'ask', 2],
      ],
      3,
    ),
    collapsed: [],
  },
  branch: {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 1, 'expand', 1],
        [3, 2, 'deeper', 2],
        [4, 1, 'analogy', 3],
        [5, 4, 'revise', 4],
        [6, 2, 'eli5-tab', 5],
      ],
      3,
    ),
    collapsed: [],
  },
  'collapsed-branch': {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 1, 'expand', 1],
        [3, 2, 'deeper', 2],
        [4, 1, 'analogy', 3],
        [5, 4, 'revise', 4],
      ],
      3,
    ),
    collapsed: [vid(1)],
  },
  'forced-open': {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 1, 'expand', 1],
        [3, 1, 'reexplain', 2],
        [4, 3, 'close-tab', 3],
        [5, 3, 'merge', 4],
      ],
      5,
    ),
    collapsed: [vid(1), vid(3)],
  },
  'same-time-siblings': {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [3, 1, 'expand', 1],
        [2, 1, 'analogy', 1],
      ],
      2,
    ),
    collapsed: [],
  },
  'two-roots': {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 1, 'expand', 1],
        [3, null, 'outside', 2],
        [4, 3, 'eli5-selection', 3],
      ],
      4,
    ),
    collapsed: [],
  },
  'missing-parent': {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 9, 'expand', 1],
        [3, 2, 'deeper', 2],
      ],
      1,
    ),
    collapsed: [],
  },
  cycle: {
    tree: tree(
      [
        [1, null, 'initial', 0],
        [2, 3, 'expand', 1],
        [3, 2, 'deeper', 2],
      ],
      3,
    ),
    collapsed: [],
  },
});

// ----------------------------------------------------------------------------------- patterns

/** The regex source zod uses for `z.iso.datetime()` (UTC, seconds required, real dates). */
function timestampPattern(): string {
  const json = z.toJSONSchema(z.iso.datetime()) as { pattern?: unknown };
  if (typeof json.pattern !== 'string') throw new Error('z.iso.datetime() exports no pattern');
  return json.pattern;
}

/** Every pattern, limit and enum the phone must repeat (`Patterns`, `Limits` and the enums in Models.kt). */
export function protocolConstants(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    syncFormatVersion: SYNC_FORMAT_VERSION,
    patterns: {
      DEVICE_ID: DEVICE_ID_RE.source,
      JOB_ID: JOB_ID_RE.source,
      DOC_ID: DOC_ID_RE.source,
      VERSION_ID: VERSION_ID_RE.source,
      FOLDER_ID: FOLDER_ID_RE.source,
      TAB_KEY: TAB_KEY_RE.source,
      SECTION_ID: SECTION_ID_RE.source,
      SHA256: SHA256_RE.source,
      ERROR_CODE: ERROR_CODE_RE.source,
      ATTACHMENT_NAME: ATTACHMENT_NAME_RE.source,
      ANCHOR_ID: ANCHOR_ID_RE.source,
      HTTP_URL: HTTP_URL_RE.source,
      ONE_LINE: ONE_LINE_RE.source,
      BLANK: BLANK_RE.source,
      TIMESTAMP: timestampPattern(),
      HOSTNAME: z.regexes.hostname.source,
    },
    limits: { ...LIMITS },
    attachmentMimeTypes: [...ATTACHMENT_MIME_TYPES],
    versionChangeKinds: [...VERSION_CHANGE_KINDS],
    jobKinds: [...JOB_KINDS],
    focusChips: [...FOCUS_CHIPS],
    jobStates: [...JOB_STATES],
  };
}

// ------------------------------------------------------------------------------ section hashes

/**
 * Values whose canonical JSON is easy to get wrong in another language: key order by UTF-16 code
 * unit, escapes (`<` stays literal here; only the script embedding escapes it), U+2028, control
 * characters, a lone surrogate, astral characters, fractions and exponents as JSON.stringify writes them,
 * and integer-like keys (a JavaScript object lists array indices first).
 */
const CANONICAL_CASES: readonly unknown[] = Object.freeze([
  { b: 1, a: [true, null, { d: 'x', c: 'y' }], Z: 'upper', é: 'accent', '😀': 'astral', '': 'empty' },
  { text: 'tab\there "quoted" back\\slash <b>&amp;</b> line\u2028sep \u0001\u001f\u007f end' },
  { lone: 'a\ud800b', pair: 'a\ud83d\ude00b', nl: 'a\nb\r\n', bs: '\b\f' },
  { n: [0, -1, 1.5, 0.1, 1e21, 1e-7, 123456789012, -0.25, 2.5e-5, 5e-324, 1.7976931348623157e308, 0.3 - 0.1] },
  // Array-index keys enumerate first, in numeric order, whatever `sort()` did; '01' and 2^32 - 1 are names.
  { '10': 'ten', '2': 'two', a: 'name', '01': 'padded', '4294967295': 'max', '4294967294': 'index' },
]);

const MODEL_SCRIPT_RE = /<script type="application\/json" id="eli5-model">([\s\S]*?)<\/script>/;

/**
 * sectionHash of every section of every built document fixture, read straight from the embedded
 * model JSON as the phone reads it (Vitest checks these equal the hashes of `parseDocument`), and of
 * the canonical cases.
 */
export function sectionHashContract(root: string): unknown {
  const dir = join(root, DOCUMENT_FIXTURES);
  const documents = readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((file) => {
      const json = MODEL_SCRIPT_RE.exec(readFileSync(join(dir, file), 'utf8'))?.[1];
      if (json === undefined) throw new Error(`${DOCUMENT_FIXTURES}/${file}: no embedded model`);
      const model = JSON.parse(json) as { tabs: { sections: Section[] }[] };
      return {
        file,
        sections: model.tabs.flatMap((t) => t.sections.map((s) => ({ id: s.id, hash: sectionHash(s) }))),
      };
    });
  const canonical = CANONICAL_CASES.map((value) => ({
    value,
    json: canonicalJson(value),
    hash: sectionHash(value as Section),
  }));
  return { documents, canonical };
}

// ------------------------------------------------------------------------------------- output

async function format(root: string, rel: string, value: unknown): Promise<string> {
  const filepath = join(root, rel);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  // DEL and the line separators stay escaped, so no generated file holds an invisible character.
  const json = JSON.stringify(value).replace(
    /[\u007f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return prettier.format(json, { ...options, filepath });
}

const toPosix = (p: string) => p.split(sep).join('/');

/** Every generated file (repo-relative path → content), computed from the protocol and the fixture folder. */
export async function buildSyncContract(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [type, schema] of Object.entries(SYNC_SCHEMAS)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
    const rel = `${CONTRACT_DIR}/${type}.schema.json`;
    out.set(rel, await format(root, rel, { $id: `eli5-learner/sync/${type}.schema.json`, ...json }));
  }

  out.set(SECTION_HASHES, await format(root, SECTION_HASHES, sectionHashContract(root)));

  const patternsRel = `${CONTRACT_DIR}/patterns.json`;
  out.set(patternsRel, await format(root, patternsRel, protocolConstants()));

  const index: { file: string; type: SyncFileType | 'layout'; valid: boolean }[] = [];
  for (const [name, c] of Object.entries(LAYOUT_CASES)) {
    const file = `layout.${name}.json`;
    const rel = `${FIXTURE_DIR}/${file}`;
    out.set(rel, await format(root, rel, { ...c, rows: layoutRemoteTree(c.tree, c.collapsed) }));
    index.push({ file, type: 'layout', valid: true });
  }

  const dir = join(root, FIXTURE_DIR);
  const handWritten = existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'index.json' && f.endsWith('.json')) : [];
  for (const file of handWritten.sort()) {
    if (LAYOUT_NAME.test(file)) continue;
    const m = FIXTURE_NAME.exec(file);
    if (!m || !(m[1]! in SYNC_SCHEMAS)) {
      throw new Error(`${toPosix(relative(root, join(dir, file)))}: not <type>.(valid|invalid).<name>.json`);
    }
    index.push({ file, type: m[1] as SyncFileType, valid: m[2] === 'valid' });
  }
  index.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const rel = `${FIXTURE_DIR}/index.json`;
  out.set(rel, await format(root, rel, { fixtures: index }));
  return out;
}

/** Writes (or, with `check`, compares) the contract; returns the paths that differ from disk. */
export async function exportSyncContract(root: string, check: boolean): Promise<string[]> {
  const files = await buildSyncContract(root);
  const stale: string[] = [];
  for (const [rel, content] of files) {
    const abs = join(root, rel);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current === content) continue;
    stale.push(rel);
    if (!check) writeFileSync(abs, content);
  }
  // A schema file whose type, or a layout fixture whose case, no longer exists.
  const orphans = [
    ...readdirSync(join(root, CONTRACT_DIR))
      .filter((f) => f.endsWith('.schema.json'))
      .map((f) => `${CONTRACT_DIR}/${f}`),
    ...readdirSync(join(root, FIXTURE_DIR))
      .filter((f) => LAYOUT_NAME.test(f))
      .map((f) => `${FIXTURE_DIR}/${f}`),
  ].filter((rel) => !files.has(rel));
  for (const rel of orphans) {
    stale.push(rel);
    if (!check) unlinkSync(join(root, rel));
  }
  return stale;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--check')) {
    console.error('usage: export-sync-schema [--check]');
    process.exitCode = 2;
    return;
  }
  const check = args.includes('--check');
  const root = resolve(import.meta.dirname, '..');
  const stale = await exportSyncContract(root, check);
  if (check && stale.length > 0) {
    console.error(`sync contract is out of date; run npm run gen:sync-schema:\n  ${stale.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(stale.length === 0 ? 'sync contract up to date' : `wrote ${stale.length} file(s)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
