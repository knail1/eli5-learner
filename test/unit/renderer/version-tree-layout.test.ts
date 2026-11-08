import { describe, expect, it } from 'vitest';
import type { DocVersionNode, DocVersionTree } from '../../../src/preload/contract';
import { loadRenderer, versionNode } from './harness';

interface Row {
  node: DocVersionNode;
  level: number;
  groupId: string | null;
  isCurrent: boolean;
  onCurrentPath: boolean;
  isRedo: boolean;
  hasChildren: boolean;
  expanded: boolean;
  forced: boolean;
  branchStart: boolean;
  laneEnd: boolean;
  setsize: number;
  posinset: number;
}
const { layoutVersionTree, VERSION_VERBS } = await loadRenderer<{
  layoutVersionTree(t: Pick<DocVersionTree, 'nodes' | 'currentId' | 'redoId'>, c?: ReadonlySet<string>): Row[];
  VERSION_VERBS: Record<string, string>;
}>('viewer/version-tree-layout.ts');

const at = (min: number) => `2026-01-01T00:${String(min).padStart(2, '0')}:00.000Z`;
const n = (id: string, parentId: string | null, min: number, over: Partial<DocVersionNode> = {}) =>
  versionNode({ id, parentId, createdAt: at(min), kind: parentId ? 'expand' : 'initial', topic: id, ...over });

/**
 * v0 ─ a ─ b ─ c       (main lane: oldest children)
 *      └ x ─ y         (x: a later child of a, its own branch)
 *        └ z           (z: a later child of x)
 */
const nodes = [
  n('v0', null, 0),
  n('a', 'v0', 1),
  n('b', 'a', 2),
  n('x', 'a', 3),
  n('c', 'b', 4),
  n('y', 'x', 5),
  n('z', 'x', 6),
];
const ids = (rows: Row[]) => rows.map((r) => r.node.id);

describe('layoutVersionTree (11 §5.7)', () => {
  it('runs the oldest-child lane top to bottom and nests later children as branches', () => {
    const rows = layoutVersionTree({ nodes, currentId: 'c' });
    expect(ids(rows)).toEqual(['v0', 'a', 'x', 'z', 'y', 'b', 'c']);
    const by = Object.fromEntries(rows.map((r) => [r.node.id, r]));
    expect(by.v0).toMatchObject({ level: 1, groupId: null, setsize: 4, posinset: 1, branchStart: false });
    expect(by.a).toMatchObject({ level: 1, hasChildren: true, expanded: true, forced: false, posinset: 2 });
    expect(by.x).toMatchObject({ level: 2, groupId: 'a', branchStart: true, hasChildren: true, setsize: 2 });
    expect(by.z).toMatchObject({ level: 3, groupId: 'x', branchStart: true, laneEnd: true });
    expect(by.c).toMatchObject({ level: 1, posinset: 4, laneEnd: true, isCurrent: true });
    expect(rows.filter((r) => r.onCurrentPath).map((r) => r.node.id)).toEqual(['v0', 'a', 'b', 'c']);
    expect(rows.filter((r) => r.hasChildren).map((r) => r.node.id)).toEqual(['a', 'x']);
  });

  it('sorts children by createdAt, whatever order the nodes come in', () => {
    const rows = layoutVersionTree({ nodes: [...nodes].reverse(), currentId: 'v0' });
    expect(ids(rows)).toEqual(['v0', 'a', 'x', 'z', 'y', 'b', 'c']);
  });

  it('hides collapsed branches, but never the branch that holds the current version', () => {
    const collapsed = new Set(['a', 'x']);
    expect(ids(layoutVersionTree({ nodes, currentId: 'c' }, collapsed))).toEqual(['v0', 'a', 'b', 'c']);
    const rows = layoutVersionTree({ nodes, currentId: 'z' }, collapsed);
    expect(ids(rows)).toEqual(['v0', 'a', 'x', 'z', 'y', 'b', 'c']);
    expect(rows.find((r) => r.node.id === 'a')).toMatchObject({ forced: true, expanded: true });
    expect(rows.find((r) => r.node.id === 'x')).toMatchObject({ forced: true, expanded: true });
  });

  it('marks the redo target and lists every node once, even with orphans', () => {
    const orphan = n('o', 'missing', 9);
    const rows = layoutVersionTree({ nodes: [...nodes, orphan], currentId: 'a', redoId: 'b' });
    expect(rows.find((r) => r.isRedo)?.node.id).toBe('b');
    expect(new Set(ids(rows)).size).toBe(rows.length);
    // A node whose parent is gone becomes a later top-level lane.
    expect(rows.at(-1)).toMatchObject({ node: { id: 'o' }, level: 1, branchStart: true });
  });

  it('returns no rows for an empty tree and has a verb for every change kind', () => {
    expect(layoutVersionTree({ nodes: [], currentId: '' })).toEqual([]);
    for (const k of ['expand', 'ask', 'merge', 'outside', 'initial', 'close-tab', 'eli5-selection']) {
      expect(VERSION_VERBS[k]).toBeTruthy();
    }
    expect(VERSION_VERBS.ask).toBe('Asked');
    expect(VERSION_VERBS.outside).toBe('Changed outside the app');
  });

  it('a damaged tree with a parent cycle still shows every version exactly once', () => {
    const rows = layoutVersionTree({
      nodes: [n('v0', null, 0), n('p', 'q', 1), n('q', 'p', 2), n('r', 'q', 3)],
      currentId: 'v0',
    });
    expect(ids(rows).sort()).toEqual(['p', 'q', 'r', 'v0']);
    expect(rows.filter((r) => r.level === 1).map((r) => r.node.id)).toEqual(['v0', 'p', 'q', 'r']);
  });
});
