import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PublishError } from './types';
import type { PublishFile, SecretFinding, SecretScanner } from './types';

/** One pattern rule (10 §5.4). `group` selects the capture to report; `test` post-filters it. */
interface Rule {
  id: string;
  re: RegExp;
  group?: number;
  test?: (value: string) => boolean;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Rules in §5.4 table order. All regexes are global so every match on a line is reported. */
const RULES: readonly Rule[] = [
  { id: 'private-key-block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    // Common cloud access key id prefixes + 16 uppercase alphanumerics.
    id: 'cloud-access-key-id',
    re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'llm-api-key',
    re: /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{40,}/g,
  },
  {
    id: 'code-host-token',
    re: /\b(?:gh[pos]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { id: 'bearer-header', re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  {
    // scheme://user:password@host
    id: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"<>]+:[^\s@/'"<>]+@[^\s/'"<>]+/gi,
  },
  {
    id: 'generic-high-entropy',
    re: /(?:secret|token|password|api[_-]?key)\s*[:=]\s*['"]?([^\s'"<>]{24,})/gi,
    group: 1,
    test: (v) => shannonEntropy(v) > 4.0,
  },
];

/** Skipped without decoding (§5.4 "binary files are skipped"). SVG is text and is scanned. */
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf']);

/** All but the first 4 chars masked; capped so a long match never widens the UI. */
export function maskPreview(match: string): string {
  const MAX_MASK = 16;
  return match.slice(0, 4) + '*'.repeat(Math.min(Math.max(match.length - 4, 0), MAX_MASK));
}

function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Pure: scan one decoded text. Exported for tests and for log redaction (§5.3 delegate step 3). */
export function scanText(relPath: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((lineText, i) => {
    const spans: [number, number][] = [];
    for (const rule of RULES) {
      for (const m of lineText.matchAll(rule.re)) {
        const value = rule.group !== undefined ? m[rule.group] : m[0];
        if (value === undefined) continue;
        if (rule.test && !rule.test(value)) continue;
        const start = m.index;
        const end = start + m[0].length;
        // The generic rule only adds what a specific rule has not already reported.
        if (rule.id === 'generic-high-entropy' && spans.some(([s, e]) => start < e && end > s)) continue;
        spans.push([start, end]);
        findings.push({ relPath, line: i + 1, rule: rule.id, preview: maskPreview(value) });
      }
    }
  });
  return findings;
}

export interface BaselineSecretScannerOptions {
  /** Injected for tests; defaults to fs.readFile. */
  readFile?: (absPath: string) => Promise<Uint8Array>;
}

/** Public pattern-based scanner, no dependencies (10 §5.4). Never logs unmasked values. */
export class BaselineSecretScanner implements SecretScanner {
  readonly id = 'baseline';
  private readonly read: (absPath: string) => Promise<Uint8Array>;

  constructor(opts: BaselineSecretScannerOptions = {}) {
    this.read = opts.readFile ?? ((p) => readFile(p));
  }

  async scan(files: readonly PublishFile[], signal: AbortSignal): Promise<SecretFinding[]> {
    const out: SecretFinding[] = [];
    const decoder = new TextDecoder('utf-8');
    for (const f of files) {
      if (signal.aborted) throw new PublishError('E_PUBLISH_CANCELLED', 'Publish cancelled');
      if (BINARY_EXTS.has(extname(f.relPath).toLowerCase())) continue;
      const buf = await this.read(f.absPath);
      if (looksBinary(buf)) continue;
      out.push(...scanText(f.relPath, decoder.decode(buf)));
    }
    return out;
  }
}
