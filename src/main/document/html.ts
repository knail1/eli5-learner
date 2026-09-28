// HTML escaping and attribute helpers for the renderer (07 §6.1: all model text is escaped).

// C0 controls other than tab, LF and CR, plus DEL and C1 controls: parse errors in HTML (13 §7.1).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufdd0-\ufdef\ufffe\uffff]/g;

/** Removes characters that are parse errors in HTML text; CR is normalized away as well. */
export function stripControls(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

/** Escapes text content. */
export function esc(s: string): string {
  return stripControls(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes a double-quoted attribute value. */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

export type AttrValue = string | number | boolean | undefined | null;

/**
 * Renders attributes in the given (fixed) order (07 §5.5). `true` renders a bare attribute,
 * `false`/`undefined`/`null` omit it.
 */
export function attrs(list: readonly (readonly [string, AttrValue])[]): string {
  let out = '';
  for (const [name, value] of list) {
    if (value === undefined || value === null || value === false) continue;
    out += value === true ? ` ${name}` : ` ${name}="${escAttr(String(value))}"`;
  }
  return out;
}

/** Collapses whitespace runs and trims (07 §5.1 step 1). */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Caps a string at `max` characters, cutting on a word boundary with an ellipsis. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}
