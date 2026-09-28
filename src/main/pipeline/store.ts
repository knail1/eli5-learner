// JobStore: job records and per-job staging under <userData>/jobs/ (06 §9.1-§9.3).
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExtractedContentSchema, type ExtractedContent, type ImageAsset } from '../extract';
import { writeFileAtomic, writeJsonAtomic } from '../library';
import { log as defaultLog, type Logger } from '../security';
import { parseJobRecord } from './job';
import type { Job, JobId, PipelineClock } from './types';

const DIR_MODE = 0o700;
const JOB_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
/** Progress-only writes: at most one per 500 ms (06 §9.1). */
export const PROGRESS_DEBOUNCE_MS = 500;
export const CORRUPT_DIR = 'corrupt';

export interface JobStoreOptions {
  clock: PipelineClock;
  debounceMs?: number;
  log?: Logger;
}

/** Image bytes live beside the JSON as `<sourceId>-<n>.bin`; the JSON keeps metadata only. */
type StoredImage = Omit<ImageAsset, 'data'> & { file: string };
type StoredContent = Omit<ExtractedContent, 'images'> & { images: StoredImage[] };

function assertJobId(id: string): void {
  if (!JOB_ID_RE.test(id)) throw new Error('Invalid job id');
}

function assertRel(rel: string): void {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('Invalid staging path');
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

interface Pending {
  job: Job;
  timer: ReturnType<typeof setTimeout>;
}

export class JobStore {
  private readonly debounceMs: number;
  private readonly log: Logger;
  private readonly lastWrite = new Map<JobId, number>();
  private readonly pending = new Map<JobId, Pending>();
  /** Serializes writes per job so an older snapshot never lands after a newer one. */
  private readonly chains = new Map<JobId, Promise<void>>();

  constructor(
    readonly dir: string,
    private readonly opts: JobStoreOptions,
  ) {
    this.debounceMs = opts.debounceMs ?? PROGRESS_DEBOUNCE_MS;
    this.log = opts.log ?? defaultLog;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
  }

  recordPath(id: JobId): string {
    assertJobId(id);
    return path.join(this.dir, `${id}.json`);
  }

  /** `<userData>/jobs/<jobId>/`: inputs/, downloads/, extracted/, gen/ (06 §9.2). */
  stagingDir(id: JobId): string {
    assertJobId(id);
    return path.join(this.dir, id);
  }

  /** Immediate atomic write (status transitions); supersedes a pending progress write. */
  save(job: Job): Promise<void> {
    const p = this.pending.get(job.id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(job.id);
    }
    return this.write(job);
  }

  /** Debounced write for progress-only changes (06 §9.1). */
  saveProgress(job: Job): void {
    const since = this.opts.clock.now().getTime() - (this.lastWrite.get(job.id) ?? -Infinity);
    const existing = this.pending.get(job.id);
    if (existing) {
      existing.job = job;
      return;
    }
    if (since >= this.debounceMs) {
      void this.write(job).catch(() => undefined);
      return;
    }
    const timer = setTimeout(
      () => {
        const p = this.pending.get(job.id);
        this.pending.delete(job.id);
        if (p) void this.write(p.job).catch(() => undefined);
      },
      Math.max(0, this.debounceMs - since),
    );
    timer.unref?.();
    this.pending.set(job.id, { job, timer });
  }

  /** Writes every pending progress record and waits for in-flight writes. */
  async flush(): Promise<void> {
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      void this.write(p.job).catch(() => undefined);
    }
    await Promise.all([...this.chains.values()].map((c) => c.catch(() => undefined)));
  }

  private write(job: Job): Promise<void> {
    const data = JSON.stringify(job, null, 2) + '\n';
    const file = this.recordPath(job.id);
    const prev = this.chains.get(job.id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => writeFileAtomic(file, data))
      .then(() => {
        this.lastWrite.set(job.id, this.opts.clock.now().getTime());
      });
    this.chains.set(job.id, next);
    const forget = (): void => {
      if (this.chains.get(job.id) === next) this.chains.delete(job.id);
    };
    next.then(forget, forget);
    return next;
  }

  /** Scans jobs/*.json (no index file); invalid records move to jobs/corrupt/ (06 §9.1). */
  async loadAll(): Promise<Job[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
    const out: Job[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(this.dir, name);
      let job: Job | null = null;
      try {
        job = parseJobRecord(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        job = null;
      }
      if (job && `${job.id}.json` === name) {
        out.push(job);
        continue;
      }
      await mkdir(path.join(this.dir, CORRUPT_DIR), { recursive: true, mode: DIR_MODE });
      await rename(file, path.join(this.dir, CORRUPT_DIR, name)).catch(() => undefined);
      this.log.warn('pipeline.job-record-corrupt', { path: name });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async removeRecord(id: JobId): Promise<void> {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
    await (this.chains.get(id) ?? Promise.resolve()).catch(() => undefined);
    await rm(this.recordPath(id), { force: true });
    this.lastWrite.delete(id);
  }

  async removeStaging(id: JobId): Promise<void> {
    await rm(this.stagingDir(id), { recursive: true, force: true });
  }

  // ---- staged artifacts ----

  private artifactPath(id: JobId, rel: string): string {
    assertRel(rel);
    return path.join(this.stagingDir(id), rel);
  }

  async writeJson(id: JobId, rel: string, value: unknown): Promise<void> {
    const file = this.artifactPath(id, rel);
    await mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
    await writeJsonAtomic(file, value);
  }

  /** Parsed JSON, or null when missing or unparseable (an invalid checkpoint artifact, 06 §9.3). */
  async readJson(id: JobId, rel: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.artifactPath(id, rel), 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  /** `extracted/<sourceId>.json` plus sibling image files (06 §5.3 step 4). */
  async writeExtracted(id: JobId, content: ExtractedContent): Promise<void> {
    const dir = this.artifactPath(id, 'extracted');
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const images: StoredImage[] = [];
    for (const [n, img] of content.images.entries()) {
      const file = `${content.sourceId}-${n}.bin`;
      await writeFile(path.join(dir, file), img.data, { mode: 0o600 });
      const { data: _data, ...meta } = img;
      images.push({ ...meta, file });
    }
    const stored: StoredContent = { ...content, images };
    await writeJsonAtomic(path.join(dir, `${content.sourceId}.json`), stored);
  }

  async readExtracted(id: JobId, sourceId: string): Promise<ExtractedContent | null> {
    assertRel(sourceId);
    const dir = this.artifactPath(id, 'extracted');
    try {
      const stored = JSON.parse(await readFile(path.join(dir, `${sourceId}.json`), 'utf8')) as StoredContent;
      const images: ImageAsset[] = [];
      for (const { file, ...meta } of stored.images) {
        assertRel(file);
        images.push({ ...meta, data: new Uint8Array(await readFile(path.join(dir, file))) });
      }
      const parsed = ExtractedContentSchema.safeParse({ ...stored, images });
      return parsed.success ? (parsed.data as ExtractedContent) : null;
    } catch {
      return null;
    }
  }
}
