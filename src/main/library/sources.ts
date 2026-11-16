/**
 * Retained source text (09 §4.4): `<slug>/.sources/`, a per-document sidecar holding the extracted
 * text of each source (`toPromptText`, image markers only) for Deep Ask (08 §6.9).
 *
 * The sidecar is append-only and its manifest is the commit point: a text file is immutable once
 * the manifest references it, new files are written before the manifest, and files the manifest
 * stops referencing are deleted after it. Readers are lock-free. No absolute path is stored: refs
 * go through the meta sanitizer. Nothing here throws or logs an error that embeds file content.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../security';
import { sanitizeSourceRecord } from './catalog';
import { DIR_MODE, FILE_MODE, errnoOf, fsyncDir, isErrno, writeFileAtomic, writeJsonAtomic } from './fs-atomic';
import { LibraryError, type SourceRecord } from './types';

export const SOURCES_DIR = '.sources';
export const SOURCES_MANIFEST = 'manifest.json';
/** Ids are never reused, so they outgrow 3 digits. */
export const SOURCE_FILE_RE = /^src-\d{2,6}\.md$/;
const SOURCE_ID_RE = /^src-\d{2,6}$/;
export const SIDECAR_VERSION = 1;
/** = extraction's maxCharsPerSource (04 §10). */
export const MAX_SOURCE_CHARS = 400_000;
/** UTF-8 bytes of all `.md` files of one document. */
export const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
export const MAX_SIDECAR_SOURCES = 100;
/** Orphan `src-NN.md` files (not in the manifest) older than this are removed by housekeeping. */
export const SIDECAR_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_LABEL_CHARS = 200;
const MAX_ID_NUMBER = 999_999;

export type SourceSidecarKind = 'file' | 'url' | 'clipboard' | 'mcp';

export interface SourceSidecarEntry {
  /** 'src-01'...: unique in this sidecar, never reused after removal. */
  id: string;
  /** `<id>.md` when stored === 'text'. */
  file?: string;
  /** Sanitized like meta (sanitizeSourceRecord): basename / URL per policy. */
  ref: string;
  /** ResolvedSource.title || ref, at most 200 characters. */
  label: string;
  kind: SourceSidecarKind;
  mime: string;
  /** ExtractedFormat. */
  format: string;
  /** image: vision input only; omitted: over the document cap, or empty. */
  stored: 'text' | 'image' | 'omitted';
  /** Of the stored .md bytes (dedup key); only with 'text'. */
  sha256?: string;
  /** ResolvedSource.sha256 (payload bytes). */
  sourceSha256?: string;
  /** Extracted characters (ExtractStats.chars). */
  chars: number;
  storedChars: number;
  truncated: boolean;
  truncatedBy?: ('extract' | 'sidecar')[];
  /** 'merge:<docId>' | 'rebuild:<jobId>'. */
  origin?: string;
  addedAt: string;
}

export interface SourceSidecarManifest {
  v: 1;
  updatedAt: string;
  totalBytes: number;
  sources: SourceSidecarEntry[];
}

export interface SourceSidecarInput {
  ref: string;
  label: string;
  kind: SourceSidecarEntry['kind'];
  mime: string;
  format: string;
  /** null for an image source. */
  text: string | null;
  chars: number;
  sourceSha256?: string;
  extractTruncated: boolean;
  origin?: string;
}

