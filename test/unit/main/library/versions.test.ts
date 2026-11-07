import { promises as fsp } from 'node:fs';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LibraryError,
  PREV_DIR,
  VERSIONS_DIR,
  childrenOf,
  historyFromTree,
  pathToRoot,
  planPrune,
  redoChild,
  resolveCurrent,
  scrollTargetFor,
  toWire,
  type DocumentMeta,
  type DocumentPatch,
  type FsLibrary,
  type SectionId,
  type VersionNodeRecord,
  type VersionTreeFile,
} from '../../../../src/main/library';
import { readBlob, sha256Hex, versionPaths, writeBlob } from '../../../../src/main/library/versions';
import type * as FsAtomic from '../../../../src/main/library/fs-atomic';
import { HTML, createDoc, testLibrary } from './fixtures';

/**
 * Fault injection: writeFileAtomic / writeJsonAtomic fail for targets matching `failOn` (13 §3).
 * Both are replaced, since writeJsonAtomic calls writeFileAtomic inside its own module.
 */
let failOn: ((target: string) => boolean) | undefined;
vi.mock('../../../../src/main/library/fs-atomic', async (orig) => {
  const real = await orig<typeof FsAtomic>();
  const guard = (target: string) => {
    if (failOn?.(target)) {
      throw new LibraryError('WRITE_FAILED', { path: path.basename(target), errno: 'EIO' });
    }
  };
  return {
    ...real,
    writeFileAtomic: async (target: string, data: string | Uint8Array, hooks?: object) => {
      guard(target);
      return real.writeFileAtomic(target, data, hooks);
    },
    writeJsonAtomic: async (target: string, value: unknown, hooks?: object) => {
      guard(target);
      return real.writeJsonAtomic(target, value, hooks);
    },
  };
});

afterEach(() => {
  failOn = undefined;
  vi.restoreAllMocks();
});

/** The version tree (09 §4.1): pure functions, the store, checkout, recovery and legacy seeding. */

const SLUG = 'widget-pricing';
const SEC = 'sec-indepth-0a1b2c3d' as SectionId;
const vid = (k: number) => `v-${k.toString(16).padStart(12, '0')}`;
const shaOf = (c: string) => c.repeat(64);
const TS0 = Date.parse('2026-03-01T00:00:00.000Z');
const at = (min: number) => new Date(TS0 + min * 60_000).toISOString();

function node(k: number, parent: number | null, over: Partial<VersionNodeRecord> = {}): VersionNodeRecord {
  return {
    id: vid(k),
    parentId: parent === null ? null : vid(parent),
    createdAt: at(k),
    kind: k === 0 ? 'initial' : 'expand',
    label: `change ${String(k)}`,
    topic: `Topic ${String(k)}`,
    sha256: shaOf((k % 16).toString(16)),
    bytes: 100,
    ...over,
  };
}

function treeOf(nodes: VersionNodeRecord[], current: number): VersionTreeFile {
  return { schemaVersion: 1, rootId: nodes[0]?.id ?? vid(0), currentId: vid(current), nodes };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function expectCode(p: Promise<unknown>, code: string): Promise<LibraryError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LibraryError);
  expect((err as LibraryError).code).toBe(code);
  return err as LibraryError;
}

function write(lib: FsLibrary, html: string, label?: string, more: Partial<DocumentPatch> = {}) {
  return lib.withDocLock(SLUG, () =>
    lib.updateDocument(SLUG, { html, meta: (m) => m, ...(label ? { label } : {}), ...more }),
  );
}

const live = (lib: FsLibrary) => readFile(lib.docPath(SLUG), 'utf8');
const vdir = (lib: FsLibrary) => path.join(lib.root, SLUG, VERSIONS_DIR);
const readTreeFile = async (lib: FsLibrary) =>
  JSON.parse(await readFile(path.join(vdir(lib), 'tree.json'), 'utf8')) as VersionTreeFile;

/** Every file under `dir` with its size and mtime, for "nothing was written" checks. */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await stat(p);
        out[path.relative(dir, p)] = `${String(st.size)}:${String(st.mtimeMs)}`;
      }
    }
  };
  await walk(dir);
  return out;
}

