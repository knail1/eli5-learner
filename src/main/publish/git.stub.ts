import type { Settings } from '../config';
import { NotAvailableInEdition } from '../editions';
import { edition } from '../editions';
import type { PublishContext, Publisher, PublishResult, PublishTarget } from './types';

/** Public-build git publisher stub (10 §5.3, HOOK-PUB-03). Never spawns git. */
export class GitPublisherStub implements Publisher {
  readonly stub = true;
  readonly id = 'git';
  readonly kind = 'git' as const;

  describe(_slug: string, _settings: Settings): Promise<PublishTarget> {
    return Promise.resolve({
      id: this.id,
      kind: this.kind,
      label: 'Push to Pages',
      available: false,
      unavailableReason: 'Available in the enterprise edition',
      requiresSignIn: false,
    });
  }

  publish(_ctx: PublishContext): Promise<PublishResult> {
    return Promise.reject(new NotAvailableInEdition('publisher:git', 'HOOK-PUB-03', edition));
  }
}