export interface SourceSidecar {
  manifest: SourceSidecarManifest;
  /** Entry id -> text, only for entries with stored === 'text' whose file read and verified. */
  texts: Record<string, string>;
}

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const SourceSidecarEntrySchema = z
  .object({
    id: z.string().regex(SOURCE_ID_RE),
    file: z.string().regex(SOURCE_FILE_RE).optional(),
    ref: z.string().min(1),
    label: z.string().max(MAX_LABEL_CHARS),
    kind: z.enum(['file', 'url', 'clipboard', 'mcp']),
    mime: z.string(),
    format: z.string(),
    stored: z.enum(['text', 'image', 'omitted']),
    sha256: Sha.optional(),
    sourceSha256: Sha.optional(),
    chars: z.number().int().min(0),
    storedChars: z.number().int().min(0),
    truncated: z.boolean(),
    truncatedBy: z.array(z.enum(['extract', 'sidecar'])).optional(),
    origin: z.string().optional(),
    addedAt: z.iso.datetime(),
  })
  .refine((e) => (e.stored === 'text' ? e.file === `${e.id}.md` && e.sha256 !== undefined : e.file === undefined), {
    message: 'file does not match stored',
  });

export const SourceSidecarManifestSchema = z
  .object({
    v: z.literal(SIDECAR_VERSION),
    updatedAt: z.iso.datetime(),
    totalBytes: z.number().int().min(0),
    sources: z.array(SourceSidecarEntrySchema).max(MAX_SIDECAR_SOURCES),
  })
  .refine((m) => new Set(m.sources.map((s) => s.id)).size === m.sources.length, { message: 'duplicate id' });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _SidecarDriftChecks = [
  Assert<Same<z.output<typeof SourceSidecarEntrySchema>, SourceSidecarEntry>>,
  Assert<Same<z.output<typeof SourceSidecarManifestSchema>, SourceSidecarManifest>>,
];

// ---- pure helpers ----

const sha256Hex = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * The meta sanitizer, plus: any ref still shaped like a local path (a clipboard or MCP ref) keeps
 * only its basename, so no absolute path is ever stored.
 */
function storedRef(kind: SourceSidecarKind, ref: string, sourceUrls: 'full' | 'redacted'): string {
  const clean = sanitizeSourceRecord({ kind, ref }, sourceUrls).ref;
  return path.isAbsolute(clean) || clean.startsWith('~/') ? path.basename(clean) : clean;
}

function redactedRef(kind: SourceSidecarKind, ref: string): string {
  return storedRef(kind, ref, 'redacted');
}

/**
 * Decision 8 (pure): the entries matching a record of `used` (the live meta.sourcesUsed): same
 * kind and the same ref after redaction on both sides (so a policy change between write and read
 * still matches) and, when both carry one, the same sha256. `missing`: the records of `used` with
 * no matching entry that has text.
 */
export function sourcesForMeta(
  sc: SourceSidecar | null,
  used: readonly SourceRecord[],
): { entries: SourceSidecarEntry[]; texts: Record<string, string>; missing: SourceRecord[] } {
  if (sc === null) return { entries: [], texts: {}, missing: [...used] };
  const matches = (e: SourceSidecarEntry, s: SourceRecord): boolean =>
    e.kind === s.kind &&
    redactedRef(e.kind, e.ref) === redactedRef(s.kind, s.ref) &&
    (e.sourceSha256 === undefined || s.sha256 === undefined || e.sourceSha256 === s.sha256);
  const entries = sc.manifest.sources.filter((e) => used.some((s) => matches(e, s)));
  const texts: Record<string, string> = {};
  for (const e of entries) {
    const t = sc.texts[e.id];
    if (t !== undefined) texts[e.id] = t;
  }
  const missing = used.filter((s) => !entries.some((e) => texts[e.id] !== undefined && matches(e, s)));
  return { entries, texts, missing };
}

