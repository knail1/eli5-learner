/** Stock photo limits (07 §7.4). Not user settings. */
export const PHOTO_LIMITS = {
  /** Photos per document, per section, and in the in-depth tab. */
  MAX_PER_DOCUMENT: 6,
  MAX_PER_SECTION: 1,
  MAX_INDEPTH: 2,
  /** Candidates shown to the pick call per slot, and slots per pick call. */
  CANDIDATES_PER_SLOT: 4,
  SLOTS_PER_PICK_CALL: 6,
  /** Pick-call thumbnails: long edge and JPEG quality. */
  THUMB_EDGE: 384,
  THUMB_QUALITY: 70,
  /** Embedded photos: long edge, first JPEG quality, and byte caps per photo and per document. */
  OUTPUT_EDGE: 1200,
  OUTPUT_QUALITY: 80,
  MAX_PHOTO_BYTES: 450 * 1024,
  MAX_TOTAL_BYTES: 1.5 * 1024 * 1024,
} as const;

export type PhotoLimits = { -readonly [K in keyof typeof PHOTO_LIMITS]: number };
