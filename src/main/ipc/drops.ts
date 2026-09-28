import path from 'node:path';

/**
 * Read targets the renderer may name in `eli5:jobs:start` (06 §11, 03 §13): paths from a trusted
 * native drop (`eli5:sources:register-drop`, sent by the app preload) or from a clipboard read in
 * main. Main never accepts any other raw path. Bounded; the oldest registration is evicted first.
 */
export class DropRegistry {
  private readonly paths = new Set<string>();

  constructor(private readonly max = 1000) {}

  register(paths: readonly string[]): void {
    for (const p of paths) {
      if (!path.isAbsolute(p)) continue;
      const key = path.resolve(p);
      this.paths.delete(key); // re-insert as newest
      this.paths.add(key);
    }
    while (this.paths.size > this.max) {
      const oldest = this.paths.values().next().value;
      if (oldest === undefined) break;
      this.paths.delete(oldest);
    }
  }

  has(p: string): boolean {
    return path.isAbsolute(p) && this.paths.has(path.resolve(p));
  }

  /** A successful start uses its paths up; a later start needs a new drop or paste. */
  consume(paths: readonly string[]): void {
    for (const p of paths) if (path.isAbsolute(p)) this.paths.delete(path.resolve(p));
  }
}