/** Cuts `text` to at most `max` characters on a line boundary when there is one. */
function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  const nl = head.lastIndexOf('\n');
  if (nl > 0) return head.slice(0, nl);
  // Never leave half a surrogate pair: its UTF-8 bytes would not round-trip (sha256 check).
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes, on a line boundary when there is one. */
function cutBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  const head = buf.subarray(0, maxBytes);
  const nl = head.lastIndexOf(0x0a);
  if (nl > 0) return head.subarray(0, nl).toString('utf8');
  let end = maxBytes;
  // Back up over UTF-8 continuation bytes so the cut never splits a character.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function cleanLabel(input: SourceSidecarInput, ref: string, sourceUrls: 'full' | 'redacted'): string {
  let label = input.label.replace(/\s+/g, ' ').trim();
  if (!label || label === input.ref.trim()) label = ref;
  else if (path.isAbsolute(label) || label.startsWith('~/') || /^[a-z][a-z0-9+.-]+:/i.test(label)) {
    // A title that is itself a path or a URL gets the same privacy rules as a ref.
    label = sanitizeSourceRecord(
      { kind: /^[a-z][a-z0-9+.-]+:/i.test(label) ? 'url' : 'file', ref: label },
      sourceUrls,
    ).ref;
  }
  return label.slice(0, MAX_LABEL_CHARS);
}

function idNumber(id: string): number {
  const m = /^src-(\d{2,6})(?:\.md)?$/.exec(id);
  return m ? Number(m[1]) : 0;
}

const idFor = (n: number): string => `src-${String(n).padStart(2, '0')}`;

/** A new text file to write before the manifest. */
interface PendingFile {
  name: string;
  text: string;
}

interface Planner {
  sources: SourceSidecarEntry[];
  totalBytes: number;
  nextId: number;
  files: PendingFile[];
  now: string;
  /** The document cap has cut a source in this pass: every later text in it is omitted. */
  full: boolean;
}

/** Appends one entry built from `input`, applying the per-source and per-document caps. */
function addEntry(p: Planner, input: SourceSidecarInput, sourceUrls: 'full' | 'redacted'): SourceSidecarEntry | null {
  if (p.sources.length >= MAX_SIDECAR_SOURCES || p.nextId > MAX_ID_NUMBER) return null;
  const ref = storedRef(input.kind, input.ref, sourceUrls);
  const id = idFor(p.nextId++);
  const base = {
    id,
    ref,
    label: cleanLabel(input, ref, sourceUrls),
    kind: input.kind,
    mime: input.mime,
    format: input.format,
    ...(input.sourceSha256 && /^[0-9a-f]{64}$/.test(input.sourceSha256) ? { sourceSha256: input.sourceSha256 } : {}),
    chars: Math.max(0, Math.floor(input.chars)),
    ...(input.origin ? { origin: input.origin } : {}),
    addedAt: p.now,
  };
  const by: ('extract' | 'sidecar')[] = input.extractTruncated ? ['extract'] : [];
  const finish = (
    stored: SourceSidecarEntry['stored'],
    storedChars: number,
    extra: Partial<SourceSidecarEntry> = {},
  ): SourceSidecarEntry => {
    const { id: _id, ...rest } = base;
    const entry: SourceSidecarEntry = {
      id,
      ...extra,
      ...rest,
      stored,
      storedChars,
      truncated: by.length > 0,
      ...(by.length > 0 ? { truncatedBy: [...by] } : {}),
    };
    p.sources.push(entry);
    return entry;
  };
  if (input.text === null) return finish('image', 0);
  let text = cutChars(input.text, MAX_SOURCE_CHARS);
  if (text.length < input.text.length && !by.includes('extract')) by.push('extract');
  if (!text.trim()) return finish('omitted', 0);
  const room = p.full ? 0 : MAX_SIDECAR_BYTES - p.totalBytes;
  const fitted = cutBytes(text, room);
  if (fitted.length < text.length) {
    // Cut to fit the document cap, or (nothing left) omitted because of it.
    by.push('sidecar');
    text = fitted;
    p.full = true;
  }
  if (!text.trim()) return finish('omitted', 0);
  const bytes = Buffer.byteLength(text, 'utf8');
  p.totalBytes += bytes;
  const name = `${id}.md`;
  p.files.push({ name, text });
  return finish('text', text.length, { file: name, sha256: sha256Hex(text) });
}

