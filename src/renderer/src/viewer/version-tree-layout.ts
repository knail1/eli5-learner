import type { DocVersionNode, DocVersionTree } from '../../../preload/contract';

/**
 * Pure layout of a document's version tree for the Versions panel (11 §5.7).
 *
 * A *lane* is a chain that follows each version's oldest child. Rows run chronologically down a
 * lane, starting with the original. Every later child of a version starts a branch: its own lane,
 * indented one level in the branch point's nested `role="group"`, after the branch point's row.
 * Collapsed branch points hide their branches, except a branch that holds the current version.
 */

export interface VersionRow {
  node: DocVersionNode;
  /** aria-level, 1-based. */
  level: number;
  /** The branch point whose group holds this row; null for the top level. */
  groupId: string | null;
  isCurrent: boolean;
  /** On the path from the original to the current version (the solid rail). */
  onCurrentPath: boolean;
  /** The version Forward / Redo would open. */
  isRedo: boolean;
  /** A branch point: it owns a group of branches (and so carries aria-expanded). */
  hasChildren: boolean;
  expanded: boolean;
  /** Expanded because it holds the current version; it cannot collapse. */
  forced: boolean;
  /** The first row of a branch lane (or of a later root). */
  branchStart: boolean;
  /** The last row of its lane. */
  laneEnd: boolean;
  setsize: number;
  posinset: number;
}

const byCreated = (a: DocVersionNode, b: DocVersionNode) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1;

export function layoutVersionTree(
  tree: Pick<DocVersionTree, 'nodes' | 'currentId' | 'redoId'>,
  collapsed: ReadonlySet<string> = new Set(),
): VersionRow[] {
  const ids = new Set(tree.nodes.map((n) => n.id));
  const kids = new Map<string, DocVersionNode[]>();
  const roots: DocVersionNode[] = [];
  for (const n of tree.nodes) {
    if (n.parentId !== null && ids.has(n.parentId) && n.parentId !== n.id) {
      const list = kids.get(n.parentId) ?? [];
      list.push(n);
      kids.set(n.parentId, list);
    } else {
      roots.push(n);
    }
  }
  for (const list of kids.values()) list.sort(byCreated);
  // A parent cycle (a damaged tree) reaches no root: its oldest node becomes a root, so every
  // version still shows exactly once.
  const reached = new Set<string>();
  const reach = (n: DocVersionNode) => {
    const stack = [n];
    while (stack.length) {
      const c = stack.pop()!;
      if (reached.has(c.id)) continue;
      reached.add(c.id);
      stack.push(...(kids.get(c.id) ?? []));
    }
  };
  roots.forEach(reach);
  for (const n of [...tree.nodes].sort(byCreated)) {
    if (reached.has(n.id)) continue;
    const siblings = kids.get(n.parentId!);
    siblings?.splice(siblings.indexOf(n), 1);
    roots.push(n);
    reach(n);
  }
  roots.sort(byCreated);

  // The path from the original to the current version.
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const path = new Set<string>();
  for (let n = byId.get(tree.currentId); n && !path.has(n.id); n = n.parentId ? byId.get(n.parentId) : undefined) {
    path.add(n.id);
  }

  const rows: VersionRow[] = [];
  const seen = new Set<string>();

  /** The chain from `start` along oldest children. */
  const laneOf = (start: DocVersionNode): DocVersionNode[] => {
    const lane: DocVersionNode[] = [];
    for (let n: DocVersionNode | undefined = start; n && !seen.has(n.id); n = kids.get(n.id)?.[0]) {
      seen.add(n.id);
      lane.push(n);
    }
    return lane;
  };

  /** Emits the lanes of one group (top level or a branch point's branches). */
  const emitGroup = (starts: DocVersionNode[], level: number, groupId: string | null) => {
    const lanes = starts.map(laneOf).filter((l) => l.length > 0);
    const setsize = lanes.reduce((s, l) => s + l.length, 0);
    let pos = 0;
    lanes.forEach((lane, li) => {
      lane.forEach((node, i) => {
        const branches = (kids.get(node.id) ?? []).slice(1).filter((b) => !seen.has(b.id));
        const hasChildren = branches.length > 0;
        const forced = hasChildren && branches.some((b) => path.has(b.id));
        const expanded = hasChildren && (forced || !collapsed.has(node.id));
        rows.push({
          node,
          level,
          groupId,
          isCurrent: node.id === tree.currentId,
          onCurrentPath: path.has(node.id),
          isRedo: node.id === tree.redoId,
          hasChildren,
          expanded,
          forced,
          branchStart: i === 0 && (groupId !== null || li > 0),
          laneEnd: i === lane.length - 1,
          setsize,
          posinset: ++pos,
        });
        if (expanded) emitGroup(branches, level + 1, node.id);
        else for (const b of branches) markSeen(b);
      });
    });
  };

  /** Hidden subtrees still count as laid out, so a node is never shown twice. */
  const markSeen = (n: DocVersionNode) => {
    const stack = [n];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      stack.push(...(kids.get(c.id) ?? []));
    }
  };

  emitGroup(roots, 1, null);
  return rows;
}

/** Display verbs for each kind of change (11 §5.7). */
export const VERSION_VERBS: Record<DocVersionNode['kind'], string> = {
  expand: 'Expanded',
  reexplain: 'Re-explained',
  analogy: 'Analogy added',
  deeper: 'Went deeper',
  revise: 'Edited with note',
  ask: 'Asked',
  'eli5-tab': 'ELI5 tab',
  'eli5-selection': 'ELI5 of a selection',
  'close-tab': 'Closed tab',
  merge: 'Merged',
  outside: 'Changed outside the app',
  initial: 'Original',
};

/** Provisional row text while a section job runs, e.g. "Answering…". */
export const PENDING_VERBS: Record<string, string> = {
  expand: 'Expanding…',
  reexplain: 'Re-explaining…',
  analogy: 'Adding an analogy…',
  deeper: 'Going deeper…',
  revise: 'Editing…',
  ask: 'Answering…',
  'eli5-tab': 'Making an ELI5 tab…',
  'eli5-selection': 'Explaining the selection…',
};
