import type { Settings } from '../config';
import { NotAvailableInEdition } from '../editions';
import { edition } from '../editions';
import { LLMError } from './errors';
import { fallbackLimits } from './models';
import type {
  ConnectionCheck,
  GenerationRequest,
  GenerationResult,
  LLMProvider,
  ModelLimits,
  StreamChunk,
} from './types';

const CAPABILITY = 'llm:bedrock';
const HOOK = 'HOOK-LLM-01';

function notAvailable(): NotAvailableInEdition {
  return new NotAvailableInEdition(CAPABILITY, HOOK, edition);
}

/**
 * Public-build Bedrock stub (02 §13, HOOK-LLM-01). Every call throws NotAvailableInEdition;
 * testConnection reports not_available without throwing. `llm.bedrock.*` keys are ignored.
 */
export class BedrockProvider implements LLMProvider {
  readonly stub = true;
  readonly id = 'bedrock' as const;
  readonly model: string;
  readonly limits: ModelLimits = fallbackLimits('bedrock');

  constructor(s?: Settings) {
    this.model = s?.llm.model ?? '';
  }

  generate(_req: GenerationRequest): Promise<GenerationResult> {
    return Promise.reject(notAvailable());
  }

  generateWithImages(_req: GenerationRequest): Promise<GenerationResult> {
    return Promise.reject(notAvailable());
  }

  stream(_req: GenerationRequest): AsyncIterable<StreamChunk> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(notAvailable()),
      }),
    };
  }

  countTokens(_req: Pick<GenerationRequest, 'system' | 'messages'>): Promise<number> {
    return Promise.reject(notAvailable());
  }

  testConnection(): Promise<ConnectionCheck> {
    return Promise.resolve({
      ok: false,
      error: new LLMError(
        'not_available',
        'Bedrock is available only in the enterprise edition',
        undefined,
        undefined,
        notAvailable(),
      ),
    });
  }
}

export function createBedrockProvider(s: Settings): LLMProvider {
  return new BedrockProvider(s);
}
