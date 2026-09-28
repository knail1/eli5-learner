import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { NotAvailableInEdition } from '../../../../src/main/editions/errors';
import { BedrockProvider } from '../../../../src/main/llm/bedrock.stub';
import { LLMError } from '../../../../src/main/llm/errors';
import type { GenerationRequest } from '../../../../src/main/llm/types';

const req: GenerationRequest = {
  taskId: 'in-depth',
  system: 's',
  messages: [{ role: 'user', text: 'hi' }],
  maxOutputTokens: 100,
};

describe('BedrockProvider stub (02 §13, HOOK-LLM-01)', () => {
  const p = new BedrockProvider(DEFAULTS);

  it('is marked as a stub with id bedrock', () => {
    expect(p.stub).toBe(true);
    expect(p.id).toBe('bedrock');
  });

  it.each(['generate', 'generateWithImages'] as const)('%s rejects with NotAvailableInEdition', async (m) => {
    const err = await p[m](req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotAvailableInEdition);
    expect(err).toMatchObject({ capability: 'llm:bedrock', hookId: 'HOOK-LLM-01', edition: 'public' });
  });

  it('countTokens and stream reject with NotAvailableInEdition', async () => {
    await expect(p.countTokens(req)).rejects.toBeInstanceOf(NotAvailableInEdition);
    const it = p.stream(req)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(NotAvailableInEdition);
  });

  it('testConnection never throws and reports not_available', async () => {
    const r = await p.testConnection();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(LLMError);
      expect(r.error.kind).toBe('not_available');
      expect(r.error.retryable).toBe(false);
    }
  });
});
