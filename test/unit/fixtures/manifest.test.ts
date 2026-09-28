/**
 * Fixture manifest rules (13 §5.2, §5.3): every file under sources/ and sites/ is listed (goldens
 * count through expect.golden), hashes match the committed bytes, provenance is synthetic, and the
 * 2 MB per-file / 20 MB total caps hold.
 *
 * sites/ belongs to the fetch module (05); when its pages land they need manifest entries too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../../contracts/extractor.contract';
import { buildManifest, FixtureManifestSchema, MANIFEST_PATH, sha256File } from './manifest-data';

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

const manifest = FixtureManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
const repoRoot = resolve(FIXTURES_DIR, '../..');

describe('test/fixtures/manifest.json', () => {
  it('lists every file under sources/ and sites/', () => {
    const listed = new Set<string>();
    for (const f of manifest.fixtures) {
      listed.add(f.path);
      if (f.expect.golden) listed.add(f.expect.golden);
    }
    const files = [...walk(resolve(FIXTURES_DIR, 'sources')), ...walk(resolve(FIXTURES_DIR, 'sites'))]
      .map((abs) => relative(FIXTURES_DIR, abs))
      .filter((rel) => !rel.endsWith('.DS_Store'));
    expect(files.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('has matching sha256, synthetic provenance, goldens and generators', () => {
    for (const f of manifest.fixtures) {
      expect(sha256File(f.path), f.path).toBe(f.sha256);
      expect(f.provenance).toBe('synthetic');
      if (f.expect.kind === 'extract' && f.path.startsWith('sources/')) {
        expect(f.expect.golden, f.path).toBeDefined();
      }
      if (f.expect.golden) expect(existsSync(resolve(FIXTURES_DIR, f.expect.golden)), f.expect.golden).toBe(true);
      if (f.expect.kind === 'skip') expect(f.expect.skipCode, f.path).toBeDefined();
      if (f.generator) expect(existsSync(resolve(repoRoot, f.generator)), f.generator).toBe(true);
    }
  });

  it('keeps fixtures under 2 MB each and 20 MB in total', () => {
    const sizes = [...walk(resolve(FIXTURES_DIR, 'sources')), ...walk(resolve(FIXTURES_DIR, 'sites'))].map(
      (f) => statSync(f).size,
    );
    for (const s of sizes) expect(s).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20 * 1024 * 1024);
  });

  it('is in sync with the extraction fixture catalog', () => {
    expect(buildManifest()).toEqual(manifest);
  });
});
