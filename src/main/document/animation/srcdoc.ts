// The animation frame document (07 §6.2, §7.1 animation): trusted shell + model code in one exact
// srcdoc skeleton, its own CSP whose script hashes match the two scripts, and the strict reverse
// (parseAnimationSrcdoc) the validity check uses. Pure; node:crypto and parse5 only, so validity.ts
// can run in plain Node (Playwright helpers).
import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { ANIMATION_SHELLS, ANIMATION_SHELL_CSS, ANIMATION_SHELL_JS } from './shell';

/** The model's code as stored in an animation DocBlock. */
export interface AnimationParts {
  html?: string | undefined;
  css?: string | undefined;
  js: string;
}

/** The exact sandbox token list of the only allowed iframe (07 §6.2): scripts, nothing else. */
export const ANIMATION_SANDBOX = 'allow-scripts';

/** CSP source expression for a script body, hashed exactly as the browser does. */
export function sha256Source(js: string): string {
  return `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`;
}

/** The frame's own policy: only its two hashed scripts run, and nothing loads from anywhere. */
export function animationCsp(hashes: readonly string[]): string {
  return [
    "default-src 'none'",
    `script-src ${hashes.join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** [shell hash, model hash]: the frame CSP's script-src, also admitted by the parent CSP. */
export function animationHashes(b: AnimationParts): [string, string] {
  return [sha256Source(ANIMATION_SHELL_JS), sha256Source(b.js)];
}

const HEAD_OPEN =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="';
const HEAD_REST =
  '"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="eli5-anim-shell">';
const STAGE_OPEN = '</style></head><body><main id="eli5-anim">';
const STAGE_CLOSE = '</main><script>';
const DOC_CLOSE = '</script></body></html>';

function build(shell: { js: string; css: string }, b: AnimationParts): string {
  const csp = animationCsp([sha256Source(shell.js), sha256Source(b.js)]);
  return (
    HEAD_OPEN +
    csp +
    HEAD_REST +
    shell.css +
    '</style><style>' +
    (b.css ?? '') +
    STAGE_OPEN +
    (b.html ?? '') +
    STAGE_CLOSE +
    shell.js +
    '</script><script>' +
    b.js +
    DOC_CLOSE
  );
}

/**
 * The srcdoc text (before attribute escaping). The CSP meta comes first in <head>, so it covers both
 * styles and both scripts; the shell runs before the model's code.
 */
export function animationSrcdoc(b: AnimationParts): string {
  return build({ js: ANIMATION_SHELL_JS, css: ANIMATION_SHELL_CSS }, b);
}

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const isElement = (n: Node): n is Element => 'tagName' in n;
const textOf = (el: Element): string =>
  el.childNodes.map((c) => ('value' in c && c.nodeName === '#text' ? c.value : '\u0000')).join('');

/**
 * Whether the frame parses the way it was built (audit round 1): the model's html and css are
 * spliced into the skeleton as text, so an unclosed quote, comment or raw-text element (`<p class='`,
 * `<textarea`, `<template`, `<noscript`) could swallow the trusted shell's <script> tag and leave the
 * model's script running without it. Parsed as a browser does (parse5), the frame must be exactly
 * head [meta x4, style(shell css), style(model css)] and body [main#eli5-anim, script(shell),
 * script(model)], with no other script anywhere (template contents included).
 */
export function frameParsesAsBuilt(
  b: AnimationParts,
  shell = { js: ANIMATION_SHELL_JS, css: ANIMATION_SHELL_CSS },
): boolean {
  const doc = parse(build(shell, b));
  const html = doc.childNodes.find(isElement);
  if (!html || html.tagName !== 'html') return false;
  const [head, body, ...more] = html.childNodes.filter(isElement);
  if (!head || head.tagName !== 'head' || !body || body.tagName !== 'body' || more.length > 0) return false;
  if (html.childNodes.length !== 2) return false;
  const tags = (el: Element): string => el.childNodes.map((c) => (isElement(c) ? c.tagName : c.nodeName)).join(' ');
  if (tags(head) !== 'meta meta meta meta style style' || tags(body) !== 'main script script') return false;
  const [, , , , shellStyle, modelStyle] = head.childNodes.filter(isElement);
  if (!shellStyle || textOf(shellStyle) !== shell.css || !modelStyle || textOf(modelStyle) !== (b.css ?? ''))
    return false;
  const [main, shellScript, modelScript] = body.childNodes.filter(isElement);
  if (!main || main.attrs.length !== 1 || main.attrs[0]?.name !== 'id' || main.attrs[0].value !== 'eli5-anim')
    return false;
  if (!shellScript || textOf(shellScript) !== shell.js || !modelScript || textOf(modelScript) !== b.js) return false;
  let scripts = 0;
  const walk = (n: Node): void => {
    if (isElement(n)) {
      if (n.tagName === 'script') scripts++;
      if (n.tagName === 'template')
        for (const c of (n as DefaultTreeAdapterMap['template']).content.childNodes) walk(c);
    }
    if ('childNodes' in n) for (const c of n.childNodes) walk(c);
  };
  walk(doc);
  return scripts === 2;
}

/**
 * Strict reverse of animationSrcdoc for validity (07 §6.2, 13 §7.1): the srcdoc must be exactly the
 * skeleton around a known shell version, with the CSP the code's hashes give. Null otherwise.
 */
export function parseAnimationSrcdoc(srcdoc: string): (AnimationParts & { hashes: [string, string] }) | null {
  for (const shell of ANIMATION_SHELLS) {
    if (!srcdoc.startsWith(HEAD_OPEN) || !srcdoc.endsWith(DOC_CLOSE)) return null;
    const cssStart = srcdoc.indexOf(`${HEAD_REST}${shell.css}</style><style>`);
    if (cssStart < 0) continue;
    const modelCssAt = cssStart + HEAD_REST.length + shell.css.length + '</style><style>'.length;
    const stageAt = srcdoc.indexOf(STAGE_OPEN, modelCssAt);
    const shellAt = srcdoc.lastIndexOf(`${STAGE_CLOSE}${shell.js}</script><script>`);
    if (stageAt < 0 || shellAt < stageAt) continue;
    const css = srcdoc.slice(modelCssAt, stageAt);
    const html = srcdoc.slice(stageAt + STAGE_OPEN.length, shellAt);
    const js = srcdoc.slice(
      shellAt + STAGE_CLOSE.length + shell.js.length + '</script><script>'.length,
      srcdoc.length - DOC_CLOSE.length,
    );
    const parts: AnimationParts = { js, ...(html ? { html } : {}), ...(css ? { css } : {}) };
    if (build(shell, parts) !== srcdoc || !frameParsesAsBuilt(parts, shell)) return null;
    return { ...parts, hashes: [sha256Source(shell.js), sha256Source(js)] };
  }
  return null;
}
