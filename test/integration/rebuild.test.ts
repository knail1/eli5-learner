/**
 * Rebuild-as-new-version end to end (design §5, D19-D20): the rehearsal driver over the real
 * registry wiring, JobQueue, stages, document builder and library, with FakeProvider. A document is
 * created, rebuilt as a new version, verified, then the old version is checked out and its html
 * must come back byte-for-byte. Offline; nothing is spent.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../../src/main/config';
import { DEFAULTS, type Settings } from '../../src/main/config/schema';
import { prepareRealRun, startRebuildRun, verifyRebuild } from '../../src/main/devtools';
import { bundledDocRuntime, type DocRuntime } from '../../src/main/document';
import { registerPublicCapabilities } from '../../src/main/editions/public';
import { Registry } from '../../src/main/editions/registry';
import { openLibrary, type DocumentMeta } from '../../src/main/library';
import { FakeProvider, loadFakeScript } from '../../src/main/llm/testing/fake';
import { createPipelineDeps, isTerminal, JobQueue, type Job } from '../../src/main/pipeline';
import type { SourceInput } from '../../src/preload/contract';
import { fakeServices } from '../contracts/extractor.contract';
import { STUB_RUNTIME } from '../fixtures/documents/runtime';
import { FakeClock } from '../helpers/clock';
import { validateDocument } from '../helpers/doc-validity';
import { SeededIdSource } from '../helpers/ids';
import { tmpLibrary } from '../helpers/tmp-library';

const REPO = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures');
const SOURCE = path.join(FIXTURES, 'sources/text/notes.md');
const read = (p: string): string => readFileSync(p, 'utf8');
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const runtime = (): DocRuntime => {
  try {
    return bundledDocRuntime();
  } catch {
    return STUB_RUNTIME;
  }
};

async function launch() {
  const { userData } = await tmpLibrary();
  const clock = new FakeClock('2026-04-01T09:00:00.000Z');
  const settings: Settings = { ...DEFAULTS };
  const fake = new FakeProvider(loadFakeScript(path.join(FIXTURES, 'llm/default.json'), read));
  const registry = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(registry);
  registry.registerLLMProvider('claude', () => fake);
  registry.freeze();
  const lib = await openLibrary({
    rootInput: { isPackaged: false, repoRoot: '/nonexistent-repo', userData, env: process.env },
    appVersion: '0.0.0-test',
    clock,
    ids: new SeededIdSource(3),
    processLock: false,
  });
  const services = fakeServices();
  let jobSeq = 0;
  const rt = createPipelineDeps({
    registry,
    settings: () => settings,
    keyStore: new MemoryKeyStore({}),
    library: lib,
    userData,
    resourcePath: (rel) => path.join(REPO, 'resources', rel),
    promptsRoot: path.join(REPO, 'config/prompts'),
    workerEntry: 'unused-in-node',
    watchSkills: false,
    extractServices: { renderPdfPages: services.renderPdfPages, normalizeImage: services.normalizeImage },
    fetchUrl: () => Promise.reject(new Error('offline')),
    requireApiKey: false,
    overrides: {
      clock,
      ids: {
        jobId: () => `01JREB${String(++jobSeq).padStart(6, '0')}`,
        docId: () => '00000000-0000-4000-8000-000000000001',
      },
      sectionIds: new SeededIdSource(9),
      docRuntime: runtime(),
      sleep: async () => {},
    },
  });
  const queue = new JobQueue(rt.deps);
  await queue.init();
  const finished = (id: string): Promise<Job> =>
    new Promise((resolve) => {
      const check = (): boolean => {
        const j = queue.get(id);
        if (!j || !isTerminal(j.status)) return false;
        void queue.settled(id).then(() => resolve(queue.get(id) ?? j));
        return true;
      };
      if (check()) return;
      const off = queue.on('changed', () => {
        if (check()) off();
      });
    });
  return { userData, settings, fake, registry, lib, rt, queue, finished };
}

describe('rebuild as a new version (design §5)', () => {
  it('rehearsal rebuild verifies, and checking out the parent restores the old html byte-for-byte', async () => {
    const app = await launch();
    const input: SourceInput = { id: 'in-00000001', kind: 'file', origin: 'drop', path: SOURCE };
    const { jobId } = await app.queue.start({ inputs: [input], options: { clarifyingInput: '', glossary: true } });
    const created = await app.finished(jobId);
    expect(created.status).toBe('done');
    const slug = created.result?.topicSlug ?? '';
    const oldHtml = await readFile(app.lib.docPath(slug));
    const oldMeta = JSON.parse(await readFile(app.lib.docPath(slug, 'meta.json'), 'utf8')) as DocumentMeta;

    const session = prepareRealRun({
      env: {
        ELI5_REAL_RUN_REBUILD: `${slug}=${SOURCE}`,
        ELI5_REAL_RUN_BUDGET_USD: '1',
        ELI5_REAL_RUN_LEDGER: path.join(app.userData, 'fake-ledger.jsonl'),
        ELI5_LLM_FAKE: '1',
      },
      isPackaged: false,
      testBuild: true,
      userData: app.userData,
      registry: { frozen: false, registerLLMProvider: () => {} },
    });
    if (!session) throw new Error('rehearsal not armed');
    const out: string[] = [];
    const codes: number[] = [];
    const summary = await startRebuildRun({
      session,
      jobs: app.queue,
      library: app.lib,
      provider: () => app.registry.llm(),
      promptSet: app.rt.prompts.set,
      keyPresent: () => Promise.resolve(false),
      planInputs: { maxOutputTokens: () => 32_000, overheadTokens: () => 1_000 },
      stockPhotos: false,
      write: (t) => void out.push(t),
      quit: (c) => void codes.push(c),
    });

    expect(codes).toEqual([0]);
    expect(summary).toMatchObject({ ok: true, mode: 'rehearsal' });
    expect(summary.preflight[0]).toMatchObject({ slug, ok: true, shaMatches: true, baseHtmlSha256: sha(oldHtml) });
    const row = summary.docs[0];
    expect(row).toMatchObject({ slug, ok: true, status: 'done', eli5CritiqueAccepted: true });
    expect(row?.verify).toMatchObject({
      ok: true,
      validity: true,
      roundTrip: true,
      hasSte: true,
      catalogStable: true,
      jobNode: true,
      parentIsBase: true,
      parentHtmlMatches: true,
    });
    expect(row?.label).toMatch(/^Rebuilt with prompt set default \([0-9a-f]{8}\)$/);
    expect(row?.parentVersionId).toBe(summary.preflight[0]?.baseVersionId);

    const newHtml = await readFile(app.lib.docPath(slug));
    expect(sha(newHtml)).not.toBe(sha(oldHtml));
    const newMeta = JSON.parse(await readFile(app.lib.docPath(slug, 'meta.json'), 'utf8')) as DocumentMeta;
    expect(validateDocument(newHtml.toString('utf8'), newMeta).errors).toEqual([]);
    expect(newMeta).toMatchObject({ id: oldMeta.id, createdAt: oldMeta.createdAt, topicSlug: slug });

    // Roll back: the pre-rebuild version comes back exactly.
    const parentId = row?.parentVersionId ?? '';
    await app.lib.withDocLock(slug, () => app.lib.checkout(slug, parentId, { retiredIds: newMeta.retiredIds }));
    expect((await readFile(app.lib.docPath(slug))).equals(oldHtml)).toBe(true);
    // And forward again to the rebuilt one.
    const rebuiltId = row?.versionId ?? '';
    await app.lib.withDocLock(slug, () => app.lib.checkout(slug, rebuiltId, { retiredIds: newMeta.retiredIds }));
    expect((await readFile(app.lib.docPath(slug))).equals(newHtml)).toBe(true);
    // The verifier agrees on a direct call too (the parent is still the base).
    const again = await verifyRebuild(app.lib, {
      slug,
      jobId: row?.jobId ?? '',
      docId: oldMeta.id,
      createdAt: oldMeta.createdAt,
      baseVersionId: parentId,
      baseHtmlSha256: sha(oldHtml),
    });
    expect(again).toMatchObject({ ok: true, parentHtmlMatches: true });
  });
});
