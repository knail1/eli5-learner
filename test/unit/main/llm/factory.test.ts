import { afterEach, describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../../../../src/main/config';
import { NotAvailableInEdition } from '../../../../src/main/editions/errors';
import { Registry } from '../../../../src/main/editions/registry';
import {
  BedrockProvider,
  ClaudeProvider,
  configureLlmRuntime,
  createProvider,
  OpenAIProvider,
  registerPublic,
  resetLlmRuntime,
} from '../../../../src/main/llm';
import { Limiter } from '../../../../src/main/llm/limiter';
import { cassette, settingsFor, TEST_KEY } from './helpers';

afterEach(() => resetLlmRuntime());

describe('createProvider (02 §4)', () => {
  it('selects by llm.provider and resolves the model', () => {
    const keys = new MemoryKeyStore();
    expect(createProvider(settingsFor('claude'), keys)).toBeInstanceOf(ClaudeProvider);
    const o = createProvider(settingsFor('openai', 'gpt-4.1'), keys);
    expect(o).toBeInstanceOf(OpenAIProvider);
    expect(o.model).toBe('gpt-4.1');
    expect(createProvider(settingsFor('openai'), keys).model).toBe('gpt-5');
    expect(createProvider(settingsFor('bedrock'), keys)).toBeInstanceOf(BedrockProvider);
  });

  it('reads the Keychain account for the provider at call time', async () => {
    const keys = new MemoryKeyStore();
    const t = cassette('openai/text.json');
    const p = createProvider(settingsFor('openai'), keys, {
      fetch: t.fetch,
      limiter: new Limiter(1, () => Promise.resolve()),
    });
    await expect(
      p.generate({ taskId: 'eli5', system: 's', messages: [{ role: 'user', text: 'u' }], maxOutputTokens: 10 }),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
    await keys.set('llm.openai.apiKey', TEST_KEY);
    const r = await p.generate({
      taskId: 'eli5',
      system: 's',
      messages: [{ role: 'user', text: 'u' }],
      maxOutputTokens: 10,
    });
    expect(r.provider).toBe('openai');
    expect(t.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('registry providers use the configured runtime (keys, llmFetch) and report not_available without a network path', async () => {
    const reg = new Registry({ edition: 'public', getSettings: () => settingsFor('claude') });
    registerPublic(reg);
    configureLlmRuntime({ keys: new MemoryKeyStore({ 'llm.claude.apiKey': TEST_KEY }) });
    const req = {
      taskId: 'summary' as const,
      system: 's',
      messages: [{ role: 'user' as const, text: 'u' }],
      maxOutputTokens: 10,
    };
    await expect(reg.llm().generate(req)).rejects.toMatchObject({ kind: 'not_available' });
    const t = cassette('claude/text.json');
    configureLlmRuntime({ fetch: t.fetch });
    expect((await reg.llm().generate(req)).text).toContain('Example Widgets');
  });

  it('public bedrock fails with NotAvailableInEdition through the registry', async () => {
    const reg = new Registry({ edition: 'public', getSettings: () => settingsFor('bedrock') });
    registerPublic(reg);
    await expect(
      reg.llm().generate({ taskId: 'summary', system: '', messages: [], maxOutputTokens: 1 }),
    ).rejects.toBeInstanceOf(NotAvailableInEdition);
  });
});