describe('pure tree functions', () => {
  it('childrenOf sorts by createdAt; pathToRoot walks up to the root', () => {
    const t = treeOf([node(0, null), node(2, 0), node(1, 0), node(3, 1)], 3);
    expect(childrenOf(t, vid(0)).map((n) => n.id)).toEqual([vid(1), vid(2)]);
    expect(pathToRoot(t, vid(3)).map((n) => n.id)).toEqual([vid(3), vid(1), vid(0)]);
    expect(pathToRoot(t, vid(9))).toEqual([]);
  });

  it('redoChild prefers forwardId, else the newest available child', () => {
    const t = treeOf([node(0, null, { forwardId: vid(1) }), node(1, 0), node(2, 0)], 0);
    expect(redoChild(t, vid(0))?.id).toBe(vid(1));
    t.nodes[1]!.sha256 = null;
    expect(redoChild(t, vid(0))?.id).toBe(vid(2));
    t.nodes[2]!.sha256 = null;
    expect(redoChild(t, vid(0))).toBeUndefined();
    expect(redoChild(t, vid(2))).toBeUndefined();
  });

  it('resolveCurrent: versionId plus sha, else detached at the last known node', () => {
    const t = treeOf([node(0, null), node(1, 0)], 0);
    expect(resolveCurrent(t, vid(1), shaOf('1'))).toEqual({ currentId: vid(1), detached: false });
    expect(resolveCurrent(t, vid(1), shaOf('f'))).toEqual({ currentId: vid(0), detached: true });
    expect(resolveCurrent(t, undefined, shaOf('1'))).toEqual({ currentId: vid(0), detached: true });
    expect(resolveCurrent(t, vid(7), shaOf('1'))).toEqual({ currentId: vid(0), detached: true });
  });

  it('historyFromTree: Undo needs an available parent; Undo and Redo can both be on', () => {
    const t = treeOf([node(0, null), node(1, 0), node(2, 1)], 1);
    expect(historyFromTree(t)).toEqual({
      canUndo: true,
      canRedo: true,
      undoLabel: 'change 1',
      redoLabel: 'change 2',
    });
    expect(historyFromTree({ ...t, currentId: vid(0) })).toEqual({
      canUndo: false,
      canRedo: true,
      redoLabel: 'change 1',
    });
    t.nodes[0]!.sha256 = null;
    expect(historyFromTree(t)).toEqual({ canUndo: false, canRedo: true, redoLabel: 'change 2' });
    expect(historyFromTree({ ...t, currentId: vid(9) })).toEqual({ canUndo: false, canRedo: false });
  });

  it('scrollTargetFor: back to an ancestor lands on the undone change, else on the target change', () => {
    const t = treeOf(
      [
        node(0, null),
        node(1, 0, {
          target: { tabKey: 'indepth', sectionId: SEC },
          undoTarget: { tabKey: 'indepth', sectionId: SEC },
        }),
        node(2, 1, { target: { tabKey: 'sx0a0b0c' }, undoTarget: { tabKey: 'eli5' } }),
        node(3, 0, { target: { tabKey: 'indepth', anchorId: 'q-0a0b0c0d' } }),
      ],
      2,
    );
    // Undo from 2 to 1: where change 2 came from.
    expect(scrollTargetFor(t, vid(2), vid(1))).toEqual({ tabKey: 'eli5' });
    // Two steps back to the root: the first change below the root on the way.
    expect(scrollTargetFor(t, vid(2), vid(0))).toEqual({ tabKey: 'indepth', sectionId: SEC });
    // Forward and sideways: the target's own change.
    expect(scrollTargetFor(t, vid(1), vid(2))).toEqual({ tabKey: 'sx0a0b0c' });
    expect(scrollTargetFor(t, vid(2), vid(3))).toEqual({ tabKey: 'indepth', anchorId: 'q-0a0b0c0d' });
    // The root has no change of its own.
    expect(scrollTargetFor(t, vid(0), vid(0))).toEqual({});
    expect(scrollTargetFor(t, vid(2), vid(9))).toEqual({});
  });

  it('planPrune keeps the root, the current path and the redo child; stubs the oldest others', () => {
    // 0 - 1 - 2 - 3(current) - 4(redo); side branches 5, 6 under 1.
    const t = treeOf(
      [
        node(0, null),
        node(1, 0),
        node(2, 1),
        node(3, 2),
        node(4, 3),
        node(5, 1, { sha256: shaOf('a') }),
        node(6, 1, { sha256: shaOf('b') }),
      ],
      3,
    );
    const p = planPrune(t, { maxSnapshots: 5 });
    expect(p.stubbed).toEqual([vid(5), vid(6)]);
    expect(p.removed).toEqual([]);
    expect(p.unreferencedBlobs.sort()).toEqual([shaOf('a'), shaOf('b')]);
    expect(p.tree.nodes.find((n) => n.id === vid(5))).toMatchObject({ sha256: null, bytes: 0 });
    // Pure: the input is untouched.
    expect(t.nodes[5]?.sha256).toBe(shaOf('a'));
    // Protected nodes are never stubbed, even past the cap.
    const all = planPrune(t, { maxSnapshots: 1 });
    expect(all.stubbed).toEqual([vid(5), vid(6)]);
  });

  it('planPrune counts bytes per distinct blob and stops once under the byte cap', () => {
    const t = treeOf(
      [
        node(0, null),
        node(1, 0, { sha256: shaOf('a'), bytes: 500 }),
        node(2, 0, { sha256: shaOf('a'), bytes: 500 }),
        node(3, 0, { sha256: shaOf('b'), bytes: 400 }),
        node(4, 0, { sha256: shaOf('c'), bytes: 10 }),
      ],
      4,
    );
    // 100 + 500 + 400 + 10 = 1010 bytes. Stubbing 1 frees nothing (2 shares its blob), then 2 frees 500.
    const p = planPrune(t, { maxBytes: 600 });
    expect(p.stubbed).toEqual([vid(1), vid(2)]);
    expect(p.unreferencedBlobs).toEqual([shaOf('a')]);
  });

  it('planPrune removes stub leaves, oldest first, while over the node cap', () => {
    const t = treeOf(
      [
        node(0, null),
        node(1, 0, { sha256: null }),
        node(2, 1, { sha256: null }),
        node(3, 0, { sha256: null }),
        node(4, 0, { forwardId: undefined }),
      ],
      4,
    );
    t.nodes[0]!.forwardId = vid(1);
    const p = planPrune(t, { maxNodes: 3 });
    // 2 and 3 start as stub leaves; 1 becomes one once 2 goes, and is older than 3.
    expect(p.removed).toEqual([vid(2), vid(1)]);
    expect(p.tree.nodes.map((n) => n.id)).toEqual([vid(0), vid(3), vid(4)]);
    expect(p.tree.nodes[0]?.forwardId).toBeUndefined();
    // Available nodes are never removed, whatever the cap.
    expect(planPrune(t, { maxNodes: 1 }).tree.nodes.map((n) => n.id)).toEqual([vid(0), vid(4)]);
  });

  it('toWire marks availability, the published node, the redo node and degraded', () => {
    const t = treeOf([node(0, null), node(1, 0, { question: 'Why?' }), node(2, 0, { sha256: null })], 0);
    const w = toWire(
      { slug: SLUG, tree: t, detached: false, readOnly: false, degraded: true, publishedSha: shaOf('1') },
      { busy: true, pending: [{ sectionId: SEC, action: 'ask', heading: 'Pricing' }] },
    );
    expect(w).toMatchObject({ slug: SLUG, currentId: vid(0), redoId: vid(1), busy: true, degraded: true });
    expect(w.nodes.map((n) => [n.id, n.available, n.published])).toEqual([
      [vid(0), true, false],
      [vid(1), true, true],
      [vid(2), false, false],
    ]);
    expect(w.nodes[1]?.question).toBe('Why?');
    expect(w.pending).toHaveLength(1);
  });
});

