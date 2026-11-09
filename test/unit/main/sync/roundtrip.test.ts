/**
 * The desktop half of the sync round trip (16 §12, S10 mobile parity): a library holding an old
 * two-tab document and a document rebuilt as a new version of itself (an ASD-STE100 tab with its
 * hint, a section ELI5 tab and sandboxed animation frames) is pushed through the real engine to the
 * in-memory Drive. What lands there is the shared contract `test/contracts/sync/roundtrip/library.json`,
 * which the phone's RoundTripTest (android/.../sync/RoundTripTest.kt) imports and renders.
 *
 * Blobs are recorded by the built fixture they hold (test/fixtures/documents/build), not as gzip
 * bytes, so the contract does not depend on a zlib version; the phone gzips the same file.
 *
 * Regenerate with ELI5_UPDATE_GOLDENS=1 npx vitest run test/unit/main/sync/roundtrip.test.ts (or as part
 * of `npm run test:update-goldens`). In update mode the fixtures are rendered here with the builder
 * golden.test.ts uses, not read from disk, so a run that rewrites them in parallel cannot leave this
 * contract pointing at their old bytes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument, renderDocument } from '../../../../src/main/document';
import { buildRuntime } from '../../../fixtures/documents/build-runtime';
import { fixtureDocument, type GoldenName } from '../../../fixtures/documents/models';
import {
  DriveAppDataStore,
  DriveClient,
  GuardedStore,
  SyncEngine,
  SyncStateStore,
  type EngineTimers,
} from '../../../../src/main/sync';
import { LibraryManifestSchema, VersionTreeSchema } from '../../../../src/main/sync/protocol';
import { FakeDrive, fakeAuth, type FakeFile } from './fake-drive';
import { MemLibrary, sha256 } from './mem-library';

const root = path.resolve(__dirname, '../../../..');
const BUILD = path.join(root, 'test/fixtures/documents/build');
const GOLDEN = path.join(root, 'test/contracts/sync/roundtrip/library.json');
const UPDATE = process.env.ELI5_UPDATE_GOLDENS === '1';
const DEV = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const OLD_DOC = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const REBUILT_LABEL = 'Rebuilt with prompt set default (0123abcd)';
const dec = new TextDecoder();

/** The shape of the contract file: every Drive file in creation order. */
export interface RoundTripFile {
  name: string;
  mimeType: string;
  appProperties: Record<string, string>;
  /** A JSON file's exact text. */
  text?: string;
  /** A blob: the built fixture whose gzip it holds. */
  html?: string;
}

const FIXTURES = ['full', 'showcase', 'with-ste'] as const satisfies readonly GoldenName[];
const built = new Map<string, Buffer>();

/** The bytes of a built fixture: from disk, or freshly rendered when updating goldens. */
function fixture(file: `${(typeof FIXTURES)[number]}.html`): Buffer {
  const b = built.get(file);
  if (!b) throw new Error(`${file} not loaded`);
  return b;
}

async function loadFixtures(): Promise<void> {
  const runtime = UPDATE ? await buildRuntime() : undefined;
  for (const name of FIXTURES) {
    const file = `${name}.html`;
    if (!runtime) built.set(file, readFileSync(path.join(BUILD, file)));
    else {
      const { model, assets, theme } = fixtureDocument(name);
      built.set(file, Buffer.from(renderDocument(model, assets, { runtime, theme })));
    }
  }
}

/** 16 §4.4 headings, exactly as src/main/index.ts reads them for the manifest. */
function headings(html: Uint8Array): string[] {
  try {
    const { model } = parseDocument(Buffer.from(html).toString('utf8'));
    const tab = model.tabs.find((t) => t.kind === 'indepth');
    return (tab?.sections ?? []).filter((x) => x.kind === 'content').map((x) => x.heading);
  } catch {
    return [];
  }
}

