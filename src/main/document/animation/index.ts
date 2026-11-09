// AI-authored animations (07 §7.1 animation, design addendum 2026-11-08): the model writes a small,
// topic-specific interactive animation that runs in a sandboxed srcdoc frame. This folder holds the
// limits, the static lint, the trusted shell, the frame document and its CSP, the figure renderer
// and the validity check of the only allowed iframe shape.
import { attrs, esc } from '../html';
import { lintAnimation } from './lint';
import {
  ANIMATION_SANDBOX,
  animationHashes,
  animationSrcdoc,
  frameParsesAsBuilt,
  parseAnimationSrcdoc,
  type AnimationParts,
} from './srcdoc';

export { ANIMATION_SHELL_CSS, ANIMATION_SHELL_JS, ANIMATION_SHELLS } from './shell';
export { ANIMATION_LINT_TABLES, codeOnly, lintAnimation, type AnimationCode } from './lint';
export {
  ANIMATION_SANDBOX,
  animationCsp,
  animationHashes,
  animationSrcdoc,
  frameParsesAsBuilt,
  parseAnimationSrcdoc,
  sha256Source,
  type AnimationParts,
} from './srcdoc';

/** Limits (07 §5.2). Code sizes are UTF-8 bytes. */
export const MAX_ANIMATION_JS = 16 * 1024;
export const MAX_ANIMATION_HTML = 4 * 1024;
export const MAX_ANIMATION_CSS = 4 * 1024;
export const MAX_ANIMATION_POSTER = 64 * 1024;
export const MAX_ANIMATION_TITLE = 90;
export const MAX_ANIMATION_CAPTION = 300;
export const MAX_ANIMATION_ALT = 400;
export const MAX_ANIMATIONS_PER_SECTION = 1;
export const MAX_ANIMATIONS_PER_TAB = 2;
export const MAX_ANIMATIONS_PER_DOC = 4;

/**
 * The value of `poster` and `js` that stands for "the section's existing animation" when a section
 * is sent back to the model (08 §6.2): the model never sees or echoes the code (07 §8).
 */
export const ANIMATION_KEEP = 'keep';

/** Iframe attributes in their fixed order; validity accepts exactly these (07 §6.2). */
export const ANIMATION_FRAME_ATTRS = [
  'sandbox',
  'srcdoc',
  'title',
  'referrerpolicy',
  'loading',
  'aria-describedby',
] as const;

/** What renderAnimationFigure needs from a DocBlock. */
export interface AnimationFigure extends AnimationParts {
  title: string;
  caption: string;
  alt: string;
  poster: string;
}

const bytes = (s: string | undefined): number => Buffer.byteLength(s ?? '', 'utf8');

/**
 * Code problems that drop the block (07 §5.2): over a size cap, empty, malformed markup, or a lint
 * hit. `lint: false` is for code that is already stored (parse, a kept animation, validity): it was
 * linted when the model wrote it, so a later, stricter lint never deletes an animation from a saved
 * document; only the checks that do not change between versions run (audit round 3).
 */
export function animationCodeProblems(b: AnimationParts, opts: { lint?: boolean } = {}): string[] {
  const out: string[] = [];
  if (b.js.trim() === '') out.push('js:empty');
  // The keep marker is not code: outside the keep path (a regenerated section's own animation) it
  // would run as `keep` and throw, so a block carrying it is dropped.
  if (b.js.trim() === ANIMATION_KEEP) out.push('js:keep');
  if (bytes(b.js) > MAX_ANIMATION_JS) out.push('js:size');
  if (bytes(b.html) > MAX_ANIMATION_HTML) out.push('html:size');
  if (bytes(b.css) > MAX_ANIMATION_CSS) out.push('css:size');
  const lint = opts.lint === false ? [] : lintAnimation(b);
  // Only well-formed code is worth parsing; malformed markup that would swallow the shell is a hit.
  if (out.length === 0 && lint.length === 0 && !frameParsesAsBuilt(b)) out.push('markup:structure');
  return [...out, ...lint];
}

/**
 * `<figure class="animation">` (07 §7.1): title, the poster (shown without JS, in print and until
 * the frame reports its height), the sandboxed frame, and the caption the frame is described by.
 */
export function renderAnimationFigure(b: AnimationFigure, idBase: string): string {
  const cap = `${idBase}-cap`;
  const frame = `<iframe${attrs([
    ['sandbox', ANIMATION_SANDBOX],
    ['srcdoc', animationSrcdoc(b)],
    ['title', b.title],
    ['referrerpolicy', 'no-referrer'],
    ['loading', 'lazy'],
    ['aria-describedby', cap],
  ])}></iframe>`;
  return (
    '<figure class="animation">' +
    `<h3 class="chart-title">${esc(b.title)}</h3>` +
    `<div class="anim-stage"><div class="anim-poster">${b.poster}</div>${frame}</div>` +
    `<figcaption class="anim-cap" id="${esc(cap)}">${esc(b.caption)}</figcaption>` +
    '</figure>'
  );
}

/** Script hashes the parent CSP must admit for these blocks (07 §6.2), deduplicated, in order. */
export function animationScriptHashes(blocks: Iterable<AnimationParts>): string[] {
  const out: string[] = [];
  for (const b of blocks) for (const h of animationHashes(b)) if (!out.includes(h)) out.push(h);
  return out;
}

/**
 * Validity of one `<iframe>` (07 §6.2, 13 §7.1): its attributes are exactly ANIMATION_FRAME_ATTRS
 * with the exact sandbox, it sits in a `figure.animation`, and its srcdoc is the exact skeleton
 * whose CSP hashes match its scripts and whose code is within the caps and parses as built (the
 * lint ran when the code was written; see animationCodeProblems). Returns the frame's script
 * hashes, or the problems found.
 */
export function checkAnimationFrame(
  frameAttrs: readonly { name: string; value: string }[],
  inAnimationFigure: boolean,
): { hashes: [string, string] } | { problems: string[] } {
  const problems: string[] = [];
  if (!inAnimationFigure) problems.push('iframe outside figure.animation');
  const names = frameAttrs.map((a) => a.name);
  if (names.join(' ') !== ANIMATION_FRAME_ATTRS.join(' '))
    problems.push(`iframe attributes [${names.join(' ')}] != [${ANIMATION_FRAME_ATTRS.join(' ')}]`);
  const get = (n: string): string | undefined => frameAttrs.find((a) => a.name === n)?.value;
  if (get('sandbox') !== ANIMATION_SANDBOX) problems.push(`sandbox "${get('sandbox') ?? ''}"`);
  if (get('referrerpolicy') !== undefined && get('referrerpolicy') !== 'no-referrer') problems.push('referrerpolicy');
  const parsed = parseAnimationSrcdoc(get('srcdoc') ?? '');
  if (!parsed) problems.push('srcdoc is not the animation frame skeleton with a matching CSP');
  else for (const p of animationCodeProblems(parsed, { lint: false })) problems.push(`code ${p}`);
  if (problems.length > 0 || !parsed) return { problems };
  return { hashes: parsed.hashes };
}