describe('blobs', () => {
  it('round-trips exact bytes, dedupes by sha and detects a corrupt blob', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const vp = versionPaths(path.join(lib.root, SLUG));
    const a = await writeBlob(vp, '<p>héllo</p>');
    expect(a.sha256).toBe(sha256Hex('<p>héllo</p>'));
    const file = path.join(vp.blobs, `${a.sha256}.html.gz`);
    expect(gunzipSync(await readFile(file)).toString('utf8')).toBe('<p>héllo</p>');
    // Header mtime is 0, so identical content always compresses to identical bytes.
    expect((await readFile(file)).readUInt32LE(4)).toBe(0);
    const mtime = (await stat(file)).mtimeMs;
    expect(await writeBlob(vp, '<p>héllo</p>')).toEqual(a);
    expect((await stat(file)).mtimeMs).toBe(mtime);
    expect((await readBlob(vp, a.sha256)).toString('utf8')).toBe('<p>héllo</p>');
    await writeFile(file, (await import('node:zlib')).gzipSync('<p>other</p>'));
    await expectCode(readBlob(vp, a.sha256), 'VERSION_CORRUPT');
    await writeFile(file, 'not gzip');
    await expectCode(readBlob(vp, a.sha256), 'VERSION_CORRUPT');
    await expectCode(readBlob(vp, shaOf('e')), 'VERSION_CORRUPT');
  });
});

