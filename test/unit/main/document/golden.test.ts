/**
 * Golden documents (13 §4 document/, §7): synthetic drafts + SeededIdSource + the real runtime.
 * Regenerate with ELI5_UPDATE_GOLDENS=1 npx vitest run test/unit/main/document/golden.test.ts
 */
import { writeFileSync } from 'node:fs';
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
