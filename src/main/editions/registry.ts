import type { Settings } from '../config';
import type { SettingsExtension } from '../config';
import type { LLMProvider, PromptPolicy } from '../llm';
import type { AuthBroker, LaneRule, LaneRouter, McpClient, SourceResolver, StagingPolicy } from '../sources';
import type { Extractor } from '../extract';
import type { LoginSignature, NetworkConfigurator } from '../fetch';
import type { PipelinePolicy } from '../pipeline';
import type { DocTheme, ReferenceFormatter } from '../document';
import type { LibraryPolicy, MergeEligibility } from '../library';
import type { PrePublishPolicy, Publisher, SecretScanner } from '../publish';
import type { UiFeature, EditionInfo } from '../../preload/contract';
import type { Edition } from './types';
import { NotAvailableInEdition } from './errors';

export type { UiFeature, EditionInfo };
export const OVERLAY_API_VERSION = 1;

/** Contract a private overlay module must default-export (01 §6.2). */
export interface EditionOverlay {
  apiVersion: number;
  name: string;
  register(reg: CapabilityRegistry): void | Promise<void>;
}

export interface CapabilityRegistry {
  readonly edition: Edition;

  // Implementations keyed by id (registering an existing id replaces it)
  registerLLMProvider(id: string, factory: (s: Settings) => LLMProvider): void; // HOOK-LLM-01
  registerSourceResolver(r: SourceResolver, opts?: { priority?: number }): void; // HOOK-SRC-01/02
  registerExtractor(e: Extractor): void;
  registerPublisher(id: string, factory: (s: Settings) => Publisher): void; // HOOK-PUB-01/03
  registerAuth(b: AuthBroker): void; // HOOK-AUTH-01
  registerMcpClient(c: McpClient): void; // HOOK-SRC-05

  // Single-slot policies (register replaces the public default)
  registerPromptPolicy(p: PromptPolicy): void; // HOOK-LLM-02
  registerLaneRules(rules: LaneRule[]): void; // HOOK-SRC-03
  registerLaneRouter(r: LaneRouter): void; // HOOK-SRC-03
  registerStagingPolicy(p: StagingPolicy): void; // HOOK-SRC-04
  registerNetworkConfigurator(fn: NetworkConfigurator): void; // HOOK-FETCH-01
  registerLoginSignatures(sigs: LoginSignature[]): void; // HOOK-FETCH-02
  registerPipelinePolicy(p: PipelinePolicy): void; // HOOK-PIPE-01
  registerDocTheme(t: DocTheme): void; // HOOK-DOC-01
  registerReferenceFormatter(fn: ReferenceFormatter): void; // HOOK-DOC-02
  registerLibraryPolicy(p: LibraryPolicy): void; // HOOK-LIB-01
  registerMergeEligibility(fn: MergeEligibility): void; // HOOK-LIB-02
  registerSecretScanner(s: SecretScanner): void; // HOOK-PUB-03
  registerPrePublishPolicy(fn: PrePublishPolicy): void; // HOOK-PUB-05
  registerSettingsExtension(ext: SettingsExtension): void; // HOOK-CFG-01
  enableUiFeatures(f: UiFeature[]): void; // HOOK-UI-01
  /** Lane-rule builder the sources module installs so registerLaneRules can build a router. */
  setLaneRouterFactory(fn: (rules: readonly LaneRule[]) => LaneRouter): void;

  // Lookups
  llm(): LLMProvider;
  resolvers(): readonly SourceResolver[];
  extractors(): readonly Extractor[];
  publisher(id: string): Publisher;
  publishers(): readonly { id: string; available: boolean }[];
  auth(): AuthBroker;
  mcp(): McpClient | undefined;
  promptPolicy(): PromptPolicy;
  laneRules(): readonly LaneRule[];
  laneRouter(): LaneRouter;
  stagingPolicy(): StagingPolicy;
  networkConfigurator(): NetworkConfigurator;
  loginSignatures(): readonly LoginSignature[];
  pipelinePolicy(): PipelinePolicy;
  docTheme(): DocTheme;
  referenceFormatter(): ReferenceFormatter;
  libraryPolicy(): LibraryPolicy;
  mergeEligibility(): MergeEligibility;
  secretScanner(): SecretScanner;
  prePublishPolicy(): PrePublishPolicy;
  settingsExtension(): SettingsExtension | undefined;
  info(): EditionInfo;
  freeze(): void;
  readonly frozen: boolean;
}

