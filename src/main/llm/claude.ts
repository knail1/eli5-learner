import type { Settings } from '../config';
import { placeholderProvider } from './placeholder';
import type { LLMProvider } from './types';

// M1: replace with the @anthropic-ai/sdk ClaudeProvider per 02 §5 (streaming, output_config, llmFetch).
export function createClaudeProvider(settings: Settings): LLMProvider {
  return placeholderProvider('claude', 'Claude', settings);
}
