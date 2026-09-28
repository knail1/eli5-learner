/** Library root resolution (09 §3.1; 01 §8.4; 12 config table). Pure: no fs access here. */
import path from 'node:path';
import type { LibraryRootInput } from './types';

export const LIBRARY_DIR_ENV = 'ELI5_LIBRARY_DIR';

/**
 * 1. `ELI5_LIBRARY_DIR` when set (tests and power users); must be absolute, else a startup error.
 * 2. Dev: the gitignored `<repo>/.library`. Never `docs/`, the public Pages source.
 * 3. Packaged: `<userData>/docs`.
 * mkdir, realpath and caching (§3.1 steps 4-5) happen in the Library at startup (M1).
 */
export function resolveLibraryRoot({ isPackaged, repoRoot, userData, env }: LibraryRootInput): string {
  const override = env[LIBRARY_DIR_ENV];
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      throw new Error(`${LIBRARY_DIR_ENV} must be an absolute path (got "${override}")`);
    }
    return path.normalize(override);
  }
  return isPackaged ? path.join(userData, 'docs') : path.join(repoRoot, '.library');
}
