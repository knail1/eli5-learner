/**
 * IPC contract (01 §5). The only location for types shared with renderers; types and string
 * constants only, no runtime dependencies. Main modules re-export the payload types they own.
 */
import type { Settings, DeepPartial, ProviderId } from '../main/config/schema';

export type { Settings, DeepPartial, ProviderId };

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type IpcErrorCode =
  | 'E_BAD_REQUEST'
  | 'E_FORBIDDEN'
  | 'E_NOT_FOUND'
  | 'E_NOT_AVAILABLE_IN_EDITION'
  | 'E_NO_API_KEY'
  | 'E_LLM_UNAVAILABLE'
  | 'E_RATE_LIMITED'
  | 'E_IO'
  | 'E_CONFLICT'
  | 'E_INTERNAL'
  // settings and Keychain (12)
  | 'E_SETTINGS_INVALID'
  | 'E_SETTINGS_LOCKED'
  | 'E_SECRET_IN_SETTINGS'
  | 'E_SETTINGS_IO'
  | 'E_KEY_FORMAT'
  | 'E_KEYCHAIN_UNAVAILABLE'
  // library (09)
  | 'E_LIBRARY_READ_ONLY'
  | 'E_SUGGESTION_STALE'
  | 'E_MERGE_FAILED'
  // publish (10): the PublishErrorCode travels in detailCode
  | 'E_PUBLISH_FAILED';

export interface IpcError {
  code: IpcErrorCode;
  /** Human readable, safe to show in the status area. */
  message: string;
  /** Optional finer module code (e.g. a PublishErrorCode); never secret. */
  detailCode?: string;
  /** Set for E_NOT_AVAILABLE_IN_EDITION. */
  capability?: string;
  /** Set for E_NOT_AVAILABLE_IN_EDITION, e.g. "HOOK-PUB-01". Never shown to users. */
  hookId?: string;
  /** Validation issues for E_SETTINGS_INVALID / E_BAD_REQUEST (paths only). */
  issues?: { path: string; message: string }[];
  /** Non-fatal warnings (e.g. unexpected API key prefix). */
  warnings?: string[];
  /** Masked secret-scanner findings for detailCode E_PUBLISH_SECRET_FOUND (10 §7 step 5). */
  findings?: SecretFinding[];
}

export type IpcResult<T> = { ok: true; value: T; warnings?: string[] } | { ok: false; error: IpcError };

// ---------------------------------------------------------------------------
// Channels (01 §5.2). This table is the complete v1 registry.
// ---------------------------------------------------------------------------

