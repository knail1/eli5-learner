import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import type { Settings } from '../../../../src/main/config';
import { NotAvailableInEdition, Registry } from '../../../../src/main/editions';
import type { PublishService, PublishServiceProgress } from '../../../../src/main/ipc/publish';
import { LibraryError, type FsLibrary } from '../../../../src/main/library';
import {
  BaselineSecretScanner,
  PublishError,
  PublishRequestError,
  createPublishService,
  registerPublic,
  type PrePublishPolicy,
  type PublishContext,
  type Publisher,
  type PublishResult,
  type PublishTarget,
  type SecretScanner,
} from '../../../../src/main/publish';
import { HTML, createDoc, testLibrary } from '../library/fixtures';

/** Publish service (10 §4, §6, §7). Real FsLibrary on a temp root; fake publishers where needed. */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

class FakePublisher implements Publisher {
  readonly kind: Publisher['kind'];
  calls: PublishContext[] = [];
  impl: (ctx: PublishContext) => Promise<PublishResult>;
  constructor(
    readonly id: string,
    kind: Publisher['kind'] = 'git',
  ) {
    this.kind = kind;
    this.impl = async (ctx) => ({
      targetId: this.id,
      kind: this.kind,
      slug: ctx.slug,
      publishedAt: '2026-02-01T00:00:00.000Z',
      files: ctx.files.map((f) => f.relPath),
      links: [
        { kind: 'commit', url: 'https://code.example.com/c/1', label: 'Commit', primary: false },
        { kind: 'site', url: `https://pages.example.com/${ctx.slug}/`, label: 'Pages URL', primary: true },
      ],
      warnings: [],
    });
  }
  describe(): Promise<PublishTarget> {
    return Promise.resolve({ id: this.id, kind: this.kind, label: this.id, available: true, requiresSignIn: false });
  }
  publish(ctx: PublishContext): Promise<PublishResult> {
    this.calls.push(ctx);
    return this.impl(ctx);
  }
}

interface World {
  lib: FsLibrary;
  clock: { advance(ms: number): void };
  slug: string;
  exportDir: string;
  settings: Settings;
  registry: Registry;
  fakes: Map<string, FakePublisher>;
  scanner: SecretScanner & { scan: ReturnType<typeof vi.fn> };
  policy: ReturnType<typeof vi.fn<PrePublishPolicy>>;
  clipboard: { writeText: Mock<(text: string) => void> };
  openExternal: Mock<(url: string) => Promise<boolean>>;
  openPath: Mock<(absPath: string) => Promise<string>>;
  showItemInFolder: Mock<(absPath: string) => void>;
  svc: ReturnType<typeof createPublishService>;
  events: PublishServiceProgress[];
}

let w: World;