describe('writes make versions (09 §4.1)', () => {
  it('the first html write seeds the original as the root (lazily) and adds a node under it', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    expect(await exists(vdir(lib))).toBe(false);
    const view0 = await lib.versions(SLUG);
    expect(view0.tree.nodes).toHaveLength(1);
    expect(view0.tree.rootId).toBe(`v-${sha256Hex(HTML).slice(0, 12)}`);
    await write(lib, '<p>v2</p>', "expanded 'Pricing'", {
      change: {
        kind: 'expand',
        topic: 'Pricing',
        heading: 'Pricing',
        target: { tabKey: 'indepth', sectionId: SEC },
        undoTarget: { tabKey: 'indepth', sectionId: SEC },
        jobId: 'job-9',
      },
    });
    const t = await readTreeFile(lib);
    expect(t.rootId).toBe(view0.tree.rootId);
    expect(t.nodes).toHaveLength(2);
    const [root, child] = t.nodes;
    expect(root).toMatchObject({ kind: 'initial', label: 'Original', parentId: null, forwardId: child?.id });
    expect(child).toMatchObject({
      parentId: root?.id,
      kind: 'expand',
      label: "expanded 'Pricing'",
      topic: 'Pricing',
      heading: 'Pricing',
      target: { tabKey: 'indepth', sectionId: SEC },
      jobId: 'job-9',
      sha256: sha256Hex('<p>v2</p>'),
    });
    expect(t.currentId).toBe(child?.id);
    const meta = await lib.getMeta(SLUG);
    expect(meta.versionId).toBe(child?.id);
    // The node file holds the meta snapshot with its own versionId.
    const nf = JSON.parse(await readFile(path.join(vdir(lib), 'nodes', `${child?.id ?? ''}.json`), 'utf8')) as {
      meta: DocumentMeta;
    };
    expect(nf.meta).toEqual(meta);
  });

  it('the parent is the current node at commit time, and a write without change is an outside change', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    await lib.undo(SLUG);
    await write(lib, '<p>v3</p>', 'second');
    const t = await readTreeFile(lib);
    const second = t.nodes.find((n) => n.label === 'second');
    expect(second?.parentId).toBe(t.rootId);
    expect(second).toMatchObject({ kind: 'outside', topic: 'second' });
  });

  it('touch and appendPublication create no node', async () => {
    const { lib, clock } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    const before = await readFile(path.join(vdir(lib), 'tree.json'), 'utf8');
    await lib.withDocLock(SLUG, () => lib.touch(SLUG));
    await lib.withDocLock(SLUG, () =>
      lib.appendPublication(SLUG, {
        targetId: 'local',
        kind: 'local',
        publishedAt: clock.now().toISOString(),
        primaryUrl: 'file:///tmp/x/index.html',
        contentSha256: sha256Hex('<p>v2</p>'),
      }),
    );
    expect(await readFile(path.join(vdir(lib), 'tree.json'), 'utf8')).toBe(before);
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(false);
    expect(view.publishedSha).toBe(sha256Hex('<p>v2</p>'));
    expect(toWire(view, { busy: false, pending: [] }).nodes.filter((n) => n.published)).toHaveLength(1);
  });

  it('identical content is stored once', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'a');
    await lib.undo(SLUG);
    await write(lib, '<p>v2</p>', 'b');
    expect((await readTreeFile(lib)).nodes).toHaveLength(3);
    expect(await readdir(path.join(vdir(lib), 'blobs'))).toHaveLength(2);
  });

  it('Redo retraces the path an undo walked back', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>a</p>', 'a');
    await lib.undo(SLUG);
    await write(lib, '<p>b1</p>', 'b1');
    await write(lib, '<p>b2</p>', 'b2');
    // Back to the root over two steps; the newer branch b is what Redo follows, not a.
    await lib.undo(SLUG);
    await lib.undo(SLUG);
    expect(await lib.history(SLUG)).toMatchObject({ redoLabel: 'b1' });
    // Check out the old branch a directly, then go back: Redo now follows a.
    const t = (await lib.versions(SLUG)).tree;
    const a = t.nodes.find((n) => n.label === 'a')?.id ?? '';
    await lib.withDocLock(SLUG, () => lib.checkout(SLUG, a, { retiredIds: [] }));
    await lib.undo(SLUG);
    expect(await lib.history(SLUG)).toMatchObject({ redoLabel: 'a' });
    // From b2, two undos then two redos land back on b2.
    const b2 = t.nodes.find((n) => n.label === 'b2')?.id ?? '';
    await lib.withDocLock(SLUG, () => lib.checkout(SLUG, b2, { retiredIds: [] }));
    await lib.undo(SLUG);
    await lib.undo(SLUG);
    await lib.redo(SLUG);
    await lib.redo(SLUG);
    expect(await live(lib)).toBe('<p>b2</p>');
  });
});

