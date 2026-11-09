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
export function codeOnly(js: string, literals?: string[]): string {
  let out = '';
  let i = 0;
  const depth: number[] = []; // brace depth per open template expression
  let braces = 0;
  const n = js.length;
  const skipString = (q: string): void => {
    let j = i + 1;
    while (j < n && js[j] !== q && js[j] !== '\n') j += js[j] === '\\' ? 2 : 1;
    if (j < n && js[j] === q) {
      literals?.push(js.slice(i + 1, j));
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
    const start = i;
    while (i < n) {
      const c = js[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        literals?.push(js.slice(start, i));
        i++;
        return;
      }
      if (c === '$' && js[i + 1] === '{') {
        literals?.push(js.slice(start, i));
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
  // a computed member key built by concatenating strings: x['fe' + 'tch'], x[k + 'al'], f()?.['a' + b].
  // Only member access (an identifier, string, `)`, `]`, `}` or `.` before the `[`): an array
  // literal such as [['Rate', r + '%']] or ['Day ' + d, 'x'] is data, not a key.
  ['concat-key', /(?<=[\w$)\]}'"`.]\s*)\[[^\]\n]*?(?:(['"`])[^'"`\]\n]*\1\s*\+|\+\s*(['"`])[^'"`\]\n]*\2\s*\])/],
  [
    'banned-element',
    new RegExp(
      `(createElement(NS)?|\\bel)\\s*\\(\\s*(['"\`][^'"\`]*['"\`]\\s*,\\s*)?['"\`]\\s*([a-z]+:)?(${BANNED_TAGS})\\s*['"\`]`,
      'i',
    ),
  ],
  ['url-string', /['"`]\s*([a-z][a-z0-9+.-]*:)?\/\/(?!www\.w3\.org\/)[a-z0-9]/i],
  // WebRTC ICE servers: a STUN/TURN request is not covered by any CSP directive
  ['ice-url', /['"`]\s*(stuns?|turns?):(?!\s)/i],
  ['ice', /iceServers|createDataChannel|createOffer|setLocalDescription/],
  ['script-close', /<\/script|<!--/i],
  // a meta refresh (audit round 3): the pragma, its content syntax ("0;url=…") or the bare name
  ['http-equiv', /http-?equiv/i],
  ['refresh', /(['"`])\s*refresh\s*\1/],
  ['refresh', /\d\s*;\s*url\s*=/i],
  // a URL split to dodge the url-string rule: 'http:' + …, '/' + '/host'
  ['url-split', /(['"`])[^'"`\n]*\b(https?|wss?|ftp|file|blob):\1\s*\+|(['"`])\/\3\s*\+\s*['"`]\/|(['"`])\/\/\4\s*\+/i],
];

/** Rules for the text of each string and template literal (anywhere in it, not only at its start). */
const JS_LITERAL: readonly [string, RegExp][] = [
  ['url-string', /\/\/(?!www\.w3\.org\/)[a-z0-9]/i],
  ['url-string', /\b(https?|wss?|ftp|file|blob):(?=\S)(?!\/\/www\.w3\.org\/)/i],
];

/** Word rules for js identifiers, applied to codeOnly() text (strings, regexes and comments gone). */
const JS_CODE: readonly [string, RegExp][] = [
  ['fetch', /\bfetch\b/],
  // a customized built-in (`class F extends HTMLAnchorElement`, `customElements.define`) creates a
  // banned element without createElement (audit round 2); the shell also removes customElements
  ['customElements', /\b(customElements|CustomElementRegistry)\b|\bextends\s+[\w$.]*(HTML|SVG)\w*Element\b/],
  ['import', /\bimport\b/],
  ['eval', /\beval\b/],
  ['Function', /\bFunction\s*\(/],
  ['cookie', /\bcookieStore\b/],
  ['storage', /\b(localStorage|sessionStorage|indexedDB)\b|\bcaches\s*(\?\.|\.)\s*(open|match|keys|has|delete)\b/],
  ['channel', /\b(BroadcastChannel|MessageChannel)\b/],
  ['navigator', /\bnavigator\b/],
  ['constructor-access', /\.\s*constructor\b/],
  ['computed-global', /(?<![.\w$])(window|globalThis|self|top|parent|document|this)\s*(\?\.\s*)?\[/],
  ['global-alias', /(?<![.\w$])(window|globalThis)\b(?!\s*(\?\.|\.))/],
  // the window through a member: globalThis.window, x.globalThis, self.frames, document.self
  [
    'global-alias',
    /(\?\.|\.)\s*(window|globalThis)\b|\b(window|self|globalThis|frames|top|parent|document|this)\s*(\?\.|\.)\s*(self|frames)\b/,
  ],
  // top-level `this` is the window: reflection over it reaches any global by a runtime string.
  // `.bind(this)`, `.call(this, …)` and `.apply(this, …)` only pass `this` on as a receiver, where
  // any use of it is linted again.
  [
    'this-global',
    /(?<![.\w$])this\s*(\?\.|\.)\s*(frames|window|self|top|parent|globalThis|document|opener)\b|(?<!\b(bind|call|apply)\s*)\(\s*this\s*[,)]|,\s*this\s*[,)]|\bin\s+this\b/,
  ],
  ['Reflect', /\bReflect\b/],
  // copying an element that is already in the frame (a shell meta) creates a banned element without
  // createElement; the Navigation API navigates the frame (audit round 3)
  ['clone', /\b(cloneNode|importNode|adoptNode)\b|(\?\.|\.)\s*implementation\b/],
  ['navigation', /\bnavigation\b/],
  ['atob', /\batob\b/],
  ['second-realm', /\b(contentWindow|contentDocument|getSVGDocument|defaultView)\b/],
  [
    'html-sink',
    /\b(innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|srcdoc|setHTMLUnsafe|parseHTMLUnsafe|XSLTProcessor|execCommand)\b|\.\s*write(ln)?\s*\(/,
  ],
  // bare `location`, or the real one through a global or a document; `peak.location` is a property
  [
    'location',
    /(?<![.\w$])(?<![{,]\s*)location\b|(?<![.\w$])location\b(?!\s*:)|(\b(window|self|globalThis|frames|top|parent|document|ownerDocument|this)|\))\s*(\?\.|\.)\s*location\b/,
  ],
  ['open', /(?<![.\w$])open\s*\(|\b(window|self|globalThis|document)\s*(\?\.|\.)\s*open\b/],
  ['opener', /\bopener\b/],
  ['frameElement', /\bframeElement\b/],
  ['cookie', /(\b(document|ownerDocument|this)|\))\s*(\?\.|\.)\s*cookie\b/],
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
const BARE_GLOBALS = ['top', 'parent', 'self', 'frames'] as const;

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
    new RegExp(`\\b(class|function)\\s+${name}\\b`),
  ].some((re) => re.test(code));
}

function bareGlobalHits(code: string): string[] {
  const hits: string[] = [];
  for (const name of BARE_GLOBALS) {
    if (declares(code, name)) continue;
    const ref = new RegExp(`(?<![.\\w$])(?<![{,]\\s*)${name}\\b|(?<![.\\w$])${name}\\b(?!\\s*:)`);
    if (ref.test(code)) hits.push(name === 'self' || name === 'frames' ? 'global-alias' : name);
  }
  // Worker: the real one (also removed by the shell) unless the code declares its own class or
  // binding of that name; a member `x.Worker` is always the global's.
  if (/(?<![.\w$])Worker\b/.test(code) && !declares(code, 'Worker')) hits.push('Worker');
  if (/(\?\.|\.)\s*Worker\b/.test(code)) hits.push('Worker');
  return hits;
}

/**
 * When the code aliases the document (`const d = document`, `el.ownerDocument`, `getRootNode()`),
 * any `.location` or `.cookie` may be the real one, so the narrow member rules above do not apply.
 */
function documentAliasHits(code: string): string[] {
  if (!/(?<![.\w$])document\b(?!\s*(\?\.|\.))|\b(ownerDocument|getRootNode)\b/.test(code)) return [];
  const hits: string[] = [];
  if (/(\?\.|\.)\s*location\b/.test(code)) hits.push('location');
  if (/(\?\.|\.)\s*cookie\b/.test(code)) hits.push('cookie');
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
  const literals: string[] = [];
  const stripped = codeOnly(js, literals);
  run('js', stripped, JS_CODE);
  for (const [name, re] of JS_LITERAL) if (literals.some((l) => re.test(l))) hits.push(`js:${name}`);
  for (const h of [...bareGlobalHits(stripped), ...documentAliasHits(stripped)]) hits.push(`js:${h}`);
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
