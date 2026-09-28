import { mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CatalogFileSchema,
  LibraryError,
  READ_ONLY_MESSAGES,
  type CatalogFile,
  type DocumentMeta,
  type LibraryChangeReason,
} from '../../../../src/main/library';
import { HTML, TS, createDoc, makeMeta, stage, testLibrary, uuid, writeDocFolder } from './fixtures';

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const catalogOf = (root: string) => readJson<CatalogFile>(path.join(root, 'catalog.json'));

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LibraryError);
  expect((err as LibraryError).code).toBe(code);
}

describe('openLibrary (09 §3.1, §4)', () => {
  it('creates the root, hidden folders and an empty catalog, and caches the realpath', async () => {
    const { lib, libraryDir } = await testLibrary();
    expect(lib.root).toBe(libraryDir);
    expect(path.isAbsolute(lib.root)).toBe(true);
    const names = (await readdir(lib.root)).sort();
    expect(names).toEqual(['.eli5', '.staging', '.trash', 'catalog.json']);
    const cat = CatalogFileSchema.parse(await catalogOf(lib.root));
    expect(cat.entries).toEqual([]);
    expect(cat.schemaVersion).toBe(1);
    expect(lib.info()).toEqual({ root: lib.root, readOnly: false, count: 0 });
  });

  it('rejects a relative ELI5_LIBRARY_DIR at startup', async () => {
    const { open } = await testLibrary();
    await expect(
      open({ rootInput: { isPackaged: false, repoRoot: '/r', userData: '/u', env: { ELI5_LIBRARY_DIR: 'rel' } } }),
    ).rejects.toThrow(/absolute/);
  });

  it('warns in dev when the root is not git-ignored', async () => {
    const lines: string[] = [];
    const logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (e: string) => void lines.push(e),
    };
    const { open } = await testLibrary();
    await open({ logger, checkIgnored: () => Promise.resolve(false) });
    expect(lines).toContain('library.root-not-ignored');
  });
});

describe('allocateSlug (09 §6.2)', () => {
  it('100 parallel allocations are all distinct', async () => {
    const { lib } = await testLibrary();
    const rs = await Promise.all(Array.from({ length: 100 }, () => lib.allocateSlug('Widget Pricing')));
    const slugs = rs.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(100);
    expect(slugs).toContain('widget-pricing');
    expect(slugs).toContain('widget-pricing-100');
  });

  it('treats folders case-insensitively, avoids reserved names, and frees on release', async () => {
    const { lib } = await testLibrary();
    await mkdir(path.join(lib.root, 'Widget-Pricing'));
    const a = await lib.allocateSlug('widget pricing');
    expect(a.slug).toBe('widget-pricing-2');
    expect((await lib.allocateSlug('Sample')).slug).toBe('sample-doc');
    const b = await lib.allocateSlug('Gadgets', 'gadget-hint');
    expect(b.slug).toBe('gadget-hint');
    b.release();
    b.release();
    expect((await lib.allocateSlug('Gadgets', 'gadget-hint')).slug).toBe('gadget-hint');
  });
});