describe('checkout (09 §4.1)', () => {
  async function seeded() {
    const t = await testLibrary({ processLock: false });
    await createDoc(t.lib, 'Widget Pricing');
    t.clock.advance(1000);
    await write(t.lib, '<p>v2</p>', 'retitled', {
      meta: (m) => ({ ...m, title: 'Revised', retiredIds: ['sec-indepth-11111111'] as never }),
    });
    const tree = (await t.lib.versions(t.lib.getEntry(SLUG)?.topicSlug ?? SLUG)).tree;
    return { ...t, rootId: tree.rootId, childId: tree.currentId };
  }

  it('pins id, topicSlug, createdAt and publications; applies retiredIds; upserts the catalog; emits changed', async () => {
    const { lib, clock, rootId, childId } = await seeded();
    const created = await lib.getMeta(SLUG);
    const pub = {
      targetId: 'local',
      kind: 'local' as const,
      publishedAt: clock.now().toISOString(),
      primaryUrl: 'file:///tmp/x/index.html',
      contentSha256: 'b'.repeat(64),
    };
    await lib.withDocLock(SLUG, () => lib.appendPublication(SLUG, pub));
    clock.advance(1000);
    const events: unknown[] = [];
    lib.on('changed', (e) => events.push(e));
    const retired = ['sec-indepth-22222222'] as never[];
    const r = await lib.withDocLock(SLUG, () => lib.checkout(SLUG, rootId, { retiredIds: retired }));
    expect(r.previousId).toBe(childId);
    expect(r.node.id).toBe(rootId);
    expect(r.tree.tree.currentId).toBe(rootId);
    expect(await live(lib)).toBe(HTML);
    const m = await lib.getMeta(SLUG);
    expect(m).toMatchObject({
      id: created.id,
      topicSlug: SLUG,
      createdAt: created.createdAt,
      publications: [pub],
      title: 'Widget Pricing',
      updatedAt: clock.now().toISOString(),
      versionId: rootId,
      retiredIds: retired,
    });
    expect(lib.getEntry(SLUG)).toMatchObject({ title: 'Widget Pricing', updatedAt: m.updatedAt });
    expect(events).toEqual([{ reason: 'updated', slugs: [SLUG] }]);
    expect((await readTreeFile(lib)).nodes.find((n) => n.id === rootId)?.forwardId).toBe(childId);
  });

  it('checking out the current node writes nothing', async () => {
    const { lib, childId } = await seeded();
    const before = await snapshotDir(path.join(lib.root, SLUG));
    const r = await lib.withDocLock(SLUG, () => lib.checkout(SLUG, childId, { retiredIds: [] }));
    expect(r.previousId).toBe(childId);
    expect(await snapshotDir(path.join(lib.root, SLUG))).toEqual(before);
  });

  it('an html override (runtime upgrade) becomes the node snapshot; the old blob is collected', async () => {
    const { lib, rootId } = await seeded();
    await lib.withDocLock(SLUG, () => lib.checkout(SLUG, rootId, { retiredIds: [], html: '<p>v1 upgraded</p>' }));
    expect(await live(lib)).toBe('<p>v1 upgraded</p>');
    const t = await readTreeFile(lib);
    expect(t.nodes.find((n) => n.id === rootId)?.sha256).toBe(sha256Hex('<p>v1 upgraded</p>'));
    expect((await lib.versions(SLUG)).detached).toBe(false);
    // The now unreferenced original blob is collected right away.
    expect(await readdir(path.join(vdir(lib), 'blobs'))).not.toContain(`${sha256Hex(HTML)}.html.gz`);
    await write(lib, '<p>v3</p>', 'next');
    // And the version still opens with the upgraded html.
    const v = await lib.readVersion(SLUG, rootId);
    expect(v.html.toString('utf8')).toBe('<p>v1 upgraded</p>');
  });

  it('refuses unknown, pruned and corrupt versions; a corrupt one becomes a stub', async () => {
    const { lib, rootId } = await seeded();
    await expectCode(
      lib.withDocLock(SLUG, () => lib.checkout(SLUG, vid(0xabc), { retiredIds: [] })),
      'VERSION_NOT_FOUND',
    );
    await writeFile(path.join(vdir(lib), 'blobs', `${sha256Hex(HTML)}.html.gz`), 'garbage');
    await expectCode(
      lib.withDocLock(SLUG, () => lib.checkout(SLUG, rootId, { retiredIds: [] })),
      'VERSION_CORRUPT',
    );
    expect(await live(lib)).toBe('<p>v2</p>');
    expect((await readTreeFile(lib)).nodes.find((n) => n.id === rootId)?.sha256).toBeNull();
    const err = await expectCode(
      lib.withDocLock(SLUG, () => lib.checkout(SLUG, rootId, { retiredIds: [] })),
      'VERSION_NOT_FOUND',
    );
    expect(err.detail).toMatchObject({ kind: 'pruned' });
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: false });
  });

  it('needs the doc lock (LOCK_NOT_HELD in dev) and takes no lock twice when held', async () => {
    const { lib, rootId } = await seeded();
    await expectCode(lib.checkout(SLUG, rootId, { retiredIds: [] }), 'LOCK_NOT_HELD');
    // Held by the caller: no LOCK_REENTRY.
    await lib.withDocLock(SLUG, async () => {
      await lib.checkout(SLUG, rootId, { retiredIds: [] });
      await lib.redo(SLUG);
    });
    expect(await live(lib)).toBe('<p>v2</p>');
  });

  it('is refused in read-only mode', async () => {
    const { lib, open, rootId } = await seeded();
    const ro = await open();
    ro.enterReadOnly('locked');
    await expectCode(
      ro.withDocLock(SLUG, () => ro.checkout(SLUG, rootId, { retiredIds: [] })),
      'LIBRARY_READ_ONLY',
    );
    await expectCode(
      ro.withDocLock(SLUG, () => ro.refreshRuntime(SLUG, '<p>x</p>')),
      'LIBRARY_READ_ONLY',
    );
    expect(await live(lib)).toBe('<p>v2</p>');
  });

  it('readVersion returns the exact html and meta snapshot without writing', async () => {
    const { lib, rootId, childId } = await seeded();
    const before = await snapshotDir(path.join(lib.root, SLUG));
    const r = await lib.readVersion(SLUG, rootId);
    expect(r.html.toString('utf8')).toBe(HTML);
    expect(r.meta.title).toBe('Widget Pricing');
    expect(r.node.id).toBe(rootId);
    expect((await lib.readVersion(SLUG, childId)).meta.title).toBe('Revised');
    await expectCode(lib.readVersion(SLUG, vid(0xabc)), 'VERSION_NOT_FOUND');
    expect(await snapshotDir(path.join(lib.root, SLUG))).toEqual(before);
  });
});

