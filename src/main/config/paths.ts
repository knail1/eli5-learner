import fs from 'node:fs';
import path from 'node:path';

export interface PathEnv {
  isPackaged: boolean;
  resourcesPath: string;
  /** Repo root in dev (the app path). */
  appPath: string;
}

let env: PathEnv | undefined;

/** Called once from bootstrap before any resource is read. */
export function initPaths(e: PathEnv): void {
  env = e;
}

/** Resolve a file under resources/ (prompts, skills, help, pdf-render, tray) (01 §8.3). */
export function resourcePath(rel: string): string {
  if (!env) throw new Error('paths not initialised');
  return env.isPackaged ? path.join(env.resourcesPath, rel) : path.join(env.appPath, 'resources', rel);
}

/**
 * userData override for dev and tests (12 §4.1): dev runs use "ELI5 Learner (dev)", and
 * ELI5_USER_DATA_DIR is honoured only in unpackaged builds.
 */
export function resolveUserDataDir(opts: { isPackaged: boolean; defaultDir: string; env: NodeJS.ProcessEnv }): string {
  if (opts.isPackaged) return opts.defaultDir;
  if (opts.env.ELI5_USER_DATA_DIR) return path.resolve(opts.env.ELI5_USER_DATA_DIR);
  return path.join(path.dirname(opts.defaultDir), 'ELI5 Learner (dev)');
}

export type LegacyMigration =
  | { status: 'moved'; from: string }
  | { status: 'nothing-to-migrate' | 'skipped-target-in-use' | 'skipped-legacy-running' | 'failed'; from?: string };

/** The new userData holds real data (as opposed to an empty shell Electron created first). */
function hasAppData(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'docs'));
}

/** Chromium's SingletonLock is a symlink to "<hostname>-<pid>": true while that process runs. */
function lockHeld(dir: string, hostname: string, isAlive: (pid: number) => boolean): boolean {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false;
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  return !!m && m[1] === hostname && isAlive(Number(m[2]));
}

/**
 * One-time move of an older userData folder into the current one (12 §4.1). Builds before
 * productName "ELI5 Learner" stored data under the package name ("eli5-learner"). Runs before
 * anything opens userData. Never overwrites real data, and leaves a profile alone while the old
 * app still holds its lock (retried on the next launch).
 */
export function migrateLegacyUserData(o: {
  appData: string;
  target: string;
  legacyNames: readonly string[];
  isAlive: (pid: number) => boolean;
  hostname: string;
}): LegacyMigration {
  const from = o.legacyNames.map((n) => path.join(o.appData, n)).find((p) => p !== o.target && hasAppData(p));
  if (!from) return { status: 'nothing-to-migrate' };
  if (hasAppData(o.target)) return { status: 'skipped-target-in-use', from };
  if (lockHeld(from, o.hostname, o.isAlive)) return { status: 'skipped-legacy-running', from };
  try {
    if (!fs.existsSync(o.target)) {
      fs.renameSync(from, o.target);
    } else {
      // An empty shell (caches only): move every legacy entry in, keeping what is already there.
      for (const name of fs.readdirSync(from)) {
        const dest = path.join(o.target, name);
        if (fs.existsSync(dest)) fs.rmSync(path.join(from, name), { recursive: true, force: true });
        else fs.renameSync(path.join(from, name), dest);
      }
      fs.rmdirSync(from);
    }
    return { status: 'moved', from };
  } catch {
    return { status: 'failed', from };
  }
}
