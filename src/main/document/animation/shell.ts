// The trusted shell of every animation frame (07 §7.1 animation, design addendum 2026-11-08): a
// fixed script and stylesheet that run inside the sandboxed srcdoc before the model's code. The
// shell neuters network and escape APIs, owns the only channel to the parent (theme in, one height
// message out), pauses animation loops while the frame is hidden or off screen, honours reduced
// motion and gives the model a small accessible helper API (`window.ELI5`).
//
// Frozen: documents pin this exact text by hash (the frame CSP and the parent CSP). A change is a
// new shell version and a DOC_RUNTIME_VERSION bump. Older versions stay in ANIMATION_SHELLS so
// older documents still parse and pass validity; rendering always writes the current shell, so an
// older document's frames (and both CSPs) change when it is re-rendered, exactly as the runtime
// refresh on open replaces its runtime. Byte-identical round-trips hold for the current shell only. Written without backticks, `${` or backslashes so
// String.raw keeps the source text exactly.

/**
 * Version 4 of the shell script: version 3 (version 2 that also removes custom elements, since a
 * customized built-in creates a banned element without createElement; version 2 is version 1 with
 * the shared chart palette, 07 §11.1) that also removes every banned element already in the frame
 * (its own metas too), denies cloneNode, importNode and createDocument results that are or hold a
 * banned element, and removes the Navigation API (audit round 3: a cloned meta refresh).
 */
