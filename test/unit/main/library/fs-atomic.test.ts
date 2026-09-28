import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryError, writeFileAtomic, writeJsonAtomic } from '../../../../src/main/library';
import { tmpLibrary } from '../../../helpers/tmp-library';

describe('writeFileAtomic (09 §8.1)', () => {
  it('writes the file with mode 0600 and leaves no temp files', async () => {
    const { libraryDir } = await tmpLibrary();
    const target = path.join(libraryDir, 'catalog.json');
    await writeFileAtomic(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(libraryDir)).toEqual(['catalog.json']);
  });

  it('a crash between the temp write and the rename leaves the previous file intact', async () => {
    const { libraryDir } = await tmpLibrary();
    const target = path.join(libraryDir, 'catalog.json');
    await writeFile(target, 'old');
    let sawTmp = '';
    const err = await writeFileAtomic(target, 'new', {
      beforeRename: async (tmp) => {
        sawTmp = path.basename(tmp);
        expect(await readFile(tmp, 'utf8')).toBe('new');
        throw new Error('killed');
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe('WRITE_FAILED');
    expect(sawTmp).toMatch(new RegExp(`^catalog\\.json\\.tmp-${process.pid}-[0-9a-f]{8}$`));
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(libraryDir)).toEqual(['catalog.json']);
  });

  it('fails with WRITE_FAILED when the directory is missing', async () => {
    const { libraryDir } = await tmpLibrary();
    await expect(writeFileAtomic(path.join(libraryDir, 'nope', 'x.json'), 'x')).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
  });

  it('writeJsonAtomic uses 2-space indentation and a trailing newline', async () => {
    const { libraryDir } = await tmpLibrary();
    const target = path.join(libraryDir, 'meta.json');
    await writeJsonAtomic(target, { a: [1] });
    expect(await readFile(target, 'utf8')).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });
});