function plannerFrom(m: SourceSidecarManifest | null, orphanNames: readonly string[], now: string): Planner {
  const used = [...(m?.sources.map((s) => idNumber(s.id)) ?? []), ...orphanNames.map(idNumber)];
  return {
    sources: m ? m.sources.map((s) => ({ ...s })) : [],
    totalBytes: m?.totalBytes ?? 0,
    nextId: Math.max(0, ...used) + 1,
    files: [],
    now,
    // 09 §4.4: "the one that crosses the cap is cut, later ones omitted" holds within one pass; a
    // later pass gets the room left by totalBytes, so replacing a cut entry frees its bytes.
    full: false,
  };
}

function manifestOf(p: Planner): SourceSidecarManifest {
  return { v: SIDECAR_VERSION, updatedAt: p.now, totalBytes: p.totalBytes, sources: p.sources };
}

// ---- file system ----

export interface SidecarFsOptions {
  sourceUrls: 'full' | 'redacted';
  now: Date;
  logger: Logger;
}

/** `<docDir>/.sources`, refused when it exists and is not a real directory (a symlink). */
async function sidecarDir(docDir: string, create: boolean): Promise<string | undefined> {
  const dir = path.join(docDir, SOURCES_DIR);
  const st = await fsp.lstat(dir).catch((err: unknown) => {
    if (isErrno(err, 'ENOENT')) return undefined;
    throw new LibraryError('WRITE_FAILED', { kind: 'sources-dir', errno: errnoOf(err) });
  });
  if (st) {
    if (!st.isDirectory()) throw new LibraryError('WRITE_FAILED', { kind: 'sources-not-dir' });
    return dir;
  }
  if (!create) return undefined;
  await fsp.mkdir(dir, { mode: DIR_MODE });
  await fsyncDir(docDir);
  return dir;
}

type ManifestRead =
  { status: 'ok'; manifest: SourceSidecarManifest } | { status: 'missing' } | { status: 'invalid'; kind: string };

/** Reads and validates `manifest.json`; never throws, and never reports file content. */
async function readManifest(dir: string): Promise<ManifestRead> {
  const file = path.join(dir, SOURCES_MANIFEST);
  const st = await fsp.lstat(file).catch(() => undefined);
  if (!st) return { status: 'missing' };
  if (!st.isFile()) return { status: 'invalid', kind: 'not-a-file' };
  if (st.size > MAX_SIDECAR_BYTES) return { status: 'invalid', kind: 'too-large' };
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return { status: 'invalid', kind: 'json' };
  }
  const r = SourceSidecarManifestSchema.safeParse(raw);
  return r.success ? { status: 'ok', manifest: r.data } : { status: 'invalid', kind: 'schema' };
}

type TextRead = { ok: true; text: string } | { ok: false; missing: boolean };

/** One entry's text: a regular file (no symlink) inside the sidecar, within the cap, sha-verified. */
async function readEntryText(dir: string, e: SourceSidecarEntry): Promise<TextRead> {
  if (e.stored !== 'text' || !e.file || !SOURCE_FILE_RE.test(e.file)) return { ok: false, missing: false };
  const file = path.join(dir, e.file);
  if (path.dirname(file) !== dir) return { ok: false, missing: false };
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile() || st.size > MAX_SIDECAR_BYTES) return { ok: false, missing: false };
    const buf = await fsp.readFile(file);
    if (sha256Hex(buf) !== e.sha256) return { ok: false, missing: false };
    return { ok: true, text: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, missing: isErrno(err, 'ENOENT') };
  }
}

/**
 * Lock-free read (09 §4.4). null: no sidecar or an invalid manifest. A referenced file that is
 * missing is re-tried once after re-reading the manifest (a concurrent upsert may have replaced
 * it). Entries whose file is missing, unreadable or mismatched are dropped from `texts`.
 */
