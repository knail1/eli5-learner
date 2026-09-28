import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOLDER_ID_RE,
  ORGANIZATION_FILE,
  TRASH_ID_RE,
  cleanFolderName,
  type LibraryMoveReceipt,
} from '../../../../src/main/library';
import { HTML, createDoc, makeMeta, testLibrary, uuid, writeDocFolder } from './fixtures';

/** Library organization (09 §4.2): folders, Archive, Trash, put back, empty trash. */

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

const orgFile = (root: string) => path.join(root, '.eli5', ORGANIZATION_FILE);

describe('folder names (09 §4.2)', () => {
  it('trims and collapses whitespace, bounds the length, and reserves the system names', () => {
    expect(cleanFolderName('  Widget   research ')).toBe('Widget research');
    expect(cleanFolderName('')).toBeUndefined();
    expect(cleanFolderName('   ')).toBeUndefined();
    expect(cleanFolderName('x'.repeat(61))).toBeUndefined();
    expect(cleanFolderName('x'.repeat(60))).toBe('x'.repeat(60));
    expect(cleanFolderName('archive')).toBeUndefined();
    expect(cleanFolderName(' TRASH ')).toBeUndefined();
    expect(cleanFolderName('line\nbreak')).toBe('line break');
  });

  it('ids and trash ids have fixed shapes; pre-merge backups are not trash items', () => {
    expect(FOLDER_ID_RE.test('f-0123abcd')).toBe(true);
    expect(FOLDER_ID_RE.test('archive')).toBe(false);
    expect(TRASH_ID_RE.test('widget-pricing--20260201T000000')).toBe(true);
    expect(TRASH_ID_RE.test('widget-pricing--20260201T000000-2')).toBe(true);
    expect(TRASH_ID_RE.test('widget-pricing--20260201T000000-premerge')).toBe(false);
    expect(TRASH_ID_RE.test('../x--20260201T000000')).toBe(false);
  });
});

describe('migration of a flat library (09 §4.2)', () => {
  it('lists every existing document unfiled and writes nothing until the first change', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await createDoc(lib, 'Widget Supply');
    const org = await lib.organization();
    expect(org).toEqual({ folders: [], placement: {}, trash: [], trashRetentionDays: 30 });
    expect(lib.list()).toHaveLength(2);
    await expect(stat(orgFile(lib.root))).rejects.toThrow();
  });

  it('a corrupt organization file is set aside and the library still opens, all unfiled', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await writeFile(orgFile(lib.root), '{not json');
    const again = await open();
    expect((await again.organization()).folders).toEqual([]);
    expect(again.list()).toHaveLength(1);
    const names = await readdir(path.join(lib.root, '.eli5'));
    expect(names.some((n) => n.startsWith(`${ORGANIZATION_FILE}.corrupt-`))).toBe(true);
  });
});

