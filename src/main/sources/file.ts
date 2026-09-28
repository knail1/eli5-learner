/**
 * File resolver (03 §5): snapshots, realpath, regular-file checks, size limits, magic-byte sniffing
 * and folder expansion. Read-only: never executes, opens with another app, modifies or copies a
 * file (copying is the pipeline's job at enqueue, 06 §9.2).
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { skip } from './reasons';
import { isImageFormat, sniff } from './sniff';
import { containerReaders, errnoOf, logSkip, readHead, sha256File } from './io';
import type {
  ResolveContext,
  ResolveOutcome,
  ResolvedSource,
  SkippedSource,
  SourceInput,
  SourceResolver,
} from './types';

type FileInput = Extract<SourceInput, { kind: 'file' }>;

/** Folders whose permission errors are almost always macOS privacy (TCC) prompts (03 §5.1 step 1). */
const PROTECTED_DIRS = ['Desktop', 'Documents', 'Downloads'];
const PRIVACY_DETAIL = 'allow access in System Settings > Privacy & Security > Files and Folders';

/** Directory entries never expanded (03 §5.3). */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);
const PACKAGE_DIR_RE = /\.(app|bundle)$/i;

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isProtectedPath(p: string, home = os.homedir()): boolean {
  return PROTECTED_DIRS.some((d) => {
    const base = path.join(home, d);
    return p === base || p.startsWith(base + path.sep);
  });
}

function pathErrorSkip(ref: string, p: string, err: unknown, ctx: ResolveContext): SkippedSource {
  const errno = errnoOf(err);
  if (errno === 'ENOENT' || errno === 'ENOTDIR') return skip(ref, 'not-found');
  if (errno === 'EACCES' || errno === 'EPERM') {
    return skip(ref, 'permission-denied', isProtectedPath(p) ? PRIVACY_DETAIL : undefined);
  }
  logSkip(ctx, 'sources.file.read-error', { code: 'read-error', sourceKind: 'file', ...(errno ? { errno } : {}) });
  return skip(ref, 'read-error', errno === 'ETIMEDOUT' || errno === 'EIO' ? 'file may not be downloaded' : undefined);
}

const none = (): ResolveOutcome => ({ resolved: [], skipped: [] });
const skipped = (s: SkippedSource): ResolveOutcome => ({ resolved: [], skipped: [s] });

/**
 * Classify and hash one regular file whose realpath and stat are already known (03 §5.1 steps 3-4).
 * `readPath` is where bytes come from (the snapshot copy when present); `location` is the original.
 */
async function resolveRegularFile(
  inputId: string,
  ref: string,
  location: string,
  readPath: string,
  size: number,
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  if (size === 0) return skipped(skip(ref, 'empty'));
  if (size > ctx.limits.maxFileBytes) return skipped(skip(ref, 'too-large'));
  let head: Buffer;
  try {
    head = await readHead(readPath);
  } catch (err) {
    return skipped(pathErrorSkip(ref, readPath, err, ctx));
  }
  // A zero-byte read of a non-empty file: typically an iCloud placeholder (03 §14).
  if (head.length === 0) return skipped(skip(ref, 'empty', 'file may not be downloaded'));
  const sniffed = await sniff(head, ref, containerReaders(readPath));
  if (!sniffed.ok) return skipped(skip(ref, sniffed.code, sniffed.detail));
  if (isImageFormat(sniffed.format) && size > ctx.limits.maxImageBytes) return skipped(skip(ref, 'too-large'));
  let sha256: string;
  try {
    sha256 = await sha256File(readPath, ctx.signal);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return skipped(pathErrorSkip(ref, readPath, err, ctx));
  }
  const src: ResolvedSource = {
    id: '', // assigned by the chain in final order (03 §4 step 6)
    inputId,
    ref,
    location,
    lane: 'local',
    resolverId: 'file',
    format: sniffed.format,
    mediaType: sniffed.mediaType,
    payload: { kind: 'path', path: readPath },
    sizeBytes: size,
    sha256,
    notes: [...sniffed.notes],
  };
  return { resolved: [src], skipped: [] };
}

interface WalkState {
  resolvedCount: number;
}