export async function readSidecar(docDir: string, slug: string, logger: Logger): Promise<SourceSidecar | null> {
  let dir: string | undefined;
  try {
    dir = await sidecarDir(docDir, false);
  } catch {
    logger.warn('library.sources-manifest-invalid', { slug, kind: 'not-a-dir' });
    return null;
  }
  if (!dir) return null;
  for (let attempt = 0; ; attempt++) {
    const m = await readManifest(dir);
    if (m.status === 'missing') return null;
    if (m.status === 'invalid') {
      logger.warn('library.sources-manifest-invalid', { slug, kind: m.kind });
      return null;
    }
    const texts: Record<string, string> = {};
    let unreadable = 0;
    let missing = false;
    for (const e of m.manifest.sources) {
      if (e.stored !== 'text') continue;
      const r = await readEntryText(dir, e);
      if (r.ok) texts[e.id] = r.text;
      else {
        unreadable++;
        if (r.missing) missing = true;
      }
    }
    if (missing && attempt === 0) continue;
    if (unreadable > 0) logger.warn('library.sources-entry-unreadable', { slug, count: unreadable });
    return { manifest: m.manifest, texts };
  }
}

/** Writes a new sidecar into a staging folder (plain writes; the staging rename is the commit). */
export async function writeStagingSidecar(
  stagingDir: string,
  inputs: readonly SourceSidecarInput[],
  o: SidecarFsOptions,
): Promise<{ count: number; bytes: number }> {
  const p = plannerFrom(null, [], o.now.toISOString());
  for (const input of inputs) addEntry(p, input, o.sourceUrls);
  const dir = path.join(stagingDir, SOURCES_DIR);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { mode: DIR_MODE });
  for (const f of p.files) await fsp.writeFile(path.join(dir, f.name), f.text, { mode: FILE_MODE, flag: 'wx' });
  await fsp.writeFile(path.join(dir, SOURCES_MANIFEST), JSON.stringify(manifestOf(p), null, 2) + '\n', {
    mode: FILE_MODE,
    flag: 'wx',
  });
  return { count: p.files.length, bytes: p.totalBytes };
}

/** Names of `src-NN.md` files in the sidecar folder (referenced or not). */
async function sourceFileNames(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => SOURCE_FILE_RE.test(n));
}

/**
 * The live write path shared by upsert and union: new files first (atomic each), then the
 * manifest (the commit point), then the files the manifest no longer references.
 */
async function commitPlan(dir: string, p: Planner, before: SourceSidecarManifest | null): Promise<void> {
  for (const f of p.files) await writeFileAtomic(path.join(dir, f.name), f.text);
  await writeJsonAtomic(path.join(dir, SOURCES_MANIFEST), manifestOf(p));
  const kept = new Set(p.sources.flatMap((s) => (s.file ? [s.file] : [])));
  for (const s of before?.sources ?? []) {
    if (s.file && !kept.has(s.file)) await fsp.unlink(path.join(dir, s.file)).catch(() => {});
  }
}

/** Opens the live sidecar for a write: its folder, current manifest (invalid = none) and planner. */
async function openForWrite(
  docDir: string,
  o: SidecarFsOptions,
): Promise<{ dir: string; before: SourceSidecarManifest | null; p: Planner }> {
  const dir = (await sidecarDir(docDir, true)) as string;
  const m = await readManifest(dir);
  const before = m.status === 'ok' ? m.manifest : null;
  const p = plannerFrom(before, await sourceFileNames(dir), o.now.toISOString());
  return { dir, before, p };
}

/** The byte total from the stored text entries' sizes on disk. */
function bytesOf(sources: readonly SourceSidecarEntry[], sizes: ReadonlyMap<string, number>): number {
  return sources.reduce((n, s) => n + (s.stored === 'text' ? (sizes.get(s.id) ?? 0) : 0), 0);
}

/**
 * Whether `input` would store what `old` already holds. An entry the document cap cut or omitted
 * is unchanged when the new text still starts with what was kept.
 */
