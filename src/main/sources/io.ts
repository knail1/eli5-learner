/** Small read-only file helpers shared by the resolvers (03 §5.1, §6.4, §7.2). */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { oleStreamNames, readZipEntry } from './containers';
import { SNIFF_HEAD_BYTES, type SniffOptions } from './sniff';
import type { ResolveContext, SkipCode } from './types';

/** First `bytes` bytes of a file (03 §5.1 step 4: 8 KiB for sniffing). */
export async function readHead(filePath: string, bytes = SNIFF_HEAD_BYTES): Promise<Buffer> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Streaming sha256 of a file (03 §2: used for dedupe). */
export function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, signal ? { signal } : {});
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** True when `child` is `parent` itself or lies inside it (lexically, after resolve). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Container readers bound to one file, for sniff() on ZIP / OLE heads. */
export function containerReaders(filePath: string): Pick<SniffOptions, 'readZipEntry' | 'oleStreamNames'> {
  return {
    readZipEntry: (name) => readZipEntry(filePath, name),
    oleStreamNames: () => oleStreamNames(filePath),
  };
}

export function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Local debug log for a resolver-level event (12 §11: allowlisted fields only, never content or
 * full paths). ctx.log is wired by the pipeline to the security logger's debug level; importing
 * ../security here would pull electron into every consumer of this module.
 */
export function logSkip(
  ctx: Pick<ResolveContext, 'jobId' | 'log'>,
  event: string,
  fields: { code: SkipCode | string; sourceKind: string; errno?: string; kind?: string },
): void {
  const data: Record<string, string> = { jobId: ctx.jobId, code: fields.code, sourceKind: fields.sourceKind };
  if (fields.errno) data.errno = fields.errno;
  if (fields.kind) data.kind = fields.kind;
  ctx.log(event, data);
}
