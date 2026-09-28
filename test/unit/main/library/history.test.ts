import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LibraryError,
  PREV_DIR,
  createDocProtocolHandler,
  type CatalogFile,
  type DocumentMeta,
  type FsLibrary,
} from '../../../../src/main/library';
import { HTML, createDoc, testLibrary } from './fixtures';

/** One prior version per document with undo/redo by swap (09 §4.1). */

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
const prevDir = (lib: FsLibrary) => path.join(lib.root, SLUG, PREV_DIR);

describe('prior version slot (09 §4.1)', () => {
  it('a new document has no prior version', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    expect(await exists(prevDir(lib))).toBe(false);
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: false });
  });

  it('an update saves the previous index.html and meta.json in .prev/ with the change label', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const before = await readJson<DocumentMeta>(lib.docPath(SLUG, 'meta.json'));
    await change(lib, '<p>v2</p>', "re-explained 'Pricing'");
    expect(await readFile(path.join(prevDir(lib), 'index.html'), 'utf8')).toBe(HTML);
    expect(await readJson<DocumentMeta>(path.join(prevDir(lib), 'meta.json'))).toEqual(before);
    expect(await html(lib)).toBe('<p>v2</p>');
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: "re-explained 'Pricing'" });
  });

  it('uses a generic label when the change has none', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>');
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'last change' });
  });

  it('keeps exactly one prior version: a later change replaces it', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await change(lib, '<p>v3</p>', 'second');
    expect(await readFile(path.join(prevDir(lib), 'index.html'), 'utf8')).toBe('<p>v2</p>');
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'second' });
    // No leftover staging folders next to it.
    expect((await readdir(path.join(lib.root, SLUG))).sort()).toEqual([PREV_DIR, 'index.html', 'meta.json']);
  });

  it('a meta-only write (no html) records no prior version', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await lib.withDocLock(SLUG, () => lib.touch(SLUG));
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: false });
  });

  it('a failed write leaves the files and the prior version unchanged', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await expectCode(
      change(lib, '<p>v3</p>', 'broken', (m) => ({ ...m, title: '' })),
      'META_INVALID',
    );
    expect(await html(lib)).toBe('<p>v2</p>');
    expect(await readFile(path.join(prevDir(lib), 'index.html'), 'utf8')).toBe(HTML);
    expect(await lib.history(SLUG)).toMatchObject({ canUndo: true, undoLabel: 'first' });
  });

  it('a slot that no longer pairs with the live meta (external rewrite) offers nothing', async () => {
    const { lib, clock } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const p = lib.docPath(SLUG, 'meta.json');
    clock.advance(1000);
    await writeFile(p, JSON.stringify({ ...(await readJson<object>(p)), updatedAt: clock.now().toISOString() }));
    expect(await lib.history(SLUG)).toEqual({ canUndo: false, canRedo: false });
    await expectCode(lib.undo(SLUG), 'HISTORY_EMPTY');
  });
});

describe('undo / redo swap (09 §4.1)', () => {
  it('undo swaps current and prior and flips the slot to redo; redo swaps back', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', "expanded 'Pricing'");
    expect(await lib.undo(SLUG)).toEqual({ canUndo: false, canRedo: true, redoLabel: "expanded 'Pricing'" });
    expect(await html(lib)).toBe(HTML);
    expect(await readFile(path.join(prevDir(lib), 'index.html'), 'utf8')).toBe('<p>v2</p>');
    await expectCode(lib.undo(SLUG), 'HISTORY_EMPTY');

    expect(await lib.redo(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: "expanded 'Pricing'" });
    expect(await html(lib)).toBe('<p>v2</p>');
    await expectCode(lib.redo(SLUG), 'HISTORY_EMPTY');
  });

  it('with no prior version both refuse with HISTORY_EMPTY', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await expectCode(lib.undo(SLUG), 'HISTORY_EMPTY');
    await expectCode(lib.redo(SLUG), 'HISTORY_EMPTY');
    await expectCode(lib.undo('not-there'), 'NOT_FOUND');
  });

  it('a new change after an undo overwrites the slot, so redo is lost', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await lib.undo(SLUG);
    await change(lib, '<p>v2b</p>', 'second');
    expect(await lib.history(SLUG)).toEqual({ canUndo: true, canRedo: false, undoLabel: 'second' });
    expect(await readFile(path.join(prevDir(lib), 'index.html'), 'utf8')).toBe(HTML);
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
    expect(events).toEqual([{ reason: 'updated', slugs: [SLUG] }]);

    // Redo brings the newer content back, still with the live publications.
    await lib.redo(SLUG);
    const r = await lib.getMeta(SLUG);
    expect(r.title).toBe('Widget pricing, revised');
    expect(r.publications).toEqual([pub]);
    expect(lib.getEntry(SLUG)).toMatchObject({ title: 'Widget pricing, revised', tabCount: 3 });
  });

  it('swaps under the document lock: a writer holding it delays the undo', async () => {
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

  it('refuses in read-only mode', async () => {
    const { lib, open } = await testLibrary({ processLock: false });
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const ro = await open();
    ro.enterReadOnly('locked');
    await expectCode(ro.undo(SLUG), 'LIBRARY_READ_ONLY');
  });
});

describe('.prev/ stays private (09 §4 rules)', () => {
  it('eli5doc:// never serves anything under .prev/', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    const handler = createDocProtocolHandler({ root: lib.root, isCatalogued: (s) => lib.hasSlug(s) });
    for (const u of [
      `eli5doc://doc/${SLUG}/.prev/index.html`,
      `eli5doc://doc/${SLUG}/%2Eprev/index.html`,
      `eli5doc://doc/${SLUG}/.prev/meta.json`,
      `eli5doc://doc/${SLUG}/.prev/`,
      `eli5doc://doc/${SLUG}/.prev%2Findex.html`,
    ]) {
      expect((await handler(new Request(u))).status, u).toBe(404);
    }
    const live = await handler(new Request(`eli5doc://doc/${SLUG}/index.html`));
    expect(await live.text()).toBe('<p>v2</p>');
  });

  it('reconcile rebuilds the catalog from the live meta only and ignores .prev/', async () => {
    const { lib, open } = await testLibrary({ processLock: false });
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first', (m) => ({ ...m, title: 'Live title' }));
    await writeFile(path.join(lib.root, 'catalog.json'), '{}');
    const again = await open();
    expect(again.list().map((e) => [e.topicSlug, e.title])).toEqual([[SLUG, 'Live title']]);
    // .prev/ was not touched by reconcile.
    expect(await readFile(path.join(prevDir(again), 'index.html'), 'utf8')).toBe(HTML);
  });

  it('housekeeping removes stale .prev staging folders left by a crash', async () => {
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

  it('trashing a document takes .prev/ with it', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await change(lib, '<p>v2</p>', 'first');
    await lib.trashDocument(SLUG);
    expect(await exists(path.join(lib.root, SLUG))).toBe(false);
    const [trashed] = await readdir(path.join(lib.root, '.trash'));
    expect(await exists(path.join(lib.root, '.trash', trashed ?? '', PREV_DIR, 'index.html'))).toBe(true);
  });
});
