// Static document validity checks (13 §7, §7.1). Used by test/helpers/doc-validity.ts and by the
// writers before every save, so an invalid document is never written.
import { createHash } from 'node:crypto';
import { attr, findAll, parseTree, textOf, walk, type P5Element } from './html-tree';
import { SECTION_ID_RE } from './section-id';

export type ValidityRule =
  | 'parse'
  | 'single-file'
  | 'no-external-ref'
  | 'csp'
  | 'section-id-format'
  | 'section-id-unique'
  | 'section-id-mirror'
  | 'tabs-match-meta'
  | 'default-tab'
  | 'glossary-scope'
  | 'references'
  | 'no-inline-handlers'
  | 'photo-credit'
  | 'size';

export interface ValidityError {
  rule: ValidityRule;
  detail: string;
  sectionId?: string;
}

export interface ValidityReport {
  ok: boolean;
  errors: ValidityError[];
  warnings: ValidityError[];
  stats: { bytes: number; sections: number; tabs: number };
}

/** The subset of DocumentMeta (09 §5.2) the checks read; a DocumentMeta is assignable to it. */
export interface ValidityMeta {
  tabs: readonly { key: string }[];
  sourcesUsed: readonly { ref: string; kind: string }[];
  sourcesSkipped: readonly { ref: string; reason: string }[];
}

/** 07 §5.4 whole-file limit: warning only. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const EXTERNAL_RE = /^\s*(https?:|\/\/|file:)/i;
const RESOURCE_ATTRS = ['src', 'srcset', 'poster', 'action', 'formaction', 'xlink:href', 'data', 'background'];

/** A resource reference is allowed only as data:, a fragment, or inline. */
function isExternalResource(v: string): boolean {
  const s = v.trim();
  if (s === '' || s.startsWith('data:') || s.startsWith('#')) return false;
  return true; // http(s), //, file:, or a relative path
}

function cssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push(m[2] ?? '');
  return out;
}

function baseName(ref: string): string {
  const parts = ref.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? ref;
}

function hostPath(ref: string): string | undefined {
  try {
    const u = new URL(ref);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return undefined;
  }
}

/**
 * 07 §6.2 policy. `script-src` is not listed: its allowed set is exactly the hashes of the
 * document's own executable inline scripts. Any directive not listed here must be 'none'.
 */
const REFERENCE_CSP: ReadonlyMap<string, readonly string[]> = new Map([
  ['default-src', ["'none'"]],
  ['img-src', ['data:']],
  ['style-src', ["'unsafe-inline'"]],
  ['font-src', ['data:']],
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

/** Parses the CSP into directive -> sources; browsers ignore a repeated directive after the first. */
function parseCsp(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), vals);
  }
  return out;
}

const sha256B64 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');

