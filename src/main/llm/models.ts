import type { ProviderId } from '../config';
import type { ModelLimits } from './types';

export { DEFAULT_MODELS } from '../config';

/**
 * Conservative limits for unknown model ids (02 §5, §6): 200k context, 8k output, no temperature.
 * M1 adds the per-model limits table.
 */
export function fallbackLimits(provider: ProviderId): ModelLimits {
  return {
    contextTokens: 200_000,
    maxOutputTokens: 8_000,
    supportsImages: true,
    maxImagesPerRequest: 20,
    maxImageBytes: 5 * 1024 * 1024,
    supportsTemperature: false,
    supportsEffort: false,
    thinkingReserveTokens: 0,
    systemRole: 'system',
    structuredMode: provider === 'openai' ? 'json_schema_strict' : 'output_config',
  };
}
