import { edition, NotAvailableInEdition } from '../editions';
import type { StockCandidate, StockImageProvider, StockSearchOptions } from './types';

const CAPABILITY = 'photos:approved-library';
const HOOK = 'HOOK-DOC-03';

/**
 * Documented stub for an organization-approved image library (07 §7.4, HOOK-DOC-03). Not registered
 * in the public build, which uses Openverse with a Wikimedia Commons fallback. An overlay registers
 * its own StockImageProvider through registerStockImageProvider; registering this stub (or any
 * provider with `stub: true`) turns stock photos off, and documents fall back to diagrams.
 *
 * A private binding supplies: the library's search endpoint and query rules, its authentication
 * (through the overlay, never the settings file), the licence and credit text each image carries,
 * and whether search terms may leave the organization at all.
 */
export class ApprovedLibraryStub implements StockImageProvider {
  readonly stub = true;
  readonly id = 'approved-library';

  search(_query: string, _o: StockSearchOptions): Promise<StockCandidate[]> {
    return Promise.reject(new NotAvailableInEdition(CAPABILITY, HOOK, edition));
  }

  download(_c: StockCandidate, _size: 'thumb' | 'full', _o: { signal: AbortSignal }): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
}
