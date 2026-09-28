// Public entry of src/main/photos (07 §7.4): open-licensed stock photos for real-world scenes.
export type { StockCandidate, StockHttp, StockImageProvider, StockLicense, StockSearchOptions } from './types';
export { ALLOWED_LICENSES, isStockStub } from './types';
export { QUERY_MAX_CHARS, QUERY_MAX_WORDS, properNounsOf, sanitizePhotoQuery } from './query';
export {
  CommonsProvider,
  FallbackStockImages,
  OpenverseProvider,
  COMMONS_API,
  OPENVERSE_API,
  STOCK_PURPOSE,
  commonsThumb,
  flickrSized,
} from './providers';
export { ApprovedLibraryStub } from './approved-library.stub';
export { PHOTO_LIMITS } from './limits';
export type { PhotoLimits } from './limits';
export { createNativePhotoOps } from './image';
export type { PhotoImageOps } from './image';
export { collectPhotoSlots, photoCredit, resolvePhotos } from './resolve';
export type { PhotoPicker, PhotoPickRequest, PhotoSlot, ResolvedPhotos, ResolvePhotosDeps } from './resolve';
export { createPublicStockImages, registerPublic } from './register';