export const ANIMATION_SHELL_JS = String.raw`(function () {
  'use strict';
  var W = window, D = document, P = W.parent;
  var post = P && P !== W ? function (m) { P.postMessage(m, '*'); } : function () {};
  function kill(o, k) {
    try { Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
  ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'RTCPeerConnection',
    'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'Worker', 'SharedWorker',
    'BroadcastChannel', 'MessageChannel', 'importScripts', 'open', 'opener', 'parent', 'frameElement',
    'indexedDB', 'localStorage', 'sessionStorage', 'caches', 'cookieStore', 'Notification'
  ].forEach(function (k) { kill(W, k); });
  try { kill(W.Navigator.prototype, 'sendBeacon'); kill(W.Navigator.prototype, 'serviceWorker'); } catch (e) {}
  function deny() { throw new TypeError('ELI5: not available in an animation'); }
  function guard(o, k, setterOnly) {
    try {
      var d = Object.getOwnPropertyDescriptor(o, k);
      if (!d) return;
      if (setterOnly && d.get) Object.defineProperty(o, k, { get: d.get, set: deny, configurable: false });
      else Object.defineProperty(o, k, { value: deny, writable: false, configurable: false });
    } catch (e) {}
  }
  ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement'].forEach(function (c) {
    var p = W[c] && W[c].prototype;
    if (!p) return;
    ['contentWindow', 'contentDocument'].forEach(function (k) {
      try { Object.defineProperty(p, k, { get: function () { return null; }, configurable: false }); } catch (e) {}
    });
    kill(p, 'getSVGDocument');
  });
  [W.Element && W.Element.prototype, W.ShadowRoot && W.ShadowRoot.prototype].forEach(function (p) {
    if (!p) return;
    guard(p, 'innerHTML', true); guard(p, 'outerHTML', true);
    guard(p, 'insertAdjacentHTML'); guard(p, 'setHTMLUnsafe');
  });
  [W.Document, W.HTMLDocument].forEach(function (c) {
    if (c) ['write', 'writeln', 'execCommand'].forEach(function (k) { guard(c.prototype, k); });
  });
  try { guard(W.Range.prototype, 'createContextualFragment'); } catch (e) {}
  ['DOMParser', 'XSLTProcessor'].forEach(function (k) { kill(W, k); });
  kill(W.Document, 'parseHTMLUnsafe');
  try { guard(W.CustomElementRegistry.prototype, 'define'); } catch (e) {}
  kill(W, 'customElements');
  var banned = ['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'link', 'meta',
    'base', 'form', 'a', 'area', 'script'];
  function bannedTag(n) {
    n = String(n).toLowerCase();
    return banned.indexOf(n.slice(n.indexOf(':') + 1)) >= 0;
  }
  var DP = W.Document.prototype, mk = DP.createElement, mkNS = DP.createElementNS;
  try {
    Object.defineProperty(DP, 'createElement', { writable: false, configurable: false, value: function (n, o) {
      if (bannedTag(n)) deny();
      return mk.call(this, n, o);
    } });
    Object.defineProperty(DP, 'createElementNS', { writable: false, configurable: false, value: function (ns, n, o) {
      if (bannedTag(n)) deny();
      return mkNS.call(this, ns, n, o);
    } });
  } catch (e) {}
  // Version 4: no element that can navigate, refresh or preload stays in the frame (the shell's own
  // metas included: their policies stay in force once parsed), and none can be copied in.
  var sel = banned.join(',');
  try {
    Array.prototype.forEach.call(D.querySelectorAll(sel), function (e) { if (e.localName !== 'script') e.remove(); });
  } catch (e) {}
  function copyGuard(o, k) {
    var f = o && o[k];
    if (typeof f !== 'function') return;
    try {
      Object.defineProperty(o, k, { writable: false, configurable: false, value: function () {
        var n = f.apply(this, arguments);
        if (n && ((n.nodeType === 1 && bannedTag(n.localName)) || (n.querySelector && n.querySelector(sel)))) deny();
        return n;
      } });
    } catch (e) {}
  }
  copyGuard(W.Node.prototype, 'cloneNode');
  copyGuard(DP, 'importNode');
  try {
    var mkDoc = W.DOMImplementation.prototype.createDocument;
    Object.defineProperty(W.DOMImplementation.prototype, 'createDocument', { writable: false, configurable: false,
      value: function (ns, n, t) { if (n && bannedTag(n)) deny(); return mkDoc.call(this, ns, n, t); } });
  } catch (e) {}
  kill(W, 'navigation');
  var themes = {
    light: { paper: '#fbfaf7', ink: '#1b1b1b', muted: '#5a5a5a', grid: '#e4e0d7', accent: '#0f5fa8',
      series: ['#0067a5', '#b84c00', '#a12a7e', '#4a4a4a', '#047c74', '#2e7514', '#5a32e0', '#7e6600'] },
    dark: { paper: '#16171a', ink: '#ece9e4', muted: '#a9a59e', grid: '#2d3035', accent: '#6fb1f5',
      series: ['#56b4e9', '#f28e52', '#d48ac4', '#cbcbcb', '#2ed3c6', '#86d45a', '#8474ff', '#d8c040'] }
  };
  var mq = function (q) { try { return W.matchMedia(q).matches; } catch (e) { return false; } };
  var theme = mq('(prefers-color-scheme: dark)') ? 'dark' : 'light';
  var themeFns = [];
  var reduced = mq('(prefers-reduced-motion: reduce)');
  var stage = D.getElementById('eli5-anim') || D.body;
  var controls = null;
  var uid = 0;
  function setTheme(t) {
    if (t !== theme) {
      theme = t;
      D.documentElement.setAttribute('data-theme', t);
      themeFns.forEach(function (f) { try { f(t); } catch (e) {} });
    }
  }
  // The frame reveals itself (its first height message) only once the model's code has run
  // without an uncaught error, so code that fails at start-up leaves the poster in place.
  var failed = false, ready = false;
  W.addEventListener('error', function () { if (!ready) failed = true; });
  W.addEventListener('unhandledrejection', function () { if (!ready) failed = true; });
  var lastH = -1;
  function height(force) {
    if (!ready) return;
    var h = Math.ceil(D.body ? D.body.getBoundingClientRect().height : 0);
    if (force || h !== lastH) { lastH = h; post({ type: 'eli5-anim-height', h: h }); }
  }
  W.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== P || !d || d.type !== 'eli5-anim-theme') return;
    if (d.theme === 'light' || d.theme === 'dark') setTheme(d.theme);
    height(true);
  });
  var loops = [], rafId = 0, last = 0, onScreen = true;
  function active() { return D.visibilityState !== 'hidden' && onScreen; }
  function frame(t) {
    rafId = 0;
    if (!active()) { last = 0; return; }
    var dt = last ? Math.min(64, t - last) : 16;
    last = t;
    loops = loops.filter(function (l) {
      if (l.done) return false;
      try { return l.fn(dt, t) !== false; } catch (e) { return false; }
    });
    if (loops.length) rafId = W.requestAnimationFrame(frame); else last = 0;
  }
  function wake() { if (!rafId && loops.length && active()) rafId = W.requestAnimationFrame(frame); }
  D.addEventListener('visibilitychange', wake);
  if (W.IntersectionObserver) {
    new W.IntersectionObserver(function (es) {
      onScreen = es.some(function (x) { return x.isIntersecting; });
      wake();
    }).observe(D.documentElement);
  }
  function place(el, into) {
    if (into) { into.appendChild(el); return el; }
    if (!controls) { controls = D.createElement('div'); controls.className = 'eli5-controls'; stage.appendChild(controls); }
    controls.appendChild(el);
    return el;
  }
  function num(v, step) {
    var s = String(step), d = s.indexOf('.') < 0 ? 0 : Math.min(6, s.length - s.indexOf('.') - 1);
    return Number(v).toFixed(d);
  }
  var ELI5 = {
    reducedMotion: reduced,
    get theme() { return theme; },
    get palette() { return themes[theme]; },
    stage: stage,
    onTheme: function (fn) { themeFns.push(fn); },
    rng: function (seed) {
      var a = (seed >>> 0) || 1;
      return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    raf: function (fn) {
      var l = { fn: fn, done: false };
      if (reduced) {
        for (var i = 0; i < 5000; i++) { try { if (fn(16, i * 16) === false) break; } catch (e) { break; } }
        return { stop: function () {} };
      }
      loops.push(l);
      wake();
      return { stop: function () { l.done = true; } };
    },
    slider: function (label, min, max, step, value, onChange, into) {
      var id = 'eli5-in-' + (++uid);
      var row = D.createElement('div'); row.className = 'eli5-field';
      var lab = D.createElement('label'); lab.htmlFor = id; lab.textContent = label;
      var input = D.createElement('input');
      input.type = 'range'; input.id = id;
      input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
      var out = D.createElement('output'); out.htmlFor = id;
      function show() {
        var t = num(input.value, step);
        out.textContent = t;
        input.setAttribute('aria-valuetext', label + ' ' + t);
      }
      show();
      input.addEventListener('input', function () { show(); if (onChange) onChange(Number(input.value)); });
      row.appendChild(lab); row.appendChild(input); row.appendChild(out);
      place(row, into);
      return {
        el: input,
        get value() { return Number(input.value); },
        set: function (v) { input.value = String(v); show(); if (onChange) onChange(Number(input.value)); }
      };
    },
    button: function (label, onClick, into) {
      var b = D.createElement('button'); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', function () { if (onClick) onClick(); });
      return place(b, into);
    },
    readout: function (label, into) {
      var p = D.createElement('p'); p.className = 'eli5-readout'; p.setAttribute('aria-live', 'polite');
      var l = D.createElement('span'); l.textContent = label + ': ';
      var v = D.createElement('strong');
      p.appendChild(l); p.appendChild(v);
      place(p, into || stage);
      return { el: p, set: function (t) { v.textContent = String(t); } };
    },
    canvas: function (w, h, into) {
      var c = D.createElement('canvas'), r = Math.max(1, Math.min(3, W.devicePixelRatio || 1));
      c.width = Math.round(w * r); c.height = Math.round(h * r);
      c.style.aspectRatio = w + ' / ' + h;
      c.setAttribute('aria-hidden', 'true');
      var ctx = c.getContext('2d');
      if (ctx) ctx.scale(r, r);
      (into || stage).appendChild(c);
      return { canvas: c, ctx: ctx, w: w, h: h };
    },
    svg: function (w, h, into) {
      var s = D.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      s.setAttribute('aria-hidden', 'true');
      (into || stage).appendChild(s);
      return s;
    },
    el: function (name, attrs, parent) {
      name = String(name);
      var svgNames = /^(svg|g|path|line|rect|circle|ellipse|polyline|polygon|text|tspan|title|defs|marker)$/;
      var htmlNames = /^(div|span|p|strong|em|b|i|small|label|output|button|input|br|ul|ol|li|table|thead|tbody|tr|th|td|canvas)$/;
      if (!svgNames.test(name) && !htmlNames.test(name)) deny();
      var e = svgNames.test(name) ? mkNS.call(D, 'http://www.w3.org/2000/svg', name) : mk.call(D, name);
      for (var k in attrs || {}) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var a = String(k).toLowerCase();
        if (a.indexOf('on') === 0 || /^(href|xlink:href|src|srcset|srcdoc|rel|http-equiv|action|formaction|ping|background|poster|data)$/.test(a)) deny();
        e.setAttribute(k, String(attrs[k]));
      }
      if (parent) parent.appendChild(e);
      return e;
    }
  };
  Object.freeze(themes.light.series); Object.freeze(themes.dark.series);
  Object.freeze(themes.light); Object.freeze(themes.dark);
  Object.defineProperty(W, 'ELI5', { value: Object.freeze(ELI5), writable: false, configurable: false });
  W.addEventListener('load', function () {
    if (failed) return;
    ready = true;
    height(true);
  });
  if (W.ResizeObserver) new W.ResizeObserver(function () { height(false); }).observe(D.body);
})();`;

