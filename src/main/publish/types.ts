import type { Settings } from '../config';
import type {
  PublicationRecord,
  PublishErrorCode,
  PublisherKind,
  PublishLink,
  PublishProgressEvent,
  PublishResult,
  PublishStage,
  PublishTarget,
} from '../../preload/contract';

// Wire types are owned by the preload contract; re-exported here so publish code has one import site.
export type {
  PublicationRecord,
  PublishErrorCode,
  PublisherKind,
  PublishLink,
  PublishProgressEvent,
  PublishResult,
  PublishStage,
  PublishTarget,
};

/** One file that may leave the machine; produced only by buildPublishFileSet (10 §3.3). */
export interface PublishFile {
  /** Path relative to the document folder, POSIX separators. */
  relPath: string;
  /** Resolved on disk, inside docs/<slug>/. */
  absPath: string;
  bytes: number;
  sha256: string;
}

/** Everything a publisher gets for one publish (10 §3.1). */
export interface PublishContext {
  slug: string;
  /** From CatalogEntry. */
  title: string;
  /** From buildPublishFileSet; publishers MUST NOT add to it. */
  files: readonly PublishFile[];
  /** Read-only snapshot. */
  settings: Settings;
  /** Cancelled when the app quits or the user cancels. */
  signal: AbortSignal;
  progress(stage: PublishStage): void;
}

/** Publisher seam (10 §3.1; HOOK-PUB-01, HOOK-PUB-03). */
export interface Publisher {
  readonly id: string;
  readonly kind: PublisherKind;
  /** Present only on stubs (01 §6.2). */
  readonly stub?: true;
  /** Cheap, no network. Reports availability and configuration state. */
  describe(slug: string, settings: Settings): Promise<PublishTarget>;
  /** Performs the publish. Throws PublishError or NotAvailableInEdition. */
  publish(ctx: PublishContext): Promise<PublishResult>;
}

/** Publish failure (10 §3.2). `detail` is logged, never sent to the renderer. */
export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

// ---------------------------------------------------------------------------
// Secret scanning (10 §5.4)
// ---------------------------------------------------------------------------

export interface SecretFinding {
  relPath: string;
  /** 1-based. */
  line: number;
  /** e.g. "private-key-block", "cloud-access-key-id", "generic-high-entropy". */
  rule: string;
  /** Matched text with all but the first 4 chars masked. */
  preview: string;
}

/** Scanner seam (HOOK-PUB-03 may replace the baseline). */
export interface SecretScanner {
  readonly id: string;
  scan(files: readonly PublishFile[], signal: AbortSignal): Promise<SecretFinding[]>;
}

// ---------------------------------------------------------------------------
// Pre-publish content policy (10 §4 step 5, §9; HOOK-PUB-05)
// ---------------------------------------------------------------------------

export interface PrePublishInput {
  slug: string;
  title: string;
  targetId: string;
  kind: PublisherKind;
  files: readonly PublishFile[];
  settings: Settings;
  signal: AbortSignal;
}

/** `message` is the user-facing wording when a publish is blocked by policy. */
export type PrePublishDecision = { allow: true } | { allow: false; message: string };

/** Runs before `publisher.publish`; the public build registers a no-op that always allows. */
export type PrePublishPolicy = (input: PrePublishInput) => Promise<PrePublishDecision>;

// ---------------------------------------------------------------------------
// Git publisher contract (10 §5.3; bound by HOOK-PUB-03/04, unused in the public build)
// ---------------------------------------------------------------------------

export type GitInvocationMode = 'direct' | 'push-tool' | 'delegate';

export type GitReadinessCheck = 'head-poll' | 'none' | 'redirect-is-deployed' | 'code-host-status';

export interface GitPublisherConfig {
  invocationMode: GitInvocationMode;
  /** Absolute; resolved per "Locating git" when unset. */
  gitPath?: string;
  workspace:
    | { kind: 'app-owned' } // <userData>/publish/git/<repo-hash>/
    | { kind: 'user-clone'; path: string }; // absolute path to an existing clone
  /** Default 120_000 (direct, push-tool). */
  pushTimeoutMs: number;
  /** Default 900_000 (delegate). */
  delegateTimeoutMs: number;
  /** §5.3 step 10; default 'head-poll'. */
  readinessCheck?: GitReadinessCheck;
}

/** Binding-supplied readiness function for `readinessCheck: 'code-host-status'` (§5.3 step 10). */
export type SiteReadinessFn = (ctx: {
  siteUrl: string;
  commitSha: string;
  signal: AbortSignal;
}) => Promise<'deployed' | 'pending' | 'failed'>;

/** Delegate hand-off manifest; never contains a credential (§5.3 delegate protocol). */
export interface GitHandoffManifest {
  schema: 1;
  publicationId: string;
  /** owner/name on the code host. */
  repo: string;
  branch: string;
  docsPath: string;
  slug: string;
  workspacePath: string;
  /** Explicit repo-relative paths, e.g. docs/<slug>/index.html. */
  files: string[];
  deletions: string[];
  commitMessage: string;
  expectedSiteUrl: string;
  resultPath: string;
}

export interface GitHandoffResult {
  schema: 1;
  status: 'pushed' | 'no-changes' | 'secret-found' | 'rejected' | 'error';
  commitSha?: string;
  pushedPaths?: string[];
  findings?: SecretFinding[];
  message?: string;
}
