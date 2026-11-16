/**
 * Retained source text, the `.sources/` sidecar (09 §4.4): layout, caps, reads, append-only
 * writes, housekeeping, HOOK-LIB-01 policy off, and privacy. Synthetic "Example Widgets Inc." text.
 */
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LibraryError,
  MAX_SIDECAR_BYTES,
  MAX_SIDECAR_SOURCES,
  MAX_SOURCE_CHARS,
  SOURCE_FILE_RE,
  SourceSidecarManifestSchema,
  defaultLibraryPolicy,
  sourcesForMeta,
  type FsLibrary,
  type SourceRecord,
  type SourceSidecar,
  type SourceSidecarInput,
  type SourceSidecarManifest,
} from '../../../../src/main/library';
import { createLogger, MemorySink } from '../../../../src/main/security';
import { HTML, makeMeta, testLibrary, writeDocFolder } from './fixtures';

const CANARY = 'CANARY-7f3a-widget-ledger';
const SLUG = 'widget-pricing';
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function input(over: Partial<SourceSidecarInput> = {}): SourceSidecarInput {
  const text = over.text === undefined ? `# Widget pricing\nExample Widgets Inc. sells widgets. ${CANARY}` : over.text;
  return {
    ref: '/Users/someone/Documents/widgets.pdf',
    label: '/Users/someone/Documents/widgets.pdf',
    kind: 'file',
    mime: 'application/pdf',
    format: 'pdf',
    chars: text?.length ?? 0,
    extractTruncated: false,
    ...over,
    text,
  };
}

async function setup(extra: Parameters<typeof testLibrary>[0] = {}) {
  const sink = new MemorySink();
  const logger = createLogger({ sink, level: () => 'debug' });
  const t = await testLibrary({ logger, ...extra });
  const meta = makeMeta({ topicSlug: SLUG });
  const docDir = await writeDocFolder(t.lib.root, meta);
  await t.lib.reconcile();
  return { ...t, sink, meta, docDir, sources: path.join(docDir, '.sources') };
}

