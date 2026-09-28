/**
 * Overlay import boundary (01 §6.5 step 4.3): an overlay imports public code only through
 * `@eli5/public/<module>` → `src/main/<module>/index.ts`, never a deep path. The build alias,
 * the type paths and lint all enforce it, so a deep import in the fixture fails cell F.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import type { Alias } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../../../../config/electron.vite.config';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

/** Applies the main build's alias list the way Vite does: first match wins. */
function resolveAlias(id: string): string | null {
  const alias = (config as { main?: { resolve?: { alias?: unknown } } }).main?.resolve?.alias;
  expect(Array.isArray(alias), 'main alias must be an ordered list').toBe(true);
  for (const a of alias as Alias[]) {
    if (typeof a.find === 'string' ? id === a.find || id.startsWith(`${a.find}/`) : a.find.test(id)) {
      return id.replace(a.find, a.replacement);
    }
  }
  return null;
}

describe('main build alias @eli5/public', () => {
  it('maps a module to its index.ts', () => {
    expect(resolveAlias('@eli5/public/llm')).toBe(path.join(ROOT, 'src/main/llm/index.ts'));
    expect(resolveAlias('@eli5/public/sources')).toBe(path.join(ROOT, 'src/main/sources/index.ts'));
  });

  it('maps the documented test entry llm/testing to its index.ts', () => {
    expect(resolveAlias('@eli5/public/llm/testing')).toBe(path.join(ROOT, 'src/main/llm/testing/index.ts'));
  });

  it('leaves deep imports unresolved, so the build fails', () => {
    expect(resolveAlias('@eli5/public/llm/testing/fake')).toBeNull();
    expect(resolveAlias('@eli5/public/llm/claude')).toBeNull();
    expect(resolveAlias('@eli5/public/editions/registry')).toBeNull();
  });
});

describe('type paths @eli5/public/*', () => {
  it('point at module index files only', () => {
    const ts = JSON.parse(readFileSync(path.join(ROOT, 'config', 'tsconfig.node.json'), 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(ts.compilerOptions.paths['@eli5/public/*']).toEqual(['../src/main/*/index.ts']);
  });
});

describe('lint: overlay imports', () => {
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, 'config', 'eslint.config.js') });
  const lint = async (code: string, file: string) => {
    const [r] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
    return r!.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
  };
  const FIXTURE = 'test/fixtures/overlay-fake/probe.ts';

  it('rejects a deep @eli5/public import in the fixture overlay', async () => {
    expect(await lint("export { FakeProvider } from '@eli5/public/llm/testing/fake';\n", FIXTURE)).toHaveLength(1);
    expect(await lint("export { Registry } from '@eli5/public/editions/registry';\n", FIXTURE)).toHaveLength(1);
  });

  it('rejects a relative import of public source', async () => {
    expect(await lint("export { FakeProvider } from '../../../src/main/llm/testing/fake';\n", FIXTURE)).toHaveLength(1);
  });

  it('allows module entries and llm/testing', async () => {
    expect(await lint("export { skip } from '@eli5/public/sources';\n", FIXTURE)).toEqual([]);
    expect(await lint("export { FakeProvider } from '@eli5/public/llm/testing';\n", FIXTURE)).toEqual([]);
  });
});
