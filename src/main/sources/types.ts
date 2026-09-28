/**
 * Source-resolution types (03 §2, §3, §8, §10.1, §12). Sole owner of SourceFormat and SkipCode;
 * 04 and 05 import them from here. Serializable input/auth types live in the preload contract and
 * are re-exported, never redefined.
 */
import type { AuthState, AuthStatus, FileSnapshot, SourceInput, SourceOrigin } from '../../preload/contract';
import type { Edition } from '../editions';
import type { FetchContext, FetchOutcome } from '../fetch';

export type { AuthState, AuthStatus, FileSnapshot, SourceInput, SourceOrigin };

/** Which access lane served a source (03 §2). */
export type Lane = 'local' | 'web' | 'mcp';

/** Formats the extraction stage understands (03 §2). Scanned PDFs are decided by 04, not here. */
export type SourceFormat =
  | 'pptx'
  | 'docx'
  | 'xlsx'
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'csv'
  | 'html'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'heic'
  | 'tiff'
  | 'bmp';

export const IMAGE_FORMATS = ['png', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'bmp'] as const;

export type SourcePayload =
  { kind: 'path'; path: string } | { kind: 'text'; text: string } | { kind: 'html'; html: string; baseUrl?: string };

export interface ResolvedSource {
  /** "src-" + two-digit zero-padded index in final job order (03 §4 step 6). */
  id: string;
  inputId: string;
  ref: string;
  location: string;
  lane: Lane;
  /** 'file' | 'clipboard' | 'url' | 'mcp' | 'ticket' | overlay-defined */
  resolverId: string;
  format: SourceFormat;
  mediaType: string;
  title?: string;
  payload: SourcePayload;
  sizeBytes: number;
  /** Of the payload bytes (UTF-8 for text/html payloads); used for dedupe. */
  sha256: string;
  notes: string[];
}

/** The single machine-code union for SkippedSource.code across 03, 04 and 05 (03 §2, §9). */
export type SkipCode =
  // resolution (03)
  | 'not-found'
  | 'permission-denied'
  | 'not-a-regular-file'
  | 'empty'
  | 'file-changed'
  | 'unsupported-type'
  | 'legacy-office-format'
  | 'too-large'
  | 'limit-exceeded'
  | 'not-a-url'
  | 'unsupported-scheme'
  | 'not-available-in-edition'
  | 'sign-in-required'
  | 'access-denied'
  | 'cancelled'
  | 'read-error'
  // fetching (05)
  | 'fetch-failed'
  | 'login-required'
  | 'paywall'
  | 'timeout'
  | 'http-error'
  | 'empty-content'
  | 'render-failed'
  | 'blocked-private-address'
  // extraction (04)
  | 'encrypted'
  | 'corrupt'
  | 'zip-bomb'
  | 'image-too-large'
  | 'image-budget-exceeded'
  | 'scan-render-failed'
  | 'internal-error';

/** A source that could not be used (03 §2). */
export interface SkippedSource {
  ref: string;
  reason: string;
  code: SkipCode;
}

export interface ResolveOutcome {
  resolved: ResolvedSource[];
  skipped: SkippedSource[];
}

/** Result of sniff() (03 §5.2). */
export type SniffResult =
  | { ok: true; format: SourceFormat; mediaType: string; notes: string[] }
  | { ok: false; code: 'unsupported-type' | 'legacy-office-format' | 'encrypted'; detail: string };

/** Per-job resolution limits (03 §3). */
export interface ResolveLimits {
  maxFileBytes: number;
  maxImageBytes: number;
  maxSourcesPerJob: number;
  maxTotalBytes: number;
  maxFolderDepth: number;
  perSourceTimeoutMs: number;
  concurrency: number;
}

/** Defaults stated in 03 §3. */
export const DEFAULT_RESOLVE_LIMITS: Readonly<ResolveLimits> = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxImageBytes: 20 * 1024 * 1024,
  maxSourcesPerJob: 50,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFolderDepth: 3,
  perSourceTimeoutMs: 90_000,
  concurrency: 4,
});

