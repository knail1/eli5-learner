/** Per-file schema versioning and migration chains (09 §5.3). */
import { promises as fsp } from 'node:fs';
import type { z } from 'zod';
import { isErrno, writeJsonAtomic } from './fs-atomic';

export interface Migration {
  from: number;
  to: number;
  /** Pure function over plain JSON. */
  up(raw: unknown): unknown;
}

/** v1: every chain is empty. */
export const metaMigrations: Migration[] = [];
export const catalogMigrations: Migration[] = [];
export const suggestionsMigrations: Migration[] = [];
export const organizationMigrations: Migration[] = [];

export interface ReadVersionedOptions<T> {
  schema: z.ZodType<T>;
  /** The current schema made lenient (`.loose()`), used for files from a newer app (step 3). */
  lenient: z.ZodType<T>;
  chain: readonly Migration[];
  current: number;
  /** When false (read-only mode, foreign folders), nothing is written or renamed. */
  allowWrite: boolean;
  /** Step 6: rename a bad file to `<file>.corrupt-<ts>`. Off for meta.json (§3.2: never touch). */
  renameCorrupt: boolean;
  /** Timestamp source for `.corrupt-<ts>`. */
  now: () => Date;
}

export type ReadVersionedResult<T> =
  | { status: 'ok'; data: T; migratedFrom?: number }
  | { status: 'newer'; data: T; version: number }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: 'parse' | 'migration' | 'schema'; movedTo?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Applies the chain from `from` up to `current`; undefined when a step is missing. */
export function migrate(raw: unknown, from: number, current: number, chain: readonly Migration[]): unknown {
  let v = from;
  let data = raw;
  while (v < current) {
    const step = chain.find((m) => m.from === v && m.to > v);
    if (!step) return undefined;
    data = step.up(data);
    v = step.to;
  }
  if (v !== current) return undefined;
  return isRecord(data) ? { ...data, schemaVersion: current } : data;
}

/** `yyyymmddThhmmss` in UTC, used for `.corrupt-` and `.trash/` names. */
export function compactTimestamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:]/g, '');
}

/** 09 §5.3 read algorithm, steps 1-6. */
export async function readVersioned<T>(file: string, opts: ReadVersionedOptions<T>): Promise<ReadVersionedResult<T>> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { status: 'missing' };
    throw err;
  }
  const fail = async (reason: 'parse' | 'migration' | 'schema'): Promise<ReadVersionedResult<T>> => {
    if (!opts.allowWrite || !opts.renameCorrupt) return { status: 'corrupt', reason };
    const movedTo = `${file}.corrupt-${compactTimestamp(opts.now())}`;
    await fsp.rename(file, movedTo).catch(() => {});
    return { status: 'corrupt', reason, movedTo };
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('parse');
  }
  if (!isRecord(raw)) return fail('schema');
  const sv = raw.schemaVersion;
  // Step 2: a missing version means v1, the first shipped version.
  const version = sv === undefined ? 1 : typeof sv === 'number' && Number.isInteger(sv) ? sv : NaN;
  if (Number.isNaN(version)) return fail('schema');

  if (version > opts.current) {
    const r = opts.lenient.safeParse(raw);
    return r.success ? { status: 'newer', data: r.data, version } : fail('schema');
  }

  if (version < opts.current) {
    const migrated = migrate(raw, version, opts.current, opts.chain);
    if (migrated === undefined) return fail('migration');
    const r = opts.schema.safeParse(migrated);
    if (!r.success) return fail('schema');
    if (opts.allowWrite) {
      const bak = `${file}.v${version}.bak`;
      await fsp.writeFile(bak, text, { flag: 'wx', mode: 0o600 }).catch(() => {});
      await writeJsonAtomic(file, migrated);
    }
    return { status: 'ok', data: r.data, migratedFrom: version };
  }

  const r = opts.schema.safeParse(sv === undefined ? { ...raw, schemaVersion: 1 } : raw);
  return r.success ? { status: 'ok', data: r.data } : fail('schema');
}
