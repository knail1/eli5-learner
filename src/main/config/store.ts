import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { SettingsDescription } from '../../preload/contract';
import type { SettingsExtension } from './extension';
import { findSecrets } from './guards';
import { migrate } from './migrations';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULTS,
  DORMANT_NAMESPACES,
  SettingsSchema,
  isDormantPath,
  type DeepPartial,
  type Settings,
} from './schema';

type Raw = Record<string, unknown>;
type LoadIssue = SettingsDescription['loadIssues'][number];
type Listener = (next: Settings, changed: string[]) => void;

export class SettingsError extends Error {
  constructor(
    readonly code: 'E_SETTINGS_INVALID' | 'E_SETTINGS_LOCKED' | 'E_SECRET_IN_SETTINGS' | 'E_SETTINGS_IO',
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface SettingsStoreOptions {
  /** Directory holding settings.json (userData). */
  dir: string;
  /** Called with dotted paths only (never values) for logging. */
  onIssue?: (event: string, fields: { path?: string; errno?: string; count?: number }) => void;
  /** Rejects bedrock and other unavailable providers in set() (12 §5.3). */
  isProviderAvailable?: (id: string) => boolean;
  now?: () => Date;
}

const MAX_REPAIR_PASSES = 50;
const KEEP_CORRUPT_BACKUPS = 3;

/**
 * Loads, validates, repairs and atomically saves <userData>/settings.json (12 §4).
 * Layers, lowest to highest: DEFAULTS < extension.defaults < user file < extension.managed.
 */
export class SettingsStore {
  private user: Raw = {};
  private snapshot: Settings = deepFreeze(structuredClone(DEFAULTS));
  private issues: LoadIssue[] = [];
  private extension: SettingsExtension | undefined;
  private managed: Raw = {};
  private schema: z.ZodType<Settings> = SettingsSchema;
  private readOnlyCompat = false;
  private readonly listeners = new Set<Listener>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly opts: SettingsStoreOptions) {
    this.file = path.join(opts.dir, 'settings.json');
  }

  get(): Settings {
    return this.snapshot;
  }

  loadIssues(): LoadIssue[] {
    return [...this.issues];
  }

  onChanged(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 12 §4.2. Runs at bootstrap step 1, and again (step 4) via applyExtension(). */
  async load(): Promise<void> {
    this.issues = [];
    let raw: Raw = {};
    let text: string | undefined;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.opts.onIssue?.('settings.read-failed', { errno: (err as NodeJS.ErrnoException).code ?? 'unknown' });
      } else {
        this.opts.onIssue?.('settings.created', {});
      }
    }
    let dirty = false;
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        raw = parsed as Raw;
      } catch {
        await this.moveAsideCorrupt();
        this.issues.push({ path: '', reason: 'corrupt-file' });
        raw = {};
        dirty = true;
      }
    }

    const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : CURRENT_SCHEMA_VERSION;
    if (version > CURRENT_SCHEMA_VERSION) {
      this.readOnlyCompat = true;
      for (const k of Object.keys(raw)) {
        if (!(k in SettingsSchema.shape)) {
          delete raw[k];
          this.issues.push({ path: k, reason: 'unknown-dropped' });
        }
      }
      raw.schemaVersion = CURRENT_SCHEMA_VERSION;
    } else if (version < CURRENT_SCHEMA_VERSION) {
      raw = migrate(raw, version);
      dirty = true;
    }
    if (this.extension?.migrate) raw = this.extension.migrate(raw);

    for (const p of findSecrets(raw)) {
      deletePath(raw, p);
      this.issues.push({ path: p, reason: 'secret-removed' });
      this.opts.onIssue?.('settings.secret-removed', { path: p });
      dirty = true;
    }

    const { value, resetPaths } = this.repair(raw);
    for (const p of resetPaths) {
      this.issues.push({ path: p, reason: 'invalid' });
      this.opts.onIssue?.('settings.reset', { path: p });
    }
    if (resetPaths.length) dirty = true;
    this.user = value;
    this.rebuild([]);
    if (dirty && !this.readOnlyCompat) await this.save();
  }

  /** Bootstrap step 4: apply the overlay's SettingsExtension (12 §8.2) and re-validate. */
  async applyExtension(ext: SettingsExtension | undefined): Promise<void> {
    if (!ext) return;
    this.extension = ext;
    const fatal = (msg: string): never => {
      throw new Error(`SettingsExtension "${ext.id}": ${msg}`);
    };
    if (ext.defaults && findSecrets(ext.defaults).length) fatal('secret-shaped value in defaults');
    if (ext.schemas) {
      for (const ns of Object.keys(ext.schemas)) {
        if (!(DORMANT_NAMESPACES as readonly string[]).includes(ns)) fatal(`schema for non-dormant namespace ${ns}`);
      }
      this.schema = extendSchema(ext.schemas);
    }
    let managed: Raw = {};
    if (typeof ext.managed === 'function') {
      managed = (await withTimeout(ext.managed(), 3000, 'managed loader timed out')) as Raw;
    } else if (ext.managed) {
      managed = ext.managed as Raw;
    }
    if (findSecrets(managed).length) fatal('secret-shaped value in managed');
    this.managed = managed;
    const { value, resetPaths } = this.repair(this.user);
    for (const p of resetPaths) this.issues.push({ path: p, reason: 'invalid' });
    this.user = value;
    this.rebuild([]);
    if (resetPaths.length) await this.save();
  }

  /** 12 §5.1. Returns the new snapshot or throws SettingsError. */
  async set(patch: DeepPartial<Settings>): Promise<Settings> {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new SettingsError('E_SETTINGS_INVALID', 'Settings patch must be an object');
    }
    // Step 1: unknown keys are rejected before anything else (12 §5.3: llm.apiKey is "unknown").
    const merged = deepMerge(structuredClone(this.user), patch as Raw);
    const shape = this.schema.safeParse(this.layered(merged));
    const unknown = shape.success ? [] : shape.error.issues.filter((i) => i.code === 'unrecognized_keys');
    if (unknown.length) {
      throw new SettingsError(
        'E_SETTINGS_INVALID',
        "That value isn't valid",
        unknown.flatMap((i) =>
          unrecognizedKeys(i).map((k) => ({ path: [...i.path, k].join('.'), message: 'unknown key' })),
        ),
      );
    }
    // Step 2: secret guard; step 3: managed locks.
    const secrets = findSecrets(patch);
    if (secrets.length) {
      throw new SettingsError(
        'E_SECRET_IN_SETTINGS',
        'Keys and tokens go in the API key field, not in settings',
        secrets.map((p) => ({ path: p, message: 'secret' })),
      );
    }
    const locked = leafPaths(patch).find((p) => this.isLocked(p));
    if (locked)
      throw new SettingsError('E_SETTINGS_LOCKED', 'This setting is managed by your organization', [
        { path: locked, message: 'locked' },
      ]);
    const provider = (patch as { llm?: { provider?: unknown } }).llm?.provider;
    if (typeof provider === 'string' && this.opts.isProviderAvailable && !this.opts.isProviderAvailable(provider)) {
      throw new SettingsError('E_SETTINGS_INVALID', 'That provider is not available in this edition', [
        { path: 'llm.provider', message: 'not available in this edition' },
      ]);
    }
    // Step 4: full validation of the merged object, then save and emit.
    if (!shape.success) {
      throw new SettingsError(
        'E_SETTINGS_INVALID',
        "That value isn't valid",
        shape.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const before = this.snapshot;
    this.user = merged;
    this.readOnlyCompat = false;
    const changed = diffPaths(before, shape.data);
    this.rebuild([]);
    // 12 §5.1 step 4: save, then emit, so listeners (and the renderer) never see a value that is not
    // on disk yet. A failed save still emits: the in-memory snapshot has changed either way.
    try {
      await this.save();
    } finally {
      this.emit(changed);
    }
    return this.snapshot;
  }

  describe(keychainAvailable: boolean): SettingsDescription {
    const extDefaults = (this.extension?.defaults ?? {}) as Raw;
    return {
      keys: leafPaths(this.snapshot as unknown as Raw, true).map((p) => ({
        path: p,
        dormant: isDormantPath(p),
        locked: this.isLocked(p),
        source: hasPath(this.managed, p)
          ? 'managed'
          : hasPath(this.user, p)
            ? 'user'
            : hasPath(extDefaults, p)
              ? 'extension'
              : 'default',
      })),
      loadIssues: this.loadIssues(),
      keychain: { available: keychainAvailable },
    };
  }

  private isLocked(p: string): boolean {
    return leafPaths(this.managed).some((m) => m === p || m.startsWith(`${p}.`) || p.startsWith(`${m}.`));
  }

  private layered(user: Raw): Raw {
    const base = deepMerge({}, (this.extension?.defaults ?? {}) as Raw);
    return deepMerge(deepMerge(base, user), this.managed);
  }

  /** Leaf-by-leaf repair: delete each offending path and re-parse (12 §4.2 step 5). */
  private repair(input: Raw): { value: Raw; resetPaths: string[] } {
    const raw = structuredClone(input);
    const resetPaths: string[] = [];
    for (let i = 0; i < MAX_REPAIR_PASSES; i++) {
      const r = this.schema.safeParse(this.layered(raw));
      if (r.success) return { value: raw, resetPaths };
      let progressed = false;
      for (const issue of r.error.issues) {
        const keys = unrecognizedKeys(issue);
        const paths = keys.length ? keys.map((k) => [...issue.path, k].join('.')) : [issue.path.join('.')];
        for (const p of paths) {
          if (p && deletePath(raw, p)) {
            resetPaths.push(p);
            progressed = true;
          }
        }
      }
      if (!progressed) break;
    }
    // Fall back to defaults plus preserved dormant subtrees.
    const fallback: Raw = {};
    for (const ns of DORMANT_NAMESPACES) {
      const v = getPath(raw, ns);
      if (v !== undefined && ns !== 'sources.mcp') setPath(fallback, ns, v);
    }
    resetPaths.push('*');
    return { value: fallback, resetPaths };
  }

  private rebuild(changed: string[]): void {
    const parsed = this.schema.parse(this.layered(this.user));
    this.snapshot = deepFreeze(parsed);
    this.emit(changed);
  }

  private emit(changed: string[]): void {
    if (changed.length) for (const l of this.listeners) l(this.snapshot, changed);
  }

  /** 12 §4.3: user layer only, 0600, temp + fsync + rename, serialized. */
  private save(): Promise<void> {
    const run = async (): Promise<void> => {
      const body = JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, ...this.user }, null, 2) + '\n';
      const tmp = `${this.file}.tmp`;
      try {
        await fsp.mkdir(this.opts.dir, { recursive: true });
        const fh = await fsp.open(tmp, 'w', 0o600);
        try {
          await fh.writeFile(body, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fsp.rename(tmp, this.file);
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code ?? 'unknown';
        this.opts.onIssue?.('settings.save-failed', { errno });
        throw new SettingsError('E_SETTINGS_IO', "Couldn't save settings (disk)");
      }
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async moveAsideCorrupt(): Promise<void> {
    const ts = (this.opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    try {
      await fsp.rename(this.file, path.join(this.opts.dir, `settings.corrupt-${ts}.json`));
      await fsp.chmod(path.join(this.opts.dir, `settings.corrupt-${ts}.json`), 0o600);
      const backups = (await fsp.readdir(this.opts.dir)).filter((f) => /^settings\.corrupt-.*\.json$/.test(f)).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_CORRUPT_BACKUPS))) {
        await fsp.rm(path.join(this.opts.dir, old), { force: true });
      }
    } catch (err) {
      this.opts.onIssue?.('settings.corrupt-move-failed', { errno: (err as NodeJS.ErrnoException).code ?? 'unknown' });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Replace loose dormant namespaces with the extension's strict schemas (12 §8.2 rule 1). */
function extendSchema(schemas: Partial<Record<string, z.ZodType>>): z.ZodType<Settings> {
  const top: Record<string, z.ZodType> = {};
  for (const [ns, schema] of Object.entries(schemas)) {
    if (!schema) continue;
    const [head, tail] = ns.split('.') as [string, string | undefined];
    if (!tail) {
      top[head] = schema;
      continue;
    }
    const parent = unwrapObject(top[head] ?? (SettingsSchema.shape as Record<string, z.ZodType>)[head]);
    if (!parent) continue;
    top[head] = parent.extend({ [tail]: schema }).prefault({});
  }
  return SettingsSchema.extend(top) as unknown as z.ZodType<Settings>;
}

function unwrapObject(t: z.ZodType | undefined): z.ZodObject | undefined {
  let cur: unknown = t;
  for (let i = 0; i < 4 && cur; i++) {
    const def = (cur as { def?: { type?: string; innerType?: unknown } }).def;
    if (def?.type === 'object') return cur as z.ZodObject;
    cur = def?.innerType;
  }
  return undefined;
}

function unrecognizedKeys(issue: z.core.$ZodIssue): string[] {
  return issue.code === 'unrecognized_keys' ? (issue.keys as string[]) : [];
}

function isPlainObject(v: unknown): v is Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(target: Raw, src: Raw): Raw {
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(target[k])) target[k] = deepMerge(target[k] as Raw, v);
    else target[k] = isPlainObject(v) ? deepMerge({}, v) : v;
  }
  return target;
}

function getPath(obj: Raw, p: string): unknown {
  let cur: unknown = obj;
  for (const k of p.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function hasPath(obj: Raw, p: string): boolean {
  return getPath(obj, p) !== undefined;
}

function setPath(obj: Raw, p: string, v: unknown): void {
  const keys = p.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Raw;
  }
  cur[keys[keys.length - 1]!] = v;
}

function deletePath(obj: Raw, p: string): boolean {
  const keys = p.split('.');
  let cur: unknown = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur)) return false;
    cur = cur[k];
  }
  const last = keys[keys.length - 1]!;
  if (!isPlainObject(cur) || !(last in cur)) return false;
  delete cur[last];
  return true;
}

/** Dotted leaf paths. With stopAtDormant, dormant namespaces are reported as single keys. */
export function leafPaths(obj: unknown, stopAtDormant = false, prefix = ''): string[] {
  if (!isPlainObject(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (stopAtDormant && (DORMANT_NAMESPACES as readonly string[]).includes(p)) out.push(p);
    else if (isPlainObject(v) && Object.keys(v).length) out.push(...leafPaths(v, stopAtDormant, p));
    else out.push(p);
  }
  return out;
}

function diffPaths(a: unknown, b: unknown): string[] {
  const pa = new Map(leafPaths(a).map((p) => [p, JSON.stringify(getPath(a as Raw, p))]));
  const pb = new Map(leafPaths(b).map((p) => [p, JSON.stringify(getPath(b as Raw, p))]));
  const all = new Set([...pa.keys(), ...pb.keys()]);
  return [...all].filter((p) => pa.get(p) !== pb.get(p)).sort();
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