/** Version 2 of the shell stylesheet (also used by versions 3 and 4): theme tokens, layout at 320 px and up, accessible controls. */
export const ANIMATION_SHELL_CSS =
  ':root{color-scheme:light dark;--paper:#fbfaf7;--ink:#1b1b1b;--muted:#5a5a5a;--grid:#e4e0d7;--accent:#0f5fa8;' +
  '--s1:#0067a5;--s2:#b84c00;--s3:#a12a7e;--s4:#4a4a4a;--s5:#047c74;--s6:#2e7514;--s7:#5a32e0;--s8:#7e6600}' +
  '@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--paper:#16171a;--ink:#ece9e4;--muted:#a9a59e;' +
  '--grid:#2d3035;--accent:#6fb1f5;--s1:#56b4e9;--s2:#f28e52;--s3:#d48ac4;--s4:#cbcbcb;--s5:#2ed3c6;--s6:#86d45a;' +
  '--s7:#8474ff;--s8:#d8c040}}' +
  ':root[data-theme=dark]{--paper:#16171a;--ink:#ece9e4;--muted:#a9a59e;--grid:#2d3035;--accent:#6fb1f5;' +
  '--s1:#56b4e9;--s2:#f28e52;--s3:#d48ac4;--s4:#cbcbcb;--s5:#2ed3c6;--s6:#86d45a;--s7:#8474ff;--s8:#d8c040}' +
  '*{box-sizing:border-box}' +
  'html,body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}' +
  '#eli5-anim{padding:8px;min-width:0}' +
  '#eli5-anim canvas,#eli5-anim svg{display:block;width:100%;height:auto;max-height:420px}' +
  '.eli5-controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:8px}' +
  '.eli5-field{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;flex:1 1 220px;min-width:0}' +
  '.eli5-field label{font-weight:600}' +
  '.eli5-field input[type=range]{flex:1 1 140px;min-width:0;min-height:32px;accent-color:var(--accent)}' +
  '.eli5-field output{font-variant-numeric:tabular-nums;min-width:3ch;font-weight:600}' +
  'button{font:inherit;min-height:36px;padding:4px 14px;border-radius:6px;border:1px solid var(--muted);' +
  'background:var(--paper);color:var(--ink);cursor:pointer}' +
  'button:hover{border-color:var(--accent)}' +
  'button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}' +
  '.eli5-readout{margin:8px 0 0;font-variant-numeric:tabular-nums}';