const inertTimers: EngineTimers = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function pushLibrary() {
  const lib = new MemLibrary();
  const old = lib.add('Where the ad money goes', 1, { id: OLD_DOC, html: () => fixture('full.html').toString() });
  const showcase = parseDocument(fixture('showcase.html').toString()).model;
  const rebuilt = parseDocument(fixture('with-ste.html').toString()).model;
  const doc = lib.add('Getting a widget to the door', 1, {
    id: showcase.docId,
    html: () => fixture('showcase.html').toString(),
  });
  lib.addVersion(doc.entry.topicSlug, fixture('with-ste.html').toString(), {
    kind: 'outside',
    label: REBUILT_LABEL,
    topic: 'Rebuilt (default)',
  });
  // What the real rebuild save writes into meta.json (save.ts saveRebuild: `tabs: built.tabs`, from the
  // rebuilt model; test/unit/main/pipeline/stages/save.test.ts checks it ends in 'ste'). MemLibrary
  // stands in for the library, so the test applies the same patch.
  doc.meta.tabs = rebuilt.tabs.map((t) => ({
    key: t.key,
    kind: t.kind,
    label: t.label,
    sectionCount: t.sections.length,
    createdAt: doc.entry.createdAt,
  }));
  doc.entry.tabCount = rebuilt.tabs.length;

  const drive = new FakeDrive();
  const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-roundtrip-'));
  dirs.push(dir);
  const state = new SyncStateStore({ dir: path.join(dir, 'sync'), mintDeviceId: () => DEV });
  const engine = new SyncEngine({
    library: lib,
    state,
    active: () => true,
    openStore: (guard) =>
      new GuardedStore(
        new DriveAppDataStore(
          new DriveClient({ auth: fakeAuth(), fetch: drive.fetch, sessions: state, sleep: async () => {} }),
        ),
        guard,
      ),
    auth: { configured: async () => true, signedIn: async () => true },
    history: () => 'all',
    pollSeconds: () => 60,
    policy: () => ({ excludeDoc: () => false }),
    outline: headings,
    isBusy: () => false,
    device: { name: 'Example Mac', appVersion: '0.4.0' },
    now: () => Date.parse('2026-11-08T12:00:00Z'),
    timers: inertTimers,
  });
  await engine.syncNow();
  return { drive, old, doc };
}

/** Maps a blob back to the fixture it holds by sha256. */
function contractOf(drive: FakeDrive): RoundTripFile[] {
  const bySha = new Map([...built].map(([f, bytes]) => [sha256(bytes), f]));
  return [...drive.files.values()].map((f: FakeFile) => {
    const base = { name: f.name, mimeType: f.mimeType, appProperties: { ...f.appProperties } };
    if (!f.name.startsWith('blob-')) return { ...base, text: dec.decode(f.body) };
    const html = bySha.get(sha256(gunzipSync(f.body)));
    if (!html) throw new Error(`blob ${f.name} holds no known fixture`);
    return { ...base, html };
  });
}

describe('sync round trip, desktop half (16 §12, S10)', () => {
  // One push for both tests: MemLibrary numbers versions per module, so a second push would mint other ids.
  let pushed: Awaited<ReturnType<typeof pushLibrary>>;
  beforeAll(async () => {
    await loadFixtures();
    pushed = await pushLibrary();
  }, 60_000);

  it('pushes the rebuilt three-tab document as a new version, with the bytes unchanged', () => {
    const { drive, old, doc } = pushed;
    const files = [...drive.files.values()];
    const manifest = LibraryManifestSchema.parse(
      JSON.parse(dec.decode(files.find((f) => f.name.startsWith('lib-'))!.body)),
    );
    const entry = manifest.docs.find((d) => d.docId === doc.entry.id)!;
    // 'ste' stays out of the manifest (D21) so 0.3.0 phones keep parsing it; the phone reads the
    // tab labels, ASD-STE100 included, from the document itself.
    expect(entry.tabs).toEqual(['indepth', 'eli5', 'sx052c0b']);
    expect(entry.headings.length).toBeGreaterThan(1);
    expect(entry.currentSha).toBe(sha256(fixture('with-ste.html')));
    expect(manifest.docs.find((d) => d.docId === old.entry.id)!.tabs).toEqual(['indepth', 'eli5']);

    const tree = VersionTreeSchema.parse(
      JSON.parse(dec.decode(files.find((f) => f.name === `tree-${doc.entry.id}.json`)!.body)),
    );
    expect(tree.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['initial', 'first version'],
      ['outside', REBUILT_LABEL],
    ]);
    expect(tree.currentId).toBe(tree.nodes[1]!.id);
    expect(tree.nodes.every((n) => n.uploaded)).toBe(true);

    // Blobs are the exact desktop bytes: animation frames, CSP hashes and the STE hint survive.
    const blob = files.find((f) => f.appProperties.s === entry.currentSha)!;
    const html = gunzipSync(blob.body);
    expect(html.equals(fixture('with-ste.html'))).toBe(true);
    const text = html.toString();
    expect(text.match(/<iframe sandbox="allow-scripts" srcdoc=/g)?.length).toBeGreaterThan(0);
    expect(text).toContain('tab-hint-ste');
  });

  it('matches the shared contract the phone imports (ELI5_UPDATE_GOLDENS=1 rewrites it)', () => {
    const { drive } = pushed;
    const contract = {
      note: 'Generated by test/unit/main/sync/roundtrip.test.ts; read by android RoundTripTest. Do not edit.',
      files: contractOf(drive),
    };
    if (UPDATE) {
      mkdirSync(path.dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(contract, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(GOLDEN, 'utf8'))).toEqual(contract);
  });
});
