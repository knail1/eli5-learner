import type { CapabilityRegistry } from '../editions';
import { fetchBytes } from '../fetch';
import { CommonsProvider, FallbackStockImages, OpenverseProvider } from './providers';
import type { StockHttp } from './types';

/** Openverse first, Wikimedia Commons as the fallback; both through the fetch module (05 §4.8). */
export function createPublicStockImages(http: StockHttp = fetchBytes): FallbackStockImages {
  return new FallbackStockImages([new OpenverseProvider(http), new CommonsProvider(http)]);
}

/**
 * Public stock photo registration (07 §7.4, HOOK-DOC-03). The documented ApprovedLibraryStub is not
 * registered: an overlay registers its organization-approved library, or the stub to turn photos off.
 */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerStockImageProvider(createPublicStockImages());
}