export interface ResolveContext {
  jobId: string;
  edition: Edition;
  /** <userData>/jobs/<jobId>/, created by the pipeline (06 §9.1); downloads go here. */
  stagingDir: string;
  /** Enterprise only: the one shared overlay-owned MCP client (03 §10.1). */
  mcp?: McpClient;
  signal: AbortSignal;
  limits: ResolveLimits;
  fetchUrl: (url: string, fctx: FetchContext) => Promise<FetchOutcome>;
  lanes: LaneRouter;
  /** Local debug log only. */
  log: (msg: string, data?: Record<string, unknown>) => void;
}

/** The resolver seam (03 §3; HOOK-SRC-01/02). */
export interface SourceResolver {
  /** Stable id; also written to ResolvedSource.resolverId. */
  readonly id: string;
  /** Inputs this resolver may be offered. URL inputs are pre-routed by lane (03 §8). */
  readonly handles: ReadonlyArray<SourceInput['kind']>;
  readonly lane: Lane;
  /** Cheap, synchronous, no I/O. */
  canResolve(input: SourceInput, ctx: ResolveContext): boolean;
  /** Must not throw for expected failures; may throw NotAvailableInEdition (stubs). */
  resolve(input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome>;
}

// ---- Lane routing (03 §8, HOOK-SRC-03) ----

export interface LaneRoute {
  lane: Lane;
  /** e.g. 'ticket' to force the ticket resolver. */
  resolverId?: string;
  /** Which rule matched (debug log only). */
  ruleId?: string;
  /** true for organization routes. */
  noWebFallback: boolean;
}

export interface LaneRule {
  id: string;
  /** Every present field must match. pattern is a RegExp source tested against the full URL. */
  match: { hostGlob?: string; pathPrefix?: string; pattern?: string };
  route: Omit<LaneRoute, 'ruleId'>;
}

export interface LaneRouter {
  route(url: URL): LaneRoute;
  /** Enterprise only: classify non-URL identifiers (e.g. ticket keys). Public returns null. */
  routeBare(text: string): { url: URL; route: LaneRoute } | null;
}

// ---- MCP (03 §10.1, HOOK-SRC-05) ----

export type McpState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Overlay-owned. Exactly one instance per app process; the public build has none. */
export interface McpClient {
  readonly serverUrl: string;
  state(): McpState;
  /** Honors signal; rejects with McpError on transport or tool failure. */
  callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
  onStateChange(listener: (s: McpState) => void): () => void;
  close(): Promise<void>;
}

export interface McpError extends Error {
  kind: 'transport' | 'auth-expired' | 'forbidden' | 'not-found' | 'too-large' | 'timeout' | 'tool-error';
}

// ---- Auth (03 §12, HOOK-AUTH-01) ----

export interface AuthBroker {
  status(): AuthStatus;
  /** User-initiated only. Never called from a job. */
  signIn(): Promise<AuthStatus>;
  signOut(): Promise<AuthStatus>;
  onChange(listener: (s: AuthStatus) => void): () => void;
}

// ---- Staging (HOOK-SRC-04; 06 §9) ----

/** Retention class for a staged source; mirrors PipelinePolicy.stagingRetention (06 §9.5). */
export type StagingRetention = 'default' | 'purge-on-terminal';

/**
 * Handling of source material on disk (HOOK-SRC-04). The public default follows 06 §9:
 * one staging root <userData>/jobs/<jobId>/, everything may be staged, 06 §9.5 retention,
 * locations persisted verbatim, no document label.
 */
export interface StagingPolicy {
  /** Staging root for a job (the ResolveContext.stagingDir). */
  stagingDir(userData: string, jobId: string): string;
  /** false: content from this lane/resolver must stay in memory and never be written to disk. */
  mayStageToDisk(src: { lane: Lane; resolverId: string }): boolean;
  /** When a source's staged material is deleted. */
  retention(src: Pick<ResolvedSource, 'lane' | 'resolverId'>): StagingRetention;
  /** Overwrite before unlinking when deleting staged material. */
  readonly secureDelete: boolean;
  /** The location string written to meta.json and the references section (may redact). */
  persistedLocation(src: Pick<ResolvedSource, 'lane' | 'resolverId' | 'location'>): string;
  /** Label required on documents built from these sources, or null for none. */
  documentLabel(sources: ReadonlyArray<Pick<ResolvedSource, 'lane' | 'resolverId'>>): string | null;
}
