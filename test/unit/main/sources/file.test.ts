import { execFileSync } from 'node:child_process';
import { chmod, mkdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileResolver, resolveFileInput } from '../../../../src/main/sources/file';
import { sha256Text } from '../../../../src/main/sources/io';
import { DEFAULT_RESOLVE_LIMITS, type SourceInput } from '../../../../src/main/sources/types';
import * as fx from './fixtures';
import { fakeCtx } from './helpers';

type FileInput = Extract<SourceInput, { kind: 'file' }>;
const fileInput = (p: string, over: Partial<FileInput> = {}): FileInput => ({
  id: 'in-0000f11e',
  kind: 'file',
  origin: 'drop',
  path: p,
  ...over,
});

describe('file resolver: single files (03 §5.1)', () => {
  it('resolves a markdown file with realpath location, basename ref, sha256 and path payload', async () => {
    const dir = await fx.tmpDir();
    const p = await fx.put(dir, 'notes.md', fx.TEXT_BODY);
    const out = await resolveFileInput(fileInput(p), fakeCtx());
    const real = await realpath(p);
    expect(out.skipped).toEqual([]);
    expect(out.resolved).toEqual([
      {
        id: '',
        inputId: 'in-0000f11e',
        ref: 'notes.md',
        location: real,
        lane: 'local',
        resolverId: 'file',
        format: 'markdown',
        mediaType: 'text/markdown',
        payload: { kind: 'path', path: real },
        sizeBytes: Buffer.byteLength(fx.TEXT_BODY),
        sha256: sha256Text(fx.TEXT_BODY),
        notes: [],
      },
    ]);
  });

  it('mismatched extension resolves by content with a note', async () => {
    const dir = await fx.tmpDir();
    const out = await resolveFileInput(fileInput(await fx.put(dir, 'report.pdf', fx.png())), fakeCtx());
    expect(out.resolved[0]).toMatchObject({ format: 'png', notes: ['extension .pdf but content is PNG'] });
  });

  it.each([
    ['deck.pptx', () => fx.ooxml('pptx'), 'pptx'],
    ['memo.docx', () => fx.ooxml('docx'), 'docx'],
    ['book.xlsm', () => fx.ooxml('xlsm'), 'xlsx'],
    ['photo.heic', () => Promise.resolve(fx.ftyp('heic', ['mif1', 'heic'])), 'heic'],
    ['scan.tiff', () => Promise.resolve(fx.tiffLE()), 'tiff'],
    ['icon.bmp', () => Promise.resolve(fx.bmp()), 'bmp'],
    ['table.csv', () => Promise.resolve(Buffer.from('a,b\n1,2\n')), 'csv'],
  ] as const)('%s resolves as %s', async (name, make, format) => {
    const dir = await fx.tmpDir();
    const out = await resolveFileInput(fileInput(await fx.put(dir, name, await make())), fakeCtx());
    expect(out.resolved[0]?.format).toBe(format);
  });

  it.each([
    ['old.ppt', () => fx.ole(['PowerPoint Document']), 'legacy-office-format', 'Older Office format'],
    ['locked.docx', () => fx.ole(['EncryptionInfo', 'EncryptedPackage']), 'encrypted', 'password protected'],
    ['pic.avif', () => fx.ftyp('avif', ['mif1', 'avif']), 'unsupported-type', 'AVIF'],
    ['memo.rtf', () => fx.rtf(), 'unsupported-type', 'RTF'],
    ['blob.bin', () => Buffer.from([0, 1, 2, 3]), 'unsupported-type', 'Unrecognized binary'],
  ] as const)('%s is skipped with %s', async (name, make, code, reasonPart) => {
    const dir = await fx.tmpDir();
    const out = await resolveFileInput(fileInput(await fx.put(dir, name, make())), fakeCtx());
    expect(out.resolved).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ ref: name, code });
    expect(out.skipped[0]?.reason).toContain(reasonPart);
  });

  it('generic ZIP is skipped as unsupported-type "ZIP archive"', async () => {
    const dir = await fx.tmpDir();
    const out = await resolveFileInput(
      fileInput(await fx.put(dir, 'generic-archive.bin', await fx.genericZip())),
      fakeCtx(),
    );
    expect(out.skipped[0]).toEqual({
      ref: 'generic-archive.bin',
      code: 'unsupported-type',
      reason: 'Unsupported file type: ZIP archive.',
    });
  });

  it('missing -> not-found; empty -> empty; FIFO -> not-a-regular-file', async () => {
    const dir = await fx.tmpDir();
    expect((await resolveFileInput(fileInput(path.join(dir, 'gone.pdf')), fakeCtx())).skipped[0]).toEqual({
      ref: 'gone.pdf',
      code: 'not-found',
      reason: 'File not found.',
    });
    const empty = await fx.put(dir, 'empty.txt', '');
    expect((await resolveFileInput(fileInput(empty), fakeCtx())).skipped[0]?.code).toBe('empty');
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect((await resolveFileInput(fileInput(fifo), fakeCtx())).skipped[0]?.code).toBe('not-a-regular-file');
  });

  it.skipIf(process.getuid?.() === 0)('unreadable file -> permission-denied', async () => {
    const dir = await fx.tmpDir();
    const locked = await fx.put(dir, 'sub/locked.txt', 'x');
    await chmod(path.dirname(locked), 0o000);
    try {
      const out = await resolveFileInput(fileInput(locked), fakeCtx());
      expect(out.skipped[0]).toMatchObject({ ref: 'locked.txt', code: 'permission-denied' });
      expect(out.skipped[0]?.reason).toMatch(/^macOS did not allow the app to read this file/);
    } finally {
      await chmod(path.dirname(locked), 0o755);
    }
  });

  it('size limits: maxFileBytes -> too-large; images over maxImageBytes -> too-large', async () => {
    const dir = await fx.tmpDir();
    const big = await fx.put(dir, 'big.txt', 'x'.repeat(2000));
    const ctx = fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, maxFileBytes: 1000, maxImageBytes: 10 } });
    expect((await resolveFileInput(fileInput(big), ctx)).skipped[0]?.code).toBe('too-large');
    const img = await fx.put(dir, 'shot.png', fx.png());
    expect((await resolveFileInput(fileInput(img), ctx)).skipped[0]?.code).toBe('too-large');
    const txt = await fx.put(dir, 'small.txt', 'x'.repeat(100));
    expect((await resolveFileInput(fileInput(txt), ctx)).resolved).toHaveLength(1);
  });

  it('follows a symlink: location is the real path, ref the dropped name', async () => {
    const dir = await fx.tmpDir();
    const target = await fx.put(dir, 'real/target.md', fx.TEXT_BODY);
    const link = path.join(dir, 'alias.md');
    await symlink(target, link);
    const out = await resolveFileInput(fileInput(link), fakeCtx());
    expect(out.resolved[0]).toMatchObject({ ref: 'alias.md', location: await realpath(target) });
  });
});

