/**
 * Results and calibration report files (13 §9.6: `results/<date>-<provider>-<model>.json`). A second
 * run the same day never overwrites the first (the one a baseline may have been committed with): it
 * gets the run's UTC time, then a counter, appended to the stem.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** File-name-safe form of a provider or model id. */
export const safeName = (s: string): string => s.replace(/[^\w.-]+/g, '_');

const isExists = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';

export async function writeReport(dir: string, stem: string, startedAt: Date, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const time = startedAt.toISOString().slice(11, 19).replace(/:/g, '');
  for (let n = 0; ; n++) {
    const name = n === 0 ? stem : n === 1 ? `${stem}-${time}` : `${stem}-${time}-${n}`;
    const file = path.join(dir, `${name}.json`);
    try {
      await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (e) {
      if (!isExists(e)) throw e;
    }
  }
}
