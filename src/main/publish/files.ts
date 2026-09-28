import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LibraryError } from '../library';
import { PublishError } from './types';
import type { PublishFile } from './types';

/** 10 §3.3 step 4. */
export const MAX_PUBLISH_BYTES = 25 * 1024 * 1024;

/** 10 §3.3 step 1. */
const PUBLISH_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** 10 §3.3 step 2: the only extensions an `assets/` entry may have. */
const ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff2']);

const symlinkAbort = () =>
  new PublishError('E_PUBLISH_FAILED', 'The document folder contains a link and was not published');

/** lstat or undefined on ENOENT/ENOTDIR. */
async function lstatOrNone(p: string) {
  try {
    return await lstat(p);
  } catch {
    return undefined;
  }
}

/** Sorted depth-first walk of `assets/`, skipping dot entries; any symlink aborts (step 3). */
async function walkAssets(docDir: string, rel: string, out: string[]): Promise<void> {
  const names = (await readdir(path.join(docDir, rel))).sort();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const childRel = `${rel}/${name}`;
    const st = await lstat(path.join(docDir, childRel));
    if (st.isSymbolicLink()) throw symlinkAbort();
    if (st.isDirectory()) await walkAssets(docDir, childRel, out);
    else if (st.isFile() && ASSET_EXTS.has(path.extname(name).toLowerCase())) out.push(childRel);
  }
}

/**
 * The single place that decides what may leave the machine (10 §3.3). `docDir` is the document
 * folder the library resolved for `slug` (09 docPath). Returns a frozen list, index.html first.
 */
export async function buildPublishFileSet(slug: string, docDir: string): Promise<readonly PublishFile[]> {
  if (!PUBLISH_SLUG.test(slug)) throw new LibraryError('NOT_FOUND', { slug: 'invalid' });
  const dirStat = await lstatOrNone(docDir);
  if (!dirStat) throw new LibraryError('NOT_FOUND', { slug });
  if (dirStat.isSymbolicLink()) throw symlinkAbort();
  if (!dirStat.isDirectory()) throw new LibraryError('NOT_FOUND', { slug });

  const index = await lstatOrNone(path.join(docDir, 'index.html'));
  if (!index) throw new LibraryError('NOT_FOUND', { slug });
  if (index.isSymbolicLink()) throw symlinkAbort();
  if (!index.isFile()) throw new LibraryError('NOT_FOUND', { slug });

  const rels = ['index.html'];
  const assets = await lstatOrNone(path.join(docDir, 'assets'));
  if (assets?.isSymbolicLink()) throw symlinkAbort();
  if (assets?.isDirectory()) await walkAssets(docDir, 'assets', rels);

  // Size first (step 4) so an oversized set is refused before it is read.
  let total = 0;
  for (const rel of rels) total += (await lstat(path.join(docDir, rel))).size;
  if (total > MAX_PUBLISH_BYTES) throw new PublishError('E_PUBLISH_FAILED', 'Document too large to publish');

  const files: PublishFile[] = [];
  for (const rel of rels) {
    const absPath = path.join(docDir, ...rel.split('/'));
    const buf = await readFile(absPath);
    files.push(
      Object.freeze({
        relPath: rel,
        absPath,
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
      }),
    );
  }
  return Object.freeze(files);
}
