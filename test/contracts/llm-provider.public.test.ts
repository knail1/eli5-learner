import path from 'node:path';
import { DEFAULTS, type Settings } from '../../src/main/config/schema';
import { ClaudeProvider } from '../../src/main/llm/claude';
import { Limiter } from '../../src/main/llm/limiter';
import { OpenAIProvider } from '../../src/main/llm/openai';
import { cassetteFetch } from '../../src/main/llm/testing/cassette';
import { FakeProvider, type FakeScript } from '../../src/main/llm/testing/fake';
import type { LLMProvider, ProviderId } from '../../src/main/llm/types';
import { describeLLMProviderContract, type ContractScenario } from './llm-provider.contract';

const CASSETTES = path.resolve(import.meta.dirname, '../fixtures/cassettes');
const key = ['sk', 'test', 'contract'].join('-');

function settings(provider: ProviderId): Settings {
  return { ...DEFAULTS, llm: { ...DEFAULTS.llm, provider } };
}

function cassetteFile(provider: 'claude' | 'openai', s: ContractScenario): string {
  if (s === 'error:auth') return 'auth.json';
  if (s.startsWith('error:')) return 'errors.json';
  return `${s}.json`;
}

function cassetteProvider(provider: 'claude' | 'openai') {
  return (s: ContractScenario): Promise<LLMProvider> => {
    const t = cassetteFetch(path.join(CASSETTES, provider, cassetteFile(provider, s)));
    const deps = {
      getApiKey: () => Promise.resolve(key),
      fetch: t.fetch,
      sleep: () => Promise.resolve(),
      limiter: new Limiter(2, () => Promise.resolve()),
    };
    return Promise.resolve(
      provider === 'claude'
        ? new ClaudeProvider(settings('claude'), deps)
        : new OpenAIProvider(settings('openai'), deps),
    );
  };
}

const VALID = { title: 'Widget supply', topicSlugHint: 'widget-supply', summary: 'Synthetic.' };

function fakeProvider(s: ContractScenario): Promise<LLMProvider> {
  let script: FakeScript;
  if (s.startsWith('error:')) {
    script = { responses: {}, errors: { summary: s.slice('error:'.length) as never } };
  } else if (s === 'repair') {
    script = { responses: { summary: [{ title: 'missing fields' }, VALID] } };
  } else if (s === 'structured') {
    script = { responses: { summary: VALID } };
  } else {
    script = { responses: { summary: '"Example Widgets Inc. makes widgets."' } };
  }
  return Promise.resolve(new FakeProvider(script));
}

describeLLMProviderContract('ClaudeProvider', cassetteProvider('claude'), { transport: 'cassette' });
describeLLMProviderContract('OpenAIProvider', cassetteProvider('openai'), { transport: 'cassette' });
describeLLMProviderContract('FakeProvider', fakeProvider, { transport: 'fake' });
