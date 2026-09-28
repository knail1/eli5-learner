import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../config';

/** Structured JSON-lines logger that never records content (12 §11). */

export type LogFieldValue = string | number | boolean | null;
export type LogFields = Record<string, LogFieldValue>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields, err?: unknown): void;
  debug(event: string, fields?: LogFields): void;
}

/** 12 §11.2 rule 1. Anything else is dropped. */
export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'jobId',
  'taskId',
  'slug',
  'sectionId',
  'tabKey',
  'attempt',
  'attempts',
  'errorKind',
  'from',
  'to',
  'status',
  'step',
  'code',
  'kind',
  'provider',
  'model',
  'latencyMs',
  'durationMs',
  'inputTokens',
  'outputTokens',
  'stopReason',
  'count',
  'bytes',
  'sourceKind',
  'sourceRef',
  'path',
  'channel',
  'errno',
  'hookId',
  'capability',
  'overlayName',
]);

const MAX_STRING = 200;
const ROTATE_BYTES = 5 * 1024 * 1024;
const ROTATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Archives kept besides main.log: four weeks of history, at most 25 MB in all. */
const KEEP_ARCHIVES = 4;

export interface LogSink {
  write(line: string): void;
}

export interface LoggerOptions {
  sink: LogSink;
  level?: () => 'info' | 'debug';
  /** Dev builds throw on unknown fields instead of dropping them (rule 1). */
  strictFields?: boolean;
  /** Absolute prefix to strip from stack traces (rule 4). */
  appRoot?: string;
  now?: () => Date;
}

/** Basename for paths, origin + pathname for URLs (rule 3). */
export function sourceRef(ref: string): string {
  if (/^https?:\/\//i.test(ref)) {
    try {
      const u = new URL(ref);
      return u.origin + u.pathname;
    } catch {
      return 'url:invalid';
    }
  }
  if (ref.startsWith('clipboard:')) return ref;
  return path.basename(ref);
}

export function createLogger(opts: LoggerOptions): Logger {
  const now = opts.now ?? (() => new Date());
  const emit = (level: LogLevel, event: string, fields: LogFields = {}, err?: unknown): void => {
    if (level === 'debug' && opts.level?.() !== 'debug') return;
    const line: Record<string, LogFieldValue> = { ts: now().toISOString(), level, event };
    for (const [k, v] of Object.entries(fields)) {
      if (!LOG_FIELD_ALLOWLIST.has(k)) {
        if (opts.strictFields) throw new Error(`log field "${k}" is not on the allowlist (12 §11.2)`);
        opts.sink.write(JSON.stringify({ ts: line.ts, level: 'warn', event: 'log.unknown-field', kind: k }) + '\n');
        continue;
      }
      line[k] = typeof v === 'string' ? clean(k === 'sourceRef' ? sourceRef(v) : v) : v;
    }
    if (err !== undefined) {
      const e = err as { name?: unknown; code?: unknown; stack?: unknown };
      line.errName = typeof e?.name === 'string' ? clean(e.name) : 'Error';
      if (typeof e?.code === 'string' || typeof e?.code === 'number') line.errCode = clean(String(e.code));
      if (typeof e?.stack === 'string') line.stack = stackOnly(e.stack, opts.appRoot);
    }
    opts.sink.write(JSON.stringify(line) + '\n');
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f, err) => emit('error', e, f, err),
    debug: (e, f) => emit('debug', e, f),
  };
}

function clean(s: string): string {
  return redact(s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);
}

/** Frames only: the first line (which carries err.message) is dropped (rule 4). */
function stackOnly(stack: string, appRoot?: string): string {
  const frames = stack.split('\n').filter((l) => /^\s+at\s/.test(l));
  let out = frames.slice(0, 15).join('\n');
  if (appRoot) out = out.split(appRoot).join('<app>');
  return redact(out.replace(/\/Users\/[^/\s]+/g, '~'));
}

export interface RotatingFileSinkOptions {
  now?: () => Date;
  maxBytes?: number;
  keepArchives?: number;
}

/**
 * File sink that starts a new file every week, or sooner at 5 MB: main.log, then main.log.1 (the
 * newest archive) to main.log.4. Older archives are deleted, so logs never grow past ~25 MB (mode 0600).
 */
export class RotatingFileSink implements LogSink {
  private fd: number | undefined;
  private size = 0;
  private startedAt = 0;
  private readonly now: () => Date;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    private readonly file: string,
    opts: RotatingFileSinkOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.maxBytes = opts.maxBytes ?? ROTATE_BYTES;
    this.keep = opts.keepArchives ?? KEEP_ARCHIVES;
  }

  write(line: string): void {
    try {
      if (this.fd === undefined) this.open();
      const t = this.now().getTime();
      if (
        this.size > 0 &&
        (this.size + Buffer.byteLength(line) > this.maxBytes || t - this.startedAt >= ROTATE_AGE_MS)
      ) {
        this.rotate();
      }
      if (this.size === 0) this.startedAt = t;
      fs.writeSync(this.fd!, line);
      this.size += Buffer.byteLength(line);
    } catch {
      // Logging must never crash the app.
    }
  }

  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.prune();
    this.fd = fs.openSync(this.file, 'a', 0o600);
    this.size = fs.fstatSync(this.fd).size;
    this.startedAt = this.size > 0 ? this.firstLineTime() : this.now().getTime();
  }

  /** When the current file was started: its first line's `ts`, else its birth time. */
  private firstLineTime(): number {
    try {
      const buf = Buffer.alloc(256);
      const fd = fs.openSync(this.file, 'r');
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const ts = /"ts":"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'))?.[1];
      const t = ts ? Date.parse(ts) : NaN;
      if (Number.isFinite(t)) return t;
    } catch {
      // fall through
    }
    const st = fs.statSync(this.file);
    return st.birthtimeMs || st.mtimeMs;
  }

  /** Deletes archives past the limit (e.g. left by a version that kept more). */
  private prune(): void {
    const base = path.basename(this.file);
    for (const name of fs.readdirSync(path.dirname(this.file))) {
      const m = name.startsWith(`${base}.`) ? /^\d+$/.exec(name.slice(base.length + 1)) : null;
      if (m && Number(m[0]) > this.keep) fs.rmSync(path.join(path.dirname(this.file), name), { force: true });
    }
  }

  private rotate(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    fs.rmSync(`${this.file}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    this.open();
  }
}

/** Collects lines in memory (tests). */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  entries(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

let current: Logger = createLogger({ sink: { write: () => {} } });

/** Process-wide logger; bootstrap installs the file sink. */
export const log: Logger = {
  info: (e, f) => current.info(e, f),
  warn: (e, f) => current.warn(e, f),
  error: (e, f, err) => current.error(e, f, err),
  debug: (e, f) => current.debug(e, f),
};

export function installLogger(l: Logger): void {
  current = l;
}