const readManifest = async (dir: string): Promise<SourceSidecarManifest> =>
  SourceSidecarManifestSchema.parse(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')));

const upsert = (lib: FsLibrary, inputs: SourceSidecarInput[], slug = SLUG) =>
  lib.withDocLock(slug, () => lib.upsertSources(slug, inputs));

/** Writes a staging folder with a sidecar and commits it as a new document. */
async function commitWith(lib: FsLibrary, title: string, inputs: SourceSidecarInput[]) {
  const r = await lib.allocateSlug(title);
  const meta = makeMeta({ title, topicSlug: r.slug });
  const dir = await lib.stagingDir(`job-${r.slug}`);
  await fsp.writeFile(path.join(dir, 'index.html'), HTML);
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  const wrote = await lib.writeSourcesToStaging(dir, inputs);
  const entry = await lib.commitDocument(r, dir, meta);
  return { entry, wrote, slug: r.slug, dir: path.join(lib.root, r.slug, '.sources') };
}

const errorOf = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('the staging write and commitDocument (09 §4.4, §8.2)', () => {
  it('writes manifest and src-NN.md files that commit with the document, modes 0700/0600', async () => {
    const { lib } = await setup();
    const img = input({ ref: 'chart.png', label: 'chart.png', mime: 'image/png', format: 'png', text: null });
    const { wrote, slug, dir } = await commitWith(lib, 'Widget costs', [input(), img]);
    expect(wrote).toEqual({ count: 1, bytes: Buffer.byteLength(input().text ?? '') });
    expect((await fsp.readdir(dir)).sort()).toEqual(['manifest.json', 'src-01.md']);
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(path.join(dir, 'src-01.md'))).mode & 0o777).toBe(0o600);
    const m = await readManifest(dir);
    expect(m).toMatchObject({ v: 1, totalBytes: wrote?.bytes });
    expect(m.sources).toEqual([
      expect.objectContaining({
        id: 'src-01',
        file: 'src-01.md',
        ref: 'widgets.pdf',
        label: 'widgets.pdf',
        stored: 'text',
        sha256: sha(input().text ?? ''),
        truncated: false,
      }),
      expect.objectContaining({ id: 'src-02', stored: 'image', storedChars: 0 }),
    ]);
    expect(m.sources[1]?.file).toBeUndefined();
    const read = await lib.readSources(slug);
    expect(read?.texts).toEqual({ 'src-01': input().text });
  });

  it('refuses staging extras other than a well-formed .sources/', async () => {
    const { lib } = await setup();
    const tryCommit = async (prep: (dir: string) => Promise<void>) => {
      const r = await lib.allocateSlug('Widget extras');
      const meta = makeMeta({ title: 'Widget extras', topicSlug: r.slug });
      const dir = await lib.stagingDir(`job-x-${Math.random().toString(16).slice(2, 8)}`);
      await fsp.writeFile(path.join(dir, 'index.html'), HTML);
      await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
      await prep(dir);
      const err = await errorOf(lib.commitDocument(r, dir, meta));
      r.release();
      return err;
    };
    const bad = [
      (d: string) => fsp.writeFile(path.join(d, 'notes.txt'), 'x'),
      async (d: string) => {
        await fsp.mkdir(path.join(d, '.sources'));
        await fsp.writeFile(path.join(d, '.sources', 'evil.txt'), 'x');
      },
      async (d: string) => {
        await fsp.mkdir(path.join(d, '.sources'));
        await fsp.mkdir(path.join(d, '.sources', 'src-01.md'));
      },
      async (d: string) => {
        const outside = path.join(lib.root, '..', 'outside-sources');
        await fsp.mkdir(outside, { recursive: true });
        await fsp.symlink(outside, path.join(d, '.sources'));
      },
    ];
    for (const prep of bad) {
      const err = await tryCommit(prep);
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe('WRITE_FAILED');
      expect((err as LibraryError).detail).toMatchObject({ kind: 'staging-contents' });
    }
  });

  it('cuts one source at 400,000 characters on a line boundary and records extract truncation', async () => {
    const { lib } = await setup();
    const line = 'Example Widgets Inc. ships widgets.\n';
    const long = line.repeat(Math.ceil(MAX_SOURCE_CHARS / line.length) + 10);
    const { dir, slug } = await commitWith(lib, 'Widget long', [
      input({ text: long, ref: 'long.md', label: 'Long' }),
      input({ ref: 'cut.md', label: 'Cut', extractTruncated: true }),
    ]);
    const m = await readManifest(dir);
    const [a, b] = m.sources;
    expect(a?.storedChars).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
    expect(a).toMatchObject({ truncated: true, truncatedBy: ['extract'], chars: long.length });
    const text = (await lib.readSources(slug))?.texts['src-01'] ?? '';
    expect(long.startsWith(text)).toBe(true);
    expect(text.endsWith('widgets.')).toBe(true);
    expect(b).toMatchObject({ truncated: true, truncatedBy: ['extract'] });
  });

  it('cuts the source that crosses 2 MiB to fit, omits later ones, and omits empty text', async () => {
    const { lib } = await setup();
    const chunk = 'é'.repeat(1000) + '\n'; // 2001 bytes per line, so the cut lands on a line
    const big = chunk.repeat(Math.floor(MAX_SOURCE_CHARS / chunk.length) - 1); // < 400k chars, ~0.8 MB
    const inputs = [1, 2, 3, 4].map((n) => input({ ref: `big-${n}.md`, label: `Big ${n}`, text: big }));
    inputs.push(input({ ref: 'empty.md', label: 'Empty', text: ' \n ' }));
    const { dir, slug, wrote } = await commitWith(lib, 'Widget big', inputs);
    const m = await readManifest(dir);
    expect(m.sources.map((s) => s.stored)).toEqual(['text', 'text', 'text', 'omitted', 'omitted']);
    expect(m.sources[2]).toMatchObject({ truncated: true, truncatedBy: ['sidecar'] });
    expect(m.sources[3]).toMatchObject({ truncatedBy: ['sidecar'] });
    expect(m.sources[4]).toMatchObject({ stored: 'omitted', truncated: false });
    expect(m.totalBytes).toBeLessThanOrEqual(MAX_SIDECAR_BYTES);
    expect(wrote?.bytes).toBe(m.totalBytes);
    let sum = 0;
    for (const n of await fsp.readdir(dir)) if (n.endsWith('.md')) sum += (await fsp.stat(path.join(dir, n))).size;
    expect(sum).toBe(m.totalBytes);
    const texts = (await lib.readSources(slug))?.texts ?? {};
    expect(Object.keys(texts)).toEqual(['src-01', 'src-02', 'src-03']);
    expect(texts['src-03']?.includes('�')).toBe(false);
  });

  it('a later replacement of the cut source gets the room its old text freed (no latch across passes)', async () => {
    const { lib } = await setup();
    const chunk = 'é'.repeat(1000) + '\n';
    const big = chunk.repeat(Math.floor(MAX_SOURCE_CHARS / chunk.length) - 1);
    const inputs = [1, 2, 3].map((n) => input({ ref: `big-${n}.md`, label: `Big ${n}`, text: big }));
    const { dir, slug } = await commitWith(lib, 'Widget relatch', inputs);
    expect((await readManifest(dir)).sources[2]).toMatchObject({ truncatedBy: ['sidecar'] });
    await upsert(lib, [input({ ref: 'big-3.md', label: 'Big 3', text: 'Widget pricing, rewritten.' })], slug);
    const m = await readManifest(dir);
    const third = m.sources.find((s) => s.ref === 'big-3.md');
    expect(third).toMatchObject({ stored: 'text', truncated: false });
    expect(Object.values((await lib.readSources(slug))?.texts ?? {})).toContain('Widget pricing, rewritten.');
    expect(m.totalBytes).toBeLessThanOrEqual(MAX_SIDECAR_BYTES);
  });

  it('keeps at most 100 entries', async () => {
    const { lib } = await setup();
    const inputs = Array.from({ length: MAX_SIDECAR_SOURCES + 5 }, (_, i) =>
      input({ ref: `s${i}.md`, label: `S${i}`, text: `Widget fact ${i}` }),
    );
    const { dir } = await commitWith(lib, 'Widget many', inputs);
    const m = await readManifest(dir);
    expect(m.sources).toHaveLength(MAX_SIDECAR_SOURCES);
    expect(m.sources.at(-1)?.id).toBe('src-100');
    expect(SOURCE_FILE_RE.test('src-100.md')).toBe(true);
  });

  it('stores refs as basenames, URLs per policy, and no absolute path anywhere', async () => {
    const { lib } = await setup({ policy: { ...defaultLibraryPolicy, sourceUrls: 'redacted' } });
    // Credential-shaped URL assembled at runtime so the repo never holds a literal one (13 §11).
    const credUrl = ['https://user', 'pw@www.example.com/widgets?q=secret#frag'].join(':');
    const { dir } = await commitWith(lib, 'Widget refs', [
      input(),
      input({
        kind: 'url',
        ref: credUrl,
        label: credUrl,
        text: 'Widget page',
      }),
      input({ ref: '/private/tmp/clip.txt', label: 'Widget notes', kind: 'clipboard', text: 'Clip' }),
    ]);
    const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8');
    const m = await readManifest(dir);
    expect(m.sources.map((s) => s.ref)).toEqual(['widgets.pdf', 'https://www.example.com/widgets', 'clip.txt']);
    expect(m.sources[1]?.label).toBe('https://www.example.com/widgets');
    expect(raw).not.toContain('/Users/');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('pw@');
  });
});

