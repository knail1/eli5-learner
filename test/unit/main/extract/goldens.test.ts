/**
 * One golden per format (13 §4 extract row, §5.1): toPromptText of each committed fixture is
 * byte-identical to its *.expected.txt, skip fixtures give their manifest skip code, and the image
 * count sent to vision matches the manifest. Update goldens with:
 *   ELI5_UPDATE_GOLDENS=1 npx vitest run test/unit/main/extract/goldens.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSource, toPromptText } from '../../../../src/main/extract';
import { FIXTURES_DIR, fixtureSource, goldenText, testContext } from '../../../contracts/extractor.contract';
import { EXTRACT_FIXTURES, goldenPathFor } from '../../../fixtures/build';

const UPDATE = process.env.ELI5_UPDATE_GOLDENS === '1';

describe('extraction goldens', () => {
  for (const f of EXTRACT_FIXTURES) {
    it(`${f.path}`, async () => {
      const started = Date.now();
      const r = await extractSource(fixtureSource(f.path), testContext());
      if (f.expect.kind === 'skip') {
        expect(r.ok ? 'ok' : r.skipped.code).toBe(f.expect.skipCode);
        // Hostile inputs are refused fast (04 acceptance: within 1 s).
        if (f.format === 'hostile') expect(Date.now() - started).toBeLessThan(1000);
        return;
      }
      if (!r.ok) throw new Error(`unexpected skip ${r.skipped.code}: ${r.skipped.reason}`);
      const text = goldenText(toPromptText(r.content));
      const golden = resolve(FIXTURES_DIR, goldenPathFor(f.path));
      if (UPDATE) writeFileSync(golden, text);
      expect(text).toBe(readFileSync(golden, 'utf8'));
      if (f.expect.imageCount !== undefined) expect(r.content.images.length).toBe(f.expect.imageCount);
      expect(toPromptText(r.content)).toBe(toPromptText(r.content));
    }, 30_000);
  }
});
