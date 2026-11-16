/**
 * Retained source text never leaves the machine (09 §4.4 "Never exposed", 12 §10, 16 §9): not over
 * eli5doc://, not in a publish file set, not in a sync push, not in the logs. Uses a real FsLibrary
 * on a temp root (MemLibrary has no folders, so it would prove nothing).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocProtocolHandler, type FsLibrary } from '../../../../src/main/library';
import { buildPublishFileSet } from '../../../../src/main/publish';
import { createLogger, installLogger, MemorySink } from '../../../../src/main/security';
import {
  DriveAppDataStore,
  DriveClient,
  GuardedStore,
  SyncEngine,
  SyncStateStore,
  type EngineTimers,
} from '../../../../src/main/sync';
import { HTML, createDoc, testLibrary } from '../library/fixtures';
import { FakeDrive, fakeAuth } from './fake-drive';

const CANARY = 'CANARYz9widgetsidecar';
const DEV = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const timers: EngineTimers = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
};

/** A real document with a sidecar holding the canary, and a later version. */
async function docWithSidecar(lib: FsLibrary): Promise<string> {
  const entry = await createDoc(lib, 'Widget pricing');
  const slug = entry.topicSlug;
  await lib.withDocLock(slug, () =>
    lib.upsertSources(slug, [
      {
        ref: 'ledger.md',
        label: 'Ledger',
        kind: 'file',
        mime: 'text/markdown',
        format: 'markdown',
        text: `Example Widgets Inc. ledger ${CANARY}`,
        chars: 40,
        extractTruncated: false,
      },
    ]),
  );
  await lib.withDocLock(slug, () =>
    lib.updateDocument(slug, { html: HTML.replace('</h1>', '</h1><p>more</p>'), meta: (m) => m, label: 'edit' }),
  );
  expect((await lib.readSources(slug))?.texts['src-01']).toContain(CANARY);
  return slug;
}

describe('the sidecar is never exposed', () => {
  it('eli5doc:// refuses .sources paths', async () => {
    const { lib } = await testLibrary();
    const slug = await docWithSidecar(lib);
    const handler = createDocProtocolHandler({ root: lib.root, isCatalogued: (s) => lib.hasSlug(s) });
    for (const p of [
      '.sources/manifest.json',
      '.sources/src-01.md',
      '%2Esources/src-01.md',
      'x/../.sources/src-01.md',
    ]) {
      const res = await handler(new Request(`eli5doc://doc/${slug}/${p}`));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(CANARY);
    }
    expect((await handler(new Request(`eli5doc://doc/${slug}/index.html`))).status).toBe(200);
  });

  it('buildPublishFileSet excludes the sidecar', async () => {
    const { lib } = await testLibrary();
    const slug = await docWithSidecar(lib);
    const files = await buildPublishFileSet(slug, path.join(lib.root, slug));
    expect(files.map((f) => f.relPath)).toEqual(['index.html']);
  });

  it('a sync push through the real engine uploads nothing containing the source text, and logs none', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ sink, level: () => 'debug' });
    installLogger(logger);
    try {
      const { lib } = await testLibrary({ logger });
      await docWithSidecar(lib);
      const drive = new FakeDrive();
      const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-sources-'));
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
        outline: () => ['Overview'],
        isBusy: () => false,
        device: { name: 'Example Mac', appVersion: '0.2.0' },
        now: () => Date.parse('2026-11-01T12:00:00Z'),
        timers,
      });
      await engine.syncNow();
      const files = [...drive.files.values()];
      expect(files.some((f) => f.appProperties.k === 'blob')).toBe(true);
      for (const f of files) {
        let body = Buffer.from(f.body);
        if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
        expect(body.toString('utf8')).not.toContain(CANARY);
        expect(JSON.stringify(f.appProperties) + f.name).not.toContain(CANARY);
      }
      engine.stop();
      await lib.close();
      expect(sink.lines.join('\n')).not.toContain(CANARY);
    } finally {
      installLogger(createLogger({ sink: { write: () => {} } }));
    }
  });
});
