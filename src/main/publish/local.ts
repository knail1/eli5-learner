import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Settings } from '../config';
import { PublishError } from './types';
import type { PublishContext, Publisher, PublishResult, PublishTarget } from './types';

/** `~` / `~/x` -> absolute (10 §5.1 step 1). */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(p);
}

/** Absolute -> `~/x` when under the home directory (10 §5.1 describe). */
export function abbreviateHome(p: string, home: string = homedir()): string {
  if (p === home) return '~';
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** Local export publisher (10 §5.1). Always available; never touches the library copy. */
export class LocalPublisher implements Publisher {
  readonly id = 'local';
  readonly kind = 'local' as const;

  describe(slug: string, settings: Settings): Promise<PublishTarget> {
    const dir = expandHome(settings.publish.local.dir);
    return Promise.resolve({
      id: this.id,
      kind: this.kind,
      label: 'Export copy',
      available: true,
      destinationPreview: `${abbreviateHome(join(dir, slug))}/`,
      requiresSignIn: false,
    });
  }

  publish(_ctx: PublishContext): Promise<PublishResult> {
    // M3: implement the §5.1 algorithm (reject docs/ dest, mkdir, atomic copy, sha verify, file: link, reveal).
    return Promise.reject(new PublishError('E_PUBLISH_FAILED', 'Not implemented yet (M3)'));
  }
}
