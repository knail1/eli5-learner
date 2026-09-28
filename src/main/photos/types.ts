// Stock photo types (07 §7.4). A StockImageProvider finds open-licensed photos for a short generic
// query and downloads them; HOOK-DOC-03 lets an organization register its approved image library.
import type { StockLicense } from '../document';
import type { BytesOutcome, BytesRequest } from '../fetch';

export type { StockLicense };

/** Reuse and modification allowed (no NC, no ND), in the order they are requested. */
export const ALLOWED_LICENSES: readonly StockLicense[] = ['cc0', 'pdm', 'by', 'by-sa'];

/** One search result: what the pick call sees and what the credit is built from. */
export interface StockCandidate {
  /** Provider-scoped, e.g. "openverse:<uuid>"; used to avoid repeating a photo. */
  id: string;
  title: string;
  creator?: string;
  license: StockLicense;
  licenseVersion?: string;
  licenseUrl?: string;
  /** The work's page at its source (credit link). */
  landingUrl?: string;
  /** Where the work is hosted, e.g. "Flickr", "Wikimedia Commons". */
  sourceName: string;
  /** The search service, e.g. "Openverse". */
  via: string;
  /** Small image for the pick call (about 300 to 600 px). */
  thumbUrl: string;
  /** Image to embed, downscaled again by the app (about 1000 to 1300 px when the host can size it). */
  imageUrl: string;
  width?: number;
  height?: number;
}

export interface StockSearchOptions {
  signal: AbortSignal;
  /** Most results to return after filtering. */
  limit: number;
}

/**
 * HOOK-DOC-03 seam (registerStockImageProvider). `search` returns only candidates the app may embed
 * (open license, not mature); it may throw on network trouble, which the caller treats as no results.
 * `download` returns the bytes or null. A provider with `stub: true` turns stock photos off.
 */
export interface StockImageProvider {
  readonly id: string;
  readonly stub?: boolean;
  search(query: string, o: StockSearchOptions): Promise<StockCandidate[]>;
  download(c: StockCandidate, size: 'thumb' | 'full', o: { signal: AbortSignal }): Promise<Uint8Array | null>;
}

/** The fetch module's fetchBytes (05 §4.8); injected so tests never touch the network. */
export type StockHttp = (url: string, o: BytesRequest) => Promise<BytesOutcome>;

export function isStockStub(p: StockImageProvider): boolean {
  return p.stub === true;
}