describe('commitDocument (09 §8.2)', () => {
  it('moves staging into place, upserts the catalog, releases the reservation and emits created', async () => {
    const { lib } = await testLibrary();
    const events: { reason: LibraryChangeReason; slugs: string[] }[] = [];
    lib.on('changed', (e) => events.push(e));
    const r = await lib.allocateSlug('Widget Pricing');
    const meta = makeMeta({ topicSlug: 'wrong-slug-overridden' });
    const dir = await stage(lib, 'job-1', meta);
    const entry = await lib.commitDocument(r, dir, meta);
    expect(entry.topicSlug).toBe('widget-pricing');
    expect(entry).toMatchObject({ id: meta.id, tabCount: 2, mergedFromCount: 0, summarySource: 'llm' });
    expect(await readFile(lib.docPath('widget-pricing'), 'utf8')).toBe(HTML);
    const onDisk = await readJson<DocumentMeta>(lib.docPath('widget-pricing', 'meta.json'));
    expect(onDisk.topicSlug).toBe('widget-pricing');
    expect((await stat(path.dirname(lib.docPath('widget-pricing')))).mode & 0o777).toBe(0o700);
    expect((await catalogOf(lib.root)).entries.map((e) => e.id)).toEqual([meta.id]);
    expect(await readdir(path.join(lib.root, '.staging'))).toEqual([]);
    expect(events).toEqual([{ reason: 'created', slugs: ['widget-pricing'] }]);
    // Reservation released; the folder itself now blocks the slug.
    expect((await lib.allocateSlug('Widget Pricing')).slug).toBe('widget-pricing-2');
  });

  it.each([
    ['an empty directory', (p: string) => mkdir(p)],
    ['a file', (p: string) => writeFile(p, 'x')],
    ['a symlink', (p: string) => symlink('/nonexistent', p)],
  ])('fails with SLUG_TAKEN when %s exists at the target', async (_n, make) => {
    const { lib } = await testLibrary();
    const r = await lib.allocateSlug('Widget Pricing');
    await make(path.join(lib.root, r.slug));
    const meta = makeMeta();
    const dir = await stage(lib, 'job-1', meta);
    await expectCode(lib.commitDocument(r, dir, meta), 'SLUG_TAKEN');
    expect(lib.list()).toEqual([]);
  });

  it('rejects staging outside <root>/.staging, extra staged files and invalid meta', async () => {
    const { lib } = await testLibrary();
    const r = await lib.allocateSlug('Widget Pricing');
    const meta = makeMeta();
    const outside = path.join(lib.root, '..', 'elsewhere');
    await mkdir(outside, { recursive: true });
    await expectCode(lib.commitDocument(r, outside, meta), 'PATH_OUTSIDE_ROOT');
    const dir = await stage(lib, 'job-1', meta);
    await expectCode(lib.commitDocument(r, dir, { ...meta, id: 'not-a-uuid' }), 'META_INVALID');
    await writeFile(path.join(dir, 'extra.png'), 'x');
    await expectCode(lib.commitDocument(r, dir, meta), 'WRITE_FAILED');
  });

  it('never stores absolute local paths or URL fragments in meta.json (09 §5.2)', async () => {
    const { lib } = await testLibrary();
    const entry = await createDoc(lib, 'Widget Pricing', {
      sourcesUsed: [
        { ref: '/Users/someone/Desktop/widgets.pdf', kind: 'file' },
        { ref: 'https://widgets.example/pricing?q=1#frag', kind: 'url' },
      ],
      sourcesSkipped: [{ ref: '/Users/someone/secret.key', reason: 'Not found', code: 'not-found' }],
    });
    const text = await readFile(lib.docPath(entry.topicSlug, 'meta.json'), 'utf8');
    expect(text).not.toContain('/Users/');
    const m = JSON.parse(text) as DocumentMeta;
    expect(m.sourcesUsed.map((s) => s.ref)).toEqual(['widgets.pdf', 'https://widgets.example/pricing?q=1']);
    expect(m.sourcesSkipped[0]?.ref).toBe('secret.key');
  });
});

