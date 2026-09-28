/**
 * Publish service (10 §4, §6, §7): listTargets, runPublish, history, cancel and the link actions.
 * Satisfies the IPC PublishService (src/main/ipc/publish.ts); bootstrap plugs it in at M3-PLUG 10.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpcErrorCode } from '../../preload/contract';
import type { Settings } from '../config';
import { NotAvailableInEdition, type CapabilityRegistry } from '../editions';
import type { PublishService, PublishServiceProgress } from '../ipc';
import { LibraryError, type FsLibrary } from '../library';
import { log as defaultLog, type Logger } from '../security';
import { buildPublishFileSet } from './files';
import { expandHome, isWithin } from './local';
import { PublishError } from './types';
import type { PublicationRecord, PublishContext, PublishResult, PublishStage, PublishTarget } from './types';

/** A request the service refuses before publishing; the IPC boundary maps `code` as is. */
export class PublishRequestError extends Error {
  constructor(
    readonly code: Extract<IpcErrorCode, 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_FORBIDDEN' | 'E_RATE_LIMITED' | 'E_IO'>,
    message: string,
  ) {
    super(message);
    this.name = 'PublishRequestError';
  }
}

export interface PublishServiceDeps {
  registry: Pick<CapabilityRegistry, 'publisher' | 'publishers' | 'secretScanner' | 'prePublishPolicy'>;
  library: Pick<FsLibrary, 'root' | 'hasSlug' | 'getEntry' | 'getMeta' | 'docPath' | 'withDocLock' | 'updateDocument'>;
  settings: () => Settings;
  /** Electron clipboard (10 §7 step 2: copying happens in main). */
  clipboard: { writeText(text: string): void };
  /** safeOpenExternal bound to the app window (12 §7.5): false when refused or rate limited. */
  openExternal(url: string): Promise<boolean>;
  /** shell.openPath: '' on success, else an error string. */
  openPath(absPath: string): Promise<string>;
  /** shell.showItemInFolder. */
  showItemInFolder(absPath: string): void;
  /** Home directory for `~` expansion (tests). */
  home?: string;
  logger?: Logger;
}

export interface PublishServiceHandle extends PublishService {
  /** App quit (10 §11): abort every running publish and wait up to `timeoutMs` for cleanup. */
  dispose(timeoutMs?: number): Promise<void>;
}

/** 10 §4: `local`, `drive`, `git`, then overlay ids alphabetically. */
const BUILTIN_ORDER = ['local', 'drive', 'git'];
function orderIds(ids: string[]): string[] {
  const builtin = BUILTIN_ORDER.filter((id) => ids.includes(id));
  return [...builtin, ...ids.filter((id) => !BUILTIN_ORDER.includes(id)).sort()];
}

const HISTORY_WARNING: Record<string, string> = {
  local: 'Exported, but the publish history could not be saved',
};
const historyWarning = (kind: string) =>
  HISTORY_WARNING[kind] ?? 'Published, but the publish history could not be saved';

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

/** Errors the IPC boundary already maps to a specific, safe message. */
function isKnown(err: unknown): boolean {
  return (
    err instanceof PublishError ||
    err instanceof PublishRequestError ||
    err instanceof NotAvailableInEdition ||
    err instanceof LibraryError
  );
}

const forbidden = () => new PublishRequestError('E_FORBIDDEN', 'That link cannot be opened');

