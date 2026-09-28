import { createHash, randomBytes } from 'node:crypto';
import { mkdir as fsMkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Settings } from '../config';
import { PublishError } from './types';
import type { PublishContext, PublishFile, Publisher, PublishResult, PublishTarget } from './types';

/** `~` / `~/x` -> absolute (10 §5.1 step 1). */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(p);
}

/** Absolute -> `~/x` when under the home directory (10 §5.1 describe). */
export function abbreviateHome(p: string, home: string = homedir()): string {
  if (p === home) return '~';
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** True when `child` is `parent` or inside it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep));
}

/** realpath of the nearest existing ancestor, with the missing tail re-appended (symlink-safe). */
export async function realpathLoose(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(await realpath(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length).replace(/^\/+/, ''));
      cur = parent;
    }
  }
}

const errnoOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;

/** 10 §5.1 step 2 and §11: filesystem errors -> a message naming the folder. */
function destinationError(err: unknown, folder: string): PublishError {
  const code = errnoOf(err);
  if (code === 'ENOENT') {
    return new PublishError('E_PUBLISH_DESTINATION', 'Folder is not available. Is the drive connected?', err);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOSPC' || code === 'EEXIST') {
    return new PublishError('E_PUBLISH_DESTINATION', `Could not write to the folder ${folder}`, err);
  }
  return new PublishError('E_PUBLISH_FAILED', 'The copy could not be exported', err);
}

const cancelled = () => new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled');
const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

export interface LocalPublisherOptions {
  /** Home directory for `~` expansion (tests). */
  home?: string;
  now?: () => Date;
  /** Temp-file suffix source (10 §5.1 step 3 `.tmp-<rand>`). */
  randomHex?: () => string;
  /** Injected for tests (unmounted volume). */
  mkdir?: (p: string, opts: { recursive: true }) => Promise<unknown>;
}

/** Local export publisher (10 §5.1). Always available; never touches the library copy. */
export class LocalPublisher implements Publisher {
  readonly id = 'local';
  readonly kind = 'local' as const;
  private readonly home: string;
  private readonly now: () => Date;
  private readonly randomHex: () => string;
  private readonly mkdir: (p: string, opts: { recursive: true }) => Promise<unknown>;

  constructor(opts: LocalPublisherOptions = {}) {
    this.home = opts.home ?? homedir();
    this.now = opts.now ?? (() => new Date());
    this.randomHex = opts.randomHex ?? (() => randomBytes(6).toString('hex'));
    this.mkdir = opts.mkdir ?? ((p, o) => fsMkdir(p, o));
  }

  describe(slug: string, settings: Settings): Promise<PublishTarget> {
    const dir = expandHome(settings.publish.local.dir, this.home);
    return Promise.resolve({
      id: this.id,
      kind: this.kind,
      label: 'Export copy',
      available: true,
      destinationPreview: `${abbreviateHome(join(dir, slug), this.home)}/`,
      requiresSignIn: false,
    });
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    if (ctx.signal.aborted) throw cancelled();
    const index = ctx.files.find((f) => f.relPath === 'index.html');
    if (!index) throw new PublishError('E_PUBLISH_FAILED', 'The document has nothing to export');

    // Step 1: never export into the library (it would recurse into docs/).
    const dir = expandHome(ctx.settings.publish.local.dir, this.home);
    const destDir = join(dir, ctx.slug);
    const shown = abbreviateHome(dir, this.home);
    if (ctx.libraryRoot !== undefined) {
      const lib = await realpathLoose(ctx.libraryRoot);
      if (isWithin(lib, await realpathLoose(destDir))) {
        throw new PublishError('E_PUBLISH_DESTINATION', 'Choose an export folder outside the Library');
      }
    }

    // Step 2.
    try {
      await this.mkdir(destDir, { recursive: true });
    } catch (err) {
      throw destinationError(err, shown);
    }

    // Steps 3-4: temp copy, fsync, verify, atomic rename; temps are removed on any failure.
    for (const f of ctx.files) {
      if (ctx.signal.aborted) throw cancelled();
      await this.copyOne(f, destDir, shown);
    }

    const out = join(destDir, 'index.html');
    if (ctx.settings.publish.local.revealAfter && ctx.reveal) {
      try {
        ctx.reveal(out);
      } catch {
        // Revealing is a convenience; the export already succeeded.
      }
    }
    return {
      targetId: this.id,
      kind: this.kind,
      slug: ctx.slug,
      publishedAt: this.now().toISOString(),
      files: ctx.files.map((f) => f.relPath),
      links: [{ kind: 'file', url: pathToFileURL(out).href, label: 'Open copy', primary: true }],
      warnings: [],
    };
  }

  private async copyOne(f: PublishFile, destDir: string, shown: string): Promise<void> {
    const target = join(destDir, ...f.relPath.split('/'));
    const tmp = `${target}.tmp-${this.randomHex()}`;
    try {
      if (dirname(target) !== destDir) await this.mkdir(dirname(target), { recursive: true });
      const buf = await readFile(f.absPath);
      const fh = await open(tmp, 'w', 0o644);
      try {
        await fh.writeFile(buf);
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (sha256(await readFile(tmp)) !== f.sha256) {
        throw new PublishError('E_PUBLISH_FAILED', 'The exported copy did not match the document. Try again.');
      }
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err instanceof PublishError ? err : destinationError(err, shown);
    }
  }
}