/** Stubs carry `readonly stub = true` (01 §6.2). */
function isStub(x: unknown): boolean {
  return typeof x === 'object' && x !== null && (x as { stub?: unknown }).stub === true;
}

/** Default priorities (01 §6.2 "Resolver order"). A new id without a priority gets 25. */
const DEFAULT_RESOLVER_PRIORITY: Record<string, number> = {
  ticket: 40,
  mcp: 30,
  url: 20,
  file: 10,
  clipboard: 10,
};
const NEW_RESOLVER_PRIORITY = 25;

type Slot =
  | 'promptPolicy'
  | 'laneRouter'
  | 'stagingPolicy'
  | 'networkConfigurator'
  | 'pipelinePolicy'
  | 'docTheme'
  | 'referenceFormatter'
  | 'libraryPolicy'
  | 'mergeEligibility'
  | 'secretScanner'
  | 'prePublishPolicy'
  | 'auth';

export interface RegistryOptions {
  edition: Edition;
  /** Returns the current settings snapshot; used by llm() and publisher(). */
  getSettings: () => Settings;
  /** Called when an id is replaced; for logging (IDs only). */
  onReplace?: (kind: string, id: string) => void;
  /** app.getVersion(), reported in EditionInfo.version (11 §7 About). */
  appVersion?: string;
}

export class Registry implements CapabilityRegistry {
  readonly edition: Edition;
  private readonly appVersion: string;
  private readonly getSettings: () => Settings;
  private readonly onReplace: (kind: string, id: string) => void;
  private isFrozen = false;
  private overlayName: string | undefined;

  private readonly llmFactories = new Map<string, (s: Settings) => LLMProvider>();
  private readonly llmCache = new Map<string, LLMProvider>();
  private readonly resolverList: { r: SourceResolver; priority: number; order: number }[] = [];
  private resolverSeq = 0;
  private readonly extractorList: Extractor[] = [];
  private readonly publisherFactories = new Map<string, (s: Settings) => Publisher>();
  private readonly slots = new Map<Slot, unknown>();
  private rules: LaneRule[] = [];
  private routerFactory: ((rules: readonly LaneRule[]) => LaneRouter) | undefined;
  private customRouter = false;
  private signatures: LoginSignature[] = [];
  private mcpClient: McpClient | undefined;
  private extension: SettingsExtension | undefined;
  private uiFeatures = new Set<UiFeature>();

  constructor(opts: RegistryOptions) {
    this.edition = opts.edition;
    this.getSettings = opts.getSettings;
    this.onReplace = opts.onReplace ?? (() => {});
    this.appVersion = opts.appVersion ?? '0.0.0';
  }

  get frozen(): boolean {
    return this.isFrozen;
  }

  setOverlayName(name: string): void {
    this.assertOpen();
    this.overlayName = name;
  }

  private assertOpen(): void {
    if (this.isFrozen) throw new Error('Capability registry is frozen; register during bootstrap only');
  }

  private setSlot(slot: Slot, value: unknown): void {
    this.assertOpen();
    if (this.slots.has(slot)) this.onReplace('slot', slot);
    this.slots.set(slot, value);
  }

  private getSlot<T>(slot: Slot): T {
    if (!this.slots.has(slot)) throw new Error(`Registry slot "${slot}" has no registration`);
    return this.slots.get(slot) as T;
  }

  // ---- implementations ----

  registerLLMProvider(id: string, factory: (s: Settings) => LLMProvider): void {
    this.assertOpen();
    if (this.llmFactories.has(id)) this.onReplace('llm', id);
    this.llmFactories.set(id, factory);
    this.llmCache.delete(id);
  }