describe('refreshRuntime (07 §5.5)', () => {
  it('rewrites the live html for the current node, keeping its id and the meta', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    const meta = await readFile(lib.docPath(SLUG, 'meta.json'), 'utf8');
    const id = (await lib.getMeta(SLUG)).versionId;
    await lib.withDocLock(SLUG, () => lib.refreshRuntime(SLUG, '<p>v2 new runtime</p>'));
    expect(await live(lib)).toBe('<p>v2 new runtime</p>');
    expect(await readFile(lib.docPath(SLUG, 'meta.json'), 'utf8')).toBe(meta);
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(false);
    expect(view.tree.currentId).toBe(id);
    expect(view.tree.nodes).toHaveLength(2);
    expect(await readdir(path.join(vdir(lib), 'blobs'))).not.toContain(`${sha256Hex('<p>v2</p>')}.html.gz`);
    // Undo and back still work.
    await lib.undo(SLUG);
    await lib.redo(SLUG);
    expect(await live(lib)).toBe('<p>v2 new runtime</p>');
  });
});

describe('recovery and fault injection (09 §4.1)', () => {
  it('a failure before the commit leaves the live files and the tree unchanged', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    const tree = await readFile(path.join(vdir(lib), 'tree.json'), 'utf8');
    const meta = await readFile(lib.docPath(SLUG, 'meta.json'), 'utf8');
    failOn = (t) => path.basename(t) === 'index.html';
    await expectCode(write(lib, '<p>v3</p>', 'broken'), 'WRITE_FAILED');
    failOn = undefined;
    expect(await live(lib)).toBe('<p>v2</p>');
    expect(await readFile(lib.docPath(SLUG, 'meta.json'), 'utf8')).toBe(meta);
    expect(await readFile(path.join(vdir(lib), 'tree.json'), 'utf8')).toBe(tree);
    expect(await readdir(path.join(vdir(lib), 'nodes'))).toHaveLength(2);
  });

  it('a crash after the commit but before tree.json is adopted with its real label', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    failOn = (t) => path.basename(t) === 'tree.json';
    await write(lib, '<p>v3</p>', "analogy for 'Pricing'", { change: { kind: 'analogy', topic: 'Pricing' } });
    failOn = undefined;
    expect(await live(lib)).toBe('<p>v3</p>');
    expect((await readTreeFile(lib)).nodes).toHaveLength(2);
    // Reads adopt it in memory...
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(false);
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: "analogy for 'Pricing'" });
    // ...and the next write path persists it.
    await write(lib, '<p>v4</p>', 'next');
    const t = await readTreeFile(lib);
    expect(t.nodes.map((n) => n.label)).toEqual(['Original', 'first', "analogy for 'Pricing'", 'next']);
    expect(t.nodes[2]).toMatchObject({ kind: 'analogy', topic: 'Pricing' });
  });

  it('two missed index writes in a row are adopted as a chain with their real labels', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    failOn = (t) => path.basename(t) === 'tree.json';
    await write(lib, '<p>v3</p>', 'second');
    await write(lib, '<p>v4</p>', 'third');
    failOn = undefined;
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(false);
    expect(view.tree.nodes.map((n) => n.label)).toEqual(['Original', 'first', 'second', 'third']);
    await write(lib, '<p>v5</p>', 'fourth');
    expect((await readTreeFile(lib)).nodes.map((n) => n.label)).toEqual([
      'Original',
      'first',
      'second',
      'third',
      'fourth',
    ]);
    await lib.undo(SLUG);
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>v3</p>');
  });

  it('a runtime refresh whose tree.json write failed is still the same node, not an outside edit', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    const id = (await lib.getMeta(SLUG)).versionId;
    failOn = (t) => path.basename(t) === 'tree.json';
    await lib.withDocLock(SLUG, () => lib.refreshRuntime(SLUG, '<p>v2 new runtime</p>'));
    failOn = undefined;
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(false);
    expect(view.tree.currentId).toBe(id);
    expect(view.tree.nodes).toHaveLength(2);
    await write(lib, '<p>v3</p>', 'next');
    expect((await readTreeFile(lib)).nodes).toHaveLength(3);
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>v2 new runtime</p>');
  });

  it('a failed runtime refresh leaves the live file and the node snapshot as they were', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    failOn = (t) => path.basename(t) === 'index.html';
    await expectCode(
      lib.withDocLock(SLUG, () => lib.refreshRuntime(SLUG, '<p>v2 new runtime</p>')),
      'WRITE_FAILED',
    );
    failOn = undefined;
    expect(await live(lib)).toBe('<p>v2</p>');
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(false);
    const v = await lib.readVersion(SLUG, view.tree.currentId);
    expect(v.html.toString('utf8')).toBe('<p>v2</p>');
  });

  it('a checkout with an html override that fails to commit keeps the node on its old snapshot', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    const rootId = (await lib.versions(SLUG)).tree.rootId;
    failOn = (t) => path.basename(t) === 'index.html';
    await expectCode(
      lib.withDocLock(SLUG, () => lib.checkout(SLUG, rootId, { retiredIds: [], html: '<p>v1 upgraded</p>' })),
      'WRITE_FAILED',
    );
    failOn = undefined;
    expect(await live(lib)).toBe('<p>v2</p>');
    await lib.undo(SLUG);
    expect(await live(lib)).toBe(HTML);
  });

  it('a symlinked .versions folder is never written through; the edit still commits, degraded', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const outside = path.join(path.dirname(lib.root), `outside-${String(process.pid)}`);
    await mkdir(outside, { recursive: true });
    await fsp.symlink(outside, vdir(lib));
    await write(lib, '<p>v2</p>', 'first');
    expect(await live(lib)).toBe('<p>v2</p>');
    expect(await readdir(outside)).toEqual([]);
    expect((await lib.versions(SLUG)).degraded).toBe(true);
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it('a corrupt tree.json is set aside and rebuilt from the node files', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    await write(lib, '<p>v3</p>', 'second');
    await writeFile(path.join(vdir(lib), 'tree.json'), '{not json');
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'second' });
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>v2</p>');
    const names = await readdir(vdir(lib));
    expect(names.some((n) => n.startsWith('tree.json.corrupt-'))).toBe(true);
    expect((await readTreeFile(lib)).nodes.map((n) => n.label)).toEqual(['Original', 'first', 'second']);
  });

  it('a node file write failure still commits the edit and flags the history degraded', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    failOn = (t) => t.includes(`${path.sep}nodes${path.sep}`);
    await write(lib, '<p>v3</p>', 'unsaved');
    failOn = undefined;
    expect(await live(lib)).toBe('<p>v3</p>');
    expect((await lib.getMeta(SLUG)).versionId).toBeUndefined();
    const view = await lib.versions(SLUG);
    expect(view).toMatchObject({ degraded: true, detached: true });
    expect(toWire(view, { busy: false, pending: [] }).degraded).toBe(true);
    // The next write snapshots the unsaved content as an outside version and clears the flag.
    await write(lib, '<p>v4</p>', 'saved');
    const after = await lib.versions(SLUG);
    expect(after.degraded).toBe(false);
    expect(after.tree.nodes.map((n) => n.label)).toEqual(['Original', 'first', 'changed outside the app', 'saved']);
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>v3</p>');
  });

  it('a hand edit makes the document detached; the next write keeps it as an outside version', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    await writeFile(lib.docPath(SLUG), '<p>edited by hand</p>');
    const view = await lib.versions(SLUG);
    expect(view.detached).toBe(true);
    expect(view.tree.nodes.at(-1)).toMatchObject({ kind: 'outside', label: 'changed outside the app' });
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'changed outside the app' });
    const metaBefore = await lib.getMeta(SLUG);
    // Undo first saves the hand edit, then goes back to "first".
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>v2</p>');
    await lib.redo(SLUG);
    expect(await live(lib)).toBe('<p>edited by hand</p>');
    const t = await readTreeFile(lib);
    expect(t.nodes.map((n) => n.kind)).toEqual(['initial', 'outside', 'outside']);
    expect(t.nodes[2]?.label).toBe('changed outside the app');
    expect(metaBefore.versionId).toBe(t.nodes[1]?.id);
  });

  it('housekeeping removes stale temp files under .versions/; materialize sweeps orphans', async () => {
    const { lib, open, clock } = await testLibrary({ processLock: false });
    await createDoc(lib, 'Widget Pricing');
    await write(lib, '<p>v2</p>', 'first');
    const stale = path.join(vdir(lib), 'blobs', `x.html.gz.tmp-123-0badc0de`);
    const fresh = path.join(vdir(lib), 'nodes', `y.json.tmp-123-0badc0df`);
    await writeFile(stale, 'x');
    await writeFile(fresh, 'y');
    const old = new Date(clock.now().getTime() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await open();
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    // Orphans: a node file outside the tree and an unreferenced blob go on the next write path.
    const orphanNode = path.join(vdir(lib), 'nodes', `${vid(0xdead)}.json`);
    const orphanBlob = path.join(vdir(lib), 'blobs', `${shaOf('d')}.html.gz`);
    await writeFile(orphanNode, '{}');
    await writeFile(orphanBlob, 'x');
    await write(lib, '<p>v3</p>', 'next');
    for (const p of [orphanNode, orphanBlob, fresh]) expect(await exists(p)).toBe(false);
  });

  it('retention caps stub old side branches as writes add versions', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    // 62 side branches straight off the root: each write, then undo back to the root.
    for (let i = 0; i < 62; i++) {
      await write(lib, `<p>side ${String(i)}</p>`, `side ${String(i)}`);
      await lib.undo(SLUG);
    }
    const t = await readTreeFile(lib);
    expect(t.nodes).toHaveLength(63);
    expect(t.nodes.filter((n) => n.sha256 !== null).length).toBeLessThanOrEqual(60);
    expect(t.nodes.find((n) => n.label === 'side 0')?.sha256).toBeNull();
    expect((await readdir(path.join(vdir(lib), 'blobs'))).length).toBeLessThanOrEqual(60);
  }, 60_000);
});

