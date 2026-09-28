// Canonical JSON for the embedded model (07 §5.5: sorted keys) and its script-safe escaping (07 §6.1).

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}

/** JSON with object keys sorted at every level and `undefined` members dropped. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortValue(v));
}

/**
 * Escapes JSON for a `<script type="application/json">` body: `<` as \u003c so it can never close
 * the element, and U+2028/U+2029 (07 §6.1). `JSON.parse` reverses all of these.
 */
export function scriptSafeJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
