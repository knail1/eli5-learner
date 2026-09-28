import { describe, expect, it } from 'vitest';
import type {
  CatalogEntry,
  LibraryFolder,
  LibraryMoveReceipt,
  LibraryOrganization,
  TrashItem,
} from '../../../src/preload/contract';
import { loadRenderer } from './harness';

/** Pure sidebar logic (11 §5.2): grouping and filter, swipe thresholds, messages, ⌘Z precedence. */

type Groups = {
  unfiled: CatalogEntry[];
  folders: { folder: LibraryFolder; entries: CatalogEntry[]; open: boolean }[];
  archive: { entries: CatalogEntry[]; open: boolean; shown: boolean };
  matches: number;
};
type Outcome = { kind: 'commit' | 'reveal'; side: 'archive' | 'trash' } | { kind: 'close' };
type Key = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

const { groupLibrary, moveMessage, trashDetail } = await loadRenderer<{
  groupLibrary(e: CatalogEntry[], o: LibraryOrganization, q: string, expanded: ReadonlySet<string>): Groups;
  moveMessage(r: LibraryMoveReceipt, o: LibraryOrganization): string;
  trashDetail(t: TrashItem, now: number): string;
}>('library/organize.ts');
const { SWIPE, swipeOutcome, classifyDrag, wheelStep, restingOffset, commitDistance } = await loadRenderer<{
  SWIPE: { actionWidth: number; revealMin: number; startSlop: number };
  swipeOutcome(offset: number, width: number): Outcome;
  classifyDrag(dx: number, dy: number): 'swipe' | 'drag' | null;
  wheelStep(offset: number, d: { deltaX: number; deltaY: number }, width: number, tracking: boolean): number | null;
  restingOffset(o: Outcome, width: number): number;
  commitDistance(width: number): number;
}>('library/swipe.ts');
const { matchLibraryKey, libraryUndoWins } = await loadRenderer<{
  matchLibraryKey(e: Key): 'trash' | null;
  libraryUndoWins(s: { toastPending: boolean; focusInSidebar: boolean; hasLastMove: boolean }): boolean;
}>('a11y/shortcuts.ts');
const { resolveRoute } = await loadRenderer<{
  resolveRoute(r: unknown, c: CatalogEntry[] | null): unknown;
}>('routes.ts');

const doc = (title: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\s+/g, '-'),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  summary: `About ${title}`,
  summarySource: 'llm',
  tabCount: 2,
  mergedFromCount: 0,
  ...over,
});
const F1: LibraryFolder = { id: 'f-0000000a', name: 'Budgets', createdAt: '2026-01-01T00:00:00.000Z' };
const F2: LibraryFolder = { id: 'f-0000000b', name: 'Supply', createdAt: '2026-01-01T00:00:00.000Z' };
const org = (over: Partial<LibraryOrganization> = {}): LibraryOrganization => ({
  folders: [F1, F2],
  placement: { 'id-Widget pricing': F1.id, 'id-Old plan': 'archive', 'id-Stock levels': F2.id },
  trash: [],
  trashRetentionDays: 30,
  ...over,
});
const entries = [doc('Widget pricing'), doc('Office plants'), doc('Old plan'), doc('Stock levels')];

describe('groupLibrary (11 §5.2)', () => {
  it('puts unfiled documents first, then folders (closed unless expanded), then the Archive', () => {
    const g = groupLibrary(entries, org(), '', new Set([F2.id]));
    expect(g.unfiled.map((e) => e.title)).toEqual(['Office plants']);
    expect(g.folders.map((f) => [f.folder.name, f.entries.map((e) => e.title), f.open])).toEqual([
      ['Budgets', ['Widget pricing'], false],
      ['Supply', ['Stock levels'], true],
    ]);
    expect(g.archive).toMatchObject({ shown: true, open: false });
    expect(g.archive.entries.map((e) => e.title)).toEqual(['Old plan']);
    expect(g.matches).toBe(4);
  });

  it('a placement to a folder that no longer exists reads as unfiled', () => {
    const g = groupLibrary(entries, org({ folders: [F2] }), '', new Set());
    expect(g.unfiled.map((e) => e.title)).toEqual(['Widget pricing', 'Office plants']);
  });

  it('the filter searches inside folders and the Archive, opening those that match', () => {
    const g = groupLibrary(entries, org(), 'pricing', new Set());
    expect(g.unfiled).toEqual([]);
    expect(g.folders.map((f) => [f.folder.name, f.entries.map((e) => e.title), f.open])).toEqual([
      ['Budgets', ['Widget pricing'], true],
    ]);
    expect(g.archive.shown).toBe(false);
    expect(g.matches).toBe(1);
    const a = groupLibrary(entries, org(), 'old', new Set());
    expect(a.archive).toMatchObject({ shown: true, open: true });
  });

  it('a folder whose name matches shows all of its documents', () => {
    const g = groupLibrary(entries, org(), 'supp', new Set());
    expect(g.folders.map((f) => [f.folder.name, f.entries.length, f.open])).toEqual([['Supply', 1, true]]);
  });

  it('empty folders still show when not filtering', () => {
    const g = groupLibrary([], org(), '', new Set());
    expect(g.folders.map((f) => f.folder.name)).toEqual(['Budgets', 'Supply']);
    expect(g.matches).toBe(0);
  });
});

