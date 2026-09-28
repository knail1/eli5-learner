import type { CapabilityRegistry } from '../editions';
import { createBedrockProvider } from './bedrock.stub';
import { createClaudeProvider } from './claude';
import { createOpenAIProvider } from './openai';
import { defaultPromptPolicy } from './policy';

/** Public-build LLM registrations (02 §4 step 2; HOOK-LLM-01, HOOK-LLM-02). */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerLLMProvider('claude', createClaudeProvider);
  reg.registerLLMProvider('openai', createOpenAIProvider);
  reg.registerLLMProvider('bedrock', createBedrockProvider);
  reg.registerPromptPolicy(defaultPromptPolicy);
}