export function checkDocumentHtml(html: string, meta?: ValidityMeta): ValidityReport {
  const errors: ValidityError[] = [];
  const warnings: ValidityError[] = [];
  const err = (rule: ValidityRule, detail: string, sectionId?: string): void => {
    errors.push({ rule, detail, ...(sectionId ? { sectionId } : {}) });
  };
  const bytes = Buffer.byteLength(html, 'utf8');
  const { doc, errors: parseErrors } = parseTree(html);

  // parse
  for (const e of parseErrors.slice(0, 5)) err('parse', `${e.code} at ${e.startLine}:${e.startCol}`);
  const htmlEls = findAll(doc, (el) => el.tagName === 'html');
  if (htmlEls.length !== 1) err('parse', `expected one <html>, found ${htmlEls.length}`);
  if ((html.match(/<html[\s>]/gi) ?? []).length !== 1) err('parse', 'more than one <html> tag in the source');

  const all: P5Element[] = [];
  walk(doc, (el) => {
    all.push(el);
  });

  // single-file, no-external-ref, no-inline-handlers
  for (const el of all) {
    const tag = el.tagName;
    if (tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'frame' || tag === 'base')
      err('single-file', `<${tag}>`);
    if (tag === 'link') err('single-file', `<link rel="${attr(el, 'rel') ?? ''}">`);
    if (tag === 'script' && attr(el, 'src') !== undefined) err('single-file', '<script src>');
    for (const a of el.attrs) {
      if (/^on/i.test(a.name)) err('no-inline-handlers', `${tag}[${a.name}]`);
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      if (RESOURCE_ATTRS.includes(name) && isExternalResource(a.value)) {
        err('no-external-ref', `${tag}[${name}]=${a.value.slice(0, 80)}`);
      }
      if (name === 'href') {
        if (tag === 'a') {
          if (EXTERNAL_RE.test(a.value) || /^mailto:/i.test(a.value)) {
            if (attr(el, 'target') !== '_blank' || attr(el, 'rel') !== 'noopener noreferrer') {
              err('no-external-ref', `a[href=${a.value.slice(0, 80)}] without target/rel`);
            }
          } else if (!a.value.startsWith('#')) {
            err('no-external-ref', `a[href=${a.value.slice(0, 80)}] relative`);
          }
        } else if (!a.value.startsWith('#')) {
          err('no-external-ref', `${tag}[href]=${a.value.slice(0, 80)}`);
        }
      }
      if (name === 'style') {
        for (const u of cssUrls(a.value))
          if (isExternalResource(u)) err('no-external-ref', `inline style url(${u.slice(0, 80)})`);
      }
    }
    if (tag === 'style') {
      const css = textOf(el);
      if (/@import/i.test(css)) err('no-external-ref', '@import in <style>');
      for (const u of cssUrls(css)) if (isExternalResource(u)) err('no-external-ref', `url(${u.slice(0, 80)})`);
    }
  }

  // csp (07 §6.2): one meta, in <head>, before any script (a meta policy only covers what follows
  // it), directive by directive no looser than the reference, script-src = the inline script hashes.
  const head = all.find((el) => el.tagName === 'head');
  const cspMetas = all.filter(
    (el) => el.tagName === 'meta' && attr(el, 'http-equiv')?.toLowerCase() === 'content-security-policy',
  );
  const cspMeta = cspMetas[0];
  if (!cspMeta) err('csp', 'missing CSP meta');
  else {
    if (cspMetas.length > 1) err('csp', `${cspMetas.length} CSP metas`);
    if (cspMeta.parentNode !== head) err('csp', 'CSP meta is not in <head>');
    const scripts = all.filter((el) => el.tagName === 'script');
    const firstScript = scripts[0];
    if (firstScript && all.indexOf(firstScript) < all.indexOf(cspMeta)) err('csp', 'a <script> precedes the CSP meta');

    const csp = parseCsp(attr(cspMeta, 'content') ?? '');
    const hashes = scripts
      .filter((el) => attr(el, 'src') === undefined && JS_TYPES.test(attr(el, 'type') ?? ''))
      .map((el) => `'sha256-${sha256B64(textOf(el))}'`);
    if ((csp.get('default-src') ?? []).join(' ') !== "'none'") err('csp', "default-src is not 'none'");
    for (const [name, sources] of csp) {
      if (name === 'default-src') continue;
      const allowed = name === 'script-src' ? hashes : (REFERENCE_CSP.get(name) ?? ["'none'"]);
      const extra = sources.filter((s) => !allowed.includes(s) && !(s === "'none'" && sources.length === 1));
      if (extra.length > 0) err('csp', `${name} looser than 07 §6.2: ${extra.join(' ')}`);
    }
    for (const name of NO_FALLBACK)
      if ((csp.get(name) ?? []).join(' ') !== "'none'") err('csp', `${name} is not 'none'`);
    const scriptSrc = csp.get('script-src') ?? [];
    for (const h of hashes) if (!scriptSrc.includes(h)) err('csp', `inline script ${h} not allowed by script-src`);
  }

  // sections and tabs
  const panels = all.filter((el) => el.tagName === 'div' && attr(el, 'role') === 'tabpanel');
  const ids = new Map<string, number>();
  for (const el of all) {
    const id = attr(el, 'id');
    if (id !== undefined) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  for (const [id, n] of ids) if (n > 1) err('section-id-unique', `duplicate id "${id}"`);
  let sectionCount = 0;
  const sectionsInPanels = new Set<P5Element>();
  for (const panel of panels) {
    const key = attr(panel, 'data-tab-key') ?? '';
    for (const c of panel.childNodes) {
      if (!('tagName' in c) || c.tagName !== 'section') continue;
      sectionsInPanels.add(c);
      sectionCount++;
      const id = attr(c, 'id') ?? '';
      if (!SECTION_ID_RE.test(id)) err('section-id-format', `bad section id "${id}"`, id);
      else if (id.slice(4, id.lastIndexOf('-')) !== key) err('section-id-format', `tab key segment != "${key}"`, id);
      if (attr(c, 'data-section-id') !== id) err('section-id-mirror', 'data-section-id != id', id);
    }
  }
  for (const el of all) {
    if (el.tagName === 'section' && !sectionsInPanels.has(el))
      err('section-id-format', 'section outside a tab panel', attr(el, 'id'));
    if (el.tagName !== 'section' && attr(el, 'data-section-id') !== undefined)
      err('section-id-mirror', `data-section-id on <${el.tagName}>`);
  }

  // tabs present: one role=tab button per panel, wired both ways (08 §2).
  const tabButtons = all.filter((el) => attr(el, 'role') === 'tab');
  for (const p of panels) {
    const key = attr(p, 'data-tab-key') ?? '';
    const id = attr(p, 'id') ?? '';
    if (id !== `tab-${key}`) err('tabs-match-meta', `panel "${key}" has id "${id}"`);
    if (!tabButtons.some((b) => attr(b, 'aria-controls') === id))
      err('tabs-match-meta', `no tab button for panel "${key}"`);
  }
  if (tabButtons.length !== panels.length)
    err('tabs-match-meta', `${tabButtons.length} tab buttons for ${panels.length} panels`);
  const keys = panels.map((p) => attr(p, 'data-tab-key') ?? '');
  if (!keys.includes('indepth') || !keys.includes('eli5')) err('tabs-match-meta', 'indepth and eli5 tabs are required');
  if (meta) {
    const want = meta.tabs.map((t) => t.key);
    if (want.join(',') !== keys.join(','))
      err('tabs-match-meta', `tabs [${keys.join(',')}] != meta [${want.join(',')}]`);
  }

  // default-tab
  const selected = all.filter((el) => attr(el, 'role') === 'tab' && attr(el, 'aria-selected') === 'true');
  if (selected.length !== 1 || attr(selected[0] as P5Element, 'aria-controls') !== 'tab-indepth') {
    err('default-tab', 'indepth must be the only initially selected tab');
  }

  // glossary-scope
  walk(doc, (el, anc) => {
    if (el.tagName === 'details' && (attr(el, 'class') ?? '').split(/\s+/).includes('gl-note')) {
      const panel = [...anc].reverse().find((a) => attr(a, 'role') === 'tabpanel');
      if (!panel || attr(panel, 'data-tab-key') !== 'indepth')
        err('glossary-scope', `note ${attr(el, 'id') ?? ''} outside the indepth panel`);
    }
  });

  // references
  const indepth = panels.find((p) => attr(p, 'data-tab-key') === 'indepth');
  const lastSection = indepth
    ? [...indepth.childNodes].reverse().find((c): c is P5Element => 'tagName' in c && c.tagName === 'section')
    : undefined;
  if (!lastSection || attr(lastSection, 'data-kind') !== 'references')
    err('references', 'indepth does not end with a references section');
  else {
    if (attr(lastSection, 'data-eli5-actionable') !== 'false') err('references', 'references section is actionable');
    if (meta) {
      const text = textOf(lastSection);
      const hrefs = findAll(lastSection, (el) => el.tagName === 'a').map((a) => attr(a, 'href') ?? '');
      for (const s of meta.sourcesUsed) {
        const found =
          s.kind === 'clipboard'
            ? /Pasted (text|image)/.test(text)
            : text.includes(baseName(s.ref)) ||
              text.includes(s.ref) ||
              hrefs.includes(s.ref) ||
              (hostPath(s.ref) !== undefined && text.includes(hostPath(s.ref) ?? ''));
        if (!found) err('references', `used source missing: ${s.ref.slice(0, 80)}`);
      }
      for (const s of meta.sourcesSkipped) {
        const label = hostPath(s.ref) ?? baseName(s.ref);
        if (!text.includes(label) && !text.includes(s.ref))
          err('references', `skipped source missing: ${s.ref.slice(0, 80)}`);
        if (s.reason.trim() && !text.includes(s.reason.trim()))
          err('references', `skip reason missing for ${s.ref.slice(0, 80)}`);
      }
    }
  }

  // photo-credit (07 §7.4): every stock photo shows its attribution with the license.
  const hasClass = (el: P5Element, c: string): boolean => (attr(el, 'class') ?? '').split(/\s+/).includes(c);
  for (const fig of all.filter((el) => el.tagName === 'figure' && hasClass(el, 'stock-photo'))) {
    const credit = findAll(fig, (el) => hasClass(el, 'fig-credit'))[0];
    if (!credit || findAll(credit, (el) => hasClass(el, 'fig-license')).length === 0)
      err('photo-credit', 'stock photo without its credit');
  }

  // size (warning only)
  if (bytes > MAX_DOCUMENT_BYTES) warnings.push({ rule: 'size', detail: `${bytes} bytes > ${MAX_DOCUMENT_BYTES}` });

  return { ok: errors.length === 0, errors, warnings, stats: { bytes, sections: sectionCount, tabs: panels.length } };
}