describe('file resolver: snapshots (03 §5.1 step 0)', () => {
  it('reads the copy; location is the original real path and ref the original basename', async () => {
    const dir = await fx.tmpDir();
    const original = await fx.put(dir, 'Desktop/Q3 Review.md', fx.TEXT_BODY);
    const copy = await fx.put(dir, 'jobs/j1/inputs/0-Q3 Review.md', fx.TEXT_BODY);
    const st = await stat(original);
    const out = await resolveFileInput(
      fileInput(original, { snapshot: { copyPath: copy, sizeBytes: st.size, mtimeMs: st.mtimeMs } }),
      fakeCtx(),
    );
    expect(out.resolved[0]).toMatchObject({
      ref: 'Q3 Review.md',
      location: await realpath(original),
      payload: { kind: 'path', path: copy },
    });
  });

  it('reads the copy even when the original is gone', async () => {
    const dir = await fx.tmpDir();
    const copy = await fx.put(dir, 'jobs/j1/inputs/0-a.md', fx.TEXT_BODY);
    const out = await resolveFileInput(
      fileInput(path.join(dir, 'gone/a.md'), { snapshot: { copyPath: copy, sizeBytes: 1, mtimeMs: 1 } }),
      fakeCtx(),
    );
    expect(out.resolved[0]).toMatchObject({ ref: 'a.md', location: path.join(dir, 'gone/a.md') });
  });

  it('missing copy -> file-changed', async () => {
    const dir = await fx.tmpDir();
    const out = await resolveFileInput(
      fileInput(path.join(dir, 'a.md'), { snapshot: { copyPath: path.join(dir, 'nope'), sizeBytes: 1, mtimeMs: 1 } }),
      fakeCtx(),
    );
    expect(out.skipped[0]).toEqual({ ref: 'a.md', code: 'file-changed', reason: 'File changed or moved.' });
  });

  it('no copy: unchanged original is read in place; changed or missing -> file-changed', async () => {
    const dir = await fx.tmpDir();
    const p = await fx.put(dir, 'huge.md', fx.TEXT_BODY);
    const st = await stat(p);
    const same = await resolveFileInput(
      fileInput(p, { snapshot: { sizeBytes: st.size, mtimeMs: st.mtimeMs } }),
      fakeCtx(),
    );
    expect(same.resolved[0]?.payload).toEqual({ kind: 'path', path: await realpath(p) });
    const changed = await resolveFileInput(
      fileInput(p, { snapshot: { sizeBytes: st.size + 1, mtimeMs: st.mtimeMs } }),
      fakeCtx(),
    );
    expect(changed.skipped[0]?.code).toBe('file-changed');
    const gone = await resolveFileInput(
      fileInput(path.join(dir, 'x.md'), { snapshot: { sizeBytes: 1, mtimeMs: 1 } }),
      fakeCtx(),
    );
    expect(gone.skipped[0]?.code).toBe('file-changed');
  });
});

