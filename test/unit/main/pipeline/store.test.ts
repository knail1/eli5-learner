import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore, createJob, snapshotOf, type Job } from '../../../../src/main/pipeline';
import type { ExtractedContent } from '../../../../src/main/extract';
import { FakeClock } from '../../../helpers/clock';
import { tmpLibrary } from '../../../helpers/tmp-library';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function job(over: Partial<Job> = {}): Job {
  return {
    ...createJob({
      id: '01J0000000000000000000000A',
      kind: 'create',
      now: new Date('2026-01-01T00:00:00Z'),
      inputs: [{ id: 'in-1', kind: 'url', origin: 'url-field', url: 'https://example.com/a' }],
      options: { clarifyingInput: '', glossary: true },
    }),
    ...over,
  };
}

async function store(clock = new FakeClock()): Promise<{ s: JobStore; dir: string; clock: FakeClock }> {
  const { userData } = await tmpLibrary();
  const dir = path.join(userData, 'jobs');
  const s = new JobStore(dir, { clock, debounceMs: 500 });
  await s.init();
  return { s, dir, clock };
}

describe('createJob (06 §3.1, §5.1 step 3)', () => {
  it('starts queued at attempt 1 with the planned steps', () => {
    const j = job();
    expect(j.status).toBe('queued');
    expect(j.attempt).toBe(1);
    expect(j.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(j.progress).toEqual({
      sourcesTotal: 1,
      sourcesDone: 0,
      stepsPlanned: ['indepth', 'eli5', 'glossary', 'summary'],
    });
    const noGlossary = createJob({ ...j, now: new Date(0), options: { clarifyingInput: '', glossary: false } });
    expect(noGlossary.progress.stepsPlanned).toEqual(['indepth', 'eli5', 'summary']);
  });
});

describe('snapshotOf (06 §3.1 JobSnapshot)', () => {
  it('carries no content and derives the action flags', () => {
    const j = job({ resolved: [], skipped: [{ ref: 'a', reason: 'x', code: 'not-found' }] });
    const s = snapshotOf(j, { queuePosition: 2 });
    expect(s).toEqual({
      id: j.id,
      kind: 'create',
      status: 'queued',
      statusLine: 'Queued (2 ahead)',
      createdAt: j.createdAt,
      queuePosition: 2,
      skippedCount: 1,
      canCancel: true,
      canRetry: false,
      canDismiss: false,
    });
    const failed = snapshotOf(job({ status: 'failed', failure: { code: 'LLM_AUTH', message: 'x', detail: 'secret' } }));
    expect(failed).toMatchObject({ failureCode: 'LLM_AUTH', canCancel: false, canRetry: true, canDismiss: true });
    expect(JSON.stringify(failed)).not.toContain('secret');
    const cancelled = snapshotOf(job({ status: 'failed', failure: { code: 'CANCELLED', message: '' } }));
    expect(cancelled.canRetry).toBe(false);
    expect(snapshotOf(job({ status: 'saving' }), { commitStarted: true }).canCancel).toBe(false);
  });
});

describe('JobStore (06 §9.1)', () => {
  it('writes records atomically as <jobId>.json with 0600 and reads them back', async () => {
    const { s, dir } = await store();
    const j = job();
    await s.save(j);
    const file = path.join(dir, `${j.id}.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(j);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    const all = await s.loadAll();
    expect(all).toEqual([j]);
  });

  it('debounces progress writes to one per 500 ms and flushes on save', async () => {
    const { s, dir, clock } = await store();
    const j = job();
    await s.save(j);
    const read = async (): Promise<Job> => JSON.parse(await readFile(path.join(dir, `${j.id}.json`), 'utf8')) as Job;
    j.progress.sourcesDone = 1;
    s.saveProgress(j); // pending, inside the window
    expect((await read()).progress.sourcesDone).toBe(0);
    clock.advance(600);
    j.progress.sourcesDone = 2;
    s.saveProgress(j);
    await s.flush();
    expect((await read()).progress.sourcesDone).toBe(2);
    j.status = 'reading';
    j.progress.sourcesDone = 3;
    s.saveProgress(j);
    await s.save(j); // a transition writes immediately and supersedes the pending progress write
    await s.flush();
    expect(await read()).toMatchObject({ status: 'reading', progress: { sourcesDone: 3 } });
  });

  it('moves a corrupt or invalid record to jobs/corrupt/ and keeps loading', async () => {
    const { s, dir } = await store();
    await s.save(job());
    await writeFile(path.join(dir, 'broken.json'), '{nope');
    await writeFile(path.join(dir, 'invalid.json'), JSON.stringify({ id: 'x', status: 'weird' }));
    const all = await s.loadAll();
    expect(all.map((j) => j.id)).toEqual(['01J0000000000000000000000A']);
    expect((await readdir(path.join(dir, 'corrupt'))).sort()).toEqual(['broken.json', 'invalid.json']);
  });

  it('round-trips extracted content with images as sibling binary files (06 §5.3 step 4)', async () => {
    const { s, dir } = await store();
    const j = job();
    const content: ExtractedContent = {
      sourceId: 'src-01',
      sourceRef: 'shot.png',
      format: 'png',
      blocks: [{ kind: 'image', imageId: 'abcdef01-img-1', origin: 'standalone' }],
      images: [
        {
          id: 'abcdef01-img-1',
          mediaType: 'image/png',
          data: new Uint8Array(PNG),
          width: 1,
          height: 1,
          byteLength: PNG.length,
          origin: 'standalone',
        },
      ],
      stats: { chars: 0, approxTokens: 0, imagesKept: 1, imagesDropped: 0, elapsedMs: 1 },
      warnings: [],
      truncated: false,
    };
    await s.writeExtracted(j.id, content);
    const files = (await readdir(path.join(dir, j.id, 'extracted'))).sort();
    expect(files).toEqual(['src-01-0.bin', 'src-01.json']);
    expect(await readFile(path.join(dir, j.id, 'extracted', 'src-01.json'), 'utf8')).not.toContain('iVBOR');
    const back = await s.readExtracted(j.id, 'src-01');
    expect(back?.images[0]?.data).toEqual(new Uint8Array(PNG));
    expect({ ...back, images: [] }).toEqual({ ...content, images: [] });
    expect(await s.readExtracted(j.id, 'src-02')).toBeNull();
  });

  it('stores generation outputs as JSON under gen/ and removes staging and records', async () => {
    const { s, dir } = await store();
    const j = job();
    await s.save(j);
    await s.writeJson(j.id, 'gen/summary.json', { summary: 'x' });
    expect(await s.readJson(j.id, 'gen/summary.json')).toEqual({ summary: 'x' });
    expect(await s.readJson(j.id, 'gen/missing.json')).toBeNull();
    await mkdir(path.join(dir, j.id, 'inputs'), { recursive: true });
    await s.removeStaging(j.id);
    await expect(stat(path.join(dir, j.id))).rejects.toThrow();
    await s.removeRecord(j.id);
    expect(await s.loadAll()).toEqual([]);
  });

  it('refuses job ids that are not path-safe', async () => {
    const { s } = await store();
    expect(() => s.stagingDir('../x')).toThrow();
  });
});
