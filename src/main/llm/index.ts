// Public API of the LLM module (02). FakeProvider and cassetteFetch live under './testing/' (test
// entry `llm/testing`, 01 §6.5) so package-mode bundles never contain them (13 §6.1).
export type {
  ProviderId,
  PromptId,
  ImageInput,
  ChatMessage,
  GenerationRequest,
  GenerationResult,
  TokenUsage,
  StreamChunk,
  ModelLimits,
  ConnectionCheck,
  LLMProvider,
  PromptPolicy,
  LLMErrorKind,
  TestConnectionResult,
  ModelsResult,
  CredentialStatus,
} from './types';
export { PROMPT_IDS } from './types';
export { LLMError } from './errors';
export { DEFAULT_MODELS, MODEL_LIMITS, fallbackLimits, limitsFor, suggestedModels } from './models';
export { BedrockProvider, createBedrockProvider } from './bedrock.stub';
export { ClaudeProvider, createClaudeProvider } from './claude';
export { OpenAIProvider, createOpenAIProvider } from './openai';
export type { ProviderDeps } from './base';
export { createProvider } from './factory';
export { configureLlmRuntime, llmRuntime, resetLlmRuntime } from './runtime';
export type { LlmRuntime } from './runtime';
export { DEFAULT_RETRY, classifyError, parseRetryAfter, retryPolicyFromPipeline, withRetry } from './retry';
export type { RetryPolicy } from './retry';
export { Limiter } from './limiter';
export { DEFAULT_TIMEOUTS } from './timeouts';
export type { TimeoutOptions } from './timeouts';
export { createLlmFetch, LLM_SESSION_PARTITION } from './net';
export { estimateTokens, imageTokens, inputBudget, reservedOutput, visibleOutput } from './budget';
export { createNativeImageReencoder } from './images';
export type { ImageReencoder } from './images';
export {
  DEFAULT_PROMPT_SET,
  FRAGMENT_IDS,
  FRAGMENT_VARS,
  PROMPT_SET_RE,
  PROMPT_VARS,
  PromptCatalogue,
  PromptError,
} from './prompts';
export type { CatalogueOptions, FragmentDef, FragmentId, PromptDef, PromptOrigin } from './prompts';
export { SkillLibrary, SKILL_SLOTS } from './skills';
export type { Skill, SkillTexts } from './skills';
export { generateStructured, validateDraft, OutputTruncated, usageOf } from './structured';
export { createTasks, deserializePrepared, serializePrepared, sectionText, MODEL_ERROR_WHILE_READING } from './tasks';
export type {
  LlmTasks,
  MergeCandidate,
  PhotoPickSlot,
  MergeWeaveInput,
  PreparedContent,
  PreparedContentJson,
  SectionAction,
  SectionActionInput,
  SectionAskInput,
  StepCtx,
  StepResult,
  SteLintSummary,
  SteStepDraft,
  Eli5CritiqueResult,
  TaskDeps,
} from './tasks';
export { resolveSte, steInputJson, indepthOutline, KEEPABLE_TYPES, SteResolveError } from './ste';
export type { ResolvedSte, SteOrigin } from './ste';
export { lintSte, steFindingsText, STE_REPAIR_THRESHOLD } from './lint/ste-lint';
export type { SteFinding, SteLintResult } from './lint/ste-lint';
export {
  lintEli5,
  eli5FindingsText,
  critiqueGate,
  critiquable,
  countVisuals,
  CRITIQUE_MIN_SECTIONS,
} from './lint/eli5-lint';
export type { CritiqueGateResult, Eli5Finding, Eli5LintResult } from './lint/eli5-lint';
export { defaultPromptPolicy } from './policy';
export { registerPublic } from './register';
export * from './schemas/draft';
