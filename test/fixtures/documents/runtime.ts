/** Golden document paths and a stand-in runtime (no Vite import, so jsdom tests can use it). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocRuntime } from '../../../src/main/document';

/**
 * Golden documents live under build/ because Prettier ignores that directory name at any depth
 * (.prettierignore `build/`), and goldens must stay byte-exact. Git does not ignore this path.
 */
export const GOLDEN_DIR = resolve(import.meta.dirname, 'build');

/** Stand-in runtime for unit tests that do not need the real one. */
export const STUB_RUNTIME: DocRuntime = {
  js: '(function(){document.documentElement.classList.add("js")})();',
  css: ':root{--paper:#fff}body{background:var(--paper)}',
};

export function goldenPath(name: string): string {
  return resolve(GOLDEN_DIR, `${name}.html`);
}

export function readGolden(name: string): string {
  return readFileSync(goldenPath(name), 'utf8');
}
