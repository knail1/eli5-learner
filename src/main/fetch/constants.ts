/** Every fetch limit (05 §11). Not user settings; enterprise differences arrive via HOOK-FETCH-01. */

const MiB = 1024 * 1024;

export const LIMITS = {
  URL_TOTAL_BUDGET_MS: 75_000,
  HTTP_HEADERS_TIMEOUT_MS: 15_000,
  HTTP_BODY_TIMEOUT_MS: 45_000,
  HTTP_STALL_TIMEOUT_MS: 15_000,
  MAX_REDIRECTS: 10,
  MAX_HTML_BYTES: 5 * MiB,
  MIN_HTML_PREFIX_BYTES: 1 * MiB,
  MAX_TEXT_BYTES: 5 * MiB,
  MAX_IMAGE_BYTES: 20 * MiB,
  MAX_DOCUMENT_BYTES: 50 * MiB,
  MAX_SVG_BYTES: 1 * MiB,
  SNIFF_BYTES: 4 * 1024,
  READABILITY_WORKERS: 2,
  READABILITY_TIMEOUT_MS: 20_000,
  READABILITY_IDLE_MS: 60_000,
  RENDER_MIN_BUDGET_MS: 15_000,
  RENDER_TIMEOUT_MS: 20_000,
  RENDER_WATCHDOG_EXTRA_MS: 5_000,
  RENDER_MIN_WAIT_MS: 1_500,
  RENDER_QUIET_MS: 1_000,
  RENDER_POLL_MS: 250,
  RENDER_IDLE_MS: 500, // inflight == 0 for this long (05 §8.3 step 5)
  RENDER_EARLY_EXIT_TEXT: 3_000,
  RENDER_EARLY_EXIT_MS: 500,
  RENDER_LONG_POLL_MS: 5_000, // in-flight requests older than this are ignored (§8.3 step 2)
  RENDER_SCROLL_BACK_MS: 300,
  MAX_RENDER_WINDOWS: 2,
  MAX_GLOBAL_FETCHES: 4,
  HOST_MIN_INTERVAL_MS: 1_000,
  RETRY_AFTER_MAX_MS: 10_000,
  RETRY_5XX_DELAY_MS: 2_000,
  RETRY_NETWORK_DELAY_MS: 1_000,
  META_REFRESH_MAX_DELAY_S: 5,
  META_REFRESH_MAX_TEXT: 4 * 1024,
  FILENAME_MAX: 120,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

/** Emptiness and login-wall thresholds (05 §6.2, §7), calibrated by the fixture suite. */
export const DETECT = {
  R1_ARTICLE_OK: 1_500,
  R2_ARTICLE_READERABLE: 500,
  R3_MOUNT_TEXT: 200,
  R3_BODY_MAX_CHILDREN: 5,
  R4_BODY_TEXT: 1_000,
  R5_SCRIPT_RATIO: 20,
  R5_BODY_TEXT: 2_000,
  R7_ARTICLE: 200,
  R7_BODY: 500,
  R8_ARTICLE: 200,
  EXTERNAL_SCRIPT_BYTES: 50_000,
  CHALLENGE_BODY_TEXT: 1_500,
  LOGIN_ARTICLE_MAX: 1_500, // password-field strong signal and paywall partial-article cutoff (§7)
  PAYWALL_TAIL_CHARS: 600,
} as const;

export const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.8,image/*;q=0.7,*/*;q=0.5';
export const FETCH_PARTITION = 'eli5-fetch';
export const renderPartition = (slot: number): string => `eli5-render-${slot}`;