async function unchanged(
  dir: string,
  old: SourceSidecarEntry,
  input: SourceSidecarInput,
  o: SidecarFsOptions,
): Promise<boolean> {
  const would = addEntry(plannerFrom(null, [], o.now.toISOString()), input, o.sourceUrls);
  if (!would) return true;
  if (would.stored === old.stored && would.sha256 === old.sha256) return true;
  if (!old.truncatedBy?.includes('sidecar') || would.stored !== 'text') return false;
  if (old.stored === 'omitted') return true;
  const kept = await readEntryText(dir, old);
  const full = cutChars(input.text ?? '', MAX_SOURCE_CHARS);
  return kept.ok && full.startsWith(kept.text);
}

async function entrySizes(dir: string, sources: readonly SourceSidecarEntry[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const s of sources) {
    if (!s.file) continue;
    const st = await fsp.lstat(path.join(dir, s.file)).catch(() => undefined);
    if (st?.isFile()) sizes.set(s.id, st.size);
  }
  return sizes;
}

/**
 * Adds new texts to a live sidecar (caller holds the doc lock). An input whose key matches an
 * entry (key = `sourceSha256` when present, else kind + ref) replaces that entry when its text
 * changed, and is a no-op when it did not.
 */
export async function upsertSidecar(
  docDir: string,
  inputs: readonly SourceSidecarInput[],
  o: SidecarFsOptions,
): Promise<{ added: number; bytes: number }> {
  if (inputs.length === 0) return { added: 0, bytes: 0 };
  const { dir, before, p } = await openForWrite(docDir, o);
  const sizes = await entrySizes(dir, p.sources);
  p.totalBytes = bytesOf(p.sources, sizes);
  let added = 0;
  for (const input of inputs) {
    const ref = storedRef(input.kind, input.ref, o.sourceUrls);
    const keyOf = (e: SourceSidecarEntry): boolean =>
      input.sourceSha256
        ? e.sourceSha256 === input.sourceSha256
        : e.sourceSha256 === undefined &&
          e.kind === input.kind &&
          redactedRef(e.kind, e.ref) === redactedRef(input.kind, ref);
    const old = p.sources.find(keyOf);
    if (old) {
      if (await unchanged(dir, old, input, o)) continue;
      p.sources = p.sources.filter((s) => s !== old);
      p.totalBytes -= sizes.get(old.id) ?? 0;
    }
    const e = addEntry(p, input, o.sourceUrls);
    const written = p.files.at(-1);
    if (e?.stored === 'text' && written) sizes.set(e.id, Buffer.byteLength(written.text, 'utf8'));
    if (e || old) added++;
  }
  if (added === 0) return { added: 0, bytes: p.totalBytes };
  await commitPlan(dir, p, before);
  return { added, bytes: p.totalBytes };
}

/**
 * Appends `fromDocDir`'s entries not already in the target (by stored sha256) to the target's
 * sidecar; every appended entry gets `origin`, replacing any it had. Idempotent: a target that
 * already has entries with this origin is left as it is. Caller holds both doc locks.
 */
export async function unionSidecars(
  targetDocDir: string,
  fromDocDir: string,
  fromSlug: string,
  origin: string,
  o: SidecarFsOptions,
): Promise<{ added: number }> {
  const from = await readSidecar(fromDocDir, fromSlug, o.logger);
  if (!from || from.manifest.sources.length === 0) return { added: 0 };
  const { dir, before, p } = await openForWrite(targetDocDir, o);
  if (p.sources.some((s) => s.origin === origin)) return { added: 0 };
  const shas = new Set(p.sources.flatMap((s) => (s.sha256 ? [s.sha256] : [])));
  const nonText = new Set(p.sources.filter((s) => s.stored !== 'text').map((s) => nonTextKey(s)));
  let added = 0;
  for (const e of from.manifest.sources) {
    if (e.stored === 'text') {
      const text = from.texts[e.id];
      if (text === undefined || (e.sha256 && shas.has(e.sha256))) continue;
      const entry = addEntry(p, inputOf(e, text, origin), o.sourceUrls);
      if (entry) {
        // Keep the truncation history the source sidecar recorded.
        mergeTruncation(entry, e);
        if (entry.sha256) shas.add(entry.sha256);
        added++;
      }
    } else {
      if (nonText.has(nonTextKey(e))) continue;
      const entry = addEntry(p, inputOf(e, e.stored === 'image' ? null : '', origin), o.sourceUrls);
      if (entry) {
        mergeTruncation(entry, e);
        nonText.add(nonTextKey(entry));
        added++;
      }
    }
  }
  if (added === 0) return { added: 0 };
  await commitPlan(dir, p, before);
  return { added };
}

