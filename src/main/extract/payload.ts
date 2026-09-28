/** Payload access by kind (04 §4) and text decoding (04 §9.2 step 1). */
import { readFile } from 'node:fs/promises';
import type { ResolvedSource } from '../sources';

/** Bytes of a source. `path` payloads are read lazily, only after dispatch (04 §4). */
export async function readSourceBytes(source: ResolvedSource): Promise<Uint8Array> {
  const p = source.payload;
  switch (p.kind) {
    case 'path':
      return new Uint8Array(await readFile(p.path));
    case 'text':
      return new TextEncoder().encode(p.text);
    case 'html':
      return new TextEncoder().encode(p.html);
  }
}

/** Text of a source: `text`/`html` payloads directly, `path` payloads decoded per 04 §9.2. */
export async function readSourceText(source: ResolvedSource): Promise<string> {
  const p = source.payload;
  switch (p.kind) {
    case 'path':
      return decodeText(await readSourceBytes(source));
    case 'text':
      return p.text;
    case 'html':
      return p.html;
  }
}

/** Size used for the per-format cap: file size, or UTF-8 bytes of an in-memory payload (04 §10.1). */
export function payloadSize(source: ResolvedSource): number {
  const p = source.payload;
  if (p.kind === 'text') return Buffer.byteLength(p.text, 'utf8');
  if (p.kind === 'html') return Buffer.byteLength(p.html, 'utf8');
  return source.sizeBytes;
}

/**
 * BOM-directed UTF-8/UTF-16 decoding. Without a BOM, UTF-8, falling back to windows-1252 when
 * UTF-8 yields more than 1% replacement characters (04 §9.2).
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (utf8.length === 0) return utf8;
  let bad = 0;
  for (const ch of utf8) if (ch === '�') bad++;
  if (bad / utf8.length > 0.01) return new TextDecoder('windows-1252').decode(bytes);
  return utf8;
}
