import { effectiveModel, type ProviderId, type Settings } from '../config';
import { LLMError } from './errors';
import { fallbackLimits } from './models';
import type { ConnectionCheck, GenerationResult, LLMProvider } from './types';

/** M0 placeholder shared by claude.ts and openai.ts; removed when the SDK providers land (M1). */
export function placeholderProvider(id: ProviderId, label: string, s: Settings): LLMProvider {
  const err = (): LLMError => new LLMError('not_available', `${label} provider not implemented yet (M1)`);
  return {
    id,
    model: effectiveModel({ ...s, llm: { ...s.llm, provider: id } }),
    limits: fallbackLimits(id),
    generate: (): Promise<GenerationResult> => Promise.reject(err()),
    generateWithImages: (): Promise<GenerationResult> => Promise.reject(err()),
    testConnection: (): Promise<ConnectionCheck> => Promise.resolve({ ok: false, error: err() }),
  };
}