describe('listing (09 §9, §9.1)', () => {
  it('lists newest first by createdAt and recents returns the last 3 finished', async () => {
    const { lib } = await testLibrary();
    const days = ['2026-01-03', '2026-01-01', '2026-01-05', '2026-01-02'];
    for (const [i, d] of days.entries()) {
      await createDoc(lib, `Widget topic ${i}`, { createdAt: `${d}T00:00:00.000Z`, updatedAt: TS });
    }
    expect(lib.list().map((e) => e.createdAt.slice(0, 10))).toEqual([
      '2026-01-05',
      '2026-01-03',
      '2026-01-02',
      '2026-01-01',
    ]);
    expect(lib.recents().map((e) => e.topicSlug)).toEqual(['widget-topic-2', 'widget-topic-0', 'widget-topic-3']);
    expect(lib.recents(1)).toHaveLength(1);
    const first = lib.list()[0]!;
    expect(lib.getEntry(first.id)).toEqual(first);
    expect(lib.getEntry(first.topicSlug)).toEqual(first);
    expect(lib.getEntry('nope')).toBeUndefined();
  });

  it('an update does not move a document up in recents (updatedAt only)', async () => {
    const { lib, clock } = await testLibrary();
    await createDoc(lib, 'Older widget', { createdAt: '2026-01-01T00:00:00.000Z' });
    await createDoc(lib, 'Newer widget', { createdAt: '2026-01-02T00:00:00.000Z' });
    clock.advance(60_000);
    await lib.withDocLock('older-widget', () => lib.touch('older-widget'));
    expect(lib.recents().map((e) => e.topicSlug)).toEqual(['newer-widget', 'older-widget']);
  });
});

describe('docPath (09 §9)', () => {
  it('accepts valid slugs and rejects anything else', async () => {
    const { lib } = await testLibrary();
    expect(lib.docPath('widget-pricing')).toBe(path.join(lib.root, 'widget-pricing', 'index.html'));
    expect(lib.docPath('widget-pricing', 'meta.json')).toBe(path.join(lib.root, 'widget-pricing', 'meta.json'));
    for (const bad of ['../x', '.eli5', 'A', 'a/b', '', 'a--b', '-a']) {
      expect(() => lib.docPath(bad)).toThrow(LibraryError);
    }
  });
});

describe('updateDocument / touch (09 §9)', () => {
  it('requires the doc lock in dev builds', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await expectCode(lib.touch('widget-pricing'), 'LOCK_NOT_HELD');
  });

  it('takes the lock implicitly when dev checks are off', async () => {
    const { lib: first, open } = await testLibrary();
    await createDoc(first, 'Widget Pricing');
    const lib = await open({ devChecks: false });
    const e = await lib.touch('widget-pricing');
    expect(e.topicSlug).toBe('widget-pricing');
  });

  it('writes html and meta, sets updatedAt, keeps id/createdAt, updates the catalog and emits updated', async () => {
    const { lib, clock } = await testLibrary();
    const created = await createDoc(lib, 'Widget Pricing');
    const events: string[] = [];
    lib.on('changed', (e) => events.push(e.reason));
    clock.advance(5_000);
    const e = await lib.withDocLock('widget-pricing', () =>
      lib.updateDocument('widget-pricing', {
        html: '<p>new</p>',
        meta: (m) => ({
          ...m,
          id: uuid(),
          createdAt: '2020-01-01T00:00:00.000Z',
          tabs: [
            ...m.tabs,
            { key: 'sx4e1a07', kind: 'section-eli5', label: 'ELI5: Widgets', sectionCount: 1, createdAt: TS },
          ],
        }),
      }),
    );
    expect(e.id).toBe(created.id);
    expect(e.createdAt).toBe(created.createdAt);
    expect(e.updatedAt).toBe(clock.now().toISOString());
    expect(e.tabCount).toBe(3);
    expect(await readFile(lib.docPath('widget-pricing'), 'utf8')).toBe('<p>new</p>');
    const m = await lib.getMeta('widget-pricing');
    expect(m.updatedAt).toBe(e.updatedAt);
    expect((await catalogOf(lib.root)).entries[0]?.tabCount).toBe(3);
    expect(events).toEqual(['updated']);
  });

  it('rejects a patch that breaks the schema, and unknown slugs', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await expectCode(
      lib.withDocLock('widget-pricing', () =>
        lib.updateDocument('widget-pricing', { meta: (m) => ({ ...m, title: '' }) }),
      ),
      'META_INVALID',
    );
    await expectCode(
      lib.withDocLock('gone', () => lib.touch('gone')),
      'NOT_FOUND',
    );
  });

  it('preserves unknown meta fields written by siblings or newer builds (09 §5.2)', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const p = lib.docPath('widget-pricing', 'meta.json');
    await writeFile(p, JSON.stringify({ ...(await readJson<object>(p)), futureField: { a: 1 } }));
    await lib.withDocLock('widget-pricing', () => lib.touch('widget-pricing'));
    expect(await readJson<Record<string, unknown>>(p)).toMatchObject({ futureField: { a: 1 } });
  });
});

