import { describe, expect, it } from 'vitest';
import { DEFAULTS, DEFAULT_MODELS, type Settings } from '../../../../src/main/config/schema';
import { NotAvailableInEdition } from '../../../../src/main/editions/errors';
import { Registry } from '../../../../src/main/editions/registry';
import { LLMError, defaultPromptPolicy, registerPublic } from '../../../../src/main/llm';
import type { GenerationRequest, ProviderId } from '../../../../src/main/llm';

const withProvider = (provider: ProviderId): Settings => ({ ...DEFAULTS, llm: { ...DEFAULTS.llm, provider } });

const req: GenerationRequest = { taskId: 'summary', system: '', messages: [], maxOutputTokens: 16 };

describe('registerPublic (02 §4, 01 §6)', () => {
  it('registers claude, openai, bedrock and the default prompt policy', () => {
    for (const id of ['claude', 'openai', 'bedrock'] as const) {
      const reg = new Registry({ edition: 'public', getSettings: () => withProvider(id) });
      registerPublic(reg);
      expect(reg.llm().id).toBe(id);
      expect(reg.promptPolicy()).toBe(defaultPromptPolicy);
    }
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    expect(reg.llm().model).toBe(DEFAULT_MODELS.claude);
  });

  it('edition info reports bedrock unavailable (stub) and the placeholders available', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    const byId = Object.fromEntries(reg.info().llmProviders.map((p) => [p.id, p.available]));
    expect(byId).toEqual({ claude: true, openai: true, bedrock: false });
  });

  it('M0 placeholders reject with not_available and testConnection never throws', async () => {
    for (const id of ['claude', 'openai'] as const) {
      const reg = new Registry({ edition: 'public', getSettings: () => withProvider(id) });
      registerPublic(reg);
      const p = reg.llm();
      const e = await p.generate(req).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LLMError);
      expect((e as LLMError).kind).toBe('not_available');
      const t = await p.testConnection();
      expect(t.ok).toBe(false);
    }
  });

  it('bedrock generate throws NotAvailableInEdition through the registry', async () => {
    const reg = new Registry({ edition: 'public', getSettings: () => withProvider('bedrock') });
    registerPublic(reg);
    await expect(reg.llm().generate(req)).rejects.toBeInstanceOf(NotAvailableInEdition);
  });

  it('default prompt policy is pass-through with no preamble or overrides', async () => {
    expect(defaultPromptPolicy.preamble).toBeNull();
    expect(defaultPromptPolicy.overridesDir).toBeNull();
    expect(defaultPromptPolicy.skills).toEqual([]);
    expect(await defaultPromptPolicy.preSendFilter(req)).toBe(req);
  });
});
