import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DropRegistration } from '../../preload/contract';

/**
 * Bound on live registrations (06 §11). Equal to the most paths one `register-drop` may carry, so a
 * single large drop is never evicted by itself; past it the least recently used id goes first.
 */
export const DROP_REGISTRY_MAX = 1000;

export interface DropRegistryOptions {
  /** Bound on live registrations; the least recently used is evicted first. */
  max?: number;
  /** Mints opaque input ids (03 §13 pattern); injected by tests. */
  newId?: () => string;
}

/**
 * Read targets the renderer may name in `eli5:jobs:start` (06 §11, 03 §13). Main mints an opaque
 * input id for each path from a trusted native drop (`eli5:sources:register-drop`) or a clipboard
 * read; file inputs carry that id and main maps it back to its own path. Raw paths never resolve.
 *
 * Ids stay valid across starts, so the input zone can Start or Restart the same draft again
 * (11 §5.4). They are released when their chip is removed or the draft is cleared
 * (`eli5:sources:release-drops`), and the registry is an LRU bounded by `max`.
 */
export class DropRegistry {
  private readonly byId = new Map<string, string>();
  private readonly max: number;
  private readonly newId: () => string;

  constructor(o: DropRegistryOptions = {}) {
    this.max = o.max ?? DROP_REGISTRY_MAX;
    this.newId = o.newId ?? (() => `drop-${randomUUID()}`);
  }

  get size(): number {
    return this.byId.size;
  }

  register(paths: readonly string[]): DropRegistration[] {
    const out: DropRegistration[] = [];
    for (const p of paths) {
      if (!path.isAbsolute(p)) continue;
      const reg = { inputId: this.newId(), path: path.resolve(p) };
      this.byId.set(reg.inputId, reg.path);
      out.push(reg);
    }
    while (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    return out;
  }

  /** The path main registered for `inputId`, or undefined for anything it did not mint. Marks it used. */
  resolve(inputId: string): string | undefined {
    const p = this.byId.get(inputId);
    if (p === undefined) return undefined;
    this.byId.delete(inputId);
    this.byId.set(inputId, p);
    return p;
  }

  /** The chip was removed or the draft cleared: these ids no longer name anything. Unknown ids are ignored. */
  release(inputIds: readonly string[]): void {
    for (const id of inputIds) this.byId.delete(id);
  }
}
