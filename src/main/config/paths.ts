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
