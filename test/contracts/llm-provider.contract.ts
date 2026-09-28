import { describe, expect, it } from 'vitest';
import { LLMError } from '../../src/main/llm/errors';
import { generateStructured } from '../../src/main/llm/structured';
import type { GenerationRequest, ImageInput, LLMErrorKind, LLMProvider } from '../../src/main/llm/types';

/**
 * LLMProvider contract suite (13 §10.2). Public providers run it against cassettes and the
 * FakeProvider; the enterprise overlay runs it against its backend (HOOK-TEST-01, HOOK-LLM-01).
 *
 * `make(scenario)` returns a provider whose transport answers that scenario: plain text, one image,
 * structured output, a first invalid answer followed by a valid one (repair), or an error class.
 * Every request carries the marker text `contract:<scenario>` in the user message and uses
 * taskId "summary", so cassettes and scripts can key on it.
 */

export type ContractErrorKind = Extract<
  LLMErrorKind,
  'auth' | 'bad_request' | 'rate_limited' | 'overloaded' | 'server' | 'context_overflow'
>;
export type ContractScenario = 'text' | 'image' | 'structured' | 'repair' | `error:${ContractErrorKind}`;

export const CONTRACT_ERROR_KINDS: readonly ContractErrorKind[] = [
  'auth',
  'bad_request',
  'rate_limited',
  'overloaded',
  'server',
  'context_overflow',
];

/** Label the image scenario sends; cassettes match on it. */
export const CONTRACT_IMAGE_LABEL = 'diagram.png';

export interface LLMContractOptions {
  transport: 'cassette' | 'fake' | 'live';
  /** Error classes this transport can produce (default: all). */
  errorKinds?: readonly ContractErrorKind[];
}

export function contractRequest(scenario: ContractScenario, extra: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    taskId: 'summary',
    system: 'Contract.',
    messages: [{ role: 'user', text: `contract:${scenario}` }],
    maxOutputTokens: 256,
    ...extra,
  };
}

export function contractImage(): ImageInput {
  return {
    mediaType: 'image/png',
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    label: CONTRACT_IMAGE_LABEL,
    sourceRef: 'diagram.png',
  };
}

/** Delegating wrapper that counts provider sends, so the repair path can be pinned to one retry. */
function counting(p: LLMProvider): { provider: LLMProvider; sends: () => number } {
  let n = 0;
  const provider: LLMProvider = {
    id: p.id,
    model: p.model,
    limits: p.limits,
    generate: (r) => (n++, p.generate(r)),
    generateWithImages: (r) => (n++, p.generateWithImages(r)),
    testConnection: () => p.testConnection(),
  };
  return { provider, sends: () => n };
}

function expectResult(p: LLMProvider, r: Awaited<ReturnType<LLMProvider['generate']>>): void {
  expect(typeof r.text).toBe('string');
  expect(r.text.length).toBeGreaterThan(0);
  expect(r.provider).toBe(p.id);
  expect(r.model.length).toBeGreaterThan(0);
  expect(r.usage.inputTokens).toBeGreaterThanOrEqual(0);
  expect(r.usage.outputTokens).toBeGreaterThanOrEqual(0);
  expect(r.attempts).toBeGreaterThanOrEqual(1);
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  expect(['end', 'max_tokens', 'refusal', 'other']).toContain(r.stopReason);
}

export function describeLLMProviderContract(
  name: string,
  make: (scenario: ContractScenario) => Promise<LLMProvider>,
  opts: LLMContractOptions,
): void {
  const kinds = opts.errorKinds ?? CONTRACT_ERROR_KINDS;

  describe(`LLMProvider contract: ${name} (${opts.transport})`, () => {
    it('exposes id, model and limits', async () => {
      const p = await make('text');
      expect(['claude', 'openai', 'bedrock']).toContain(p.id);
      expect(p.model.length).toBeGreaterThan(0);
      expect(p.limits.contextTokens).toBeGreaterThan(0);
      expect(p.limits.maxOutputTokens).toBeGreaterThan(0);
    });

    it('text request returns a GenerationResult with usage', async () => {
      const p = await make('text');
      expectResult(p, await p.generate(contractRequest('text')));
    });

    it('image request returns a GenerationResult with usage', async () => {
      const p = await make('image');
      const req = contractRequest('image');
      req.messages = [{ role: 'user', text: 'contract:image', images: [contractImage()] }];
      expectResult(p, await p.generateWithImages(req));
    });

    it('generate() rejects images with bad_request', async () => {
      const p = await make('text');
      const req = contractRequest('text');
      req.messages = [{ role: 'user', text: 'contract:text', images: [contractImage()] }];
      const e = await p.generate(req).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LLMError);
      expect((e as LLMError).kind).toBe('bad_request');
    });

    it('structured output validates without repair', async () => {
      const c = counting(await make('structured'));
      const r = await generateStructured({
        provider: c.provider,
        schema: 'SummaryDraft',
        request: contractRequest('structured'),
      });
      expect(r.repaired).toBe(false);
      expect(c.sends()).toBe(1);
      expect(r.data.topicSlugHint.length).toBeGreaterThan(0);
    });

    it('invalid structured output runs the repair path exactly once', async () => {
      const c = counting(await make('repair'));
      const r = await generateStructured({
        provider: c.provider,
        schema: 'SummaryDraft',
        request: contractRequest('repair'),
      });
      expect(r.repaired).toBe(true);
      expect(c.sends()).toBe(2);
      expect(r.data.topicSlugHint.length).toBeGreaterThan(0);
    });

    for (const kind of kinds) {
      it(`error class maps to LLMErrorKind "${kind}"`, async () => {
        const p = await make(`error:${kind}`);
        const e = await p.generate(contractRequest(`error:${kind}`)).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(LLMError);
        expect((e as LLMError).kind).toBe(kind);
        expect((e as LLMError).retryable).toBe(['rate_limited', 'overloaded', 'server'].includes(kind));
      });
    }

    it('testConnection never throws', async () => {
      const ok = await (await make('text')).testConnection();
      for (const kind of kinds) {
        await expect((await make(`error:${kind}`)).testConnection()).resolves.toHaveProperty('ok');
      }
      expect(ok.ok).toBe(true);
      if (kinds.includes('auth')) {
        const bad = await (await make('error:auth')).testConnection();
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error.kind).toBe('auth');
      }
    });
  });
}