describe('folders (09 §4.2)', () => {
  it('creates, renames and persists folders; names are unique and case-insensitive', async () => {
    const { lib, open } = await testLibrary();
    const events: string[] = [];
    lib.on('organization', () => events.push('org'));
    const f = await lib.createFolder('  Widget research ');
    expect(f.id).toMatch(FOLDER_ID_RE);
    expect(f.name).toBe('Widget research');
    await expectCode(lib.createFolder('widget RESEARCH'), 'FOLDER_NAME_TAKEN');
    await expectCode(lib.createFolder('Archive'), 'FOLDER_NAME_INVALID');
    await expectCode(lib.createFolder(''), 'FOLDER_NAME_INVALID');
    const g = await lib.createFolder('Budgets');
    expect((await lib.organization()).folders.map((x) => x.name)).toEqual(['Budgets', 'Widget research']);

    expect((await lib.renameFolder(f.id, 'Supply')).name).toBe('Supply');
    await expectCode(lib.renameFolder(g.id, 'supply'), 'FOLDER_NAME_TAKEN');
    // Renaming to its own name in another case is allowed.
    expect((await lib.renameFolder(g.id, 'BUDGETS')).name).toBe('BUDGETS');
    await expectCode(lib.renameFolder('f-00000000', 'X'), 'FOLDER_NOT_FOUND');
    expect(events.length).toBeGreaterThanOrEqual(4);

    const disk = JSON.parse(await readFile(orgFile(lib.root), 'utf8')) as { schemaVersion: number };
    expect(disk.schemaVersion).toBe(1);
    const again = await open();
    expect((await again.organization()).folders.map((x) => x.name)).toEqual(['BUDGETS', 'Supply']);
  });

  it('refuses organization writes in read-only mode', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const p = path.join(lib.root, 'catalog.json');
    await writeFile(p, (await readFile(p, 'utf8')).replace('"schemaVersion": 1', '"schemaVersion": 99'));
    const ro = await open();
    await expectCode(ro.createFolder('Budgets'), 'LIBRARY_READ_ONLY');
    await expectCode(ro.moveDocument('widget-pricing', 'archive'), 'LIBRARY_READ_ONLY');
    await expectCode(ro.emptyTrash(), 'LIBRARY_READ_ONLY');
  });
});

describe('moving documents (09 §4.2)', () => {
  it('moves between unfiled, a folder and the Archive, with a receipt for undo', async () => {
    const { lib } = await testLibrary();
    const e = await createDoc(lib, 'Widget Pricing');
    const f = await lib.createFolder('Budgets');
    const moved: LibraryMoveReceipt[] = [];
    lib.on('moved', (r) => moved.push(r));

    const r1 = await lib.moveDocument('widget-pricing', f.id);
    expect(r1).toMatchObject({ slug: 'widget-pricing', docId: e.id, from: 'unfiled', to: f.id });
    expect((await lib.organization()).placement).toEqual({ [e.id]: f.id });
    const r2 = await lib.moveDocument('widget-pricing', 'archive');
    expect(r2).toMatchObject({ from: f.id, to: 'archive' });
    expect(lib.locationOf(e.id)).toBe('archive');
    const r3 = await lib.moveDocument('widget-pricing', 'unfiled', { undo: true });
    expect(r3).toMatchObject({ from: 'archive', to: 'unfiled', undo: true });
    expect((await lib.organization()).placement).toEqual({});
    expect(moved.map((m) => m.to)).toEqual([f.id, 'archive', 'unfiled']);

    await expectCode(lib.moveDocument('widget-pricing', 'f-00000000'), 'FOLDER_NOT_FOUND');
    await expectCode(lib.moveDocument('no-such-doc', 'archive'), 'NOT_FOUND');
  });

  it('archived documents stay in the Library list but leave the recents', async () => {
    const { lib, clock } = await testLibrary();
    await createDoc(lib, 'Widget Pricing', { createdAt: '2026-01-01T00:00:00.000Z' });
    clock.advance(1000);
    await createDoc(lib, 'Widget Supply', { createdAt: '2026-01-02T00:00:00.000Z' });
    await lib.moveDocument('widget-supply', 'archive');
    expect(lib.list().map((x) => x.topicSlug)).toEqual(['widget-supply', 'widget-pricing']);
    expect(lib.recents().map((x) => x.topicSlug)).toEqual(['widget-pricing']);
  });

  it('keeps folder membership when catalog.json is deleted and rebuilt', async () => {
    const { lib, open } = await testLibrary();
    const e = await createDoc(lib, 'Widget Pricing');
    const f = await lib.createFolder('Budgets');
    await lib.moveDocument('widget-pricing', f.id);
    await rm(path.join(lib.root, 'catalog.json'));
    const again = await open();
    expect(again.list()).toHaveLength(1);
    expect((await again.organization()).placement).toEqual({ [e.id]: f.id });
  });
});