describe('locks (09 §8.3)', () => {
  it('serializes work per slug and detects reentry', async () => {
    const { lib } = await testLibrary();
    const order: string[] = [];
    const slow = lib.withDocLock('a', async () => {
      order.push('a1-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a1-end');
    });
    const second = lib.withDocLock('a', async () => void order.push('a2'));
    const other = lib.withDocLock('b', async () => void order.push('b'));
    await Promise.all([slow, second, other]);
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1-end'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a1-end'));
    await expectCode(
      lib.withDocLock('a', () => lib.withDocLock('a', async () => 1)),
      'LOCK_REENTRY',
    );
  });

  it('a continuation scheduled inside a doc lock stops holding it once the lock is released', async () => {
    const { lib } = await testLibrary({ devChecks: true });
    await createDoc(lib, 'Widget Pricing');
    let later: Promise<boolean> | undefined;
    await lib.withDocLock('widget-pricing', async () => {
      expect(lib.holdsDocLock('widget-pricing')).toBe(true);
      later = new Promise((r) => setTimeout(() => r(lib.holdsDocLock('widget-pricing')), 10));
    });
    expect(await later).toBe(false);
    // A deferred write from inside the lock must take the lock again (no LOCK_REENTRY, no bypass).
    let deferred: Promise<unknown> | undefined;
    await lib.withDocLock('widget-pricing', async () => {
      deferred = new Promise((r) => setTimeout(r, 5)).then(() => lib.touch('widget-pricing'));
    });
    await expectCode(deferred as Promise<unknown>, 'LOCK_NOT_HELD');
    let retaken: Promise<number> | undefined;
    await lib.withDocLock('widget-pricing', async () => {
      retaken = new Promise((r) => setTimeout(r, 5)).then(() => lib.withDocLock('widget-pricing', async () => 1));
    });
    expect(await retaken).toBe(1);
  });

  it('withDocLocks takes locks in ascending order, so opposite orders never deadlock', async () => {
    const { lib } = await testLibrary();
    const results = await Promise.all([
      lib.withDocLocks(['b', 'a'], async () => (lib.holdsDocLock('a') && lib.holdsDocLock('b') ? 1 : 0)),
      lib.withDocLocks(['a', 'b'], async () => 2),
    ]);
    expect(results).toEqual([1, 2]);
  });
});

