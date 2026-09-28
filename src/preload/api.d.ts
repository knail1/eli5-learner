import type {
  AppNavigateEvent,
  ApiKeyProvider,
  AuthStatus,
  CatalogEntry,
  CreateSectionEli5Request,
  DeepPartial,
  DocUpdatedEvent,
  EditionInfo,
  IpcResult,
  JobSnapshot,
  LibraryInfo,
  MergeSuggestion,
  ModelsResult,
  ProviderId,
  PublicationRecord,
  PublishProgressEvent,
  PublishResult,
  PublishTarget,
  ScrollToEvent,
  SectionActionRequest,
  SectionBusyEvent,
  Settings,
  SettingsDescription,
  SourceInput,
  StartJobRequest,
  TestConnectionResult,
  ViewerBounds,
} from './contract';

type Unsub = () => void;
type R<T> = Promise<IpcResult<T>>;

/** window.eli5 in the app renderer (01 §5.3). */
export interface Eli5Api {
  jobs: {
    start(r: StartJobRequest): R<{ jobId: string }>;
    list(): R<JobSnapshot[]>;
    cancel(jobId: string): R<void>;
    retry(jobId: string): R<void>;
    dismiss(jobId: string): R<void>;
    onChanged(cb: (s: JobSnapshot) => void): Unsub;
  };
  sources: {
    readClipboard(draftId: string): R<SourceInput[]>;
    stageText(draftId: string, text: string, markup: 'plain' | 'html'): R<SourceInput>;
    discard(draftId: string, inputId: string): R<void>;
    discardDraft(draftId: string): R<void>;
  };
  library: {
    list(): R<CatalogEntry[]>;
    open(slug: string): R<void>;
    reveal(slug: string): R<void>;
    info(): R<LibraryInfo>;
    onChanged(cb: (e: { entries: CatalogEntry[] }) => void): Unsub;
  };
  suggestions: {
    list(): R<MergeSuggestion[]>;
    accept(id: string): R<{ targetSlug: string }>;
    dismiss(id: string): R<void>;
    onChanged(cb: (e: { suggestions: MergeSuggestion[] }) => void): Unsub;
  };
  doc: { onUpdated(cb: (e: DocUpdatedEvent) => void): Unsub };
  viewer: { setBounds(r: ViewerBounds): R<void>; setVisible(v: boolean): R<void> };
  llm: {
    testConnection(provider?: ProviderId): R<TestConnectionResult>;
    models(provider: ProviderId): R<ModelsResult>;
  };
  settings: {
    get(): R<Settings>;
    set(p: DeepPartial<Settings>): R<Settings>;
    describe(): R<SettingsDescription>;
    setApiKey(p: ApiKeyProvider, k: string): R<void>;
    hasApiKey(p: ApiKeyProvider): R<boolean>;
    clearApiKey(p: ApiKeyProvider): R<void>;
    onChanged(cb: (e: { changed: string[]; settings: Settings }) => void): Unsub;
  };
  edition: { info(): R<EditionInfo> };
  publish: {
    targets(slug: string): R<PublishTarget[]>;
    run(slug: string, targetId: string): R<PublishResult>;
    history(slug: string): R<PublicationRecord[]>;
    cancel(slug: string, targetId: string): R<void>;
    copyLink(url: string): R<void>;
    openLink(url: string): R<void>;
    reveal(url: string): R<void>;
    onProgress(cb: (e: PublishProgressEvent) => void): Unsub;
  };
  auth: {
    status(): R<AuthStatus>;
    signIn(): R<AuthStatus>;
    signOut(): R<AuthStatus>;
    onChanged(cb: (s: AuthStatus) => void): Unsub;
  };
  app: {
    onNavigate(cb: (e: AppNavigateEvent) => void): Unsub;
    contextMenu(r: { kind: 'library-item'; slug: string }): R<void>;
  };
  /** webUtils.getPathForFile; the single drop-path helper. */
  files: { pathFor(file: File): string };
}

/** window.eli5Doc in the document viewer only (01 §5.3). */
export interface Eli5DocApi {
  regenerateSection(r: Omit<SectionActionRequest, 'slug'>): R<{ jobId: string }>;
  createSectionEli5(r: Omit<CreateSectionEli5Request, 'slug'>): R<{ jobId: string }>;
  closeTab(tabKey: string): R<void>;
  openExternal(url: string): R<void>;
  onScrollTo(cb: (e: ScrollToEvent) => void): Unsub;
  onSectionBusy(cb: (e: SectionBusyEvent) => void): Unsub;
}

declare global {
  interface Window {
    eli5: Eli5Api;
    eli5Doc?: Eli5DocApi;
  }
}