  registerSourceResolver(r: SourceResolver, opts?: { priority?: number }): void {
    this.assertOpen();
    const idx = this.resolverList.findIndex((e) => e.r.id === r.id);
    if (idx >= 0) {
      const prev = this.resolverList[idx]!;
      this.onReplace('resolver', r.id);
      this.resolverList[idx] = { r, priority: opts?.priority ?? prev.priority, order: prev.order };
      return;
    }
    const priority = opts?.priority ?? DEFAULT_RESOLVER_PRIORITY[r.id] ?? NEW_RESOLVER_PRIORITY;
    this.resolverList.push({ r, priority, order: this.resolverSeq++ });
  }

  registerExtractor(e: Extractor): void {
    this.assertOpen();
    const idx = this.extractorList.findIndex((x) => x.id === e.id);
    if (idx >= 0) {
      this.onReplace('extractor', e.id);
      this.extractorList[idx] = e;
    } else {
      this.extractorList.push(e);
    }
  }

  registerPublisher(id: string, factory: (s: Settings) => Publisher): void {
    this.assertOpen();
    if (this.publisherFactories.has(id)) this.onReplace('publisher', id);
    this.publisherFactories.set(id, factory);
  }

  registerAuth(b: AuthBroker): void {
    this.setSlot('auth', b);
  }

  registerMcpClient(c: McpClient): void {
    this.assertOpen();
    this.mcpClient = c;
  }

  // ---- single-slot policies ----

  registerPromptPolicy(p: PromptPolicy): void {
    this.setSlot('promptPolicy', p);
  }
  registerLaneRules(rules: LaneRule[]): void {
    this.assertOpen();
    this.rules = [...rules];
  }
  registerLaneRouter(r: LaneRouter): void {
    this.setSlot('laneRouter', r);
    this.customRouter = true;
  }
  setLaneRouterFactory(fn: (rules: readonly LaneRule[]) => LaneRouter): void {
    this.assertOpen();
    this.routerFactory = fn;
  }
  registerStagingPolicy(p: StagingPolicy): void {
    this.setSlot('stagingPolicy', p);
  }
  registerNetworkConfigurator(fn: NetworkConfigurator): void {
    this.setSlot('networkConfigurator', fn);
  }
  registerLoginSignatures(sigs: LoginSignature[]): void {
    this.assertOpen();
    this.signatures.push(...sigs);
  }
  registerPipelinePolicy(p: PipelinePolicy): void {
    this.setSlot('pipelinePolicy', p);
  }
  registerDocTheme(t: DocTheme): void {
    this.setSlot('docTheme', t);
  }
  registerReferenceFormatter(fn: ReferenceFormatter): void {
    this.setSlot('referenceFormatter', fn);
  }
  registerLibraryPolicy(p: LibraryPolicy): void {
    this.setSlot('libraryPolicy', p);
  }
  registerMergeEligibility(fn: MergeEligibility): void {
    this.setSlot('mergeEligibility', fn);
  }
  registerSecretScanner(s: SecretScanner): void {
    this.setSlot('secretScanner', s);
  }
  registerPrePublishPolicy(fn: PrePublishPolicy): void {
    this.setSlot('prePublishPolicy', fn);
  }
  registerSettingsExtension(ext: SettingsExtension): void {
    this.assertOpen();
    if (this.extension) throw new Error('Only one SettingsExtension may be registered (12 §8.2)');
    this.extension = ext;
  }
  enableUiFeatures(f: UiFeature[]): void {
    this.assertOpen();
    for (const x of f) this.uiFeatures.add(x);
  }

  // ---- lookups ----

  llm(): LLMProvider {
    const s = this.getSettings();
    const id = s.llm.provider;
    const factory = this.llmFactories.get(id);
    if (!factory) throw new NotAvailableInEdition(`llm:${id}`, 'HOOK-LLM-01', this.edition);
    let p = this.llmCache.get(id);
    if (!p) {
      p = factory(s);
      this.llmCache.set(id, p);
    }
    return p;
  }

