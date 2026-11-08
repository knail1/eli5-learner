// Static lint of model-written animation code (07 §5.2, §7.1 animation; design addendum). Defense in
// depth only: the boundary is the frame's sandbox and CSP (07 §6.2). A hit drops the block with the
// `animation-dropped` warning; it is never a repair request. Rules are deliberately broad: a false
// positive costs one animation (the poster and caption remain), a false negative is still sandboxed.

export interface AnimationCode {
  html?: string | undefined;
  css?: string | undefined;
  js: string;
}

/** Keywords after which a `/` starts a regular expression literal, not a division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);

/**
 * Removes string, template and regular expression literal text and comments, keeping `${…}`
 * expressions, so word rules on identifiers (top, parent, location, fetch, eval) do not fire on
 * prose or labels. A quote that does not close on its line cannot start a valid string, so it is
 * kept as code: a scanner confused by unusual code never hides the rest of a line.
 */
export function codeOnly(js: string): string {
  let out = '';
  let i = 0;
  const depth: number[] = []; // brace depth per open template expression
  let braces = 0;
  const n = js.length;
  const skipString = (q: string): void => {
    let j = i + 1;
    while (j < n && js[j] !== q && js[j] !== '\n') j += js[j] === '\\' ? 2 : 1;
    if (j < n && js[j] === q) {
      i = j + 1;
      out += ' ';
    } else {
      out += q; // unterminated: not a string, keep scanning it as code
      i++;
    }
  };
  const regexStarts = (): boolean => {
    const before = out.trimEnd();
    if (before === '') return true;
    const last = before[before.length - 1] as string;
    if ('(,=:[!&|?{};+-*%<>~^'.includes(last)) return true;
    const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0];
    return word !== undefined && REGEX_AFTER_WORD.has(word);
  };
  const skipRegex = (): void => {
    let j = i + 1;
    let inClass = false;
    while (j < n && js[j] !== '\n') {
      const c = js[j];
      if (c === '\\') j += 2;
      else {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
    }
    if (j < n && js[j] === '/') {
      j++;
      while (j < n && /[a-z]/i.test(js[j] as string)) j++;
      i = j;
      out += ' ';
    } else {
      out += '/'; // unterminated: a division after all
      i++;
    }
  };
  const skipTemplate = (): void => {
    // From just after a backtick or a closing `}` of an expression to the next `${` or backtick.
    while (i < n) {
      const c = js[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return;
      }
      if (c === '$' && js[i + 1] === '{') {
        i += 2;
        depth.push(braces);
        braces = 0;
        out += ' ${';
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = js[i] as string;
    const d = js[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && js[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && d === '*') {
      const end = js.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
    } else if (c === '/' && regexStarts()) {
      skipRegex();
    } else if (c === "'" || c === '"') {
      skipString(c);
    } else if (c === '`') {
      i++;
      out += ' ';
      skipTemplate();
    } else if (c === '{') {
      braces++;
      out += c;
      i++;
    } else if (c === '}' && depth.length > 0 && braces === 0) {
      braces = depth.pop() ?? 0;
      out += '} ';
      i++;
      skipTemplate();
    } else {
      if (c === '}') braces--;
      out += c;
      i++;
    }
  }
  return out;
}

/** Elements model code may never create (a second realm, navigation, preloads, forms, scripts). */
const BANNED_TAGS = 'iframe|frame|frameset|object|embed|portal|fencedframe|link|meta|base|form|a|area|script';

/**
 * Raw-text rules for js: names that are never prose, the markup of banned elements created by
 * name, external URLs in strings, and the obfuscation heuristics that build names from strings.
 */
const JS_RAW: readonly [string, RegExp][] = [
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['WebTransport', /WebTransport/],
  ['EventSource', /EventSource/],
  ['sendBeacon', /sendBeacon/],
  ['RTCPeerConnection', /RTC[A-Za-z]*(Connection|Channel|SessionDescription|IceCandidate)|PeerConnection/],
  ['Worker', /SharedWorker|serviceWorker/],
  ['importScripts', /importScripts/],
  ['string-timer', /\bset(Timeout|Interval)\s*\(\s*['"`]/],
  ['postMessage', /postMessage/],
  ['constructor-key', /\[\s*['"`]constructor/],
  // a computed key built by concatenating strings: x['fe' + 'tch'], x[k + 'al']
  ['concat-key', /\[\s*(['"`])[^'"`\]\n]*\1\s*\+|\+\s*(['"`])[^'"`\]\n]*\2\s*\]/],
  [
    'banned-element',
    new RegExp(
      `(createElement(NS)?|\\bel)\\s*\\(\\s*(['"\`][^'"\`]*['"\`]\\s*,\\s*)?['"\`]\\s*([a-z]+:)?(${BANNED_TAGS})\\s*['"\`]`,
      'i',
    ),
  ],
  ['url-string', /['"`]\s*([a-z][a-z0-9+.-]*:)?\/\/(?!www\.w3\.org\/)[a-z0-9]/i],
  ['script-close', /<\/script|<!--/i],
];

/** Word rules for js identifiers, applied to codeOnly() text (strings, regexes and comments gone). */
const JS_CODE: readonly [string, RegExp][] = [
  ['fetch', /\bfetch\b/],
  ['Worker', /\bWorker\b/],
  ['import', /\bimport\b/],
  ['eval', /\beval\b/],
  ['Function', /\bFunction\s*\(/],
  ['cookie', /\.\s*cookie\b|\bcookieStore\b/],
  ['storage', /\b(localStorage|sessionStorage|indexedDB)\b|\bcaches\s*(\?\.|\.)\s*(open|match|keys|has|delete)\b/],
  ['channel', /\b(BroadcastChannel|MessageChannel)\b/],
  ['navigator', /\bnavigator\b/],
  ['constructor-access', /\.\s*constructor\b/],
  ['computed-global', /(?<![.\w$])(window|globalThis|self|frames|top|parent|document|this)\s*(\?\.\s*)?\[/],
  ['global-alias', /(?<![.\w$])(window|globalThis|frames)\b(?!\s*(\?\.|\.))/],
  ['Reflect', /\bReflect\b/],
  ['atob', /\batob\b/],
  ['second-realm', /\b(contentWindow|contentDocument|getSVGDocument|defaultView)\b/],
  [
    'html-sink',
    /\b(innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|srcdoc|setHTMLUnsafe|parseHTMLUnsafe|XSLTProcessor|execCommand)\b|\.\s*write(ln)?\s*\(/,
  ],
  ['location', /(?<![\w$])location\b/],
  ['open', /(?<![.\w$])open\s*\(|\b(window|self|globalThis|document)\s*(\?\.|\.)\s*open\b/],
  ['opener', /\bopener\b/],
  ['frameElement', /\bframeElement\b/],
  // top and parent through a global, or used for what only the real ones offer
  ['top', /\b(window|self|globalThis|document|frames)\s*(\?\.|\.)\s*(top|parent)\b/],
  [
    'top',
    /(?<![\w$])(top|parent)\s*(\?\.|\.)\s*(document|location|postMessage|frames|window|self|top|parent|opener|frameElement|open|eval|Function|fetch)\b/,
  ],
];

/**
 * `top`, `parent` and `self` as bare identifiers are hits unless the code declares a binding of
 * that name (a margin variable, a helper's parameter), so a reference to the real window cannot be
 * taken without a rule seeing it. Object keys (`{ top: 1 }`) are not references.
 */
const BARE_GLOBALS = ['top', 'parent', 'self'] as const;

/** The binding parts (before each top-level `=`) of every var/let/const declaration list. */
function declaredBindings(code: string): string[] {
  const out: string[] = [];
  const re = /\b(var|let|const)\s+/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let binding = true;
    let cur = '';
    for (; i < code.length; i++) {
      const c = code[i] as string;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === ';' || c === '\n')) break;
      else if (depth === 0 && c === ',') {
        out.push(cur);
        cur = '';
        binding = true;
        continue;
      } else if (depth === 0 && c === '=' && code[i + 1] !== '=' && code[i + 1] !== '>') {
        binding = false;
        continue;
      }
      if (binding) cur += c;
    }
    out.push(cur);
  }
  return out;
}

function declares(code: string, name: string): boolean {
  const w = new RegExp(`(?<![.\\w$])${name}\\b`);
  if (declaredBindings(code).some((b) => w.test(b))) return true;
  return [
    new RegExp(`\\bfunction\\b[\\w$\\s]*\\([^)]*${w.source}[^)]*\\)`),
    new RegExp(`\\(([^()]*[,\\s(])?${name}\\s*(,[^()]*)?\\)\\s*=>`),
    new RegExp(`(?<![.\\w$])${name}\\s*=>`),
    new RegExp(`\\bcatch\\s*\\(\\s*${name}\\s*\\)`),
  ].some((re) => re.test(code));
}

function bareGlobalHits(code: string): string[] {
  const hits: string[] = [];
  for (const name of BARE_GLOBALS) {
    if (declares(code, name)) continue;
    const ref = new RegExp(`(?<![.\\w$])(?<![{,]\\s*)${name}\\b|(?<![.\\w$])${name}\\b(?!\\s*:)`);
    if (ref.test(code)) hits.push(name === 'self' ? 'global-alias' : name);
  }
  return hits;
}

/** Markup and URL rules: checked in html, and in js string literals (raw js). */
const MARKUP: readonly [string, RegExp][] = [
  ['<iframe', /<\s*iframe/i],
  ['<frame', /<\s*frame\b/i],
  ['<form', /<\s*form\b/i],
  ['<a href', /<\s*a\b[^>]*\bhref/i],
  ['<meta', /<\s*meta\b/i],
  ['<base', /<\s*base\b/i],
  ['<script src', /<\s*script\b[^>]*\bsrc/i],
  ['<link', /<\s*link\b/i],
  ['<object', /<\s*(object|embed|portal)\b/i],
  ['javascript:', /javascript\s*:/i],
  ['url(', /url\(\s*['"]?\s*(?!data:|#)[^)\s'"]/i],
];

/** HTML-only rules. */
const HTML_ONLY: readonly [string, RegExp][] = [
  ['<script', /<\s*script\b/i],
  ['inline-handler', /\son[a-z]+\s*=/i],
  [
    'external-ref',
    /\b(src|href|action|formaction|srcset|poster|data|background|xlink:href)\s*=\s*['"]?\s*(?!data:|#)[^\s'">]/i,
  ],
];

/** CSS-only rules. */
const CSS_ONLY: readonly [string, RegExp][] = [
  ['@import', /@import/i],
  ['style-close', /<\/style/i],
  ['expression', /expression\s*\(/i],
];

/**
 * The rules an animation's code breaks, as `<part>:<rule>` strings (empty: accepted). Never throws.
 */
export function lintAnimation(code: AnimationCode): string[] {
  const hits: string[] = [];
  const run = (part: string, text: string, rules: readonly [string, RegExp][]): void => {
    for (const [name, re] of rules) if (re.test(text)) hits.push(`${part}:${name}`);
  };
  const js = code.js;
  run('js', js, JS_RAW);
  const stripped = codeOnly(js);
  run('js', stripped, JS_CODE);
  for (const h of bareGlobalHits(stripped)) hits.push(`js:${h}`);
  run('js', js, MARKUP);
  const html = code.html ?? '';
  if (html) {
    run('html', html, MARKUP);
    run('html', html, HTML_ONLY);
  }
  const css = code.css ?? '';
  if (css) {
    run('css', css, MARKUP);
    run('css', css, CSS_ONLY);
  }
  return [...new Set(hits)];
}
