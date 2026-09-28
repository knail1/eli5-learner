/** Atomic file and directory writes (09 §8.1, §8.2). Every library write goes through here. */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { log } from '../security';
import { LibraryError } from './types';

/** Document folders are 0o700, files 0o600 (09 §8.1). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
/** Temp files are `<target>.tmp-<pid>-<8 hex>` (09 §4). */
export const TMP_MARKER = '.tmp-';

export function tmpPathFor(target: string): string {
  return `${target}${TMP_MARKER}${process.pid}-${randomBytes(4).toString('hex')}`;
}

/** Test seam: lets a test simulate a crash between the temp write and the rename (13 §3). */
export interface AtomicWriteHooks {
  beforeRename?: (tmp: string, target: string) => Promise<void> | void;
}

/**
 * 09 §8.1: open(tmp,'wx',0600) -> write -> fsync -> close -> rename -> fsync(parent). Errors before
 * the rename unlink the temp file and throw WRITE_FAILED; the target is either old or new.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const tmp = tmpPathFor(target);
  try {
    const fh = await fsp.open(tmp, 'wx', FILE_MODE);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await hooks.beforeRename?.(tmp, target);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw new LibraryError('WRITE_FAILED', { path: path.basename(target), errno: errnoOf(err) });
  }
  await fsyncDir(path.dirname(target));
}

/** JSON with 2-space indentation and a trailing newline (09 §8.1). */
export function writeJsonAtomic(target: string, value: unknown, hooks?: AtomicWriteHooks): Promise<void> {
  return writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n', hooks);
}

/** fsync a directory; logged, not thrown, since some filesystems refuse it (09 §8.1 step 4). */
export async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await fsp.open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    log.debug('library.fsync-dir-failed', { errno: errnoOf(err) });
  }
}

/** Same-volume directory rename followed by fsync of both parents (09 §8.2 steps 2-3). */
export async function renameDirAtomic(from: string, to: string): Promise<void> {
  await fsp.rename(from, to);
  await fsyncDir(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) await fsyncDir(path.dirname(from));
}

export function errnoOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export function isErrno(err: unknown, code: string): boolean {
  return errnoOf(err) === code;
}
