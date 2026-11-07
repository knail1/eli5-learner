import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LibraryError,
  PREV_DIR,
  VERSIONS_DIR,
  createDocProtocolHandler,
  type CatalogFile,
  type DocumentMeta,
  type FsLibrary,
} from '../../../../src/main/library';
import { HTML, createDoc, testLibrary } from './fixtures';

/** Undo/redo over the version tree, through the unchanged history API (09 §4.1, 08 §6.7). */

const SLUG = 'widget-pricing';
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LibraryError);
  expect((err as LibraryError).code).toBe(code);
}

/** One in-place change through the library's update path, as a section action makes it. */
function change(lib: FsLibrary, html: string, label?: string, meta: (m: DocumentMeta) => DocumentMeta = (m) => m) {
  return lib.withDocLock(SLUG, () => lib.updateDocument(SLUG, { html, meta, ...(label ? { label } : {}) }));
}

const html = (lib: FsLibrary) => readFile(lib.docPath(SLUG), 'utf8');
const versionsDir = (lib: FsLibrary) => path.join(lib.root, SLUG, VERSIONS_DIR);

describe('history state over the version tree (09 §4.1)', () => {
  it('a new document has no versions folder and offers nothing', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    expect(await exists(versionsDir(lib))).toBe(false);
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: false });
  });

  it('an update keeps the original as the root version and offers Undo with the change label', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', "re-explained 'Pricing'");
    expect(await html(lib)).toBe('<p>v2</p>');
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: "re-explained 'Pricing'" });
    const { tree } = await lib.versions(SLUG);
    expect(tree.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['initial', 'Original'],
      ['outside', "re-explained 'Pricing'"],
    ]);
    expect((await lib.getMeta(SLUG)).versionId).toBe(tree.currentId);
  });

  it('uses a generic label when the change has none', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>');
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'last change' });
  });

  it('keeps every version: two changes make a chain of three', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await change(lib, '<p>v3</p>', 'second');
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'second' });
    expect((await lib.versions(SLUG)).tree.nodes).toHaveLength(3);
    // Only the live files and the versions folder; no staging leftovers.
    expect((await readdir(path.join(lib.root, SLUG))).sort()).toEqual([VERSIONS_DIR, 'index.html', 'meta.json']);
    expect((await readdir(versionsDir(lib))).sort()).toEqual(['blobs', 'nodes', 'tree.json']);
  });

  it('a meta-only write (no html) records no version', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await lib.withDocLock(SLUG, () => lib.touch(SLUG));
    expect(await exists(versionsDir(lib))).toBe(false);
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: false });
  });

  it('a refused write leaves the files and the history unchanged', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await expectCode(
      change(lib, '<p>v3</p>', 'broken', (m) => ({ ...m, title: '' })),
      'META_INVALID',
    );
    expect(await html(lib)).toBe('<p>v2</p>');
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: 'first' });
    expect((await lib.versions(SLUG)).tree.nodes).toHaveLength(2);
  });

  it('a meta-only rewrite outside the library no longer voids the history (D4)', async () => {
    const { lib, clock } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const p = lib.docPath(SLUG, 'meta.json');
    clock.advance(1000);
    await writeFile(p, JSON.stringify({ ...(await readJson<object>(p)), updatedAt: clock.now().toISOString() }));
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: 'first' });
    await lib.undo(SLUG);
    expect(await html(lib)).toBe(HTML);
  });
});

