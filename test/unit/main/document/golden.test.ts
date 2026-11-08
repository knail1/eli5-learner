/**
 * Golden documents (13 §4 document/, §7): synthetic drafts + SeededIdSource + the real runtime.
 * Regenerate with ELI5_UPDATE_GOLDENS=1 npx vitest run test/unit/main/document/golden.test.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDocument, renderDocument, type DocRuntime } from '../../../../src/main/document';
import { GOLDEN_NAMES, fixtureDocument, type GoldenName } from '../../../fixtures/documents/models';
import { buildRuntime } from '../../../fixtures/documents/build-runtime';
import { goldenPath, readGolden } from '../../../fixtures/documents/runtime';
import { validateDocument } from '../../../helpers/doc-validity';

const UPDATE = process.env.ELI5_UPDATE_GOLDENS === '1';
let runtime: DocRuntime;

beforeAll(async () => {
  runtime = await buildRuntime();
}, 60_000);

function renderFixture(name: GoldenName, rt: DocRuntime): string {
  const { model, assets, theme } = fixtureDocument(name);
  return renderDocument(model, assets, { runtime: rt, theme });
}

describe('doc-runtime bundle (07 §2)', () => {
  it('is a classic IIFE within budget with no network or eval', () => {
    expect(Buffer.byteLength(runtime.js)).toBeLessThanOrEqual(40 * 1024);
    expect(Buffer.byteLength(runtime.css)).toBeLessThanOrEqual(30 * 1024);
    expect(runtime.js).not.toMatch(/\bimport\s*\(|\bimport\s+[\w{*]|\bexport\s/);
    expect(runtime.js).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|\beval\s*\(|new Function\s*\(/);
  });
});

/**
 * Explorables' share of the runtime (07 §7.1, design D26). Measured: about 9.1 KiB of JS for both
 * kinds with the shared math (over the design's 6 KiB estimate, still inside the 40 KiB total) and
 * under 1 KiB of CSS. The ceilings catch growth.
 */
describe('explorable runtime budget (07 §2, design D26)', () => {
  it('JS <= 10 KiB minified for both kinds, CSS <= 1.5 KiB', async () => {
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        target: 'es2020',
        minify: true,
        lib: { entry: resolve(process.cwd(), 'src/doc-runtime/explorable.ts'), formats: ['iife'], name: 'X' },
      },
    })) as Rollup.RollupOutput[];
    const js = out.flatMap((o) => o.output).find((o) => o.type === 'chunk');
    expect(js?.type === 'chunk' && Buffer.byteLength(js.code)).toBeLessThanOrEqual(10 * 1024);
    const rules = runtime.css.match(/[^{}]*explorable[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(5);
    expect(Buffer.byteLength(rules.join(''))).toBeLessThanOrEqual(1536);
  }, 60_000);
});

describe.each(GOLDEN_NAMES)('golden document %s', (name) => {
  it('matches the committed golden and passes validateDocument', () => {
    const html = renderFixture(name, runtime);
    if (UPDATE) writeFileSync(goldenPath(name), html);
    expect(html).toBe(readGolden(name));
    const report = validateDocument(html);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('round-trips: render(parse(render(m))) === render(m)', () => {
    const html = readGolden(name);
    const parsed = parseDocument(html);
    expect(renderDocument(parsed.model, parsed.assets, { runtime: parsed.runtime, theme: parsed.theme })).toBe(html);
  });
});