/** Folder expansion (03 §5.3): depth-first, name order, hidden and package entries skipped. */
async function expandFolder(
  inputId: string,
  dir: string,
  ctx: ResolveContext,
  depth: number,
  state: WalkState,
  out: ResolveOutcome,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    out.skipped.push(pathErrorSkip(path.basename(dir), dir, err, ctx));
    return;
  }
  entries.sort((a, b) => nameCollator.compare(a.name, b.name));
  for (const e of entries) {
    if (ctx.signal.aborted) return;
    if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (PACKAGE_DIR_RE.test(e.name)) continue;
      if (depth < ctx.limits.maxFolderDepth) await expandFolder(inputId, full, ctx, depth + 1, state, out);
      continue;
    }
    if (!e.isFile() && !e.isSymbolicLink()) continue; // sockets, FIFOs, devices inside folders: ignored
    // Beyond the per-job cap, record the rest without reading them (03 §4 step 5 re-checks totals).
    if (state.resolvedCount >= ctx.limits.maxSourcesPerJob) {
      out.skipped.push(skip(e.name, 'limit-exceeded'));
      continue;
    }
    let real: string;
    try {
      real = await realpath(full);
    } catch (err) {
      out.skipped.push(pathErrorSkip(e.name, full, err, ctx));
      continue;
    }
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(real);
    } catch (err) {
      out.skipped.push(pathErrorSkip(e.name, real, err, ctx));
      continue;
    }
    if (!st.isFile()) continue; // symlinked directories are not followed (cycle safety)
    const r = await resolveRegularFile(inputId, e.name, real, real, st.size, ctx);
    state.resolvedCount += r.resolved.length;
    out.resolved.push(...r.resolved);
    out.skipped.push(...r.skipped);
  }
}

/** 03 §5.1 step 0: snapshot handling. Returns an outcome, or null to continue in place. */
async function fromSnapshot(input: FileInput, ref: string, ctx: ResolveContext): Promise<ResolveOutcome | null> {
  const snap = input.snapshot;
  if (!snap) return null;
  if (snap.copyPath) {
    let location = path.resolve(input.path);
    try {
      location = await realpath(input.path);
    } catch {
      // The original may be gone by now; the copy is what we read, the path is only a label.
    }
    let st;
    try {
      st = await stat(snap.copyPath);
    } catch {
      return skipped(skip(ref, 'file-changed'));
    }
    if (!st.isFile()) return skipped(skip(ref, 'file-changed'));
    return resolveRegularFile(input.id, ref, location, snap.copyPath, st.size, ctx);
  }
  // No copy (over the snapshot threshold): compare with the enqueue-time stat.
  try {
    const st = await stat(input.path);
    if (st.size !== snap.sizeBytes || Math.trunc(st.mtimeMs) !== Math.trunc(snap.mtimeMs)) {
      return skipped(skip(ref, 'file-changed'));
    }
  } catch {
    return skipped(skip(ref, 'file-changed'));
  }
  return null;
}

/** Resolve one file input (03 §5.1). Never throws for expected failures. */
export async function resolveFileInput(input: FileInput, ctx: ResolveContext): Promise<ResolveOutcome> {
  const ref = path.basename(input.path) || input.path;
  const snap = await fromSnapshot(input, ref, ctx);
  if (snap) return snap;

  let real: string;
  try {
    real = await realpath(input.path);
  } catch (err) {
    return skipped(pathErrorSkip(ref, input.path, err, ctx));
  }
  let st;
  try {
    st = await lstat(real);
  } catch (err) {
    return skipped(pathErrorSkip(ref, real, err, ctx));
  }
  if (st.isDirectory()) {
    const out = none();
    await expandFolder(input.id, real, ctx, 1, { resolvedCount: 0 }, out);
    if (out.resolved.length === 0 && !ctx.signal.aborted) {
      return skipped({ ref, code: 'empty', reason: 'Folder contained no supported files.' });
    }
    return out;
  }
  if (!st.isFile()) return skipped(skip(ref, 'not-a-regular-file'));
  return resolveRegularFile(input.id, ref, real, real, st.size, ctx);
}

/** The `file` resolver (03 §3 order 4, lane local). */
export class FileResolver implements SourceResolver {
  readonly id = 'file';
  readonly handles = ['file'] as const;
  readonly lane = 'local' as const;

  canResolve(input: SourceInput, _ctx: ResolveContext): boolean {
    return input.kind === 'file' && typeof input.path === 'string' && path.isAbsolute(input.path);
  }

  resolve(input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
    if (input.kind !== 'file') return Promise.resolve(skipped(skip(input.id, 'unsupported-type')));
    return resolveFileInput(input, ctx);
  }
}

export const fileResolver: SourceResolver = new FileResolver();