describe('file resolver: folder expansion (03 §5.3)', () => {
  async function tree(): Promise<string> {
    const dir = await fx.tmpDir();
    const root = path.join(dir, 'Research');
    await fx.put(root, 'a10.md', '# ten\n');
    await fx.put(root, 'a2.md', '# two\n');
    await fx.put(root, '.hidden.md', '# hidden\n');
    await fx.put(root, '.git/config', 'x');
    await fx.put(root, 'node_modules/pkg/readme.md', 'x');
    await fx.put(root, 'Tool.app/Contents/info.txt', 'x');
    await fx.put(root, 'b/deep1.md', '# d1\n');
    await fx.put(root, 'b/c/deep2.md', '# d2\n');
    await fx.put(root, 'b/c/d/deep3.md', '# d3 (depth 4, not reached)\n');
    await fx.put(root, 'b/old.ppt', fx.ole(['PowerPoint Document']));
    return root;
  }

  it('walks depth-first in numeric name order up to depth 3, skipping hidden and package entries', async () => {
    const root = await tree();
    const out = await resolveFileInput(fileInput(root), fakeCtx());
    expect(out.resolved.map((r) => r.ref)).toEqual(['a2.md', 'a10.md', 'deep2.md', 'deep1.md']); // b/c sorts before b/deep1.md;
    expect(out.resolved.every((r) => r.inputId === 'in-0000f11e')).toBe(true);
    expect(out.skipped).toEqual([expect.objectContaining({ ref: 'old.ppt', code: 'legacy-office-format' })]);
  });

  it('respects maxFolderDepth', async () => {
    const root = await tree();
    const out = await resolveFileInput(
      fileInput(root),
      fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, maxFolderDepth: 1 } }),
    );
    expect(out.resolved.map((r) => r.ref)).toEqual(['a2.md', 'a10.md']);
  });

  it('files beyond maxSourcesPerJob are skipped as limit-exceeded without being read', async () => {
    const root = await tree();
    const out = await resolveFileInput(
      fileInput(root),
      fakeCtx({ limits: { ...DEFAULT_RESOLVE_LIMITS, maxSourcesPerJob: 2 } }),
    );
    expect(out.resolved.map((r) => r.ref)).toEqual(['a2.md', 'a10.md']);
    expect(out.skipped.map((s) => s.code)).toEqual(['limit-exceeded', 'limit-exceeded', 'limit-exceeded']);
  });

  it('a folder with no supported files yields a single empty skip', async () => {
    const dir = await fx.tmpDir();
    const root = path.join(dir, 'Archive');
    await mkdir(root);
    await writeFile(path.join(root, 'x.rtf'), fx.rtf());
    await writeFile(path.join(root, '.DS_Store'), 'x');
    const out = await resolveFileInput(fileInput(root), fakeCtx());
    expect(out).toEqual({
      resolved: [],
      skipped: [{ ref: 'Archive', code: 'empty', reason: 'Folder contained no supported files.' }],
    });
  });
});

describe('FileResolver', () => {
  const r = new FileResolver();
  it('has the spec shape and claims only absolute file inputs', () => {
    expect([r.id, r.lane, r.handles]).toEqual(['file', 'local', ['file']]);
    expect(r.canResolve(fileInput('/abs/a.md'), fakeCtx())).toBe(true);
    expect(r.canResolve(fileInput('rel/a.md'), fakeCtx())).toBe(false);
    expect(r.canResolve({ id: 'in-1', kind: 'url', origin: 'url-field', url: 'https://example.com' }, fakeCtx())).toBe(
      false,
    );
  });
});

describe('committed unsupported fixtures (13 §5.1 sources/unsupported/*)', () => {
  const dir = path.resolve(import.meta.dirname, '../../../fixtures/sources/unsupported');
  it.each([
    ['memo.rtf', 'unsupported-type'],
    ['empty.txt', 'empty'],
  ] as const)('%s -> %s', async (name, code) => {
    const out = await resolveFileInput(fileInput(path.join(dir, name)), fakeCtx());
    expect(out.resolved).toEqual([]);
    expect(out.skipped[0]).toMatchObject({ ref: name, code });
  });
});
