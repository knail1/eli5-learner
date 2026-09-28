/** Synthetic library fixtures (13 §4: "Example Widgets Inc." material only). */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FakeClock } from '../../../helpers/clock';
import { SeededIdSource } from '../../../helpers/ids';
import { tmpLibrary } from '../../../helpers/tmp-library';
import { openLibrary, type DocumentMeta, type FsLibrary, type OpenLibraryOptions } from '../../../../src/main/library';

export const TS = '2026-01-01T00:00:00.000Z';

let counter = 0;
/** A distinct valid v4 UUID per call. */
export function uuid(n = ++counter): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function makeMeta(over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    schemaVersion: 1,
    id: uuid(),
    topicSlug: 'widget-pricing',
    title: 'Widget pricing at Example Widgets Inc.',
    summary: 'How Example Widgets Inc. prices its widgets.',
    summarySource: 'llm',
    createdAt: TS,
    updatedAt: TS,
    jobId: 'job-1',
    edition: 'public',
    clarifyingInput: '',
    glossaryEnabled: true,
    sourcesUsed: [{ ref: 'widgets.pdf', kind: 'file' }],
    sourcesSkipped: [],
    tabs: [
      { key: 'indepth', kind: 'indepth', label: 'In depth', sectionCount: 4, createdAt: TS },
      { key: 'eli5', kind: 'eli5', label: 'ELI5', sectionCount: 3, createdAt: TS },
    ],
    retiredIds: [],
    generation: { provider: 'claude', model: 'test-model', prompts: ['in-depth@1'] },
    warnings: [],
    merges: [],
    publications: [],
    ...over,
  };
}

export const HTML = '<!doctype html><html><body><h1>Example Widgets Inc.</h1></body></html>\n';

/** Writes a finished document folder straight to disk (as if created earlier or by Finder). */
export async function writeDocFolder(root: string, meta: DocumentMeta, html = HTML): Promise<string> {
  const dir = path.join(root, meta.topicSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html);
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return dir;
}

export interface TestLibrary {
  lib: FsLibrary;
  libraryDir: string;
  clock: FakeClock;
  open: (extra?: Partial<OpenLibraryOptions>) => Promise<FsLibrary>;
}

/** tmpLibrary() + openLibrary with a fake clock and seeded ids, resolving the root via ELI5_LIBRARY_DIR. */
export async function testLibrary(extra: Partial<OpenLibraryOptions> = {}): Promise<TestLibrary> {
  const { userData } = await tmpLibrary();
  const clock = new FakeClock('2026-02-01T00:00:00.000Z');
  const open = (more: Partial<OpenLibraryOptions> = {}) =>
    openLibrary({
      rootInput: { isPackaged: false, repoRoot: '/nonexistent-repo', userData, env: process.env },
      appVersion: '0.0.0-test',
      clock,
      ids: new SeededIdSource(7),
      ...extra,
      ...more,
    });
  const lib = await open();
  return { lib, libraryDir: lib.root, clock, open };
}

/** Stages index.html + meta.json the way the pipeline does (06 §5.7). */
export async function stage(lib: FsLibrary, jobId: string, meta: DocumentMeta): Promise<string> {
  const dir = await lib.stagingDir(jobId);
  await writeFile(path.join(dir, 'index.html'), HTML);
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

/** allocate + stage + commit. */
export async function createDoc(lib: FsLibrary, title: string, over: Partial<DocumentMeta> = {}) {
  const r = await lib.allocateSlug(title);
  const meta = makeMeta({ title, topicSlug: r.slug, ...over });
  const dir = await stage(lib, `job-${r.slug}`, meta);
  return lib.commitDocument(r, dir, meta);
}
