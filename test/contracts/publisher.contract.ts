/**
 * Publisher contract suite (13 §10.2). Public and private publishers run identical assertions:
 * describe() reports the target; publish() sends exactly the documented file set (10 §3.3) and
 * returns a PublishResult with one primary link, or a typed PublishError; republishing is
 * idempotent; remote publishers (kind `git`, and `drive` when `scansBeforeUpload`, HOOK-PUB-05)
 * run the secret scan before anything is uploaded. The local publisher is not required to scan.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Settings } from '../../src/main/config';
import {
  buildPublishFileSet,
  PublishError,
  type PublishContext,
  type Publisher,
  type PublishFile,
  type PublishResult,
  type PublishStage,
  type PublishTarget,
} from '../../src/main/publish';

const STAGES: readonly PublishStage[] = [
  'preparing',
  'scanning',
  'uploading',
  'sharing',
  'committing',
  'pushing',
  'waiting-for-site',
  'done',
];

export const CONTRACT_SLUG = 'contract-widgets';
export const SECRET_SLUG = 'contract-leaky';

/** A code-host-token-shaped value, assembled at runtime so the repo holds no secret literal. */
export function fakeSecretLine(): string {
  const body = Array.from({ length: 36 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
  return `token: ${['gh', 'p_'].join('')}${body}`;
}

/** Where a contract run writes: a temp library with two documents and an export directory. */
export interface PublisherFixture {
  root: string;
  settings: Settings;
  exportDir: string;
  docDir(slug: string): string;
}

export interface PublisherContractOptions {
  /** true when the publisher sends files off the machine and must scan first (default: kind === 'git'). */
  scansBeforeUpload?: boolean;
  /**
   * Relative paths the publisher actually delivered for `slug` (export folder contents, a recording
   * fake's last upload). Enables the "exactly the file set" and "nothing uploaded" checks.
   */
  delivered?: (fx: PublisherFixture, slug: string) => Promise<string[]>;
}

async function writeDoc(dir: string, html: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html);
  // Never part of the file set (10 §3.3 step 3).
  await writeFile(path.join(dir, 'meta.json'), '{"schema":1}\n');
  await writeFile(path.join(dir, '.draft'), 'hidden\n');
}

function context(fx: PublisherFixture, slug: string, files: readonly PublishFile[], stages: PublishStage[]) {
  const ctl = new AbortController();
  const ctx: PublishContext = {
    slug,
    title: 'Example Widgets Inc. supply plan',
    files,
    settings: fx.settings,
    signal: ctl.signal,
    progress: (s) => void stages.push(s),
    libraryRoot: path.join(fx.root, 'library'),
  };
  return { ctx, ctl };
}

function expectResult(r: PublishResult, target: PublishTarget, slug: string, files: readonly PublishFile[]): void {
  expect(r.targetId).toBe(target.id);
  expect(r.kind).toBe(target.kind);
  expect(r.slug).toBe(slug);
  expect(new Date(r.publishedAt).toISOString()).toBe(r.publishedAt);
  expect([...r.files].sort()).toEqual(files.map((f) => f.relPath).sort());
  expect(r.links.length).toBeGreaterThan(0);
  expect(r.links.filter((l) => l.primary)).toHaveLength(1);
  for (const l of r.links) {
    expect(['file', 'share', 'site', 'commit']).toContain(l.kind);
    expect(l.label.length).toBeGreaterThan(0);
    expect(l.url).toMatch(target.kind === 'local' ? /^file:\/\// : /^https:\/\//);
  }
  expect(Array.isArray(r.warnings)).toBe(true);
}

export function describePublisherContract(
  name: string,
  make: (fx: PublisherFixture) => Promise<Publisher>,
  target: PublishTarget,
  opts: PublisherContractOptions = {},
): void {
  const scans = opts.scansBeforeUpload ?? target.kind === 'git';

  describe(`Publisher contract: ${name}`, () => {
    const fx: PublisherFixture = {
      root: '',
      settings: DEFAULTS,
      exportDir: '',
      docDir: (slug) => path.join(fx.root, 'library', 'docs', slug),
    };

    beforeAll(async () => {
      fx.root = await mkdtemp(path.join(tmpdir(), 'eli5-publisher-contract-'));
      fx.exportDir = path.join(fx.root, 'export');
      fx.settings = { ...DEFAULTS, publish: { ...DEFAULTS.publish, local: { dir: fx.exportDir, revealAfter: false } } };
      await writeDoc(fx.docDir(CONTRACT_SLUG), '<!doctype html><title>Widgets</title><p>Example Widgets Inc.</p>\n');
      await writeDoc(fx.docDir(SECRET_SLUG), `<!doctype html><title>Leaky</title><pre>${fakeSecretLine()}</pre>\n`);
    });

    afterAll(async () => {
      await rm(fx.root, { recursive: true, force: true });
    });

    const fileSet = (slug: string) => buildPublishFileSet(slug, fx.docDir(slug));

    it('describe() reports the target without side effects', async () => {
      const p = await make(fx);
      expect(p.id).toBe(target.id);
      expect(p.kind).toBe(target.kind);
      expect(p.stub).toBeUndefined();
      const t = await p.describe(CONTRACT_SLUG, fx.settings);
      expect(t).toMatchObject({ id: target.id, kind: target.kind, available: target.available });
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.unavailableReason ?? '').not.toMatch(/HOOK-/);
      expect(typeof t.requiresSignIn).toBe('boolean');
      if (opts.delivered) expect(await opts.delivered(fx, CONTRACT_SLUG)).toEqual([]);
    });

    it('publishes exactly the documented file set and returns one primary link', async () => {
      const p = await make(fx);
      const files = await fileSet(CONTRACT_SLUG);
      expect(files.map((f) => f.relPath)).toEqual(['index.html']);
      const stages: PublishStage[] = [];
      const r = await p.publish(context(fx, CONTRACT_SLUG, files, stages).ctx);
      expectResult(r, target, CONTRACT_SLUG, files);
      for (const s of stages) expect(STAGES).toContain(s);
      if (opts.delivered) expect((await opts.delivered(fx, CONTRACT_SLUG)).sort()).toEqual(['index.html']);
    });

    it('republishing is idempotent', async () => {
      const p = await make(fx);
      const files = await fileSet(CONTRACT_SLUG);
      const a = await p.publish(context(fx, CONTRACT_SLUG, files, []).ctx);
      const b = await p.publish(context(fx, CONTRACT_SLUG, files, []).ctx);
      expect(b.files).toEqual(a.files);
      expect(b.links.find((l) => l.primary)?.url).toBe(a.links.find((l) => l.primary)?.url);
      if (opts.delivered) expect((await opts.delivered(fx, CONTRACT_SLUG)).sort()).toEqual(['index.html']);
    });

    it('a cancelled publish fails with a typed PublishError', async () => {
      const p = await make(fx);
      const { ctx, ctl } = context(fx, CONTRACT_SLUG, await fileSet(CONTRACT_SLUG), []);
      ctl.abort();
      const e = await p.publish(ctx).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PublishError);
      expect((e as PublishError).code).toBe('E_PUBLISH_CANCELLED');
    });

    if (scans) {
      it('runs the secret scan before upload and sends nothing when it finds one', async () => {
        const p = await make(fx);
        const stages: PublishStage[] = [];
        const e = await p
          .publish(context(fx, SECRET_SLUG, await fileSet(SECRET_SLUG), stages).ctx)
          .catch((x: unknown) => x);
        expect(e).toBeInstanceOf(PublishError);
        expect((e as PublishError).code).toBe('E_PUBLISH_SECRET_FOUND');
        const findings = (e as PublishError).findings ?? [];
        expect(findings.length).toBeGreaterThan(0);
        // Findings are masked: the secret never travels with the error.
        expect(JSON.stringify(findings)).not.toContain(fakeSecretLine().slice(7));
        expect(stages).toContain('scanning');
        expect(stages).not.toContain('done');
        if (opts.delivered) expect(await opts.delivered(fx, SECRET_SLUG)).toEqual([]);
      });
    }
  });
}
