/**
 * Clipboard routing (03 §6.2) and the `clipboard` resolver (03 §6.4). The pasteboard is reached
 * only through ClipboardPort, which Electron's `clipboard` satisfies structurally, so routing is
 * testable without a real pasteboard (03 §15).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imagePreview, mintInputId, stageDraftItem, textPreview } from './drafts';
import { containerReaders, errnoOf, isInside, logSkip, readHead, sha256File, sha256Text } from './io';
import { parsePlistStringArray } from './plist';
import { skip } from './reasons';
import { sniff } from './sniff';
import type { ResolveContext, ResolveOutcome, ResolvedSource, SourceInput, SourceResolver } from './types';

/** The subset of Electron's NativeImage used here. */
export interface ClipboardImage {
  isEmpty(): boolean;
  toPNG(): Buffer;
}

/** The subset of Electron's `clipboard` used by routing (03 §15). */
export interface ClipboardPort {
  availableFormats(): string[];
  read(format: string): string;
  readText(): string;
  readHTML(): string;
  readImage(): ClipboardImage;
  readBuffer(format: string): Buffer;
}

export const FILENAMES_PBOARD_TYPE = 'NSFilenamesPboardType';
export const FILE_URL_TYPE = 'public.file-url';

/** Absolute file paths on the clipboard (03 §6.2 step 1), in clipboard order. */
export function clipboardFilePaths(cb: ClipboardPort): string[] {
  const safeRead = (fmt: string): string => {
    try {
      return cb.read(fmt) ?? '';
    } catch {
      return '';
    }
  };
  const plist = safeRead(FILENAMES_PBOARD_TYPE).trim();
  if (plist) {
    const items = parsePlistStringArray(plist) ?? []; // parse failure -> treat as empty (step 1.1)
    const paths = items.filter((p) => path.isAbsolute(p));
    if (paths.length > 0) return paths;
  }
  const fileUrl = safeRead(FILE_URL_TYPE).trim();
  if (fileUrl.toLowerCase().startsWith('file://')) {
    try {
      const p = fileURLToPath(fileUrl);
      if (path.isAbsolute(p)) return [p];
    } catch {
      // Not a local file URL.
    }
  }
  return [];
}

const HTTP_LINE = /^https?:\/\/\S+$/i;

export interface ReadClipboardOptions {
  userData: string;
  draftId: string;
  now?: () => Date;
  mintId?: () => string;
}

/**
 * Snapshot the clipboard into SourceInputs (03 §6.1 step 3, §6.2). First matching branch wins:
 * file references, then visible text (URL list, HTML, plain), then image; otherwise [].
 */
export async function readClipboardInputs(cb: ClipboardPort, opts: ReadClipboardOptions): Promise<SourceInput[]> {
  const mint = opts.mintId ?? mintInputId;
  const formats = new Set(cb.availableFormats());

  // 1. File references (probed regardless of availableFormats()).
  const files = clipboardFilePaths(cb);
  if (files.length > 0) return files.map((p) => ({ id: mint(), kind: 'file', origin: 'paste', path: p }));

  // 2. Text with visible characters.
  const text = cb.readText() ?? '';
  if (/\S/.test(text)) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (lines.every((l) => HTTP_LINE.test(l))) {
      return lines.map((url) => ({ id: mint(), kind: 'url', origin: 'paste', url }));
    }
    const id = mint();
    const html = formats.has('text/html') ? (cb.readHTML() ?? '') : '';
    const markup = html.trim() !== '' ? 'html' : 'plain';
    const stagedPath = await stageDraftItem(
      opts.userData,
      opts.draftId,
      id,
      markup === 'html' ? 'html' : 'txt',
      markup === 'html' ? html : text,
    );
    return [{ id, kind: 'text', origin: 'paste', stagedPath, markup, preview: textPreview(text) }];
  }

  // 3. Image (a screenshot goes straight to vision; no OCR).
  const img = cb.readImage();
  if (img && !img.isEmpty()) {
    const id = mint();
    const stagedPath = await stageDraftItem(opts.userData, opts.draftId, id, 'png', img.toPNG());
    const now = opts.now ? opts.now() : new Date();
    return [{ id, kind: 'image', origin: 'paste', stagedPath, mediaType: 'image/png', preview: imagePreview(now) }];
  }

  // 4. Nothing usable.
  return [];
}