export const IPC = {
  jobs: {
    start: 'eli5:jobs:start',
    list: 'eli5:jobs:list',
    cancel: 'eli5:jobs:cancel',
    retry: 'eli5:jobs:retry',
    dismiss: 'eli5:jobs:dismiss',
    changed: 'eli5:jobs:changed',
  },
  sources: {
    readClipboard: 'eli5:sources:read-clipboard',
    stageText: 'eli5:sources:stage-text',
    discard: 'eli5:sources:discard',
    discardDraft: 'eli5:sources:discard-draft',
    classifyText: 'eli5:sources:classify-text',
    /** Preload-only: paths of a trusted native drop, so jobs:start can refuse forged paths (06 §11). */
    registerDrop: 'eli5:sources:register-drop',
  },
  auth: {
    status: 'eli5:auth:status',
    signIn: 'eli5:auth:sign-in',
    signOut: 'eli5:auth:sign-out',
    changed: 'eli5:auth:changed',
  },
  llm: {
    testConnection: 'eli5:llm:test-connection',
    models: 'eli5:llm:models',
  },
  library: {
    list: 'eli5:library:list',
    open: 'eli5:library:open',
    reveal: 'eli5:library:reveal',
    info: 'eli5:library:info',
    revealRoot: 'eli5:library:reveal-root',
    changed: 'eli5:library:changed',
  },
  suggestions: {
    list: 'eli5:suggestions:list',
    accept: 'eli5:suggestions:accept',
    dismiss: 'eli5:suggestions:dismiss',
    changed: 'eli5:suggestions:changed',
  },
  doc: {
    regenerateSection: 'eli5:doc:regenerate-section',
    createSectionEli5: 'eli5:doc:create-section-eli5',
    closeTab: 'eli5:doc:close-tab',
    updated: 'eli5:doc:updated',
    scrollTo: 'eli5:doc:scroll-to',
    sectionBusy: 'eli5:doc:section-busy',
    /** App-only (01 §5.2): the one-level undo/redo of a document (09 §4.1). */
    history: 'eli5:doc:history',
    undo: 'eli5:doc:undo',
    redo: 'eli5:doc:redo',
    historyChanged: 'eli5:doc:history-changed',
  },
  viewer: {
    setBounds: 'eli5:viewer:set-bounds',
    setVisible: 'eli5:viewer:set-visible',
    openExternal: 'eli5:viewer:open-external',
    focus: 'eli5:viewer:focus',
  },
  app: {
    navigate: 'eli5:app:navigate',
    cycleRegion: 'eli5:app:cycle-region',
    contextMenu: 'eli5:app:context-menu',
    testNotification: 'eli5:app:test-notification',
    openNotificationSettings: 'eli5:app:open-notification-settings',
  },
  test: {
    trayClick: 'eli5:test:tray-click',
  },
  settings: {
    get: 'eli5:settings:get',
    set: 'eli5:settings:set',
    setApiKey: 'eli5:settings:set-api-key',
    hasApiKey: 'eli5:settings:has-api-key',
    clearApiKey: 'eli5:settings:clear-api-key',
    describe: 'eli5:settings:describe',
    chooseFolder: 'eli5:settings:choose-folder',
    openHelp: 'eli5:settings:open-help',
    changed: 'eli5:settings:changed',
  },
  edition: {
    info: 'eli5:edition:info',
  },
  publish: {
    targets: 'eli5:publish:targets',
    run: 'eli5:publish:run',
    progress: 'eli5:publish:progress',
    history: 'eli5:publish:history',
    cancel: 'eli5:publish:cancel',
    copyLink: 'eli5:publish:copy-link',
    openLink: 'eli5:publish:open-link',
    reveal: 'eli5:publish:reveal',
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];
export type IpcChannel = Leaves<typeof IPC>;

/** Which renderer may invoke a channel (01 §5.1, 12 §7.2 step 6). */
export type IpcSurface = 'app' | 'viewer';

/** Channels invoked by the document viewer; everything else invokable is app-only. */
export const VIEWER_CHANNELS: readonly IpcChannel[] = [
  IPC.doc.regenerateSection,
  IPC.doc.createSectionEli5,
  IPC.doc.closeTab,
  IPC.viewer.openExternal,
];

// ---------------------------------------------------------------------------
// Edition (01 §6.2)
// ---------------------------------------------------------------------------

export type Edition = 'public' | 'enterprise';
export type UiFeature = 'publish.drive' | 'publish.git' | 'auth.signIn';

export interface EditionInfo {
  edition: Edition;
  /** App version (app.getVersion()), shown in Settings > About (11 §7). */
  version: string;
  overlayLoaded: boolean;
  /** Display name supplied by the overlay (HOOK-UI-02). */
  overlayName?: string;
  llmProviders: { id: string; available: boolean }[];
  publishers: { id: string; available: boolean }[];
  uiFeatures: UiFeature[];
  authAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Settings (12 §5)
// ---------------------------------------------------------------------------

export interface SettingsDescription {
  keys: {
    path: string;
    dormant: boolean;
    locked: boolean;
    source: 'default' | 'extension' | 'user' | 'managed';
  }[];
  loadIssues: { path: string; reason: 'invalid' | 'secret-removed' | 'unknown-dropped' | 'corrupt-file' }[];
  keychain: { available: boolean };
}

export type ApiKeyProvider = 'claude' | 'openai';

/** Settings keys that `eli5:settings:choose-folder` may set (11 §10). */
export type FolderSettingKey = 'publish.local.dir';

/** `eli5:settings:choose-folder` result: main showed the panel, validated and saved the key. */
export type ChooseFolderResult = { path: string } | { cancelled: true };

/**
 * `eli5:settings:open-help` topics (11 §7 Publishing and About, HOOK-UI-02): the public README,
 * the bundled Pages help page (10 §8) and the bundled skills' license notices. Main maps each topic
 * to a fixed URL or file; the renderer never names a path.
 */
export type HelpTopic = 'readme' | 'publish-pages' | 'licenses';

// ---------------------------------------------------------------------------
// Sources and auth (03)
// ---------------------------------------------------------------------------

export type SourceOrigin = 'drop' | 'paste' | 'url-field' | 'picker';

export interface FileSnapshot {
  /** <userData>/jobs/<jobId>/inputs/<index>-<basename>, when size ≤ 200 MB. */
  copyPath?: string;
  sizeBytes: number;
  mtimeMs: number;
}

export type SourceInput =
  | { id: string; kind: 'file'; origin: SourceOrigin; path: string; snapshot?: FileSnapshot }
  | { id: string; kind: 'url'; origin: SourceOrigin; url: string }
  | { id: string; kind: 'text'; origin: 'paste'; stagedPath: string; markup: 'plain' | 'html'; preview: string }
  | { id: string; kind: 'image'; origin: 'paste'; stagedPath: string; mediaType: 'image/png'; preview: string };

/** `eli5:sources:register-drop` result: main's opaque id for one dropped path (06 §11). */
export interface DropRegistration {
  inputId: string;
  path: string;
}

/** `eli5:sources:classify-text` (11 §5.4): non-http tokens from the URL field. */
export interface ClassifyTextResult {
  kind: 'url' | 'bare' | 'invalid';
  label: string;
}

export type AuthState = 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in' | 'expired' | 'error';

export interface AuthStatus {
  state: AuthState;
  /** Display name only, as reported by the MCP server; never a token. */
  account?: string;
  detail?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Jobs (06)
// ---------------------------------------------------------------------------

export type JobId = string;
export type JobStatus = 'queued' | 'reading' | 'extracting' | 'generating' | 'saving' | 'done' | 'failed';
export type JobKind = 'create' | 'section';

export interface JobOptions {
  /** '' when the user typed nothing. */
  clarifyingInput: string;
  /** Per-job toggle; default from settings glossary.defaultOn. */
  glossary: boolean;
}

export interface StartJobRequest {
  inputs: SourceInput[];
  options: JobOptions;
  /** Draft whose staged pastes these inputs reference (03 §13). */
  draftId?: string;
}

export type JobFailureCode =
  | 'NO_USABLE_CONTENT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_AUTH'
  | 'SAVE_FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'INTERNAL'
  | 'SECTION_TOO_LARGE'
  | 'SECTION_GONE'
  | 'SECTION_CHANGED'
  | 'DOC_GONE'
  | 'TOO_MANY_TABS';

export interface JobResultRef {
  docId: string;
  topicSlug: string;
  title: string;
}

export interface JobSnapshot {
  id: JobId;
  kind: JobKind;
  status: JobStatus;
  statusLine: string;
  createdAt: string;
  finishedAt?: string;
  queuePosition?: number;
  result?: JobResultRef;
  failureCode?: JobFailureCode;
  skippedCount: number;
  canCancel: boolean;
  canRetry: boolean;
  canDismiss: boolean;
}

// ---------------------------------------------------------------------------
// Library and suggestions (09)
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  id: string;
  title: string;
  topicSlug: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  summarySource: 'llm' | 'fallback';
  tabCount: number;
  mergedFromCount: number;
}

export interface LibraryInfo {
  root: string;
  readOnly: boolean;
  readOnlyReason?: string;
  count: number;
}

export type MergeSuggestionStatus = 'pending' | 'accepting' | 'accepted' | 'dismissed' | 'stale';

export interface MergeSuggestion {
  id: string;
  createdAt: string;
  status: MergeSuggestionStatus;
  source: { id: string; slug: string; title: string };
  target: { id: string; slug: string; title: string };
  score: number;
  reason: string;
  scorer: 'lexical+llm' | 'embedding+llm';
  resolvedAt?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Documents and viewer (07, 08, 11)
// ---------------------------------------------------------------------------

/** /^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/ (07 §4). */
export type SectionId = string & { readonly __brand: 'SectionId' };

export type SectionAction = 'expand' | 'reexplain' | 'analogy' | 'deeper';
export type MenuAction = SectionAction | 'eli5-tab';

export interface SectionActionRequest {
  /** Filled by the doc preload from the loaded URL, never by the page. */
  slug: string;
  tabKey: string;
  sectionId: SectionId;
  action: SectionAction;
  selectionText: string;
  note?: string;
}

export type CreateSectionEli5Request = Omit<SectionActionRequest, 'action'>;

/** `eli5:doc:close-tab` (08 §3): Section ELI5 tabs only. */
export interface CloseTabRequest {
  slug: string;
  tabKey: string;
}

export interface ScrollToEvent {
  sectionId?: SectionId;
  tabKey?: string;
  flash: boolean;
  loadSeq: number;
}

export interface SectionBusyEvent {
  busy: { sectionId: SectionId; action: MenuAction }[];
  /** Inline notices for section jobs that just failed (08 §9); shown once under the section heading. */
  notices?: { sectionId: SectionId; message: string }[];
}

export interface DocUpdatedEvent {
  slug: string;
  sectionId?: SectionId;
  tabKey?: string;
}

/**
 * A document's one-level undo/redo (09 §4.1): the single prior version is either older (undo) or
 * newer (redo) than the live one. Labels name the change the swap would undo or redo, e.g.
 * "re-explained 'The particular…'". `busy`: a section job for the document is queued or running,
 * so undo and redo are refused (08 §8.1).
 */
export interface DocHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  busy?: boolean;
}

/** `eli5:doc:history-changed` (M→R). */
export interface DocHistoryChangedEvent {
  slug: string;
  state: DocHistoryState;
}

export interface ViewerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SettingsSection = 'ai' | 'documents' | 'library' | 'publishing' | 'notifications' | 'about' | 'enterprise';

/** `eli5:app:test-notification` (11 §14.7). */
export interface TestNotificationResult {
  shown: boolean;
  reason?: 'disabled' | 'unsupported';
}

export type UiRoute =
  | { view: 'welcome' }
  | { view: 'doc'; slug: string }
  | { view: 'not-found'; slug: string }
  | { view: 'settings'; section?: SettingsSection };

export interface AppNavigateEvent {
  route: UiRoute;
}

/** F6 (1) or Shift+F6 (-1) pressed while the viewer had focus (11 §12 viewer focus handoff). */
export interface CycleRegionEvent {
  dir: 1 | -1;
}

// ---------------------------------------------------------------------------
// LLM (02)
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
  ok: boolean;
  model?: string;
  message?: string;
}

export interface ModelsResult {
  suggested: string[];
  default: string;
}

// ---------------------------------------------------------------------------
// Publish (10)
// ---------------------------------------------------------------------------

export type PublisherKind = 'local' | 'drive' | 'git';

export type PublishStage =
  'preparing' | 'scanning' | 'uploading' | 'sharing' | 'committing' | 'pushing' | 'waiting-for-site' | 'done';

export type PublishErrorCode =
  | 'E_PUBLISH_NOT_CONFIGURED'
  | 'E_PUBLISH_SIGN_IN_REQUIRED'
  | 'E_PUBLISH_SECRET_FOUND'
  | 'E_PUBLISH_DESTINATION'
  | 'E_PUBLISH_CONFLICT'
  | 'E_PUBLISH_CANCELLED'
  | 'E_PUBLISH_FAILED';

/** One secret-scanner hit (10 §5.4); `preview` is already masked. */
export interface SecretFinding {
  relPath: string;
  /** 1-based. */
  line: number;
  /** e.g. "private-key-block", "cloud-access-key-id", "generic-high-entropy". */
  rule: string;
  /** Matched text with all but the first 4 chars masked. */
  preview: string;
}

export interface PublicationRecord {
  targetId: string;
  kind: PublisherKind;
  publishedAt: string;
  primaryUrl: string;
  /** sha256 of index.html at publish time. */
  contentSha256: string;
}

export interface PublishTarget {
  id: string;
  kind: PublisherKind;
  label: string;
  available: boolean;
  /** Human readable, e.g. "Not configured" (never a hook ID). */
  unavailableReason?: string;
  destinationPreview?: string;
  requiresSignIn: boolean;
  lastPublished?: PublicationRecord;
  /** Set with lastPublished: index.html's sha256 differs from its contentSha256 (10 §4). */
  changedSincePublish?: boolean;
}

export interface PublishLink {
  kind: 'file' | 'share' | 'site' | 'commit';
  url: string;
  label: string;
  primary: boolean;
}

export interface PublishResult {
  targetId: string;
  kind: PublisherKind;
  slug: string;
  publishedAt: string;
  files: string[];
  links: PublishLink[];
  warnings: string[];
  commit?: { sha: string; branch: string };
  sharing?: { scope: 'organization' | 'owner' | 'custom'; description: string };
}

export interface PublishProgressEvent {
  slug: string;
  targetId: string;
  stage: PublishStage | 'failed';
  result?: PublishResult;
  /** On 'failed': code E_PUBLISH_FAILED with the PublishErrorCode in detailCode (10 §6). */
  error?: IpcError;
}