describe('undo / redo (09 §4.1)', () => {
  it('undo opens the parent version and redo the child again', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', "expanded 'Pricing'");
    expect(await lib.undo(SLUG)).toEqual({ canUndo: false, canRedo: true, redoLabel: "expanded 'Pricing'" });
    expect(await html(lib)).toBe(HTML);
    await expectCode(lib.undo(SLUG), 'HISTORY_EMPTY');

    expect(await lib.redo(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: "expanded 'Pricing'" });
    expect(await html(lib)).toBe('<p>v2</p>');
    await expectCode(lib.redo(SLUG), 'HISTORY_EMPTY');
  });

  it('walks back through several versions and forward again', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await change(lib, '<p>v3</p>', 'second');
    expect(await lib.undo(SLUG)).toEqual({ canUndo: true, canRedo: true, undoLabel: 'first', redoLabel: 'second' });
    expect(await html(lib)).toBe('<p>v2</p>');
    await lib.undo(SLUG);
    expect(await html(lib)).toBe(HTML);
    await lib.redo(SLUG);
    await lib.redo(SLUG);
    expect(await html(lib)).toBe('<p>v3</p>');
  });

  it('with no earlier version both refuse with HISTORY_EMPTY', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await expectCode(lib.undo(SLUG), 'HISTORY_EMPTY');
    await expectCode(lib.redo(SLUG), 'HISTORY_EMPTY');
    await expectCode(lib.undo('not-there'), 'NOT_FOUND');
  });

  it('a new change after an undo starts a branch; the old future is kept', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await lib.undo(SLUG);
    await change(lib, '<p>v2b</p>', 'second');
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: 'second' });
    const { tree } = await lib.versions(SLUG);
    expect(tree.nodes.filter((n) => n.parentId === tree.rootId).map((n) => n.label)).toEqual(['first', 'second']);
    // Back at the root, Redo follows the branch just left.
    expect(await lib.undo(SLUG)).toMatchObject({ canRedo: true, redoLabel: 'second' });
  });

  it('restores the older meta but keeps id, createdAt, topicSlug and publications from the live one', async () => {
    const { lib, clock } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const created = await lib.getMeta(SLUG);
    clock.advance(1000);
    await change(lib, '<p>v2</p>', 'retitled', (m) => ({
      ...m,
      title: 'Widget pricing, revised',
      tabs: [
        ...m.tabs,
        { key: 'sx4e1a07', kind: 'section-eli5', label: 'ELI5: x', sectionCount: 1, createdAt: m.createdAt },
      ],
    }));
    const pub = {
      targetId: 'local',
      kind: 'local' as const,
      publishedAt: clock.now().toISOString(),
      primaryUrl: 'file:///tmp/x/index.html',
      contentSha256: 'a'.repeat(64),
    };
    await lib.withDocLock(SLUG, () => lib.appendPublication(SLUG, pub));
    clock.advance(1000);
    const events: { reason: string; slugs: string[] }[] = [];
    lib.on('changed', (e) => events.push(e));
    await lib.undo(SLUG);

    const m = await lib.getMeta(SLUG);
    expect(m.title).toBe(created.title);
    expect(m.tabs).toHaveLength(2);
    expect(m.id).toBe(created.id);
    expect(m.createdAt).toBe(created.createdAt);
    expect(m.topicSlug).toBe(SLUG);
    expect(m.publications).toEqual([pub]);
    expect(m.updatedAt).toBe(clock.now().toISOString());

    // catalog.json and the in-memory entry follow (updatedAt, tabCount, title).
    const cat = await readJson<CatalogFile>(path.join(lib.root, 'catalog.json'));
    expect(cat.entries[0]).toMatchObject({ title: created.title, tabCount: 2, updatedAt: m.updatedAt });
    expect(lib.getEntry(SLUG)).toMatchObject({ title: created.title, tabCount: 2 });
    expect(events.at(-1)).toEqual({ reason: 'updated', slugs: [SLUG] });

    // Redo brings the newer content back, still with the live publications.
    await lib.redo(SLUG);
    const r = await lib.getMeta(SLUG);
    expect(r.title).toBe('Widget pricing, revised');
    expect(r.publications).toEqual([pub]);
    expect(lib.getEntry(SLUG)).toMatchObject({ title: 'Widget pricing, revised', tabCount: 3 });
  });

  it('runs under the document lock: a writer holding it delays the undo', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    let release!: () => void;
    const held = lib.withDocLock(SLUG, () => new Promise<void>((r) => (release = r)));
    let done = false;
    const undo = lib.undo(SLUG).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(await html(lib)).toBe('<p>v2</p>');
    release();
    await held;
    await undo;
    expect(await html(lib)).toBe(HTML);
  });

  it('refuses in read-only mode, while history still answers', async () => {
    const { lib, open } = await testLibrary({ processLock: false });
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const ro = await open();
    ro.enterReadOnly('locked');
    await expectCode(ro.undo(SLUG), 'LIBRARY_READ_ONLY');
    expect(await ro.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'first' });
    expect((await ro.versions(SLUG)).readOnly).toBe(true);
  });
});

describe('.versions/ stays private and travels with the document (09 §4 rules)', () => {
  it('eli5doc:// never serves anything under .versions/', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const handler = createDocProtocolHandler({ root: lib.root, isCatalogued: (s) => lib.hasSlug(s) });
    for (const u of [
      `eli5doc://doc/${SLUG}/.versions/tree.json`,
      `eli5doc://doc/${SLUG}/%2Eversions/tree.json`,
      `eli5doc://doc/${SLUG}/.versions/`,
      `eli5doc://doc/${SLUG}/.versions%2Ftree.json`,
      `eli5doc://doc/${SLUG}/.versions/blobs/`,
    ]) {
      expect((await handler(new Request(u))).status, u).toBe(404);
    }
    const live = await handler(new Request(`eli5doc://doc/${SLUG}/index.html`));
    expect(await live.text()).toBe('<p>v2</p>');
  });

  it('reconcile rebuilds the catalog from the live meta only and leaves .versions/ alone', async () => {
    const { lib, open } = await testLibrary({ processLock: false });
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first', (m) => ({ ...m, title: 'Live title' }));
    const before = await readFile(path.join(versionsDir(lib), 'tree.json'), 'utf8');
    await writeFile(path.join(lib.root, 'catalog.json'), '{}');
    const again = await open();
    expect(again.list().map((e) => [e.topicSlug, e.title])).toEqual([[SLUG, 'Live title']]);
    expect(await readFile(path.join(versionsDir(again), 'tree.json'), 'utf8')).toBe(before);
    expect(await again.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'first' });
  });

  it('housekeeping removes stale .prev staging folders an older build left behind', async () => {
    const { lib, open, clock } = await testLibrary({ processLock: false });
    await createDoc(lib, 'Widget Pricing');
    const stale = path.join(lib.root, SLUG, `${PREV_DIR}.tmp-123-0badc0de`);
    await mkdir(stale);
    await writeFile(path.join(stale, 'index.html'), 'x');
    const old = new Date(clock.now().getTime() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await open();
    expect(await exists(stale)).toBe(false);
  });

  it('trashing a document takes .versions/ with it, and Put Back brings the history back', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const receipt = await lib.trashDocument(SLUG);
    expect(await exists(path.join(lib.root, SLUG))).toBe(false);
    const trashId = receipt.trashId ?? '';
    expect(await exists(path.join(lib.root, '.trash', trashId, VERSIONS_DIR, 'tree.json'))).toBe(true);
    await lib.putBack(trashId);
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: 'first' });
    await lib.undo(SLUG);
    expect(await html(lib)).toBe(HTML);
  });
});
