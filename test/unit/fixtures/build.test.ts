/**
 * Fixture generators (13 §5.3 rule 2). Each generator is run in memory into a scratch dir and its
 * output extracted: the text must match the committed golden (bytes may differ, e.g. zip
 * timestamps), and skip fixtures must still be refused with the same code.
 *
 * Regenerate the committed binaries and the manifest with:
 *   ELI5_WRITE_FIXTURES=1 npx vitest run test/unit/fixtures/build.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractSource, toPromptText } from '../../../src/main/extract';
import { FIXTURES_DIR, fixtureSource, goldenText, testContext } from '../../contracts/extractor.contract';
import { EXTRACT_FIXTURES, goldenPathFor } from '../../fixtures/build';
import { buildManifest, MANIFEST_PATH } from './manifest-data';

const WRITE = process.env.ELI5_WRITE_FIXTURES === '1';

describe('fixture generators (13 §5.3)', () => {
  if (WRITE) {
    it('writes fixtures and manifest', async () => {
      for (const f of EXTRACT_FIXTURES) {
        if (!f.build) continue;
        const abs = resolve(FIXTURES_DIR, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, await f.build());
      }
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(buildManifest(), null, 2)}\n`);
    }, 120_000);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'eli5-fixtures-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  for (const f of EXTRACT_FIXTURES.filter((x) => x.build)) {
    it(`${f.path} rebuilds to the same extraction`, async () => {
      const bytes = await f.build!();
      expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      const out = join(scratch, basename(f.path));
      writeFileSync(out, bytes);
      // Same ref and sha as the committed file so image ids match the golden.
      const committed = fixtureSource(f.path);
      const fresh = {
        ...committed,
        location: out,
        payload: { kind: 'path' as const, path: out },
        sizeBytes: bytes.byteLength,
      };
      const r = await extractSource(fresh, testContext());
      if (f.expect.kind === 'skip') {
        expect(r.ok ? 'ok' : r.skipped.code).toBe(f.expect.skipCode);
        return;
      }
      if (!r.ok) throw new Error(`unexpected skip ${r.skipped.code}`);
      const golden = readFileSync(resolve(FIXTURES_DIR, goldenPathFor(f.path)), 'utf8');
      expect(goldenText(toPromptText(r.content))).toBe(golden);
    }, 60_000);
  }
});
