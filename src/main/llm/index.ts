// Public API of the LLM module (02). FakeProvider is imported from './testing/fake' directly
// so package-mode bundles never contain it (13 §6.1).
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
} from './types';
export { PROMPT_IDS } from './types';
export { LLMError } from './errors';
export { DEFAULT_MODELS, fallbackLimits } from './models';
export { BedrockProvider, createBedrockProvider } from './bedrock.stub';
export { createClaudeProvider } from './claude';
export { createOpenAIProvider } from './openai';
export { defaultPromptPolicy } from './policy';
export { registerPublic } from './register';
export * from './schemas/draft';
