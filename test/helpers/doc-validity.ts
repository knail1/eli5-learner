/**
 * validateDocument (13 §7): static validity checks for a generated index.html. The core rules live
 * in src/main/document/validity.ts so writers run the same checks before every save (13 §7); this
 * helper adds the stricter test-side checks on top: the CSP meta compared directive by directive
 * with 07 §6.2 (including the runtime script hash and the meta's placement) and tab buttons that
 * match their panels.
 */
import { createHash } from 'node:crypto';
// validity.ts / html-tree.ts directly, not the module index: the index pulls in Electron, and
// Playwright specs run this helper in plain Node.
import { attr, parseTree, textOf, walk, type P5Element } from '../../src/main/document/html-tree';
import { checkDocumentHtml } from '../../src/main/document/validity';
import type { DocumentMeta } from '../../src/main/library';
import type { ValidityError, ValidityMeta, ValidityReport, ValidityRule } from '../../src/main/document/validity';

export type { ValidityError, ValidityMeta, ValidityReport, ValidityRule };

/**
 * 07 §6.2 policy. `script-src` holds only the placeholder: the allowed set is exactly the hashes of
 * the document's own executable inline scripts.
 */
const REFERENCE_CSP: ReadonlyMap<string, readonly string[]> = new Map([
  ['default-src', ["'none'"]],
  ['img-src', ['data:']],
  ['style-src', ["'unsafe-inline'"]],
  ['font-src', ['data:']],
  ['script-src', ['<hashes>']],
  ['connect-src', ["'none'"]],
  ['media-src', ["'none'"]],
  ['object-src', ["'none'"]],
  ['frame-src', ["'none'"]],
  ['form-action', ["'none'"]],
  ['base-uri', ["'none'"]],
]);
/** Directives that do not fall back to default-src, so they must be present. */
const NO_FALLBACK = ['form-action', 'base-uri'];
const JS_TYPES = /^(|module|(text|application)\/(x-)?(java|ecma)script)$/i;

function parseCsp(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    // A repeated directive is ignored by browsers after the first occurrence.
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), vals);
  }
  return out;
}

const sha256B64 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');

/** Test-side checks: CSP against 07 §6.2 and tab buttons against panels (13 §7.1). */
function extraChecks(html: string): ValidityError[] {
  const out: ValidityError[] = [];
  const { doc } = parseTree(html);
  const order: P5Element[] = [];
  let head: P5Element | undefined;
  walk(doc, (el) => {
    order.push(el);
    if (el.tagName === 'head') head = el;
  });

  // csp: one meta, in <head>, before any script (a meta policy only covers what follows it).
  const metas = order.filter(
    (el) => el.tagName === 'meta' && attr(el, 'http-equiv')?.toLowerCase() === 'content-security-policy',
  );
  const scripts = order.filter((el) => el.tagName === 'script');
  const executable = scripts.filter((el) => attr(el, 'src') === undefined && JS_TYPES.test(attr(el, 'type') ?? ''));
  const meta = metas[0];
  if (metas.length > 1) out.push({ rule: 'csp', detail: `${metas.length} CSP metas` });
  if (meta) {
    if (meta.parentNode !== head) out.push({ rule: 'csp', detail: 'CSP meta is not in <head>' });
    const firstScript = scripts[0];
    if (firstScript && order.indexOf(firstScript) < order.indexOf(meta))
      out.push({ rule: 'csp', detail: 'a <script> precedes the CSP meta' });

    const csp = parseCsp(attr(meta, 'content') ?? '');
    const hashes = executable.map((el) => `'sha256-${sha256B64(textOf(el))}'`);
    for (const [name, sources] of csp) {
      const allowed = name === 'script-src' ? hashes : (REFERENCE_CSP.get(name) ?? ["'none'"]);
      const extra = sources.filter((s) => !allowed.includes(s) && !(s === "'none'" && sources.length === 1));
      if (extra.length > 0) out.push({ rule: 'csp', detail: `${name} looser than 07 §6.2: ${extra.join(' ')}` });
    }
    for (const name of NO_FALLBACK)
      if ((csp.get(name) ?? []).join(' ') !== "'none'") out.push({ rule: 'csp', detail: `${name} is not 'none'` });
    const scriptSrc = csp.get('script-src') ?? [];
    for (const h of hashes)
      if (!scriptSrc.includes(h)) out.push({ rule: 'csp', detail: `inline script ${h} not allowed by script-src` });
  }

  // tabs present: one role=tab button per panel, wired both ways (08 §2).
  const panels = order.filter((el) => el.tagName === 'div' && attr(el, 'role') === 'tabpanel');
  const buttons = order.filter((el) => attr(el, 'role') === 'tab');
  for (const p of panels) {
    const key = attr(p, 'data-tab-key') ?? '';
    const id = attr(p, 'id') ?? '';
    if (id !== `tab-${key}`) out.push({ rule: 'tabs-match-meta', detail: `panel "${key}" has id "${id}"` });
    if (!buttons.some((b) => attr(b, 'aria-controls') === id))
      out.push({ rule: 'tabs-match-meta', detail: `no tab button for panel "${key}"` });
  }
  if (buttons.length !== panels.length)
    out.push({ rule: 'tabs-match-meta', detail: `${buttons.length} tab buttons for ${panels.length} panels` });
  return out;
}

export function validateDocument(html: string, meta?: DocumentMeta | ValidityMeta): ValidityReport {
  const base = checkDocumentHtml(html, meta);
  const seen = new Set(base.errors.map((e) => `${e.rule}:${e.detail}`));
  const errors = [...base.errors];
  for (const e of extraChecks(html)) {
    const k = `${e.rule}:${e.detail}`;
    if (!seen.has(k)) errors.push(e);
    seen.add(k);
  }
  return { ...base, ok: errors.length === 0, errors };
}

/** Throws with every error listed; convenient in tests. */
export function assertValidDocument(html: string, meta?: DocumentMeta | ValidityMeta): ValidityReport {
  const r = validateDocument(html, meta);
  if (!r.ok) throw new Error(`Invalid document:\n${r.errors.map((e) => `  ${e.rule}: ${e.detail}`).join('\n')}`);
  return r;
}
