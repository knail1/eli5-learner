import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import type { Settings } from '../../../../src/main/config';
import {
  LocalPublisher,
  PublishError,
  buildPublishFileSet,
  type PublishContext,
  type PublishStage,
} from '../../../../src/main/publish';

/** LocalPublisher (10 §5.1). */

const HTML = '<!doctype html><html><body><h1>Example Widgets Inc.</h1></body></html>\n';
const NOW = new Date('2026-03-04T05:06:07.000Z');

let base: string;
let libraryRoot: string;
let exportDir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'eli5-local-'));
  libraryRoot = path.join(base, 'docs');
  exportDir = path.join(base, 'Export Folder');
  await mkdir(path.join(libraryRoot, 'widget-pricing'), { recursive: true });
  await writeFile(path.join(libraryRoot, 'widget-pricing', 'index.html'), HTML);
  await writeFile(path.join(libraryRoot, 'widget-pricing', 'meta.json'), '{}');
});
afterEach(async () => {
  await chmod(base, 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

function settingsWith(dir: string, revealAfter = true): Settings {
  const s = structuredClone(DEFAULTS);
  s.publish.local.dir = dir;
  s.publish.local.revealAfter = revealAfter;
  return s;
}

async function ctx(over: Partial<PublishContext> = {}): Promise<PublishContext & { stages: PublishStage[] }> {
  const stages: PublishStage[] = [];
  return {
    slug: 'widget-pricing',
    title: 'Widget pricing',
    files: await buildPublishFileSet('widget-pricing', path.join(libraryRoot, 'widget-pricing')),
    settings: settingsWith(exportDir),
    signal: new AbortController().signal,
    progress: (s) => stages.push(s),
    libraryRoot,
    reveal: vi.fn(),
    stages,
    ...over,
  };
}

const publisher = () => new LocalPublisher({ now: () => NOW, randomHex: () => 'abcd1234' });

async function failure(p: Promise<unknown>): Promise<PublishError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PublishError);
  return err as PublishError;
}

describe('LocalPublisher.publish (10 §5.1)', () => {
  it('writes <dir>/<slug>/index.html byte-identical, no meta.json, and returns one primary file: link', async () => {
    const c = await ctx();
    const result = await publisher().publish(c);
    const out = path.join(exportDir, 'widget-pricing', 'index.html');
    expect(await readFile(out, 'utf8')).toBe(HTML);
    expect(await readdir(path.join(exportDir, 'widget-pricing'))).toEqual(['index.html']);
    expect(result).toEqual({
      targetId: 'local',
      kind: 'local',
      slug: 'widget-pricing',
      publishedAt: NOW.toISOString(),
      files: ['index.html'],
      links: [{ kind: 'file', url: pathToFileURL(out).href, label: 'Open copy', primary: true }],
      warnings: [],
    });
    expect(result.links[0]?.url).toContain('Export%20Folder');
  });

  it('expands ~ in publish.local.dir', async () => {
    const home = path.join(base, 'home');
    const c = await ctx({ settings: settingsWith('~/Exports') });
    const r = await new LocalPublisher({ home, now: () => NOW }).publish(c);
    expect(await readFile(path.join(home, 'Exports', 'widget-pricing', 'index.html'), 'utf8')).toBe(HTML);
    expect(r.links[0]?.url).toBe(pathToFileURL(path.join(home, 'Exports', 'widget-pricing', 'index.html')).href);
  });

  it('republishing overwrites the previous export atomically and leaves no temp files', async () => {
    await publisher().publish(await ctx());
    const html2 = HTML.replace('Example', 'Updated Example');
    await writeFile(path.join(libraryRoot, 'widget-pricing', 'index.html'), html2);
    await publisher().publish(await ctx());
    expect(await readFile(path.join(exportDir, 'widget-pricing', 'index.html'), 'utf8')).toBe(html2);
    expect(await readdir(path.join(exportDir, 'widget-pricing'))).toEqual(['index.html']);
  });

  it('reveals the exported file only when revealAfter is on', async () => {
    const on = await ctx();
    await publisher().publish(on);
    expect(on.reveal).toHaveBeenCalledWith(path.join(exportDir, 'widget-pricing', 'index.html'));
    const off = await ctx({ settings: settingsWith(exportDir, false) });
    await publisher().publish(off);
    expect(off.reveal).not.toHaveBeenCalled();
  });

  it('a failing reveal does not fail the export', async () => {
    const c = await ctx({
      reveal: () => {
        throw new Error('no Finder');
      },
    });
    await expect(publisher().publish(c)).resolves.toMatchObject({ targetId: 'local' });
  });

  it.each([
    ['the library root itself', () => libraryRoot],
    ['a folder inside the library', () => path.join(libraryRoot, 'exports')],
    ['a folder that contains the library as <dir>/<slug>', () => base],
  ])('rejects exporting into %s with E_PUBLISH_DESTINATION', async (_n, dir) => {
    const slugDir = path.join(base, 'docs');
    // For the "contains" case the slug folder would be the library itself.
    const c = await ctx({ settings: settingsWith(dir()) });
    if (dir() === base) c.slug = path.basename(slugDir);
    const err = await failure(publisher().publish(c));
    expect(err.code).toBe('E_PUBLISH_DESTINATION');
  });

  it('rejects a destination that reaches the library through a symlink', async () => {
    const link = path.join(base, 'sneaky');
    await symlink(libraryRoot, link);
    const err = await failure(publisher().publish(await ctx({ settings: settingsWith(path.join(link, 'x')) })));
    expect(err.code).toBe('E_PUBLISH_DESTINATION');
  });

  it('maps an unwritable folder to E_PUBLISH_DESTINATION naming the folder', async () => {
    const locked = path.join(base, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    const err = await failure(publisher().publish(await ctx({ settings: settingsWith(locked) })));
    expect(err.code).toBe('E_PUBLISH_DESTINATION');
    expect(err.message).toContain('locked');
  });

  it('maps ENOENT on mkdir to "Folder is not available" (unmounted volume)', async () => {
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const p = new LocalPublisher({ now: () => NOW, mkdir: () => Promise.reject(enoent) });
    const err = await failure(p.publish(await ctx()));
    expect(err.code).toBe('E_PUBLISH_DESTINATION');
    expect(err.message).toBe('Folder is not available. Is the drive connected?');
  });

  it('fails and removes the temp file when the copy does not match the source sha256 (step 4)', async () => {
    const c = await ctx();
    await writeFile(path.join(libraryRoot, 'widget-pricing', 'index.html'), 'changed underneath');
    const err = await failure(publisher().publish(c));
    expect(err.code).toBe('E_PUBLISH_FAILED');
    expect(await readdir(path.join(exportDir, 'widget-pricing'))).toEqual([]);
  });

  it('honors a cancelled signal with E_PUBLISH_CANCELLED and writes nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await failure(publisher().publish(await ctx({ signal: ac.signal })));
    expect(err.code).toBe('E_PUBLISH_CANCELLED');
    await expect(readFile(path.join(exportDir, 'widget-pricing', 'index.html'))).rejects.toThrow();
  });
});

describe('LocalPublisher.describe (10 §5.1)', () => {
  it('is always available and previews the destination with ~ abbreviated', async () => {
    const home = path.join(base, 'home');
    const t = await new LocalPublisher({ home }).describe('widget-pricing', settingsWith('~/Missing Folder'));
    expect(t).toEqual({
      id: 'local',
      kind: 'local',
      label: 'Export copy',
      available: true,
      destinationPreview: '~/Missing Folder/widget-pricing/',
      requiresSignIn: false,
    });
  });
});
