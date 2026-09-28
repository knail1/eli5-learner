import type { GenerationRequest, PromptPolicy } from './types';

/** Public HOOK-LLM-02 default (02 §13, 01 §6): no preamble, no overrides, pass-through filter. */
export const defaultPromptPolicy: PromptPolicy = Object.freeze({
  preamble: null,
  overridesDir: null,
  skills: Object.freeze([]) as readonly string[],
  preSendFilter: (req: GenerationRequest): GenerationRequest => req,
});
