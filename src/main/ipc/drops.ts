import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DropRegistration } from '../../preload/contract';

export interface DropRegistryOptions {
  /** Bound on live registrations; the oldest is evicted first. */
  max?: number;
  /** Mints opaque input ids (03 §13 pattern); injected by tests. */
  newId?: () => string;
}

/**
 * Read targets the renderer may name in `eli5:jobs:start` (06 §11, 03 §13). Main mints an opaque
 * input id for each path from a trusted native drop (`eli5:sources:register-drop`) or a clipboard
 * read; file inputs carry that id and main maps it back to its own path. Raw paths never resolve.
 */
export class DropRegistry {
  private readonly byId = new Map<string, string>();
  private readonly max: number;
  private readonly newId: () => string;

  constructor(o: DropRegistryOptions = {}) {
    this.max = o.max ?? 1000;
    this.newId = o.newId ?? (() => `drop-${randomUUID()}`);
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

  /** The path main registered for `inputId`, or undefined for anything it did not mint. */
  resolve(inputId: string): string | undefined {
    return this.byId.get(inputId);
  }

  /** A successful start uses its ids up; a later start needs a new drop or paste. */
  consume(inputIds: readonly string[]): void {
    for (const id of inputIds) this.byId.delete(id);
  }
}