describe('messages (11 §5.2)', () => {
  const r = (over: Partial<LibraryMoveReceipt>): LibraryMoveReceipt => ({
    slug: 'x',
    docId: 'id-x',
    title: 'X',
    from: 'unfiled',
    to: 'archive',
    ...over,
  });
  it('names where a document went, for the Undo toast', () => {
    expect(moveMessage(r({ to: 'archive' }), org())).toBe('Moved to Archive');
    expect(moveMessage(r({ to: 'trash', trashId: 'x--20260101T000000' }), org())).toBe('Moved to Trash');
    expect(moveMessage(r({ to: F1.id }), org())).toBe('Moved to “Budgets”');
    expect(moveMessage(r({ from: F2.id, to: 'unfiled' }), org())).toBe('Removed from “Supply”');
    expect(moveMessage(r({ from: 'archive', to: 'unfiled' }), org())).toBe('Removed from Archive');
  });

  it('describes a Trash item: when, and where from or what it was merged into', () => {
    const now = Date.parse('2026-01-04T00:00:00.000Z');
    const t: TrashItem = {
      trashId: 'x--20260101T000000',
      docId: 'id-x',
      title: 'X',
      topicSlug: 'x',
      summary: '',
      trashedAt: '2026-01-01T00:00:00.000Z',
      reason: 'trashed',
      from: F1.id,
      fromName: 'Budgets',
    };
    expect(trashDetail(t, now)).toBe('Deleted 3d ago · from “Budgets”');
    expect(trashDetail({ ...t, from: 'unfiled', fromName: undefined }, now)).toBe('Deleted 3d ago');
    expect(trashDetail({ ...t, from: 'archive', fromName: undefined }, now)).toBe('Deleted 3d ago · from Archive');
    expect(trashDetail({ ...t, reason: 'merged', mergedInto: 'Widget plan' }, now)).toBe(
      'Merged into “Widget plan” 3d ago',
    );
  });
});

describe('swipe thresholds (11 §5.2)', () => {
  const W = 260;
  it('a long swipe commits: left archives, right trashes', () => {
    expect(swipeOutcome(-commitDistance(W), W)).toEqual({ kind: 'commit', side: 'archive' });
    expect(swipeOutcome(commitDistance(W) + 1, W)).toEqual({ kind: 'commit', side: 'trash' });
    expect(commitDistance(W)).toBe(130);
    expect(commitDistance(100)).toBe(120);
  });

  it('a short swipe leaves the action button showing; a tiny one closes', () => {
    expect(swipeOutcome(-(SWIPE.revealMin + 1), W)).toEqual({ kind: 'reveal', side: 'archive' });
    expect(swipeOutcome(SWIPE.revealMin + 1, W)).toEqual({ kind: 'reveal', side: 'trash' });
    expect(swipeOutcome(SWIPE.revealMin - 1, W)).toEqual({ kind: 'close' });
    expect(swipeOutcome(0, W)).toEqual({ kind: 'close' });
    expect(restingOffset({ kind: 'reveal', side: 'archive' }, W)).toBe(-SWIPE.actionWidth);
    expect(restingOffset({ kind: 'reveal', side: 'trash' }, W)).toBe(SWIPE.actionWidth);
    expect(restingOffset({ kind: 'close' }, W)).toBe(0);
    expect(restingOffset({ kind: 'commit', side: 'trash' }, W)).toBe(W);
  });

  it('a pointer drag is a swipe when mostly horizontal, a move-to-folder drag when vertical', () => {
    expect(classifyDrag(3, 2)).toBeNull();
    expect(classifyDrag(20, 4)).toBe('swipe');
    expect(classifyDrag(-20, 4)).toBe('swipe');
    expect(classifyDrag(6, 14)).toBe('drag');
    expect(classifyDrag(12, 12)).toBe('drag');
  });

  it('two-finger wheel: horizontal deltas move the row opposite to deltaX; vertical ones scroll', () => {
    expect(wheelStep(0, { deltaX: 10, deltaY: 1 }, W, false)).toBe(-10);
    expect(wheelStep(-10, { deltaX: -30, deltaY: 0 }, W, true)).toBe(20);
    expect(wheelStep(0, { deltaX: 2, deltaY: 12 }, W, false)).toBeNull();
    // Once tracking, a vertical wobble does not drop the gesture; the row never passes its width.
    expect(wheelStep(-10, { deltaX: 0, deltaY: 5 }, W, true)).toBe(-10);
    expect(wheelStep(-250, { deltaX: 90, deltaY: 0 }, W, true)).toBe(-W);
  });
});

describe('library keys (11 §9)', () => {
  const k = (over: Partial<Key>): Key => ({
    key: 'Backspace',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });
  it('Cmd+Backspace moves the focused row to the Trash', () => {
    expect(matchLibraryKey(k({}))).toBe('trash');
    expect(matchLibraryKey(k({ metaKey: false }))).toBeNull();
    expect(matchLibraryKey(k({ shiftKey: true }))).toBeNull();
    expect(matchLibraryKey(k({ key: 'z' }))).toBeNull();
  });

  it('Cmd+Z: a pending Undo toast wins, then focus in the sidebar with a move to undo, else the document', () => {
    expect(libraryUndoWins({ toastPending: true, focusInSidebar: false, hasLastMove: true })).toBe(true);
    expect(libraryUndoWins({ toastPending: false, focusInSidebar: true, hasLastMove: true })).toBe(true);
    expect(libraryUndoWins({ toastPending: false, focusInSidebar: true, hasLastMove: false })).toBe(false);
    expect(libraryUndoWins({ toastPending: false, focusInSidebar: false, hasLastMove: true })).toBe(false);
  });
});

describe('routes', () => {
  it('the Trash route resolves to itself', () => {
    expect(resolveRoute({ view: 'trash' }, [])).toEqual({ view: 'trash' });
  });
});