/** At least two Markdown heading or list lines -> markdown (03 §6.4). */
export function looksLikeMarkdown(text: string): boolean {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s{0,3}(#{1,6}\s+\S|[-*+]\s+\S|\d{1,9}[.)]\s+\S)/.test(line) && ++n >= 2) return true;
  }
  return false;
}

const MISSING_REASON = 'Pasted item was no longer available.';

type PasteInput = Extract<SourceInput, { kind: 'text' | 'image' }>;

async function resolvePaste(input: PasteInput, ctx: ResolveContext): Promise<ResolveOutcome> {
  const ref = input.preview || (input.kind === 'image' ? 'Pasted image' : 'Pasted text');
  const none = (s: ReturnType<typeof skip>): ResolveOutcome => ({ resolved: [], skipped: [s] });
  // 03 §6.4: staged content is read only from the job's inputs/ snapshot.
  if (!isInside(path.join(ctx.stagingDir, 'inputs'), input.stagedPath) || !path.isAbsolute(input.stagedPath)) {
    logSkip(ctx, 'sources.clipboard.outside-staging', { code: 'read-error', sourceKind: input.kind });
    return none(skip(ref, 'read-error'));
  }
  let size: number;
  try {
    const st = await stat(input.stagedPath);
    if (!st.isFile()) return none({ ref, code: 'not-found', reason: MISSING_REASON });
    size = st.size;
  } catch (err) {
    const errno = errnoOf(err);
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return none({ ref, code: 'not-found', reason: MISSING_REASON });
    logSkip(ctx, 'sources.clipboard.read-error', {
      code: 'read-error',
      sourceKind: input.kind,
      ...(errno ? { errno } : {}),
    });
    return none(skip(ref, 'read-error'));
  }
  if (size === 0) return none(skip(ref, 'empty'));
  const base = {
    id: '',
    inputId: input.id,
    ref,
    location: 'clipboard',
    lane: 'local' as const,
    resolverId: 'clipboard',
  };

  try {
    if (input.kind === 'image') {
      if (size > ctx.limits.maxImageBytes) return none(skip(ref, 'too-large'));
      const sniffed = await sniff(await readHead(input.stagedPath), 'pasted.png', containerReaders(input.stagedPath));
      if (!sniffed.ok || sniffed.format !== 'png')
        return none(skip(ref, 'unsupported-type', 'pasted image is not a PNG'));
      const src: ResolvedSource = {
        ...base,
        format: 'png',
        mediaType: 'image/png',
        payload: { kind: 'path', path: input.stagedPath },
        sizeBytes: size,
        sha256: await sha256File(input.stagedPath, ctx.signal),
        notes: [],
      };
      return { resolved: [src], skipped: [] };
    }
    if (size > ctx.limits.maxFileBytes) return none(skip(ref, 'too-large'));
    const body = await readFile(input.stagedPath, 'utf8');
    if (!/\S/.test(body)) return none(skip(ref, 'empty'));
    const common = { ...base, sizeBytes: Buffer.byteLength(body, 'utf8'), sha256: sha256Text(body), notes: [] };
    if (input.markup === 'html') {
      return {
        resolved: [{ ...common, format: 'html', mediaType: 'text/html', payload: { kind: 'html', html: body } }],
        skipped: [],
      };
    }
    const md = looksLikeMarkdown(body);
    return {
      resolved: [
        {
          ...common,
          format: md ? 'markdown' : 'text',
          mediaType: md ? 'text/markdown' : 'text/plain',
          payload: { kind: 'text', text: body },
        },
      ],
      skipped: [],
    };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const errno = errnoOf(err);
    logSkip(ctx, 'sources.clipboard.read-error', {
      code: 'read-error',
      sourceKind: input.kind,
      ...(errno ? { errno } : {}),
    });
    return none(skip(ref, 'read-error'));
  }
}

/** The `clipboard` resolver (03 §3 order 5, lane local) for `text` and `image` inputs. */
export class ClipboardResolver implements SourceResolver {
  readonly id = 'clipboard';
  readonly handles = ['text', 'image'] as const;
  readonly lane = 'local' as const;

  canResolve(input: SourceInput, _ctx: ResolveContext): boolean {
    return input.kind === 'text' || input.kind === 'image';
  }

  resolve(input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
    if (input.kind !== 'text' && input.kind !== 'image') {
      return Promise.resolve({ resolved: [], skipped: [skip(input.id, 'unsupported-type')] });
    }
    return resolvePaste(input, ctx);
  }
}

export const clipboardResolver: SourceResolver = new ClipboardResolver();