describe('readSources (lock-free)', () => {
  it('returns null without a sidecar, for an invalid manifest, and for a symlinked .sources', async () => {
    const { lib, sources, docDir, sink } = await setup();
    expect(await lib.readSources(SLUG)).toBeNull();
    await fsp.mkdir(sources);
    await fsp.writeFile(path.join(sources, 'manifest.json'), `{"v":1,"sources":"${CANARY}"`);
    expect(await lib.readSources(SLUG)).toBeNull();
    // A traversal file name fails the strict schema.
    await upsert(lib, [input()]);
    const m = await readManifest(sources);
    const evil = { ...m, sources: [{ ...m.sources[0], file: '../meta.json' }] };
    await fsp.writeFile(path.join(sources, 'manifest.json'), JSON.stringify(evil));
    expect(await lib.readSources(SLUG)).toBeNull();
    await fsp.rm(sources, { recursive: true });
    const outside = path.join(lib.root, '..', 'elsewhere');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.symlink(outside, path.join(docDir, '.sources'));
    expect(await lib.readSources(SLUG)).toBeNull();
    expect(sink.lines.join('\n')).not.toContain(CANARY);
  });

  it('drops a missing, symlinked or sha-mismatched entry and logs a count', async () => {
    const { lib, sources, sink } = await setup();
    await upsert(lib, [
      input({ ref: 'a.md', label: 'A', text: 'Widget A' }),
      input({ ref: 'b.md', label: 'B', text: 'Widget B' }),
      input({ ref: 'c.md', label: 'C', text: 'Widget C' }),
      input({ ref: 'd.md', label: 'D', text: 'Widget D' }),
    ]);
    await fsp.rm(path.join(sources, 'src-01.md'));
    await fsp.writeFile(path.join(sources, 'src-02.md'), `tampered ${CANARY}`);
    await fsp.rm(path.join(sources, 'src-03.md'));
    const outside = path.join(lib.root, '..', 'c.md');
    await fsp.writeFile(outside, 'Widget C');
    await fsp.symlink(outside, path.join(sources, 'src-03.md'));
    const r = await lib.readSources(SLUG);
    expect(r?.texts).toEqual({ 'src-04': 'Widget D' });
    expect(r?.manifest.sources).toHaveLength(4);
    const logged = sink.entries().find((e) => e.event === 'library.sources-entry-unreadable');
    expect(logged).toMatchObject({ slug: SLUG, count: 3 });
    expect(sink.lines.join('\n')).not.toContain(CANARY);
  });

  it('re-reads the manifest once when a file vanished under a concurrent upsert', async () => {
    const { lib, sources } = await setup();
    const url = { kind: 'url' as const, ref: 'https://www.example.com/widgets', label: 'Widgets' };
    await upsert(lib, [input({ ...url, text: 'Old widget page' })]);
    const real = fsp.readFile.bind(fsp);
    let raced = false;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      if (!raced && String(args[0]).endsWith('src-01.md')) {
        raced = true;
        spy.mockRestore();
        await upsert(lib, [input({ ...url, text: 'New widget page' })]);
      }
      return real(...args);
    }) as typeof fsp.readFile);
    try {
      const r = await lib.readSources(SLUG);
      expect(raced).toBe(true);
      expect(r?.texts).toEqual({ 'src-02': 'New widget page' });
      expect(await fsp.readdir(sources)).not.toContain('src-01.md');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('upsertSources (append-only)', () => {
  it('is a no-op for the same text and replaces changed text under a new id, deleting the old file', async () => {
    const { lib, sources } = await setup();
    await upsert(lib, [input()]);
    const before = await fsp.readFile(path.join(sources, 'manifest.json'), 'utf8');
    await upsert(lib, [input()]);
    expect(await fsp.readFile(path.join(sources, 'manifest.json'), 'utf8')).toBe(before);

    // Same payload key (sourceSha256) with different text: replaced.
    const k = 'a'.repeat(64);
    await upsert(lib, [input({ ref: 'k.pdf', label: 'K', sourceSha256: k, text: 'Widget v1' })]);
    await upsert(lib, [input({ ref: 'k.pdf', label: 'K', sourceSha256: k, text: 'Widget v2' })]);
    const m = await readManifest(sources);
    expect(m.sources.map((s) => s.id)).toEqual(['src-01', 'src-03']);
    expect(await fsp.readdir(sources)).not.toContain('src-02.md');
    expect((await lib.readSources(SLUG))?.texts['src-03']).toBe('Widget v2');
  });

  it('keys a URL source without sourceSha256 by kind + ref (a re-fetched page)', async () => {
    const { lib, sources } = await setup();
    const url = { kind: 'url' as const, ref: 'https://www.example.com/w', label: 'W' };
    await upsert(lib, [input({ ...url, text: 'Page one' })]);
    await upsert(lib, [input({ ...url, text: 'Page two' })]);
    const m = await readManifest(sources);
    expect(m.sources).toHaveLength(1);
    expect(m.sources[0]?.id).toBe('src-02');
    expect((await lib.readSources(SLUG))?.texts).toEqual({ 'src-02': 'Page two' });
  });

  it('continues ids past src-999 from orphan file names, still matching SOURCE_FILE_RE', async () => {
    const { lib, sources } = await setup();
    await fsp.mkdir(sources);
    await fsp.writeFile(path.join(sources, 'src-1200.md'), 'orphan');
    await upsert(lib, [input()]);
    const m = await readManifest(sources);
    expect(m.sources[0]?.id).toBe('src-1201');
    expect(SOURCE_FILE_RE.test(m.sources[0]?.file ?? '')).toBe(true);
  });

  it('needs the doc lock, and is a no-op on a read-only library', async () => {
    const { lib, sources } = await setup();
    const err = await errorOf(lib.upsertSources(SLUG, [input()]));
    expect((err as LibraryError).code).toBe('LOCK_NOT_HELD');
    lib.enterReadOnly('locked');
    await upsert(lib, [input()]);
    expect(await fsp.lstat(sources).catch(() => undefined)).toBeUndefined();
  });
});

describe('sourcesForMeta (decision 8)', () => {
  const entry = (id: string, over: Partial<SourceSidecarManifest['sources'][number]> = {}) => ({
    id,
    file: `${id}.md`,
    ref: 'widgets.pdf',
    label: 'Widgets',
    kind: 'file' as const,
    mime: 'application/pdf',
    format: 'pdf',
    stored: 'text' as const,
    sha256: 'b'.repeat(64),
    chars: 3,
    storedChars: 3,
    truncated: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
  const sidecar = (sources: SourceSidecarManifest['sources'], texts: Record<string, string>): SourceSidecar => ({
    manifest: { v: 1, updatedAt: '2026-01-01T00:00:00.000Z', totalBytes: 0, sources },
    texts,
  });

  it('matches by kind + redacted ref (+ sha when both have one), drops the rest, lists missing records', () => {
    const sc = sidecar(
      [
        entry('src-01', { sourceSha256: 'c'.repeat(64) }),
        entry('src-02', { kind: 'url', ref: 'https://www.example.com/w?q=1', file: 'src-02.md' }),
        entry('src-03', { ref: 'merged-away.pdf' }),
        entry('src-04', { ref: 'chart.png', stored: 'image', file: undefined, sha256: undefined }),
      ],
      { 'src-01': 'A', 'src-02': 'B', 'src-03': 'C' },
    );
    const used: SourceRecord[] = [
      { ref: 'widgets.pdf', kind: 'file', sha256: 'c'.repeat(64) },
      // Written under 'full', meta re-sanitized as 'redacted': still a match.
      { ref: 'https://www.example.com/w', kind: 'url' },
      { ref: 'chart.png', kind: 'file' },
      { ref: 'never-kept.docx', kind: 'file' },
    ];
    const r = sourcesForMeta(sc, used);
    expect(r.entries.map((e) => e.id)).toEqual(['src-01', 'src-02', 'src-04']);
    expect(r.texts).toEqual({ 'src-01': 'A', 'src-02': 'B' });
    expect(r.missing.map((s) => s.ref)).toEqual(['chart.png', 'never-kept.docx']);
  });

  it('a different sha does not match; a null sidecar gives every record as missing', () => {
    const sc = sidecar([entry('src-01', { sourceSha256: 'c'.repeat(64) })], { 'src-01': 'A' });
    const used: SourceRecord[] = [{ ref: 'widgets.pdf', kind: 'file', sha256: 'd'.repeat(64) }];
    expect(sourcesForMeta(sc, used)).toEqual({ entries: [], texts: {}, missing: used });
    expect(sourcesForMeta(null, used)).toEqual({ entries: [], texts: {}, missing: used });
  });
});

describe('housekeeping and HOOK-LIB-01', () => {
  it('removes orphan src-NN.md files older than an hour and stale temp files', async () => {
    const { lib, sources, clock } = await setup();
    await upsert(lib, [input()]);
    const old = new Date(clock.now().getTime() - 2 * 60 * 60 * 1000);
    const fresh = new Date(clock.now().getTime() - 60 * 1000);
    for (const [n, at] of [
      ['src-07.md', old],
      ['src-08.md', fresh],
      ['manifest.json.tmp-1-0a0b0c0d', old],
    ] as const) {
      await fsp.writeFile(path.join(sources, n), 'orphan');
      await fsp.utimes(path.join(sources, n), at, at);
    }
    const old01 = path.join(sources, 'src-01.md');
    await fsp.utimes(old01, old, old);
    await lib.reconcile();
    expect((await fsp.readdir(sources)).sort()).toEqual(['manifest.json', 'src-01.md', 'src-08.md']);
  });

  it('policy off: no staging write, no upsert, readSources null, and housekeeping removes every sidecar', async () => {
    const t = await setup();
    await upsert(t.lib, [input()]);
    // A trashed document with a sidecar, then the policy is switched off.
    const other = await commitWith(t.lib, 'Widget trash', [input({ text: 'Trashed widget' })]);
    const receipt = await t.lib.trashDocument(other.slug);
    const trashed = path.join(t.lib.root, '.trash', receipt.trashId ?? '', '.sources');
    expect(await fsp.lstat(trashed).catch(() => undefined)).toBeDefined();

    const off = await t.open({ policy: { ...defaultLibraryPolicy, retainSourceText: false } });
    expect(off.retainsSourceText).toBe(false);
    expect(await fsp.lstat(t.sources).catch(() => undefined)).toBeUndefined();
    expect(await fsp.lstat(trashed).catch(() => undefined)).toBeUndefined();
    expect(t.sink.entries().find((e) => e.event === 'library.sources-removed')).toMatchObject({ count: 2 });

    expect(await off.readSources(SLUG)).toBeNull();
    await off.withDocLock(SLUG, () => off.upsertSources(SLUG, [input()]));
    expect(await fsp.lstat(t.sources).catch(() => undefined)).toBeUndefined();
    const dir = await off.stagingDir('job-off');
    expect(await off.writeSourcesToStaging(dir, [input()])).toBeNull();
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('the public default retains source text', () => {
    expect(defaultLibraryPolicy.retainSourceText).toBe(true);
  });
});

describe('the sidecar through the document lifecycle', () => {
  const snapshot = async (dir: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const n of (await fsp.readdir(dir)).sort()) out[n] = sha(await fsp.readFile(path.join(dir, n)));
    return out;
  };

  it('trash and Put Back keep it byte-identical; checkout, undo, redo and refreshRuntime leave it alone', async () => {
    const { lib, sources } = await setup();
    await upsert(lib, [input(), input({ ref: 'b.md', label: 'B', text: 'Widget B' })]);
    const before = await snapshot(sources);

    await lib.withDocLock(SLUG, () =>
      lib.updateDocument(SLUG, { html: HTML.replace('Inc.', 'Inc. v2'), meta: (m) => m, label: 'edit' }),
    );
    await lib.undo(SLUG);
    await lib.redo(SLUG);
    const tree = await lib.versions(SLUG);
    await lib.withDocLock(SLUG, () => lib.checkout(SLUG, tree.tree.rootId, { retiredIds: [] }));
    await lib.withDocLock(SLUG, () => lib.refreshRuntime(SLUG, HTML.replace('Inc.', 'Inc. v3')));
    expect(await snapshot(sources)).toEqual(before);

    const receipt = await lib.trashDocument(SLUG);
    const back = await lib.putBack(receipt.trashId ?? '');
    expect(back.slug).toBe(SLUG);
    expect(await snapshot(sources)).toEqual(before);

    // Reconcile and list() read meta only: the sidecar never makes or breaks an entry.
    await lib.reconcile();
    expect(lib.list().map((e) => e.topicSlug)).toEqual([SLUG]);
    expect(JSON.stringify(lib.list())).not.toContain(CANARY);
    expect(await fsp.readFile(path.join(lib.root, 'catalog.json'), 'utf8')).not.toContain(CANARY);
  });

  it('never throws or logs source content (canary)', async () => {
    const { lib, sources, sink } = await setup();
    await upsert(lib, [input()]);
    await fsp.writeFile(path.join(sources, 'src-01.md'), `changed ${CANARY}`);
    await lib.readSources(SLUG);
    await fsp.writeFile(path.join(sources, 'manifest.json'), CANARY);
    await lib.readSources(SLUG);
    const err = await errorOf(lib.writeSourcesToStaging('/tmp/not-staging', [input()]));
    expect(String((err as Error).message)).not.toContain(CANARY);
    expect(JSON.stringify((err as LibraryError).detail ?? {})).not.toContain(CANARY);
    // An upsert over an unreadable manifest starts afresh without reporting the text.
    await upsert(lib, [input({ ref: 'n.md', label: 'N', text: `New ${CANARY}` })]);
    expect(sink.lines.join('\n')).not.toContain(CANARY);
  });
});
