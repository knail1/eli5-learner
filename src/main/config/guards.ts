/** Secret-in-settings detection and API key format checks (12 §5.2, §5.4). */

const SECRET_KEY_NAME =
  /(api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|client[-_]?secret|bearer)/i;

const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /^sk-(ant-)?[A-Za-z0-9_-]{20,}/,
  /^gh[pousr]_[A-Za-z0-9]{30,}/,
  /^github_pat_/,
  /^AKIA[0-9A-Z]{16}$/,
  /^xox[abpr]-/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/,
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when a string value looks like a credential. */
export function looksLikeSecret(value: string): boolean {
  if (SECRET_VALUE_SHAPES.some((re) => re.test(value))) return true;
  return value.length >= 32 && !/\s/.test(value) && shannonEntropy(value) > 4.5;
}

/** Returns dotted paths of leaves that look like secrets. Never returns values. */
export function findSecrets(obj: unknown, prefix = ''): string[] {
  const hits: string[] = [];
  if (obj === null || typeof obj !== 'object') return hits;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      hits.push(...findSecrets(v, path));
      continue;
    }
    const leaves = Array.isArray(v) ? v : [v];
    const nameHit = SECRET_KEY_NAME.test(k) && v !== null && v !== '' && v !== false;
    const valueHit = leaves.some((x) => typeof x === 'string' && looksLikeSecret(x));
    if (nameHit || valueHit) hits.push(path);
  }
  return hits;
}

/** Replace credential shapes inside free text with [REDACTED] (12 §11.2 rule 2). */
export function redact(text: string): string {
  let out = text;
  const inline: readonly RegExp[] = [
    /sk-(ant-)?[A-Za-z0-9_-]{20,}/g,
    /gh[pousr]_[A-Za-z0-9]{30,}/g,
    /github_pat_[A-Za-z0-9_]+/g,
    /AKIA[0-9A-Z]{16}/g,
    /xox[abpr]-[A-Za-z0-9-]+/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  ];
  for (const re of inline) out = out.replace(re, '[REDACTED]');
  return out.replace(/\S{32,}/g, (tok) => (shannonEntropy(tok) > 4.5 ? '[REDACTED]' : tok));
}

export type KeyFormatResult = { ok: true; key: string; warning?: string } | { ok: false };

/** 12 §5.2 steps 2-3: reject malformed keys; unexpected prefixes only warn. */
export function checkApiKeyFormat(provider: 'claude' | 'openai', raw: string): KeyFormatResult {
  const key = raw.trim();
  if (key.length === 0 || key.length > 512) return { ok: false };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false };
  const prefix = provider === 'claude' ? 'sk-ant-' : 'sk-';
  if (!key.startsWith(prefix)) {
    return { ok: true, key, warning: `Key does not start with "${prefix}"; saved anyway.` };
  }
  return { ok: true, key };
}
