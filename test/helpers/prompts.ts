import path from 'node:path';
import { PromptCatalogue } from '../../src/main/llm/prompts';
import type { StructuredCall } from '../../src/main/llm/structured';

/** The prompt catalogue root in the repo (02 §9): config/prompts with the `default` set. */
export const PROMPTS_ROOT = path.resolve(import.meta.dirname, '../../config/prompts');

let cached: PromptCatalogue | undefined;

/** The shipped default catalogue, loaded once per test file. */
export function defaultCatalogue(): PromptCatalogue {
  cached ??= PromptCatalogue.load({ root: PROMPTS_ROOT });
  return cached;
}

/** The repair, no-output and contract texts tasks.ts passes to generateStructured, from the catalogue. */
export function structuredTexts(
  c: PromptCatalogue = defaultCatalogue(),
): Pick<StructuredCall<'SummaryDraft'>, 'repairText' | 'noOutputText' | 'contractText'> {
  return {
    repairText: (errors) => c.fragment('json-repair', { errors }).text,
    noOutputText: () => c.fragment('json-no-output').text,
    contractText: (schemaName, schema) => c.fragment('json-contract', { schemaName, schema }).text,
  };
}
