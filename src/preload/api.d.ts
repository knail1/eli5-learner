import type {
  AppNavigateEvent,
  CycleRegionEvent,
  ApiKeyProvider,
  AuthStatus,
  CatalogEntry,
  ChooseFolderResult,
  ClassifyTextResult,
  CreateSectionEli5Request,
  DeepPartial,
  DocHistoryChangedEvent,
  DocHistoryState,
  DocUpdatedEvent,
  EditionInfo,
  FolderSettingKey,
  HelpTopic,
  IpcResult,
  JobSnapshot,
  LibraryFolder,
  LibraryInfo,
  LibraryLocation,
  LibraryMoveReceipt,
  LibraryOrganization,
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
  TestNotificationResult,
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
    /** Non-http tokens from the URL field (11 §5.4). */
    classifyText(text: string): R<ClassifyTextResult>;
  };
  library: {
    list(): R<CatalogEntry[]>;
    open(slug: string): R<void>;
    reveal(slug: string): R<void>;
    info(): R<LibraryInfo>;
    /** Reveals the Library root in Finder (Settings > Library, 11 §7). */
    revealRoot(): R<void>;
    onChanged(cb: (e: { entries: CatalogEntry[] }) => void): Unsub;
    /** Folders, Archive and Trash (09 §4.2, 11 §5.2). */
    organization(): R<LibraryOrganization>;
    createFolder(name: string): R<LibraryFolder>;
    renameFolder(folderId: string, name: string): R<LibraryFolder>;
    /** Its documents go to the Trash. */
    deleteFolder(folderId: string): R<{ trashed: number }>;
    move(slug: string, to: LibraryLocation, opts?: { undo?: boolean }): R<LibraryMoveReceipt>;
    putBack(trashId: string): R<{ slug: string }>;
    deletePermanently(trashId: string): R<void>;
    emptyTrash(): R<{ deleted: number }>;
    onOrganizationChanged(cb: (e: { organization: LibraryOrganization }) => void): Unsub;
    /** Every move, including those from the native item menu; the sidebar offers Undo. */
    onMoved(cb: (r: LibraryMoveReceipt) => void): Unsub;
  };
  suggestions: {
    list(): R<MergeSuggestion[]>;
    accept(id: string): R<{ targetSlug: string }>;
    dismiss(id: string): R<void>;
    onChanged(cb: (e: { suggestions: MergeSuggestion[] }) => void): Unsub;
  };
  doc: {
    onUpdated(cb: (e: DocUpdatedEvent) => void): Unsub;
    /** One-level undo/redo of a document (09 §4.1): state, swaps, and state pushes. */
    history(slug: string): R<DocHistoryState>;
    undo(slug: string): R<DocHistoryState>;
    redo(slug: string): R<DocHistoryState>;
    onHistoryChanged(cb: (e: DocHistoryChangedEvent) => void): Unsub;
  };
  viewer: {
    setBounds(r: ViewerBounds): R<void>;
    setVisible(v: boolean): R<void>;
    /** F6 into the viewer: main focuses the view's webContents (11 §12). */
    focus(): R<void>;
  };
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
    /** Main shows the folder panel, validates and saves the key (11 §7, §10). */
    chooseFolder(key: FolderSettingKey): R<ChooseFolderResult>;
    /** Main opens the topic's fixed README link or bundled help file (11 §7, HOOK-UI-02). */
    openHelp(topic: HelpTopic): R<void>;
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
    /** F6 / Shift+F6 pressed inside the viewer; the app cycles on from the viewer region. */
    onCycleRegion(cb: (e: CycleRegionEvent) => void): Unsub;
    contextMenu(r: { kind: 'library-item'; slug: string }): R<void>;
    /** 11 §14.7. */
    testNotification(): R<TestNotificationResult>;
    /** Opens System Settings > Notifications (11 §14.6). */
    openNotificationSettings(): R<void>;
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
    /** Test builds only (13 §8.1): enter the input zone as if these paths were dropped. */
    __eli5Test?: { dropPaths(paths: string[]): Promise<void> };
  }
}