  /** Drop cached providers (02 invalidates on llm.* settings or key changes). */
  invalidateLLM(): void {
    this.llmCache.clear();
  }

  resolvers(): readonly SourceResolver[] {
    return [...this.resolverList].sort((a, b) => b.priority - a.priority || a.order - b.order).map((e) => e.r);
  }

  extractors(): readonly Extractor[] {
    return [...this.extractorList];
  }

  publisher(id: string): Publisher {
    const f = this.publisherFactories.get(id);
    if (!f) throw new NotAvailableInEdition(`publisher:${id}`, 'HOOK-PUB-01', this.edition);
    return f(this.getSettings());
  }

  publishers(): readonly { id: string; available: boolean }[] {
    const s = this.getSettings();
    return [...this.publisherFactories.entries()].map(([id, f]) => ({ id, available: !isStub(f(s)) }));
  }

  auth(): AuthBroker {
    return this.getSlot('auth');
  }
  mcp(): McpClient | undefined {
    return this.mcpClient;
  }
  promptPolicy(): PromptPolicy {
    return this.getSlot('promptPolicy');
  }
  laneRules(): readonly LaneRule[] {
    return this.rules;
  }
  laneRouter(): LaneRouter {
    if (this.customRouter) return this.getSlot('laneRouter');
    if (!this.routerFactory) throw new Error('No lane router factory registered (sources module)');
    return this.routerFactory(this.rules);
  }
  stagingPolicy(): StagingPolicy {
    return this.getSlot('stagingPolicy');
  }
  networkConfigurator(): NetworkConfigurator {
    return this.getSlot('networkConfigurator');
  }
  loginSignatures(): readonly LoginSignature[] {
    return this.signatures;
  }
  pipelinePolicy(): PipelinePolicy {
    return this.getSlot('pipelinePolicy');
  }
  docTheme(): DocTheme {
    return this.getSlot('docTheme');
  }
  referenceFormatter(): ReferenceFormatter {
    return this.getSlot('referenceFormatter');
  }
  libraryPolicy(): LibraryPolicy {
    return this.getSlot('libraryPolicy');
  }
  mergeEligibility(): MergeEligibility {
    return this.getSlot('mergeEligibility');
  }
  secretScanner(): SecretScanner {
    return this.getSlot('secretScanner');
  }
  prePublishPolicy(): PrePublishPolicy {
    return this.getSlot('prePublishPolicy');
  }
  settingsExtension(): SettingsExtension | undefined {
    return this.extension;
  }

  /** Slots that have no registration; empty after registerPublicCapabilities (tested). */
  missingSlots(): string[] {
    const all: Slot[] = [
      'promptPolicy',
      'stagingPolicy',
      'networkConfigurator',
      'pipelinePolicy',
      'docTheme',
      'referenceFormatter',
      'libraryPolicy',
      'mergeEligibility',
      'secretScanner',
      'prePublishPolicy',
      'auth',
    ];
    const missing: string[] = all.filter((s) => !this.slots.has(s));
    if (!this.customRouter && !this.routerFactory) missing.push('laneRouter');
    return missing;
  }

  info(): EditionInfo {
    const s = this.getSettings();
    const llmProviders = [...this.llmFactories.entries()].map(([id, f]) => {
      let available = false;
      try {
        available = !isStub(this.llmCache.get(id) ?? f(s));
      } catch {
        available = false;
      }
      return { id, available };
    });
    let authAvailable = false;
    try {
      authAvailable = this.auth().status().state !== 'unavailable';
    } catch {
      authAvailable = false;
    }
    return {
      edition: this.edition,
      version: this.appVersion,
      overlayLoaded: this.overlayName !== undefined,
      ...(this.overlayName !== undefined ? { overlayName: this.overlayName } : {}),
      llmProviders,
      publishers: [...this.publishers()],
      uiFeatures: [...this.uiFeatures],
      authAvailable,
    };
  }

  freeze(): void {
    this.isFrozen = true;
  }
}
