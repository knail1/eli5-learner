import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { catalogMigrations, metaMigrations, readVersioned, suggestionsMigrations } from '../../../../src/main/library';
import type { Migration } from '../../../../src/main/library';
import { tmpLibrary } from '../../../helpers/tmp-library';

// A synthetic v3 schema whose chain renames `name` (v1) -> `label` (v2) -> adds `tags` (v3).
const V3 = z.object({ schemaVersion: z.number().int(), label: z.string(), tags: z.array(z.string()) });
type V3 = z.infer<typeof V3>;
const chain: Migration[] = [
  {
    from: 1,
    to: 2,
    up: (raw) => {
      const { name, ...rest } = raw as { name: string };
      return { ...rest, label: name, schemaVersion: 2 };
    },
  },
  { from: 2, to: 3, up: (raw) => ({ ...(raw as object), tags: [] }) },
];
const now = () => new Date('2026-02-01T10:20:30.000Z');
const opts = (over: Partial<Parameters<typeof readVersioned<V3>>[1]> = {}) => ({
  schema: V3,
  lenient: V3.loose(),
  chain,
  current: 3,
  allowWrite: true,
  renameCorrupt: true,
  now,
  ...over,
});

async function setup(content: string): Promise<{ dir: string; file: string }> {
  const { libraryDir } = await tmpLibrary();
  const file = path.join(libraryDir, 'thing.json');
  await writeFile(file, content);
  return { dir: libraryDir, file };
}

describe('migration chains (09 §5.3)', () => {
  it('are empty in v1', () => {
    expect(metaMigrations).toEqual([]);
    expect(catalogMigrations).toEqual([]);
    expect(suggestionsMigrations).toEqual([]);
  });
});

describe('readVersioned (09 §5.3)', () => {
  it('returns missing for an absent file', async () => {
    const { libraryDir } = await tmpLibrary();
    expect(await readVersioned(path.join(libraryDir, 'none.json'), opts())).toEqual({ status: 'missing' });
  });

  it('reads a current file', async () => {
    const { file } = await setup(JSON.stringify({ schemaVersion: 3, label: 'Widgets', tags: ['a'] }));
    expect(await readVersioned(file, opts())).toEqual({
      status: 'ok',
      data: { schemaVersion: 3, label: 'Widgets', tags: ['a'] },
    });
  });

  it('migrates an older file, writes a .bak once and the migrated file atomically', async () => {
    const original = JSON.stringify({ schemaVersion: 1, name: 'Widgets' });
    const { dir, file } = await setup(original);
    const r = await readVersioned(file, opts());
    expect(r).toEqual({ status: 'ok', migratedFrom: 1, data: { schemaVersion: 3, label: 'Widgets', tags: [] } });
    expect(await readFile(`${file}.v1.bak`, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 3, label: 'Widgets', tags: [] });
    expect((await readdir(dir)).sort()).toEqual(['thing.json', 'thing.json.v1.bak']);
  });

  it('treats a missing schemaVersion as v1', async () => {
    const { file } = await setup(JSON.stringify({ name: 'Widgets' }));
    const r = await readVersioned(file, opts({ allowWrite: false }));
    expect(r).toMatchObject({ status: 'ok', migratedFrom: 1 });
    // allowWrite false: the file is left alone.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ name: 'Widgets' });
  });

  it('returns newer (lenient parse) for a file from a newer app and never rewrites it', async () => {
    const text = JSON.stringify({ schemaVersion: 9, label: 'Widgets', tags: [], extra: true });
    const { file } = await setup(text);
    const r = await readVersioned(file, opts());
    expect(r).toMatchObject({ status: 'newer', version: 9, data: { label: 'Widgets', extra: true } });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('a missing chain step is corrupt and renames the file to .corrupt-<ts>', async () => {
    const { dir, file } = await setup(JSON.stringify({ schemaVersion: 1, name: 'Widgets' }));
    const r = await readVersioned(file, opts({ chain: [chain[1]!] }));
    expect(r).toEqual({ status: 'corrupt', reason: 'migration', movedTo: `${file}.corrupt-20260201T102030` });
    expect(await readdir(dir)).toEqual(['thing.json.corrupt-20260201T102030']);
  });

  it.each([
    ['unparseable JSON', '{nope', 'parse'],
    ['a non-object', '[1,2]', 'schema'],
    ['a non-integer version', '{"schemaVersion":"3"}', 'schema'],
    ['a schema violation', '{"schemaVersion":3,"label":1,"tags":[]}', 'schema'],
  ])('%s is corrupt', async (_n, content, reason) => {
    const { file } = await setup(content);
    expect(await readVersioned(file, opts({ renameCorrupt: false }))).toEqual({ status: 'corrupt', reason });
    expect(await readFile(file, 'utf8')).toBe(content);
  });
});