function nonTextKey(e: SourceSidecarEntry): string {
  return `${e.kind}\0${e.ref}\0${e.sourceSha256 ?? ''}\0${e.stored}`;
}

function inputOf(e: SourceSidecarEntry, text: string | null, origin: string): SourceSidecarInput {
  return {
    ref: e.ref,
    label: e.label,
    kind: e.kind,
    mime: e.mime,
    format: e.format,
    text,
    chars: e.chars,
    ...(e.sourceSha256 ? { sourceSha256: e.sourceSha256 } : {}),
    extractTruncated: e.truncatedBy?.includes('extract') ?? false,
    origin,
  };
}

function mergeTruncation(entry: SourceSidecarEntry, from: SourceSidecarEntry): void {
  const by = new Set([...(entry.truncatedBy ?? []), ...(from.truncatedBy ?? [])]);
  if (by.size === 0) return;
  entry.truncated = true;
  entry.truncatedBy = (['extract', 'sidecar'] as const).filter((k) => by.has(k));
}

/**
 * Housekeeping for one live document (09 §7 step 8): orphan `src-NN.md` files the manifest does not
 * reference and older than an hour. Returns how many were removed.
 */
export async function sweepSidecar(docDir: string, nowMs: number): Promise<number> {
  const dir = path.join(docDir, SOURCES_DIR);
  const st = await fsp.lstat(dir).catch(() => undefined);
  if (!st?.isDirectory()) return 0;
  const m = await readManifest(dir);
  const referenced = new Set(
    m.status === 'ok' ? m.manifest.sources.flatMap((s) => (s.file ? [s.file] : [])) : ([] as string[]),
  );
  let removed = 0;
  for (const n of await sourceFileNames(dir)) {
    if (referenced.has(n)) continue;
    const f = await fsp.lstat(path.join(dir, n)).catch(() => undefined);
    if (!f || nowMs - f.mtimeMs <= SIDECAR_ORPHAN_MAX_AGE_MS) continue;
    await fsp.unlink(path.join(dir, n)).catch(() => {});
    removed++;
  }
  return removed;
}

/** Policy off: removes `<docDir>/.sources/` (not following a symlink). Returns 1 when removed. */
export async function removeSidecar(docDir: string): Promise<number> {
  const dir = path.join(docDir, SOURCES_DIR);
  const st = await fsp.lstat(dir).catch(() => undefined);
  if (!st) return 0;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return 1;
}

/**
 * Staging check for commitDocument (09 §8.2): `.sources` must be a real directory holding only
 * `manifest.json` and `src-NN.md` regular files.
 */
export async function validStagingSidecar(stagingDir: string): Promise<boolean> {
  const dir = path.join(stagingDir, SOURCES_DIR);
  const st = await fsp.lstat(dir).catch(() => undefined);
  if (!st?.isDirectory()) return false;
  for (const n of await fsp.readdir(dir)) {
    if (n !== SOURCES_MANIFEST && !SOURCE_FILE_RE.test(n)) return false;
    const f = await fsp.lstat(path.join(dir, n)).catch(() => undefined);
    if (!f?.isFile()) return false;
  }
  return true;
}
