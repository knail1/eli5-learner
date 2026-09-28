import type { ProviderId } from '../config';
import { DEFAULT_MODELS } from '../config';
import type { ModelLimits } from './types';

export { DEFAULT_MODELS };

/**
 * Per-model limits (02 §5, §6, §8.2). Defaults are pinned per release in config's DEFAULT_MODELS;
 * nothing else hard-codes a model id. Unknown ids fall back to `fallbackLimits` (conservative).
 */

const MB = 1024 * 1024;

/** Current Claude rows: sampling params rejected (400), effort supported, adaptive thinking. */
const claudeCurrent = (contextTokens: number, maxOutputTokens: number): ModelLimits => ({
  contextTokens,
  maxOutputTokens,
  supportsImages: true,
  maxImagesPerRequest: 100,
  maxImageBytes: 5 * MB,
  supportsTemperature: false,
  supportsEffort: true,
  thinkingReserveTokens: 16_000,
  systemRole: 'system',
  structuredMode: 'output_config',
});

/** OpenAI reasoning rows: developer role, no temperature, reasoning_effort. */
const openaiReasoning = (contextTokens: number, maxOutputTokens: number): ModelLimits => ({
  contextTokens,
  maxOutputTokens,
  supportsImages: true,
  maxImagesPerRequest: 50,
  maxImageBytes: 20 * MB,
  supportsTemperature: false,
  supportsEffort: true,
  thinkingReserveTokens: 16_000,
  systemRole: 'developer',
  structuredMode: 'json_schema_strict',
});

const openaiChat = (contextTokens: number, maxOutputTokens: number): ModelLimits => ({
  ...openaiReasoning(contextTokens, maxOutputTokens),
  supportsTemperature: true,
  supportsEffort: false,
  thinkingReserveTokens: 0,
  systemRole: 'system',
});

export const MODEL_LIMITS: Readonly<Record<Exclude<ProviderId, 'bedrock'>, Readonly<Record<string, ModelLimits>>>> = {
  claude: {
    'claude-opus-5-5': claudeCurrent(1_000_000, 128_000),
    'claude-opus-5': claudeCurrent(1_000_000, 128_000),
    'claude-fable-5-1': claudeCurrent(1_000_000, 128_000),
    'claude-fable-5': claudeCurrent(1_000_000, 128_000),
    'claude-sonnet-5': claudeCurrent(1_000_000, 128_000),
    'claude-opus-4-8': claudeCurrent(1_000_000, 128_000),
    'claude-opus-4-7': claudeCurrent(1_000_000, 128_000),
    'claude-opus-4-6': { ...claudeCurrent(1_000_000, 128_000), supportsTemperature: true },
    'claude-sonnet-4-6': { ...claudeCurrent(1_000_000, 128_000), supportsTemperature: true },
    'claude-haiku-4-5': {
      ...claudeCurrent(200_000, 64_000),
      supportsTemperature: true,
      supportsEffort: false,
      thinkingReserveTokens: 0,
    },
  },
  openai: {
    'gpt-5': openaiReasoning(400_000, 128_000),
    'gpt-5-mini': openaiReasoning(400_000, 128_000),
    o3: openaiReasoning(200_000, 100_000),
    'o4-mini': openaiReasoning(200_000, 100_000),
    'gpt-4.1': openaiChat(1_000_000, 32_768),
    'gpt-4o': openaiChat(128_000, 16_384),
  },
};

/** OpenAI ids starting with these are reasoning models: unknown ones get role `developer` (02 §6). */
export const OPENAI_REASONING_PREFIXES: readonly string[] = ['o1', 'o3', 'o4', 'gpt-5'];

/**
 * Conservative limits for unknown model ids (02 §5, §6): 200k context, 8k output, no temperature.
 */
export function fallbackLimits(provider: ProviderId, model = ''): ModelLimits {
  const reasoning = provider === 'openai' && OPENAI_REASONING_PREFIXES.some((p) => model.startsWith(p));
  return {
    contextTokens: 200_000,
    maxOutputTokens: 8_000,
    supportsImages: true,
    maxImagesPerRequest: 20,
    maxImageBytes: 5 * MB,
    supportsTemperature: false,
    supportsEffort: false,
    thinkingReserveTokens: 0,
    systemRole: reasoning ? 'developer' : 'system',
    structuredMode: provider === 'openai' ? 'json_schema_strict' : 'output_config',
  };
}

/** Limits for a provider/model pair; unknown ids fall back (02 §5 "Unknown model IDs are allowed"). */
export function limitsFor(provider: ProviderId, model: string): ModelLimits {
  const row = provider === 'bedrock' ? undefined : MODEL_LIMITS[provider][model];
  return row ? { ...row } : fallbackLimits(provider, model);
}

/** Suggestions for the Settings model field (02 §14 `eli5:llm:models`). */
export function suggestedModels(provider: ProviderId): { suggested: string[]; default: string } {
  const suggested = provider === 'bedrock' ? [] : Object.keys(MODEL_LIMITS[provider]);
  return { suggested, default: DEFAULT_MODELS[provider] };
}
