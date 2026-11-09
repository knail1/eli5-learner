/**
 * Golden documents (13 §4 document/, §7): synthetic drafts + SeededIdSource + the real runtime.
 * Regenerate with ELI5_UPDATE_GOLDENS=1 npx vitest run test/unit/main/document/golden.test.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDocument, renderDocument, type DocRuntime } from '../../../../src/main/document';
import { ANIMATION_SHELL_CSS, ANIMATION_SHELL_JS } from '../../../../src/main/document/animation';
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
 * Animations' share (07 §7.1, design addendum): the parent side of the runtime is small (theme in,
 * height out), and the trusted shell that every frame embeds stays compact. Ceilings catch growth.
 */
describe('animation budget (07 §2, §7.1)', () => {
  it('runtime part <= 2 KiB minified JS and <= 1.5 KiB CSS; shell <= 13 KiB JS and 2.5 KiB CSS', async () => {
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        target: 'es2020',
        minify: true,
        lib: { entry: resolve(process.cwd(), 'src/doc-runtime/animation.ts'), formats: ['iife'], name: 'X' },
      },
    })) as Rollup.RollupOutput[];
    const js = out.flatMap((o) => o.output).find((o) => o.type === 'chunk');
    expect(js?.type === 'chunk' && Buffer.byteLength(js.code)).toBeLessThanOrEqual(2 * 1024);
    const rules = runtime.css.match(/[^{}]*anim-[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(5);
    expect(Buffer.byteLength(rules.join(''))).toBeLessThanOrEqual(1536);
    expect(Buffer.byteLength(ANIMATION_SHELL_JS)).toBeLessThanOrEqual(13 * 1024);
    expect(Buffer.byteLength(ANIMATION_SHELL_CSS)).toBeLessThanOrEqual(2560);
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
