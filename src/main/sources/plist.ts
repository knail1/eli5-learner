/**
 * Minimal XML property-list reader for NSFilenamesPboardType (03 §6.2 step 1.1): returns the
 * <string> items of the top-level <array>. Built in because the `plist` package listed in 01 §7 is
 * not installed; this handles only the shape Finder writes. Returns null on anything malformed.
 */

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string | null {
  let bad = false;
  const out = s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (_m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        bad = true;
        return '';
      }
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[e.toLowerCase()];
    if (v === undefined) bad = true;
    return v ?? '';
  });
  return bad ? null : out;
}

/** Strings of the root array in an XML plist, or null if the input is not such a plist. */
export function parsePlistStringArray(xml: string): string[] | null {
  const body = xml
    .replace(/^\s+/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const root = /^<plist\b[^>]*>([\s\S]*)<\/plist>$/.exec(body);
  if (!root) return null;
  const inner = (root[1] ?? '').trim();
  if (/^<array\s*\/>$/.test(inner)) return [];
  const arr = /^<array>([\s\S]*)<\/array>$/.exec(inner);
  if (!arr) return null;
  const items: string[] = [];
  const re = /\s*<string>([^<]*)<\/string>\s*|\s*<string\s*\/>\s*/y;
  const content = arr[1] ?? '';
  let pos = 0;
  while (pos < content.length) {
    re.lastIndex = pos;
    const m = re.exec(content);
    if (!m) return content.slice(pos).trim() === '' ? items : null;
    const decoded = decodeEntities(m[1] ?? '');
    if (decoded === null) return null;
    items.push(decoded);
    pos = re.lastIndex;
  }
  return items;
}
