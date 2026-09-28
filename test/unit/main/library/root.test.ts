import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLibraryRoot } from '../../../../src/main/library/root';

const repoRoot = '/Users/dev/eli5-learner';
const userData = '/Users/dev/Library/Application Support/ELI5 Learner';

describe('resolveLibraryRoot (09 §3.1)', () => {
  it('dev: the gitignored <repo>/.library, never the public docs/ folder', () => {
    expect(resolveLibraryRoot({ isPackaged: false, repoRoot, userData, env: {} })).toBe(
      path.join(repoRoot, '.library'),
    );
  });

  it('packaged: <userData>/docs', () => {
    expect(resolveLibraryRoot({ isPackaged: true, repoRoot, userData, env: {} })).toBe(path.join(userData, 'docs'));
  });

  it('dev honors an absolute ELI5_LIBRARY_DIR (normalized)', () => {
    const env = { ELI5_LIBRARY_DIR: '/tmp/x/../lib/docs' };
    expect(resolveLibraryRoot({ isPackaged: false, repoRoot, userData, env })).toBe('/tmp/lib/docs');
  });

  it('packaged also honors an absolute ELI5_LIBRARY_DIR (power users)', () => {
    const env = { ELI5_LIBRARY_DIR: '/tmp/lib' };
    expect(resolveLibraryRoot({ isPackaged: true, repoRoot, userData, env })).toBe('/tmp/lib');
  });

  it('dev rejects a relative ELI5_LIBRARY_DIR', () => {
    const env = { ELI5_LIBRARY_DIR: 'relative/docs' };
    expect(() => resolveLibraryRoot({ isPackaged: false, repoRoot, userData, env })).toThrow(/absolute/);
  });

  it('treats an empty ELI5_LIBRARY_DIR as unset', () => {
    const env = { ELI5_LIBRARY_DIR: '' };
    expect(resolveLibraryRoot({ isPackaged: false, repoRoot, userData, env })).toBe(path.join(repoRoot, '.library'));
  });
});
