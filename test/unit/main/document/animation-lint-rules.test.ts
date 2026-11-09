import { describe, expect, it } from 'vitest';
import { ANIMATION_LINT_TABLES, lintAnimation } from '../../../../src/main/document/animation';

/**
 * One sample per lint rule (each regex of each table, and the bare-global and document-alias
 * checks), asserting the exact rule id it raises. The deletion check removes each table entry in
 * turn and expects some sample to lose its id, so no rule can be deleted or emptied undetected.
 */

type Part = 'js' | 'html' | 'css';
const S: [id: string, part: Part, code: string][] = [
  // JS_RAW
  ['js:XMLHttpRequest', 'js', 'var X = XMLHttpRequest;'],
  ['js:WebSocket', 'js', 'new WebSocket(u);'],
  ['js:WebTransport', 'js', 'new WebTransport(u);'],
  ['js:EventSource', 'js', 'new EventSource(u);'],
  ['js:sendBeacon', 'js', 'x.sendBeacon(1);'],
  ['js:RTCPeerConnection', 'js', 'new RTCPeerConnection();'],
  ['js:Worker', 'js', 'var w = new SharedWorker(u);'],
  ['js:importScripts', 'js', 'importScripts(u);'],
  ['js:string-timer', 'js', "setTimeout('go()', 1);"],
  ['js:postMessage', 'js', 'x.postMessage(1);'],
  ['js:constructor-key', 'js', "var c = x['constructor'];"],
  ['js:concat-key', 'js', "var f = x['fe' + 'tch'];"],
  ['js:banned-element', 'js', "var f = ELI5.el('iframe');"],
  ['js:url-string', 'js', "go(); // from '//cdn.example/x'"],
  ['js:ice-url', 'js', "var s = 'stun:relay.example:3478';"],
  ['js:ice', 'js', 'pc.createOffer();'],
  ['js:script-close', 'js', "var s = '</script>';"],
  ['js:shadow', 'js', "el.attachShadow({ mode: 'open' });"],
  ['js:http-equiv', 'js', 'm.httpEquiv = 1;'],
  ['js:refresh', 'js', "m.content = 'refresh';"],
  ['js:refresh', 'js', "var c = '0; url=next';"],
  ['js:url-split', 'js', "var u = 'https:' + rest;"],
  // JS_LITERAL
  ['js:url-string', 'js', "var u = 'see //host.example';"],
  ['js:url-string', 'js', "var u = 'go https:host.example';"],
  // JS_CODE
  ['js:fetch', 'js', 'fetch(u);'],
  ['js:customElements', 'js', "customElements.define('x-y', C);"],
  ['js:import', 'js', "import('x');"],
  ['js:eval', 'js', 'eval(s);'],
  ['js:Function', 'js', "var f = Function('a');"],
  ['js:cookie', 'js', "cookieStore.get('a');"],
  ['js:storage', 'js', 'localStorage.x = 1;'],
  ['js:channel', 'js', 'var c = new MessageChannel();'],
  ['js:navigator', 'js', 'var l = navigator.language;'],
  ['js:constructor-access', 'js', 'var c = x.constructor;'],
  ['js:computed-global', 'js', "var d = document['a'];"],
  ['js:global-alias', 'js', 'var w = window;'],
  ['js:global-alias', 'js', 'var w = x.window;'],
  ['js:this-global', 'js', 'var k = Object.keys(this);'],
  ['js:Reflect', 'js', "Reflect.get(a, 'b');"],
  ['js:clone', 'js', 'var c = el.cloneNode(true);'],
  ['js:navigation', 'js', 'navigation.back();'],
  ['js:atob', 'js', 'var s = atob(b);'],
  ['js:second-realm', 'js', 'var w = f.contentWindow;'],
  ['js:html-sink', 'js', 'el.innerHTML = s;'],
  ['js:location', 'js', 'var h = location.href;'],
  ['js:open', 'js', "open('x');"],
  ['js:opener', 'js', 'var o = x.opener;'],
  ['js:frameElement', 'js', 'var f = x.frameElement;'],
  ['js:cookie', 'js', 'var c = document.cookie;'],
  ['js:top', 'js', 'var t = window.top;'],
  ['js:top', 'js', 'var top = get(); top.document.title = 1;'],
  // bare globals and document aliases
  ['js:top', 'js', 'go(top);'],
  ['js:parent', 'js', 'go(parent);'],
  ['js:global-alias', 'js', 'go(self);'],
  ['js:global-alias', 'js', 'go(frames);'],
  ['js:Worker', 'js', 'var w = new Worker(u);'],
  ['js:Worker', 'js', 'var w = new x.Worker(u);'],
  ['js:location', 'js', 'var d = document; d.location = 1;'],
  ['js:cookie', 'js', 'var d = document; var c = d.cookie;'],
  // MARKUP
  ['html:<iframe', 'html', '<iframe></iframe>'],
  ['html:<frame', 'html', '<frame>'],
  ['html:<form', 'html', '<form></form>'],
  ['html:<a href', 'html', '<a href="#x">x</a>'],
  ['html:<meta', 'html', '<meta charset="utf-8">'],
  ['html:<base', 'html', '<base>'],
  ['html:<script src', 'html', '<script src="x"></script>'],
  ['html:<link', 'html', '<link>'],
  ['html:<object', 'html', '<object></object>'],
  ['html:javascript:', 'html', '<p>javascript:go()</p>'],
  ['css:url(', 'css', 'div{background:url(x.png)}'],
  // HTML_ONLY
  ['html:<script', 'html', '<script>go()</script>'],
  ['html:shadowroot', 'html', '<template shadowrootmode="open"></template>'],
  ['html:<a', 'html', '<a>x</a>'],
  ['html:<frame', 'html', '<frameset></frameset>'],
  ['html:inline-handler', 'html', '<div onclick="go()"></div>'],
  ['html:external-ref', 'html', '<img src="x.png">'],
  // CSS_ONLY
  ['css:@import', 'css', "@import 'x.css';"],
  ['css:style-close', 'css', '</style>'],
  ['css:expression', 'css', 'b{x:expression(1)}'],
];

const lint = (part: Part, code: string): string[] =>
  lintAnimation(part === 'js' ? { js: code } : { js: 'go();', [part]: code });

describe('animation lint, rule by rule (13 §7.1)', () => {
  it.each(S)('raises %s for %s: %s', (id, part, code) => {
    expect(lint(part, code)).toContain(id);
  });

  it('every table entry is load-bearing: removing it loses a sample', () => {
    const missed: string[] = [];
    for (const [table, rules] of Object.entries(ANIMATION_LINT_TABLES)) {
      const list = rules as unknown as [string, RegExp][];
      for (let i = 0; i < list.length; i++) {
        const [entry] = list.splice(i, 1);
        try {
          if (S.every(([id, part, code]) => lint(part, code).includes(id))) missed.push(`${table}[${i}] ${entry?.[0]}`);
        } finally {
          if (entry) list.splice(i, 0, entry);
        }
      }
    }
    expect(missed).toEqual([]);
    // The tables are intact afterwards.
    for (const [id, part, code] of S) expect(lint(part, code)).toContain(id);
  });
});