// Version 3 (runtime 1.3.2) is version 4 without the lines between its "Version 4" comment and
// the theme table; its stylesheet is the current one. A test pins its exact hashes.
const V4_START = '  // Version 4: ';
const SHELL_V3_JS =
  ANIMATION_SHELL_JS.slice(0, ANIMATION_SHELL_JS.indexOf(V4_START)) +
  ANIMATION_SHELL_JS.slice(ANIMATION_SHELL_JS.indexOf('  var themes = {'));

// Version 2 (runtime 1.3.1) is version 3 without the custom-elements lines; its stylesheet is the
// current one. A test pins its exact hashes.
const CUSTOM_ELEMENTS_V3 =
  "  try { guard(W.CustomElementRegistry.prototype, 'define'); } catch (e) {}\n  kill(W, 'customElements');\n";
const SHELL_V2_JS = SHELL_V3_JS.replace(CUSTOM_ELEMENTS_V3, '');

// Version 1 (runtime 1.3.0) differs from version 2 only in its series colours, so it is derived
// from version 2 by swapping them back; a test pins its exact hashes.
const PALETTE_V2 = {
  light: ['#0067a5', '#b84c00', '#a12a7e', '#4a4a4a', '#047c74', '#2e7514', '#5a32e0', '#7e6600'],
  dark: ['#56b4e9', '#f28e52', '#d48ac4', '#cbcbcb', '#2ed3c6', '#86d45a', '#8474ff', '#d8c040'],
};
const PALETTE_V1 = {
  light: ['#0072b2', '#d55e00', '#ab2b85', '#5f5f5f', '#3a8fc8', '#117733', '#8c8c8c', '#a47500'],
  dark: ['#56b4e9', '#f28e52', '#c07caf', '#b8b8b8', '#9fd3f2', '#44aa77', '#8c8c8c', '#e0b040'],
};
const seriesJs = (l: readonly string[]): string => `series: [${l.map((c) => `'${c}'`).join(', ')}]`;
const seriesCss = (l: readonly string[]): string => l.map((c, i) => `--s${i + 1}:${c}`).join(';');

/** Version 2 with every series colour list and `--sN` declaration set back to version 1. */
function shellV1(text: string, list: (l: readonly string[]) => string): string {
  let out = text;
  for (const k of ['light', 'dark'] as const) out = out.split(list(PALETTE_V2[k])).join(list(PALETTE_V1[k]));
  return out;
}
const SHELL_V1_CSS = shellV1(ANIMATION_SHELL_CSS, seriesCss);

/** Every shell version a valid document may contain, newest first (07 §6.2 validity). */
export const ANIMATION_SHELLS: readonly { js: string; css: string }[] = [
  { js: ANIMATION_SHELL_JS, css: ANIMATION_SHELL_CSS },
  { js: SHELL_V3_JS, css: ANIMATION_SHELL_CSS },
  { js: SHELL_V2_JS, css: ANIMATION_SHELL_CSS },
  { js: shellV1(SHELL_V2_JS, seriesJs), css: SHELL_V1_CSS },
];