export function createPublishService(d: PublishServiceDeps): PublishServiceHandle {
  const logger = d.logger ?? defaultLog;
  const home = d.home ?? homedir();
  const listeners = new Set<(e: PublishServiceProgress) => void>();
  const running = new Map<string, { ac: AbortController; done: Promise<unknown> }>();

  const emit = (e: PublishServiceProgress) => {
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        // A listener never breaks a publish.
      }
    }
  };

  const requireDoc = (slug: string) => {
    if (!d.library.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
  };

  /** Records newest first; appended in publish order, so newest is last on disk (09 meta). */
  const historyOf = async (slug: string): Promise<PublicationRecord[]> =>
    [...(await d.library.getMeta(slug)).publications].reverse();

  const exportDir = () => expandHome(d.settings().publish.local.dir, home);

  /** 10 §7 step 3: a `file:` link must point inside publish.local.dir (lexically). */
  const fileInsideExport = (u: URL): string => {
    if (u.hostname !== '' && u.hostname !== 'localhost') throw forbidden();
    let abs: string;
    try {
      abs = path.resolve(fileURLToPath(u));
    } catch {
      throw forbidden();
    }
    const dir = exportDir();
    if (abs === dir || !isWithin(dir, abs)) throw forbidden();
    return abs;
  };

  /** Scheme and folder checks shared by the link actions (10 §7). */
  const checkLink = (raw: string, schemes: readonly ('https:' | 'file:')[]): { url: URL; file?: string } => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw forbidden();
    }
    if (!(schemes as readonly string[]).includes(url.protocol)) throw forbidden();
    if (url.protocol === 'https:') {
      if (!url.hostname || url.username || url.password) throw forbidden();
      return { url };
    }
    return { url, file: fileInsideExport(url) };
  };

  async function publishLocked(
    slug: string,
    targetId: string,
    ac: AbortController,
    progress: (s: PublishStage) => void,
  ): Promise<PublishResult> {
    const publisher = d.registry.publisher(targetId);
    const settings = structuredClone(d.settings());
    const title = d.library.getEntry(slug)?.title ?? slug;
    const base = { slug, title, settings, signal: ac.signal, progress, libraryRoot: d.library.root };

    // Stubs are not special-cased (10 §4 step 1): their publish() throws NotAvailableInEdition,
    // before anything is read, scanned or shown to a policy.
    if (publisher.stub) return publisher.publish({ ...base, files: Object.freeze([]) });

    return d.library.withDocLock(slug, async () => {
      // Step 3: a merge or delete that won the lock leaves nothing to publish.
      requireDoc(slug);
      if (ac.signal.aborted) throw new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled');
      // Step 4.
      const files = await buildPublishFileSet(slug, path.dirname(d.library.docPath(slug)));
      // Step 5 (HOOK-PUB-05).
      const decision = await d.registry.prePublishPolicy()({
        slug,
        title,
        targetId,
        kind: publisher.kind,
        files,
        settings,
        signal: ac.signal,
      });
      if (!decision.allow) throw new PublishError('E_PUBLISH_FAILED', decision.message);
      // 10 §5.3 step 4, §9: the baseline scan gates every git-kind publish (HOOK-PUB-03).
      if (publisher.kind === 'git') {
        progress('scanning');
        const findings = await d.registry.secretScanner().scan(files, ac.signal);
        if (findings.length > 0) {
          throw new PublishError(
            'E_PUBLISH_SECRET_FOUND',
            'This document contains something that looks like a secret. Remove it and regenerate the section.',
            undefined,
            findings,
          );
        }
      }
      // Step 6.
      const ctx: PublishContext = { ...base, files, reveal: (p) => d.showItemInFolder(p) };
      const result = await publisher.publish(ctx);

      // Step 7: history. The export already happened, so a failed write is only a warning.
      const primary = result.links.find((l) => l.primary) ?? result.links[0];
      const index = files.find((f) => f.relPath === 'index.html');
      if (primary && index) {
        const record: PublicationRecord = {
          targetId,
          kind: publisher.kind,
          publishedAt: result.publishedAt,
          primaryUrl: primary.url,
          contentSha256: index.sha256,
        };
        try {
          await d.library.updateDocument(slug, {
            meta: (m) => ({ ...m, publications: [...m.publications, record] }),
          });
        } catch (err) {
          logger.warn('publish.history-failed', { slug, code: err instanceof LibraryError ? err.code : 'unknown' });
          return { ...result, warnings: [...result.warnings, historyWarning(publisher.kind)] };
        }
      }
      return result;
    });
  }

  return {
    async targets(slug) {
      requireDoc(slug);
      const history = await historyOf(slug);
      let currentSha: string | undefined;
      try {
        currentSha = sha256(await readFile(d.library.docPath(slug)));
      } catch {
        currentSha = undefined;
      }
      const settings = d.settings();
      const ids = orderIds(d.registry.publishers().map((p) => p.id));
      const out: PublishTarget[] = [];
      for (const id of ids) {
        const t = await d.registry.publisher(id).describe(slug, settings);
        const last = history.find((r) => r.targetId === id);
        out.push(
          last ? { ...t, lastPublished: last, changedSincePublish: currentSha !== last.contentSha256 } : { ...t },
        );
      }
      return out;
    },

    async run(slug, targetId) {
      const key = `${slug}\u0000${targetId}`;
      // Step 2: no event, so the running publish's own progress stays authoritative.
      if (running.has(key)) throw new PublishRequestError('E_CONFLICT', 'Already publishing');
      const ac = new AbortController();
      const started = Date.now();
      const progress = (stage: PublishStage) => {
        // 'done' is emitted by the service together with the result.
        if (stage !== 'done' && !ac.signal.aborted) emit({ slug, targetId, stage });
      };
      const work = (async () => {
        progress('preparing');
        requireDoc(slug);
        // Step 1.
        if (!d.registry.publishers().some((p) => p.id === targetId)) {
          throw new PublishRequestError('E_NOT_FOUND', 'Publish target not found');
        }
        return publishLocked(slug, targetId, ac, progress);
      })();
      running.set(key, { ac, done: work.catch(() => {}) });
      try {
        const result = await work;
        emit({ slug, targetId, stage: 'done', result });
        logger.info('publish.done', { slug, kind: result.kind, durationMs: Date.now() - started });
        return result;
      } catch (raw) {
        let err: unknown = raw;
        if (!isKnown(raw)) {
          logger.error('publish.failed', { slug }, raw);
          err = ac.signal.aborted
            ? new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled', raw)
            : new PublishError('E_PUBLISH_FAILED', 'Publishing failed. Try again.', raw);
        } else {
          logger.info('publish.failed', {
            slug,
            code: err instanceof PublishError || err instanceof PublishRequestError ? err.code : 'other',
          });
        }
        emit({ slug, targetId, stage: 'failed', error: err });
        throw err;
      } finally {
        running.delete(key);
      }
    },

    async history(slug) {
      requireDoc(slug);
      return historyOf(slug);
    },

    cancel(slug, targetId) {
      running.get(`${slug}\u0000${targetId}`)?.ac.abort();
      return Promise.resolve();
    },

    async copyLink(url) {
      checkLink(url, ['https:', 'file:']);
      d.clipboard.writeText(url);
    },

    async openLink(url) {
      const { url: u, file } = checkLink(url, ['https:', 'file:']);
      if (file === undefined) {
        if (!(await d.openExternal(u.href))) throw new PublishRequestError('E_RATE_LIMITED', 'Link not opened');
        return;
      }
      // The exported file must exist and, through any symlink, still sit inside the folder.
      let real: string;
      let realDir: string;
      try {
        real = await realpath(file);
        realDir = await realpath(exportDir());
      } catch {
        throw new PublishRequestError('E_NOT_FOUND', 'The exported copy is no longer there');
      }
      if (!isWithin(realDir, real) || real === realDir) throw forbidden();
      const problem = await d.openPath(file);
      if (problem !== '') throw new PublishRequestError('E_IO', 'The exported copy could not be opened');
    },

    async reveal(url) {
      const { file } = checkLink(url, ['file:']);
      if (file !== undefined) d.showItemInFolder(file);
    },

    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async dispose(timeoutMs = 5000) {
      const all = [...running.values()];
      for (const r of all) r.ac.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(all.map((r) => r.done)), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    },
  };
}