describe('Trash (09 §4.2)', () => {
  it('moving to Trash keeps the files intact in .trash/ and lists the document there', async () => {
    const { lib } = await testLibrary();
    const e = await createDoc(lib, 'Widget Pricing');
    const f = await lib.createFolder('Budgets');
    await lib.moveDocument('widget-pricing', f.id);
    const r = await lib.moveDocument('widget-pricing', 'trash');
    expect(r).toMatchObject({ from: f.id, to: 'trash', trashId: 'widget-pricing--20260201T000000' });
    expect(lib.list()).toEqual([]);
    expect(lib.hasSlug('widget-pricing')).toBe(false);
    const dir = path.join(lib.root, '.trash', 'widget-pricing--20260201T000000');
    expect(await readFile(path.join(dir, 'index.html'), 'utf8')).toBe(HTML);
    const org = await lib.organization();
    expect(org.placement).toEqual({});
    expect(org.trash).toEqual([
      {
        trashId: 'widget-pricing--20260201T000000',
        docId: e.id,
        title: 'Widget Pricing',
        topicSlug: 'widget-pricing',
        summary: e.summary,
        trashedAt: '2026-02-01T00:00:00.000Z',
        reason: 'trashed',
        from: f.id,
        fromName: 'Budgets',
      },
    ]);
  });

  it('Put Back returns the document to its folder, or unfiled when the folder is gone', async () => {
    const { lib } = await testLibrary();
    const e = await createDoc(lib, 'Widget Pricing');
    const f = await lib.createFolder('Budgets');
    await lib.moveDocument('widget-pricing', f.id);
    const { trashId } = await lib.moveDocument('widget-pricing', 'trash');
    const changed: string[] = [];
    lib.on('changed', (c) => changed.push(c.reason));
    expect(await lib.putBack(trashId!)).toEqual({ slug: 'widget-pricing' });
    expect(lib.getEntry(e.id)?.topicSlug).toBe('widget-pricing');
    expect(lib.locationOf(e.id)).toBe(f.id);
    expect((await lib.organization()).trash).toEqual([]);
    expect(changed).toEqual(['restored']);

    const again = (await lib.moveDocument('widget-pricing', 'trash')).trashId!;
    await lib.deleteFolder(f.id);
    await lib.putBack(again);
    expect(lib.locationOf(e.id)).toBe('unfiled');
    await expectCode(lib.putBack(again), 'TRASH_ITEM_NOT_FOUND');
    await expectCode(lib.putBack('../../etc'), 'TRASH_ITEM_NOT_FOUND');
  });

  it('Put Back of an archived document returns it to the Archive', async () => {
    const { lib } = await testLibrary();
    const e = await createDoc(lib, 'Widget Pricing');
    await lib.moveDocument('widget-pricing', 'archive');
    const { trashId } = await lib.moveDocument('widget-pricing', 'trash');
    await lib.putBack(trashId!);
    expect(lib.locationOf(e.id)).toBe('archive');
  });

  it("a trashed document's slug is not reused, so Put Back keeps its slug", async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const { trashId } = await lib.moveDocument('widget-pricing', 'trash');
    const next = await createDoc(lib, 'Widget Pricing');
    expect(next.topicSlug).toBe('widget-pricing-2');
    expect(await lib.putBack(trashId!)).toEqual({ slug: 'widget-pricing' });
  });

  it('Put Back picks a fresh slug when the old folder name is taken, and rewrites the meta', async () => {
    const { lib } = await testLibrary();
    const e = await createDoc(lib, 'Widget Pricing');
    const { trashId } = await lib.moveDocument('widget-pricing', 'trash');
    // A document copied in by hand under the same name.
    await writeDocFolder(lib.root, makeMeta({ id: uuid(), topicSlug: 'widget-pricing' }));
    await lib.reconcile();
    const { slug } = await lib.putBack(trashId!);
    expect(slug).toBe('widget-pricing-2');
    expect(lib.getEntry(e.id)?.topicSlug).toBe('widget-pricing-2');
    const meta = JSON.parse(await readFile(path.join(lib.root, slug, 'meta.json'), 'utf8')) as { topicSlug: string };
    expect(meta.topicSlug).toBe('widget-pricing-2');
  });

  it('deleting a folder moves its documents to the Trash, remembering the folder name', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await createDoc(lib, 'Widget Supply');
    await createDoc(lib, 'Office Plants');
    const f = await lib.createFolder('Widgets');
    await lib.moveDocument('widget-pricing', f.id);
    await lib.moveDocument('widget-supply', f.id);
    expect(await lib.deleteFolder(f.id)).toEqual({ trashed: 2 });
    const org = await lib.organization();
    expect(org.folders).toEqual([]);
    expect(org.trash.map((t) => [t.topicSlug, t.fromName]).sort()).toEqual([
      ['widget-pricing', 'Widgets'],
      ['widget-supply', 'Widgets'],
    ]);
    expect(lib.list().map((x) => x.topicSlug)).toEqual(['office-plants']);
    await expectCode(lib.deleteFolder(f.id), 'FOLDER_NOT_FOUND');
  });

  it('Delete Permanently and Empty Trash remove files; pre-merge backups are left alone', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await createDoc(lib, 'Widget Supply');
    await createDoc(lib, 'Office Plants');
    const a = (await lib.moveDocument('widget-pricing', 'trash')).trashId!;
    await lib.moveDocument('widget-supply', 'trash');
    await lib.moveDocument('office-plants', 'trash');
    const backup = path.join(lib.root, '.trash', 'widget-supply--20260101T000000-premerge');
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, 'index.html'), HTML);

    await lib.deletePermanently(a);
    await expectCode(lib.deletePermanently(a), 'TRASH_ITEM_NOT_FOUND');
    expect((await lib.organization()).trash).toHaveLength(2);
    expect(await lib.emptyTrash()).toEqual({ deleted: 2 });
    expect((await lib.organization()).trash).toEqual([]);
    expect(await readdir(path.join(lib.root, '.trash'))).toEqual(['widget-supply--20260101T000000-premerge']);
  });

  it('lists a document trashed before folders existed, with no record, as trashed from unfiled', async () => {
    const { lib } = await testLibrary();
    const meta = makeMeta({ id: uuid(), topicSlug: 'old-widget', title: 'Old widget' });
    const dir = path.join(lib.root, '.trash', 'old-widget--20260115T101500');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), HTML);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    const org = await lib.organization();
    expect(org.trash).toMatchObject([
      { trashId: 'old-widget--20260115T101500', title: 'Old widget', from: 'unfiled', reason: 'trashed' },
    ]);
    expect(org.trash[0]?.trashedAt).toBe('2026-01-15T10:15:00.000Z');
    expect(org.trash[0]?.topicSlug).toBe('old-widget');
  });

  it('expired trash is purged at startup and its record dropped', async () => {
    const { lib, clock, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await lib.moveDocument('widget-pricing', 'trash');
    clock.advance(31 * 24 * 60 * 60 * 1000);
    const again = await open();
    expect((await again.organization()).trash).toEqual([]);
    const disk = JSON.parse(await readFile(orgFile(lib.root), 'utf8')) as { trashed: object };
    expect(disk.trashed).toEqual({});
  });

  it('records a merged-away source as merged into the target', async () => {
    const { lib } = await testLibrary();
    const src = await createDoc(lib, 'Widget Pricing');
    const dest = await lib.moveToTrash(path.join(lib.root, 'widget-pricing'), 'widget-pricing');
    await lib.noteMergedAway(path.basename(dest), src.id, 'Widget supply plan');
    await lib.applyMergeToCatalog(undefined, src.id);
    const [item] = (await lib.organization()).trash;
    expect(item).toMatchObject({ reason: 'merged', mergedInto: 'Widget supply plan', title: 'Widget Pricing' });
    const { slug } = await lib.putBack(item!.trashId);
    expect(lib.getEntry(src.id)?.topicSlug).toBe(slug);
  });
});
