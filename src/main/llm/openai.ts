import type { Settings } from '../config';
import { placeholderProvider } from './placeholder';
import type { LLMProvider } from './types';

// M1: replace with the openai SDK OpenAIProvider per 02 §6 (streaming, json_schema strict, llmFetch).
export function createOpenAIProvider(settings: Settings): LLMProvider {
  return placeholderProvider('openai', 'OpenAI', settings);
}