describe('reconcile (09 §7, §12)', () => {
  it('rebuilds a deleted catalog.json from folders', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await createDoc(lib, 'Gadget Returns');
    await rm(path.join(lib.root, 'catalog.json'));
    const again = await open();
    expect(
      again
        .list()
        .map((e) => e.topicSlug)
        .sort(),
    ).toEqual(['gadget-returns', 'widget-pricing']);
    expect((await catalogOf(lib.root)).entries).toHaveLength(2);
  });

  it('renames a corrupt catalog.json to .corrupt-<ts> and rebuilds it', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await writeFile(path.join(lib.root, 'catalog.json'), '{ not json');
    const again = await open();
    expect(again.list()).toHaveLength(1);
    const names = await readdir(lib.root);
    expect(names.some((n) => /^catalog\.json\.corrupt-\d{8}T\d{6}$/.test(n))).toBe(true);
    expect(CatalogFileSchema.safeParse(await catalogOf(lib.root)).success).toBe(true);
  });

  it('ignores and never modifies folders without valid meta.json (e.g. the Pages sample/)', async () => {
    const { lib, open } = await testLibrary();
    const sample = path.join(lib.root, 'sample');
    await mkdir(sample);
    await writeFile(path.join(sample, 'index.html'), '<p>sample</p>');
    const bad = await writeDocFolder(lib.root, makeMeta({ topicSlug: 'broken-widget' }));
    await writeFile(path.join(bad, 'meta.json'), '{"schemaVersion":1,"id":"x"}');
    await writeFile(path.join(lib.root, 'index.html'), '<p>pages root</p>');
    await mkdir(path.join(lib.root, 'Has Spaces'));
    const again = await open();
    expect(again.list()).toEqual([]);
    expect((await readdir(sample)).sort()).toEqual(['index.html']);
    expect((await readdir(bad)).sort()).toEqual(['index.html', 'meta.json']);
    expect(await readFile(path.join(bad, 'meta.json'), 'utf8')).toBe('{"schemaVersion":1,"id":"x"}');
    expect(await readFile(path.join(lib.root, 'index.html'), 'utf8')).toBe('<p>pages root</p>');
    await expectCode(again.getMeta('broken-widget'), 'META_INVALID');
    expect(lib.list()).toEqual([]);
  });

  it('adds folders with no entry, drops entries with no folder, and lets meta win', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    await createDoc(lib, 'Gadget Returns');
    await rm(path.join(lib.root, 'gadget-returns'), { recursive: true });
    const orphan = makeMeta({ topicSlug: 'crash-window-doc', title: 'Crash window doc' });
    await writeDocFolder(lib.root, orphan);
    const p = lib.docPath('widget-pricing', 'meta.json');
    await writeFile(p, JSON.stringify({ ...(await readJson<DocumentMeta>(p)), title: 'Edited title' }));
    const events: { reason: string; slugs: string[] }[] = [];
    lib.on('changed', (e) => events.push(e));
    await lib.reconcile();
    expect(
      lib
        .list()
        .map((e) => [e.topicSlug, e.title])
        .sort(),
    ).toEqual([
      ['crash-window-doc', 'Crash window doc'],
      ['widget-pricing', 'Edited title'],
    ]);
    expect(events).toEqual([{ reason: 'reconciled', slugs: ['crash-window-doc', 'gadget-returns', 'widget-pricing'] }]);
    const reopened = await open();
    expect(reopened.list()).toHaveLength(2);
  });

  it('uses the folder name when a folder was renamed in Finder, and bumps updatedAt', async () => {
    const { lib, clock, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const before = (await lib.getMeta('widget-pricing')).updatedAt;
    await (
      await import('node:fs/promises')
    ).rename(path.join(lib.root, 'widget-pricing'), path.join(lib.root, 'widgets-renamed'));
    clock.advance(60_000);
    const again = await open();
    expect(again.list().map((e) => e.topicSlug)).toEqual(['widgets-renamed']);
    const meta = await again.getMeta('widgets-renamed');
    expect(meta.topicSlug).toBe('widgets-renamed');
    expect(meta.updatedAt).toBe(clock.now().toISOString());
    expect(meta.updatedAt).not.toBe(before);
    expect(again.getEntry('widgets-renamed')?.updatedAt).toBe(meta.updatedAt);
    expect((await catalogOf(lib.root)).entries[0]?.updatedAt).toBe(meta.updatedAt);
  });

  it('rewrites meta.json only under the doc lock, re-reading it so a concurrent update is kept', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const p = lib.docPath('widget-pricing', 'meta.json');
    await writeFile(p, JSON.stringify({ ...(await readJson<DocumentMeta>(p)), topicSlug: 'old-name' }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = lib.withDocLock('widget-pricing', async () => {
      await gate;
      await lib.updateDocument('widget-pricing', { meta: (m) => ({ ...m, title: 'Updated meanwhile' }) });
    });
    const rec = lib.reconcile();
    await new Promise((r) => setTimeout(r, 20));
    // Reconcile's phase 2 waits for the doc lock: meta.json is untouched so far.
    expect((await readJson<DocumentMeta>(p)).topicSlug).toBe('old-name');
    release();
    await Promise.all([holder, rec]);
    const meta = await readJson<DocumentMeta>(p);
    expect(meta.title).toBe('Updated meanwhile');
    expect(meta.topicSlug).toBe('widget-pricing');
  });

  it('skips a folder whose meta.json cannot be read instead of failing startup', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const odd = path.join(lib.root, 'odd-folder');
    await mkdir(path.join(odd, 'meta.json'), { recursive: true });
    await writeFile(path.join(odd, 'index.html'), '<p>x</p>');
    const again = await open();
    expect(again.list().map((e) => e.topicSlug)).toEqual(['widget-pricing']);
    expect((await readdir(path.join(odd, 'meta.json'))).length).toBe(0);
    await expectCode(again.getMeta('odd-folder'), 'META_INVALID');
  });

  it('gives copied folders with a duplicate id a new id; the earliest createdAt keeps it', async () => {
    const { lib, open } = await testLibrary();
    const id = uuid();
    await writeDocFolder(lib.root, makeMeta({ id, topicSlug: 'widget-copy', createdAt: '2026-01-02T00:00:00.000Z' }));
    await writeDocFolder(lib.root, makeMeta({ id, topicSlug: 'widget-orig', createdAt: '2026-01-01T00:00:00.000Z' }));
    const again = await open();
    expect(again.getEntry('widget-orig')?.id).toBe(id);
    const copyId = again.getEntry('widget-copy')?.id;
    expect(copyId).toBeDefined();
    expect(copyId).not.toBe(id);
    expect((await again.getMeta('widget-copy')).id).toBe(copyId);
  });

  it('deletes stale temp files and purges trash past retention', async () => {
    const { lib, clock, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const old = new Date(clock.now().getTime() - 2 * 60 * 60 * 1000);
    const staleTmp = path.join(lib.root, 'catalog.json.tmp-1-deadbeef');
    const freshTmp = path.join(lib.root, 'widget-pricing', 'meta.json.tmp-1-cafebabe');
    await writeFile(staleTmp, 'x');
    await writeFile(freshTmp, 'x');
    await utimes(staleTmp, old, old);
    await utimes(freshTmp, clock.now(), clock.now());
    const trash = path.join(lib.root, '.trash');
    await mkdir(path.join(trash, 'old-doc--20251201T000000'));
    await mkdir(path.join(trash, 'new-doc--20260130T000000'));
    await open();
    expect(await readdir(trash)).toEqual(['new-doc--20260130T000000']);
    await expect(stat(staleTmp)).rejects.toThrow();
    await expect(stat(freshTmp)).resolves.toBeDefined();
  });

  it('never deletes old files that only look like temp files (foreign docs/ content, 09 §3.2)', async () => {
    const { lib, clock, open } = await testLibrary();
    const old = new Date(clock.now().getTime() - 2 * 60 * 60 * 1000);
    const foreign = ['notes.tmp-draft.html', 'x.tmp-1-DEADBEEF', 'y.tmp-1-deadbeef.bak'].map((n) =>
      path.join(lib.root, n),
    );
    for (const f of foreign) {
      await writeFile(f, 'x');
      await utimes(f, old, old);
    }
    await open();
    for (const f of foreign) await expect(stat(f)).resolves.toBeDefined();
  });
});

