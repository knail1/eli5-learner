import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryError } from '../../../../src/main/library';
import { PublishError, buildPublishFileSet, MAX_PUBLISH_BYTES } from '../../../../src/main/publish';

/** buildPublishFileSet (10 §3.3): the single place that decides what may leave the machine. */

const HTML = '<!doctype html><html><body><h1>Example Widgets Inc.</h1></body></html>\n';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

let base: string;
let docDir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'eli5-files-'));
  docDir = path.join(base, 'widget-pricing');
  await mkdir(docDir);
  await writeFile(path.join(docDir, 'index.html'), HTML);
  await writeFile(path.join(docDir, 'meta.json'), '{"clarifyingInput":"private"}');
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishError || err instanceof LibraryError) return err.code;
    throw err;
  }
  return 'resolved';
}

describe('buildPublishFileSet (10 §3.3)', () => {
  it('returns only index.html with bytes and sha256, never meta.json', async () => {
    const files = await buildPublishFileSet('widget-pricing', docDir);
    expect(files).toEqual([
      {
        relPath: 'index.html',
        absPath: path.join(docDir, 'index.html'),
        bytes: Buffer.byteLength(HTML),
        sha256: sha(HTML),
      },
    ]);
  });

  it('freezes the set and each entry (step 5)', async () => {
    const files = await buildPublishFileSet('widget-pricing', docDir);
    expect(Object.isFrozen(files)).toBe(true);
    expect(Object.isFrozen(files[0])).toBe(true);
  });

  it('adds allowlisted assets/ entries only, skipping dotfiles and other extensions (step 2)', async () => {
    await mkdir(path.join(docDir, 'assets', 'img'), { recursive: true });
    await writeFile(path.join(docDir, 'assets', 'chart.svg'), '<svg/>');
    await writeFile(path.join(docDir, 'assets', 'img', 'photo.PNG'), 'png');
    await writeFile(path.join(docDir, 'assets', 'notes.txt'), 'no');
    await writeFile(path.join(docDir, 'assets', '.hidden.css'), 'no');
    await mkdir(path.join(docDir, 'assets', '.git'));
    await writeFile(path.join(docDir, 'assets', '.git', 'x.js'), 'no');
    await writeFile(path.join(docDir, '.DS_Store'), 'no');
    await writeFile(path.join(docDir, 'extra.html'), 'no');
    const files = await buildPublishFileSet('widget-pricing', docDir);
    expect(files.map((f) => f.relPath)).toEqual(['index.html', 'assets/chart.svg', 'assets/img/photo.PNG']);
  });

  it.each([
    ['uppercase', 'Widget'],
    ['traversal', '../widget-pricing'],
    ['leading dash', '-widget'],
    ['too long', 'a'.repeat(81)],
    ['empty', ''],
  ])('rejects an invalid slug (%s) with NOT_FOUND', async (_n, slug) => {
    expect(await code(buildPublishFileSet(slug, docDir))).toBe('NOT_FOUND');
  });

  it('rejects a missing document folder or index.html with NOT_FOUND', async () => {
    expect(await code(buildPublishFileSet('gone', path.join(base, 'gone')))).toBe('NOT_FOUND');
    await rm(path.join(docDir, 'index.html'));
    expect(await code(buildPublishFileSet('widget-pricing', docDir))).toBe('NOT_FOUND');
  });

  it('aborts on a symlinked index.html, asset, assets folder or document folder (step 3)', async () => {
    const outside = path.join(base, 'outside.html');
    await writeFile(outside, 'secret');

    await rm(path.join(docDir, 'index.html'));
    await symlink(outside, path.join(docDir, 'index.html'));
    expect(await code(buildPublishFileSet('widget-pricing', docDir))).toBe('E_PUBLISH_FAILED');
    await rm(path.join(docDir, 'index.html'));
    await writeFile(path.join(docDir, 'index.html'), HTML);

    await mkdir(path.join(docDir, 'assets'));
    await symlink(outside, path.join(docDir, 'assets', 'a.css'));
    expect(await code(buildPublishFileSet('widget-pricing', docDir))).toBe('E_PUBLISH_FAILED');
    await rm(path.join(docDir, 'assets'), { recursive: true });

    await symlink(base, path.join(docDir, 'assets'));
    expect(await code(buildPublishFileSet('widget-pricing', docDir))).toBe('E_PUBLISH_FAILED');

    const link = path.join(base, 'linked-doc');
    await symlink(docDir, link);
    expect(await code(buildPublishFileSet('linked-doc', link))).toBe('E_PUBLISH_FAILED');
  });

  it('aborts when the set is larger than 25 MB (step 4)', async () => {
    expect(MAX_PUBLISH_BYTES).toBe(25 * 1024 * 1024);
    await writeFile(path.join(docDir, 'index.html'), Buffer.alloc(MAX_PUBLISH_BYTES + 1, 0x61));
    const err = await buildPublishFileSet('widget-pricing', docDir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).message).toBe('Document too large to publish');
  });
});
