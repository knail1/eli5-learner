import { account, type KeyStore, type Settings } from '../config';
import type { ProviderDeps } from './base';
import { BedrockProvider } from './bedrock.stub';
import { ClaudeProvider } from './claude';
import { OpenAIProvider } from './openai';
import type { LLMProvider } from './types';

/**
 * createProvider (02 §4): selects by `llm.provider`, resolves the model with effectiveModel, and
 * reads the key from the Keychain at call time (missing key → LLMError('auth') on the call, not at
 * app start). The registry caches the instance and invalidates it on llm.* or key changes.
 */
export function createProvider(
  s: Settings,
  keys: Pick<KeyStore, 'get'>,
  deps: Omit<ProviderDeps, 'getApiKey'> = {},
): LLMProvider {
  switch (s.llm.provider) {
    case 'claude':
      return new ClaudeProvider(s, { ...deps, getApiKey: () => keys.get(account('claude')) });
    case 'openai':
      return new OpenAIProvider(s, { ...deps, getApiKey: () => keys.get(account('openai')) });
    case 'bedrock':
      return new BedrockProvider(s);
  }
}
