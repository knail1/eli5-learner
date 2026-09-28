/** URL-fetch public types (05 §2, §4.2, §6.1). */
import type { Session } from 'electron';

export interface FetchContext {
  jobId: string;
  signal: AbortSignal; // job cancellation; aborts network + render window
  stagingDir: string; // <userData>/jobs/<jobId>/ (06 §9.2); binary bodies are written here
  onProgress?: (detail: FetchProgress) => void;
}

export type FetchProgress =
  { phase: 'http'; url: string } | { phase: 'render'; url: string } | { phase: 'extract'; url: string };

export type FetchOutcome =
  | { kind: 'article'; content: FetchedArticle }
  | { kind: 'binary'; content: FetchedBinary }
  | { kind: 'skipped'; code: FetchSkipCode; reason: string; finalUrl?: string };

export interface FetchedArticle {
  requestedUrl: string;
  finalUrl: string; // after redirects / client navigation
  title: string | null;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null; // ISO 8601 when discoverable
  excerpt: string | null;
  contentHtml: string; // Readability output, sanitized (§5.3)
  textLength: number;
  via: 'http' | 'render';
  imageUrls: string[]; // absolute URLs of in-article images (not fetched here)
}

export interface FetchedBinary {
  requestedUrl: string;
  finalUrl: string;
  mime: string; // normalized, e.g. 'application/pdf'
  filename: string; // from Content-Disposition or URL path, sanitized
  path: string; // absolute path of the body inside ctx.stagingDir
  sizeBytes: number;
}

export type FetchSkipCode =
  | 'invalid-url'
  | 'blocked-scheme'
  | 'credentials-in-url'
  | 'dns-failure'
  | 'connect-failure'
  | 'tls-error'
  | 'timeout'
  | 'too-large'
  | 'too-many-redirects'
  | 'http-not-found'
  | 'http-gone'
  | 'http-client-error'
  | 'http-server-error'
  | 'rate-limited'
  | 'login-required'
  | 'paywall'
  | 'unsupported-type'
  | 'empty-content'
  | 'render-failed'
  | 'blocked-private-address';

/** Login-wall signature (HOOK-FETCH-02, 05 §4.2/§7). Public build registers none. */
export interface LoginSignature {
  hostPattern?: RegExp;
  urlPattern?: RegExp;
  domSelector?: string;
  kind: 'conclusive' | 'strong';
}

/** Configures proxy and TLS trust on a session (HOOK-FETCH-01, 01 §6.2). */
export type NetworkConfigurator = (ses: Session) => Promise<void>;

/** Signals from the original (pre-Readability) DOM (05 §6.1). */
export interface PageSignals {
  bodyTextLength: number;
  articleTextLength: number;
  readerable: boolean;
  scriptBytes: number;
  htmlBytes: number;
  mountPointEmpty: boolean;
  noscriptSaysEnableJs: boolean;
  hasPasswordField: boolean;
  formCount: number;
  metaRefreshUrl: string | null;
  titleText: string;
  challengeMarkers: boolean;
}