describe('trashDocument (09 §4, §9)', () => {
  it('moves the folder to .trash/<slug>--<ts> and removes the entry', async () => {
    const { lib } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const events: string[] = [];
    lib.on('changed', (e) => events.push(e.reason));
    await lib.trashDocument('widget-pricing');
    expect(lib.list()).toEqual([]);
    expect(await readdir(path.join(lib.root, '.trash'))).toEqual(['widget-pricing--20260201T000000']);
    expect(events).toEqual(['removed']);
    await expectCode(lib.trashDocument('widget-pricing'), 'NOT_FOUND');
  });
});

describe('versioning and read-only mode (09 §5.3, §8.5)', () => {
  it('a newer catalog schemaVersion enters read-only mode and refuses writes', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const p = path.join(lib.root, 'catalog.json');
    const before = await readFile(p, 'utf8');
    await writeFile(p, before.replace('"schemaVersion": 1', '"schemaVersion": 99'));
    const ro = await open();
    expect(ro.readOnly).toBe(true);
    expect(ro.info().readOnlyReason).toBe(READ_ONLY_MESSAGES['newer-schema']);
    expect(ro.list()).toHaveLength(1);
    await expectCode(ro.allocateSlug('x'), 'LIBRARY_READ_ONLY');
    await expectCode(ro.trashDocument('widget-pricing'), 'LIBRARY_READ_ONLY');
    await expectCode(
      ro.withDocLock('widget-pricing', () => ro.touch('widget-pricing')),
      'LIBRARY_READ_ONLY',
    );
    expect(await readFile(p, 'utf8')).toContain('"schemaVersion": 99');
  });

  it('a newer meta schemaVersion enters read-only mode but still lists the document', async () => {
    const { lib, open } = await testLibrary();
    await createDoc(lib, 'Widget Pricing');
    const p = lib.docPath('widget-pricing', 'meta.json');
    await writeFile(p, JSON.stringify({ ...(await readJson<object>(p)), schemaVersion: 2 }));
    const ro = await open();
    expect(ro.readOnly).toBe(true);
    expect(ro.list().map((e) => e.topicSlug)).toEqual(['widget-pricing']);
  });

  it('takes the process lock by default and releases it on close', async () => {
    const { lib } = await testLibrary();
    const lockFile = path.join(lib.root, '.eli5', 'library.lock');
    const rec = await readJson<{ pid: number; startedAt: string }>(lockFile);
    expect(rec.pid).toBe(process.pid);
    expect(Math.abs(Date.parse(rec.startedAt) - (Date.now() - process.uptime() * 1000))).toBeLessThan(5000);
    await lib.close();
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('processLock: false opens without a lock file', async () => {
    const { open } = await testLibrary({ processLock: false });
    const lib = await open();
    await expect(stat(path.join(lib.root, '.eli5', 'library.lock'))).rejects.toThrow();
  });

  it('a held process lock enters read-only mode; a stale one does not', async () => {
    const { lib, open } = await testLibrary();
    const lockFile = path.join(lib.root, '.eli5', 'library.lock');
    const startedAt = new Date('2026-02-01T00:00:00.000Z');
    await writeFile(lockFile, JSON.stringify({ pid: 4242, appVersion: 'x', startedAt: startedAt.toISOString() }));
    const probe = (start: Date | undefined) => ({
      isAlive: (pid: number) => pid === 4242,
      startTime: () => Promise.resolve(start),
      command: () => Promise.resolve(undefined),
    });
    const held = await open({ processLock: { startedAt: new Date(), pid: 1, probe: probe(startedAt) } });
    expect(held.readOnly).toBe(true);
    expect(held.info().readOnlyReason).toBe(READ_ONLY_MESSAGES.locked);
    const reused = await open({
      processLock: { startedAt: new Date(), pid: 1, probe: probe(new Date('2026-03-01T00:00:00.000Z')) },
    });
    expect(reused.readOnly).toBe(false);
    expect((await readJson<{ pid: number }>(lockFile)).pid).toBe(1);
    await reused.close();
    await expect(stat(lockFile)).rejects.toThrow();
  });
});

describe('merge surface before M3 (09 §10)', () => {
  it('produces no suggestions', async () => {
    const { lib } = await testLibrary();
    expect(await lib.runMergeCheck('x')).toBeNull();
    expect(lib.suggestions()).toEqual([]);
    await expectCode(lib.acceptSuggestion('x'), 'SUGGESTION_STALE');
    await expect(lib.dismissSuggestion('x')).resolves.toBeUndefined();
  });
});