describe('legacy .prev/ seeding (09 §4.1.1)', () => {
  async function withPrev(slot: 'undo' | 'redo' | 'unpaired') {
    const t = await testLibrary();
    await createDoc(t.lib, 'Widget Pricing');
    const dir = path.join(t.lib.root, SLUG);
    // An older build: live files plus a `.prev/` slot paired with the live meta.
    const metaFile = path.join(dir, 'meta.json');
    const liveMeta = JSON.parse(await readFile(metaFile, 'utf8')) as DocumentMeta;
    await writeFile(path.join(dir, 'index.html'), '<p>live</p>');
    const prev = path.join(dir, PREV_DIR);
    await mkdir(prev);
    await writeFile(path.join(prev, 'index.html'), '<p>prev</p>');
    await writeFile(path.join(prev, 'meta.json'), JSON.stringify({ ...liveMeta, title: 'Prev title' }));
    await writeFile(
      path.join(prev, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        slot: slot === 'unpaired' ? 'undo' : slot,
        label: "expanded 'Pricing'",
        pairedUpdatedAt: slot === 'unpaired' ? '2020-01-01T00:00:00.000Z' : liveMeta.updatedAt,
      }),
    );
    return { ...t, dir, prev };
  }

  it('an undo slot: .prev is the root, live its child; history answers before anything is written', async () => {
    const { lib, dir, prev } = await withPrev('undo');
    const before = await snapshotDir(dir);
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: "expanded 'Pricing'" });
    expect(await snapshotDir(dir)).toEqual(before);
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>prev</p>');
    expect((await lib.getMeta(SLUG)).title).toBe('Prev title');
    expect(await exists(prev)).toBe(false);
    const t = await readTreeFile(lib);
    expect(t.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['initial', 'Earlier version'],
      ['outside', "expanded 'Pricing'"],
    ]);
    expect(t.currentId).toBe(t.rootId);
    await lib.redo(SLUG);
    expect(await live(lib)).toBe('<p>live</p>');
  });

  it('a redo slot: live is the root, .prev its forward child', async () => {
    const { lib, prev } = await withPrev('redo');
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: true, redoLabel: "expanded 'Pricing'" });
    await lib.redo(SLUG);
    expect(await live(lib)).toBe('<p>prev</p>');
    expect(await exists(prev)).toBe(false);
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('an unpaired slot: a single root; .prev is removed on the first write path', async () => {
    const { lib, prev } = await withPrev('unpaired');
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: false });
    await write(lib, '<p>new</p>', 'first');
    expect(await exists(prev)).toBe(false);
    expect((await readTreeFile(lib)).nodes.map((n) => n.label)).toEqual(['Original', 'first']);
  });

  it('.prev is removed only after tree.json is durable', async () => {
    const { lib, prev } = await withPrev('undo');
    failOn = (t) => path.basename(t) === 'tree.json';
    await write(lib, '<p>new</p>', 'first');
    failOn = undefined;
    // The edit committed, the tree could not be saved: the legacy slot is still there.
    expect(await live(lib)).toBe('<p>new</p>');
    expect(await exists(prev)).toBe(true);
    // The node files were written, so the versions are rebuilt and adopted with their labels.
    const view = await lib.versions(SLUG);
    expect(view).toMatchObject({ degraded: false, detached: false });
    expect(view.tree.nodes.map((n) => n.label)).toEqual(['Earlier version', "expanded 'Pricing'", 'first']);
    // The next write path makes tree.json durable, then removes the legacy slot.
    await write(lib, '<p>newer</p>', 'second');
    expect(await exists(prev)).toBe(false);
    await lib.undo(SLUG);
    await lib.undo(SLUG);
    await lib.undo(SLUG);
    expect(await live(lib)).toBe('<p>prev</p>');
  });
});

describe('reads never write (D5)', () => {
  it('versions(), history() and readVersion() write nothing, in every state', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const spies = ['open', 'writeFile', 'rename', 'unlink', 'rm', 'mkdir'].map((m) => vi.spyOn(fsp, m as 'open'));
    const writes = () =>
      spies.reduce(
        (n, s, i) => n + s.mock.calls.filter((c) => i !== 0 || (c[1] !== undefined && c[1] !== 'r')).length,
        0,
      );
    const check = async () => {
      const n = writes();
      const view = await lib.versions(SLUG);
      await lib.history(SLUG);
      await lib.readVersion(SLUG, view.tree.currentId);
      expect(writes()).toBe(n);
    };
    await check(); // no tree yet
    const n = writes();
    await write(lib, '<p>v2</p>', 'first');
    expect(writes()).toBeGreaterThan(n); // the spies see real writes
    await check(); // a clean tree
    await writeFile(lib.docPath(SLUG), '<p>hand edit</p>');
    await check(); // detached
    await writeFile(path.join(vdir(lib), 'tree.json'), 'garbage');
    await check(); // corrupt tree
  });
});
