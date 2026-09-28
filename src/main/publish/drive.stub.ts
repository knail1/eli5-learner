import type { Settings } from '../config';
import { NotAvailableInEdition } from '../editions';
import { edition } from '../editions';
import type { PublishContext, Publisher, PublishResult, PublishTarget } from './types';

/** Public-build cloud drive stub (10 §5.2, HOOK-PUB-01). No network, no UI (HOOK-UI-01). */
export class DrivePublisherStub implements Publisher {
  readonly stub = true;
  readonly id = 'drive';
  readonly kind = 'drive' as const;

  describe(_slug: string, _settings: Settings): Promise<PublishTarget> {
    return Promise.resolve({
      id: this.id,
      kind: this.kind,
      label: 'Share to cloud drive',
      available: false,
      unavailableReason: 'Available in the enterprise edition',
      requiresSignIn: true,
    });
  }

  publish(_ctx: PublishContext): Promise<PublishResult> {
    return Promise.reject(new NotAvailableInEdition('publisher:drive', 'HOOK-PUB-01', edition));
  }
}
