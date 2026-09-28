/**
 * FixtureManifest (13 §5.2): the type, the validator, and the builder used when fixtures are
 * regenerated. Entries for files outside the extraction set (e.g. fetch's sites/) are kept as-is.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { FIXTURES_DIR } from '../../contracts/extractor.contract';
import { EXTRACT_FIXTURES, goldenPathFor } from '../../fixtures/build';

export const MANIFEST_PATH = resolve(FIXTURES_DIR, 'manifest.json');

export const FixtureEntrySchema = z
  .object({
    path: z.string().min(1),
    format: z.enum([
      'pptx',
      'docx',
      'pdf',
      'pdf-scanned',
      'xlsx',
      'image',
      'md',
      'txt',
      'html',
      'unsupported',
      'hostile',
    ]),
    generator: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    expect: z
      .object({
        kind: z.enum(['extract', 'skip']),
        golden: z.string().optional(),
        skipCode: z.string().optional(),
        imageCount: z.number().int().nonnegative().optional(),
      })
      .strict(),
    provenance: z.literal('synthetic'),
  })
  .strict();

export const FixtureManifestSchema = z
  .object({ version: z.literal(1), fixtures: z.array(FixtureEntrySchema) })
  .strict();

export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export function sha256File(rel: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(FIXTURES_DIR, rel)))
    .digest('hex');
}

/** Rebuilds the extraction entries from EXTRACT_FIXTURES and keeps any other existing entries. */
export function buildManifest(): FixtureManifest {
  const ours = new Set(EXTRACT_FIXTURES.map((f) => f.path));
  const existing: FixtureEntry[] = existsSync(MANIFEST_PATH)
    ? FixtureManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))).fixtures.filter(
        (e) => !ours.has(e.path),
      )
    : [];
  const entries: FixtureEntry[] = EXTRACT_FIXTURES.map((f) => ({
    path: f.path,
    format: f.format,
    ...(f.generator ? { generator: f.generator } : {}),
    sha256: sha256File(f.path),
    expect: {
      kind: f.expect.kind,
      ...(f.expect.kind === 'extract' ? { golden: goldenPathFor(f.path) } : {}),
      ...(f.expect.skipCode ? { skipCode: f.expect.skipCode } : {}),
      ...(f.expect.imageCount !== undefined ? { imageCount: f.expect.imageCount } : {}),
    },
    provenance: 'synthetic' as const,
  }));
  return { version: 1, fixtures: [...entries, ...existing].sort((a, b) => a.path.localeCompare(b.path)) };
}