async function world(extraPublishers: string[] = []): Promise<World> {
  const { lib, clock } = await testLibrary();
  const entry = await createDoc(lib, 'Widget pricing');
  const exportDir = await mkdtemp(path.join(tmpdir(), 'eli5-export-'));
  const settings = structuredClone(DEFAULTS);
  settings.publish.local.dir = exportDir;
  settings.publish.local.revealAfter = false;
  const registry = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublic(registry);
  const fakes = new Map<string, FakePublisher>();
  for (const id of extraPublishers) {
    const f = new FakePublisher(id);
    fakes.set(id, f);
    registry.registerPublisher(id, () => f);
  }
  const scanner = { id: 'test', scan: vi.fn(async () => []) };
  registry.registerSecretScanner(scanner);
  const policy = vi.fn<PrePublishPolicy>(async () => ({ allow: true }));
  registry.registerPrePublishPolicy(policy);
  const clipboard = { writeText: vi.fn<(text: string) => void>() };
  const openExternal = vi.fn<(url: string) => Promise<boolean>>(async () => true);
  const openPath = vi.fn<(absPath: string) => Promise<string>>(async () => '');
  const showItemInFolder = vi.fn<(absPath: string) => void>();
  const svc = createPublishService({
    registry,
    library: lib,
    settings: () => settings,
    clipboard,
    openExternal,
    openPath,
    showItemInFolder,
  });
  const events: PublishServiceProgress[] = [];
  svc.onProgress((e) => events.push(e));
  const out: World = {
    lib,
    clock,
    slug: entry.topicSlug,
    exportDir,
    settings,
    registry,
    fakes,
    scanner,
    policy,
    clipboard,
    openExternal,
    openPath,
    showItemInFolder,
    svc,
    events,
  };
  return out;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

beforeEach(async () => {
  w = await world();
  return () => rm(w.exportDir, { recursive: true, force: true });
});

describe('createPublishService', () => {
  it('satisfies the IPC PublishService interface', () => {
    const svc: PublishService = w.svc;
    expect(typeof svc.run).toBe('function');
  });
});

describe('targets (10 §4 listTargets)', () => {
  it('lists local, drive, git then overlay ids alphabetically, stubs unavailable', async () => {
    w = await world(['zeta', 'alpha']);
    const targets = await w.svc.targets(w.slug);
    expect(targets.map((t) => [t.id, t.available])).toEqual([
      ['local', true],
      ['drive', false],
      ['git', false],
      ['alpha', true],
      ['zeta', true],
    ]);
    expect(targets[0]?.destinationPreview).toBe(`${path.join(w.exportDir, w.slug)}/`);
  });

  it('attaches lastPublished and flags "Changed since last publish" after the document changes', async () => {
    expect((await w.svc.targets(w.slug))[0]?.lastPublished).toBeUndefined();
    await w.svc.run(w.slug, 'local');
    let local = (await w.svc.targets(w.slug))[0];
    expect(local?.lastPublished).toMatchObject({ targetId: 'local', contentSha256: sha(HTML) });
    expect(local?.changedSincePublish).toBe(false);
    await w.lib.withDocLock(w.slug, () => w.lib.updateDocument(w.slug, { html: HTML + '<!-- v2 -->', meta: (m) => m }));
    local = (await w.svc.targets(w.slug))[0];
    expect(local?.changedSincePublish).toBe(true);
  });

  it('rejects an unknown document with LibraryError NOT_FOUND', async () => {
    const err = await rejection(w.svc.targets('no-such-doc'));
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe('NOT_FOUND');
  });
});

describe('run (10 §4 runPublish)', () => {
  it('exports locally, emits preparing then done, and appends a PublicationRecord', async () => {
    const result = await w.svc.run(w.slug, 'local');
    const out = path.join(w.exportDir, w.slug, 'index.html');
    expect(await readFile(out, 'utf8')).toBe(HTML);
    expect(result.links).toEqual([{ kind: 'file', url: pathToFileURL(out).href, label: 'Open copy', primary: true }]);
    expect(w.events.map((e) => e.stage)).toEqual(['preparing', 'done']);
    expect(w.events[1]).toEqual({ slug: w.slug, targetId: 'local', stage: 'done', result });
    const meta = await w.lib.getMeta(w.slug);
    expect(meta.publications).toEqual([
      {
        targetId: 'local',
        kind: 'local',
        publishedAt: result.publishedAt,
        primaryUrl: pathToFileURL(out).href,
        contentSha256: sha(HTML),
      },
    ]);
    // The exported folder never holds meta.json or catalog.json.
    await expect(readFile(path.join(w.exportDir, w.slug, 'meta.json'))).rejects.toThrow();
  });

  it('recording history leaves the catalog, updatedAt and Library events alone (10 §4 step 7)', async () => {
    const before = await w.lib.getMeta(w.slug);
    const catalogBefore = await readFile(path.join(w.lib.root, 'catalog.json'), 'utf8');
    const changes: unknown[] = [];
    w.lib.on('changed', (e) => changes.push(e));
    w.clock.advance(60_000);
    await w.svc.run(w.slug, 'local');
    const after = await w.lib.getMeta(w.slug);
    expect(after.publications).toHaveLength(1);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await readFile(path.join(w.lib.root, 'catalog.json'), 'utf8')).toBe(catalogBefore);
    expect(w.lib.getEntry(w.slug)?.updatedAt).toBe(before.updatedAt);
    expect(changes).toEqual([]);
  });

  it('history returns records newest first', async () => {
    w = await world(['alpha']);
    await w.svc.run(w.slug, 'local');
    await w.svc.run(w.slug, 'alpha');
    const h = await w.svc.history(w.slug);
    expect(h.map((r) => r.targetId)).toEqual(['alpha', 'local']);
    expect(h[0]?.primaryUrl).toBe(`https://pages.example.com/${w.slug}/`);
  });

  it('rejects an unknown target with E_NOT_FOUND and an unknown document with NOT_FOUND', async () => {
    const err = await rejection(w.svc.run(w.slug, 'nowhere'));
    expect(err).toBeInstanceOf(PublishRequestError);
    expect((err as PublishRequestError).code).toBe('E_NOT_FOUND');
    const gone = await rejection(w.svc.run('no-such-doc', 'local'));
    expect((gone as LibraryError).code).toBe('NOT_FOUND');
    expect(w.events.at(-1)).toMatchObject({ slug: 'no-such-doc', stage: 'failed', error: gone });
  });

  it('stubs throw NotAvailableInEdition (HOOK-PUB-01/03) without scanning or policy calls', async () => {
    for (const [id, hook] of [
      ['drive', 'HOOK-PUB-01'],
      ['git', 'HOOK-PUB-03'],
    ] as const) {
      const err = await rejection(w.svc.run(w.slug, id));
      expect(err).toBeInstanceOf(NotAvailableInEdition);
      expect((err as NotAvailableInEdition).hookId).toBe(hook);
      expect(w.events.at(-1)).toMatchObject({ targetId: id, stage: 'failed', error: err });
    }
    expect(w.scanner.scan).not.toHaveBeenCalled();
    expect(w.policy).not.toHaveBeenCalled();
    expect((await w.lib.getMeta(w.slug)).publications).toEqual([]);
  });

  it('rejects a concurrent publish of the same slug and target with E_CONFLICT', async () => {
    w = await world(['alpha', 'beta']);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    const base = alpha.impl;
    alpha.impl = async (ctx) => {
      await gate;
      return base(ctx);
    };
    const first = w.svc.run(w.slug, 'alpha');
    await vi.waitFor(() => expect(alpha.calls).toHaveLength(1));
    const second = await rejection(w.svc.run(w.slug, 'alpha'));
    expect(second).toBeInstanceOf(PublishRequestError);
    expect((second as PublishRequestError).code).toBe('E_CONFLICT');
    expect((second as Error).message).toBe('Already publishing');
    release();
    await first;
    // After it finishes the same pair may run again.
    await expect(w.svc.run(w.slug, 'alpha')).resolves.toMatchObject({ targetId: 'alpha' });
  });

  it('holds the document lock: a regenerate requested mid-publish waits, then succeeds', async () => {
    w = await world(['alpha']);
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    const base = alpha.impl;
    alpha.impl = async (ctx) => {
      await gate;
      order.push('published');
      return base(ctx);
    };
    const pub = w.svc.run(w.slug, 'alpha');
    await vi.waitFor(() => expect(alpha.calls).toHaveLength(1));
    const regen = w.lib.withDocLock(w.slug, async () => {
      order.push('regenerated');
      return w.lib.updateDocument(w.slug, { html: HTML + '<!-- regen -->', meta: (m) => m });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await pub;
    await regen;
    expect(order).toEqual(['published', 'regenerated']);
    expect((await w.lib.getMeta(w.slug)).publications).toHaveLength(1);
  });

  it('git kind: runs the registered secret scanner first and blocks with masked findings', async () => {
    w = await world(['alpha']);
    const findings = [{ relPath: 'index.html', line: 2, rule: 'code-host-token', preview: 'ghp_****' }];
    w.scanner.scan.mockResolvedValueOnce(findings);
    const err = await rejection(w.svc.run(w.slug, 'alpha'));
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).code).toBe('E_PUBLISH_SECRET_FOUND');
    expect((err as PublishError).findings).toEqual(findings);
    expect(w.fakes.get('alpha')?.calls).toHaveLength(0);
    expect(w.events.map((e) => e.stage)).toEqual(['preparing', 'scanning', 'failed']);
    // Clean scan: the publisher runs and its progress is forwarded.
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    const base = alpha.impl;
    alpha.impl = async (ctx) => {
      ctx.progress('committing');
      ctx.progress('pushing');
      return base(ctx);
    };
    w.events.length = 0;
    await w.svc.run(w.slug, 'alpha');
    expect(w.events.map((e) => e.stage)).toEqual(['preparing', 'scanning', 'committing', 'pushing', 'done']);
    expect(w.scanner.scan.mock.calls[1]?.[0]).toEqual(alpha.calls[0]?.files);
  });

  it('local kind is not scanned (the baseline scan gates git publishing only, 10 §9)', async () => {
    await w.svc.run(w.slug, 'local');
    expect(w.scanner.scan).not.toHaveBeenCalled();
  });

  it('calls the pre-publish policy (HOOK-PUB-05) and blocks with its message', async () => {
    w.policy.mockResolvedValueOnce({ allow: false, message: 'Blocked by policy' });
    const err = await rejection(w.svc.run(w.slug, 'local'));
    expect(err).toMatchObject({ code: 'E_PUBLISH_FAILED', message: 'Blocked by policy' });
    expect(w.policy).toHaveBeenCalledWith(
      expect.objectContaining({ slug: w.slug, targetId: 'local', kind: 'local', title: 'Widget pricing' }),
    );
    await expect(readFile(path.join(w.exportDir, w.slug, 'index.html'))).rejects.toThrow();
  });

  it('cancel aborts ctx.signal and the publish fails with E_PUBLISH_CANCELLED; cancel is a no-op otherwise', async () => {
    await expect(w.svc.cancel(w.slug, 'local')).resolves.toBeUndefined();
    w = await world(['alpha']);
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    alpha.impl = (ctx) =>
      new Promise((_r, reject) =>
        ctx.signal.addEventListener('abort', () =>
          reject(new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled')),
        ),
      );
    const p = w.svc.run(w.slug, 'alpha');
    await vi.waitFor(() => expect(alpha.calls).toHaveLength(1));
    await w.svc.cancel(w.slug, 'alpha');
    const err = await rejection(p);
    expect(err).toMatchObject({ code: 'E_PUBLISH_CANCELLED' });
    expect(w.events.at(-1)).toMatchObject({ stage: 'failed' });
  });

  it('wraps an unexpected publisher error as E_PUBLISH_FAILED without leaking its message', async () => {
    w = await world(['alpha']);
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    alpha.impl = () => Promise.reject(new Error('/Users/someone/private/path exploded'));
    const err = await rejection(w.svc.run(w.slug, 'alpha'));
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).code).toBe('E_PUBLISH_FAILED');
    expect((err as PublishError).message).not.toContain('/Users');
  });

  it('a history write failure after a successful export returns the result with a warning', async () => {
    vi.spyOn(w.lib, 'appendPublication').mockRejectedValueOnce(new LibraryError('LIBRARY_READ_ONLY'));
    const r = await w.svc.run(w.slug, 'local');
    expect(r.warnings).toEqual(['Exported, but the publish history could not be saved']);
  });

  it('dispose aborts every running publish and waits for it to settle', async () => {
    w = await world(['alpha']);
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    alpha.impl = (ctx) =>
      new Promise((_r, reject) =>
        ctx.signal.addEventListener('abort', () =>
          setTimeout(() => reject(new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled')), 10),
        ),
      );
    const p = rejection(w.svc.run(w.slug, 'alpha'));
    await vi.waitFor(() => expect(alpha.calls).toHaveLength(1));
    await w.svc.dispose();
    expect(await p).toMatchObject({ code: 'E_PUBLISH_CANCELLED' });
  });
});

describe('run: baseline secret scan and cancellation details', () => {
  it('a remote-kind target with the public BaselineSecretScanner blocks a quoted token, masked', async () => {
    w = await world(['alpha']);
    w.registry.registerSecretScanner(new BaselineSecretScanner());
    const token = ['gh', 'p_'].join('') + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    await w.lib.withDocLock(w.slug, () =>
      w.lib.updateDocument(w.slug, { html: HTML + `<pre>token: ${token}</pre>\n`, meta: (m) => m }),
    );
    const err = await rejection(w.svc.run(w.slug, 'alpha'));
    expect(err).toMatchObject({ code: 'E_PUBLISH_SECRET_FOUND' });
    const findings = (err as PublishError).findings ?? [];
    expect(findings.map((f) => [f.relPath, f.line, f.rule])).toEqual([['index.html', 2, 'code-host-token']]);
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(w.fakes.get('alpha')?.calls).toHaveLength(0);
  });

  it('a cancel while waiting for the document lock never reaches the publisher', async () => {
    w = await world(['alpha']);
    let release: () => void = () => {};
    const held = w.lib.withDocLock(w.slug, () => new Promise<void>((r) => (release = r)));
    const p = rejection(w.svc.run(w.slug, 'alpha'));
    await new Promise((r) => setTimeout(r, 10));
    await w.svc.cancel(w.slug, 'alpha');
    release();
    await held;
    expect(await p).toMatchObject({ code: 'E_PUBLISH_CANCELLED' });
    expect(w.fakes.get('alpha')?.calls).toHaveLength(0);
  });

  it("a publisher's own 'done' stage is not forwarded twice", async () => {
    w = await world(['alpha']);
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    const base = alpha.impl;
    alpha.impl = async (ctx) => {
      ctx.progress('done');
      return base(ctx);
    };
    await w.svc.run(w.slug, 'alpha');
    expect(w.events.filter((e) => e.stage === 'done')).toHaveLength(1);
  });

  it('dispose gives up waiting after its timeout', async () => {
    w = await world(['alpha']);
    const alpha = w.fakes.get('alpha');
    if (!alpha) throw new Error('fake missing');
    alpha.impl = () => new Promise(() => {});
    void w.svc.run(w.slug, 'alpha').catch(() => {});
    await vi.waitFor(() => expect(alpha.calls).toHaveLength(1));
    await expect(w.svc.dispose(20)).resolves.toBeUndefined();
    expect(alpha.calls[0]?.signal.aborted).toBe(true);
  });
});

describe('link actions (10 §7)', () => {
  const inside = () => pathToFileURL(path.join(w.exportDir, w.slug, 'index.html')).href;

  async function code(p: Promise<unknown>): Promise<string> {
    const err = await rejection(p);
    return (err as PublishRequestError).code;
  }

  it('copyLink writes https and exported file: links to the clipboard in main', async () => {
    await w.svc.copyLink('https://pages.example.com/widget-pricing/');
    await w.svc.copyLink(inside());
    expect(w.clipboard.writeText.mock.calls).toEqual([['https://pages.example.com/widget-pricing/'], [inside()]]);
  });

  it('openLink: https goes through safeOpenExternal; a refusal is E_RATE_LIMITED', async () => {
    await w.svc.openLink('https://pages.example.com/widget-pricing/');
    expect(w.openExternal).toHaveBeenCalledWith('https://pages.example.com/widget-pricing/');
    w.openExternal.mockResolvedValueOnce(false);
    expect(await code(w.svc.openLink('https://pages.example.com/'))).toBe('E_RATE_LIMITED');
  });

  it('openLink: an exported file: link opens the file; a missing export is E_NOT_FOUND', async () => {
    expect(await code(w.svc.openLink(inside()))).toBe('E_NOT_FOUND');
    await w.svc.run(w.slug, 'local');
    await w.svc.openLink(inside());
    expect(w.openPath).toHaveBeenCalledWith(path.join(w.exportDir, w.slug, 'index.html'));
    w.openPath.mockResolvedValueOnce('No application');
    expect(await code(w.svc.openLink(inside()))).toBe('E_IO');
  });

  it('reveal shows an exported file in Finder', async () => {
    await w.svc.reveal(inside());
    expect(w.showItemInFolder).toHaveBeenCalledWith(path.join(w.exportDir, w.slug, 'index.html'));
  });

  it.each([
    ['http', 'http://pages.example.com/'],
    ['javascript', 'javascript:alert(1)'],
    ['file outside the export folder', 'file:///etc/hosts'],
    ['file traversal out of the export folder', 'EXPORT/../outside.html'],
    ['file on a remote host', 'file://server/share/index.html'],
    ['https with credentials', 'https://user:pw@pages.example.com/'],
  ])('rejects %s with E_FORBIDDEN on every action', async (_n, raw) => {
    const url = raw.startsWith('EXPORT') ? pathToFileURL(w.exportDir).href + raw.slice('EXPORT'.length) : raw;
    expect(await code(w.svc.copyLink(url))).toBe('E_FORBIDDEN');
    expect(await code(w.svc.openLink(url))).toBe('E_FORBIDDEN');
    expect(await code(w.svc.reveal(url))).toBe('E_FORBIDDEN');
    expect(w.clipboard.writeText).not.toHaveBeenCalled();
    expect(w.openExternal).not.toHaveBeenCalled();
    expect(w.openPath).not.toHaveBeenCalled();
    expect(w.showItemInFolder).not.toHaveBeenCalled();
  });

  it('a file: link must be <folder>/<slug>/index.html: other files in the folder are E_FORBIDDEN', async () => {
    await w.svc.run(w.slug, 'local');
    const cmd = path.join(w.exportDir, 'evil.command');
    await writeFile(cmd, '#!/bin/sh\n');
    const nested = path.join(w.exportDir, w.slug, 'other.command');
    await writeFile(nested, '#!/bin/sh\n');
    for (const f of [cmd, nested, path.join(w.exportDir, 'Not A Slug', 'index.html')]) {
      const url = pathToFileURL(f).href;
      expect(await code(w.svc.openLink(url))).toBe('E_FORBIDDEN');
      expect(await code(w.svc.reveal(url))).toBe('E_FORBIDDEN');
      expect(await code(w.svc.copyLink(url))).toBe('E_FORBIDDEN');
    }
    expect(w.openPath).not.toHaveBeenCalled();
    expect(w.showItemInFolder).not.toHaveBeenCalled();
    expect(w.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('openLink refuses an index.html that is a symlink to another file', async () => {
    const dir = path.join(w.exportDir, 'linked-doc');
    await mkdir(dir);
    const target = path.join(w.exportDir, 'payload.command');
    await writeFile(target, '#!/bin/sh\n');
    await symlink(target, path.join(dir, 'index.html'));
    expect(await code(w.svc.openLink(pathToFileURL(path.join(dir, 'index.html')).href))).toBe('E_FORBIDDEN');
    expect(w.openPath).not.toHaveBeenCalled();
  });

  it('after publish.local.dir changes, a recorded export still copies and reveals; Open explains', async () => {
    await w.svc.run(w.slug, 'local');
    const old = inside();
    const moved = await mkdtemp(path.join(tmpdir(), 'eli5-export2-'));
    w.settings.publish.local.dir = moved;
    try {
      await w.svc.copyLink(old);
      expect(w.clipboard.writeText).toHaveBeenCalledWith(old);
      await w.svc.reveal(old);
      expect(w.showItemInFolder).toHaveBeenCalledWith(path.join(w.exportDir, w.slug, 'index.html'));
      const err = await rejection(w.svc.openLink(old));
      expect((err as PublishRequestError).code).toBe('E_FORBIDDEN');
      expect((err as PublishRequestError).message).toBe('This copy was exported to a different folder');
      expect(w.openPath).not.toHaveBeenCalled();
      // A link that was never recorded stays forbidden outside the current folder.
      const other = pathToFileURL(path.join(w.exportDir, 'other-doc', 'index.html')).href;
      expect(await code(w.svc.copyLink(other))).toBe('E_FORBIDDEN');
      expect(await code(w.svc.reveal(other))).toBe('E_FORBIDDEN');
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  });

  it('reveal takes file: links only', async () => {
    expect(await code(w.svc.reveal('https://pages.example.com/'))).toBe('E_FORBIDDEN');
  });

  it('the export folder check follows publish.local.dir with ~ expansion', async () => {
    const home = path.dirname(w.exportDir);
    w.settings.publish.local.dir = `~/${path.basename(w.exportDir)}`;
    const svc = createPublishService({
      registry: w.registry,
      library: w.lib,
      settings: () => w.settings,
      clipboard: w.clipboard,
      openExternal: w.openExternal,
      openPath: w.openPath,
      showItemInFolder: w.showItemInFolder,
      home,
    });
    await svc.reveal(inside());
    expect(w.showItemInFolder).toHaveBeenCalledTimes(1);
  });
});

describe('never touches the exported copy of other slugs or writes files beyond the set', () => {
  it('writes nothing into the export folder except <slug>/index.html', async () => {
    await writeFile(path.join(w.exportDir, 'keep.txt'), 'user file');
    await w.svc.run(w.slug, 'local');
    expect(await readFile(path.join(w.exportDir, 'keep.txt'), 'utf8')).toBe('user file');
  });
});
