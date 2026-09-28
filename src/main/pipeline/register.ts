import type { CapabilityRegistry } from '../editions';
import { defaultPipelinePolicy } from './policy';

/** Registers the public pipeline defaults (HOOK-PIPE-01, 06 §9.5). */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerPipelinePolicy(defaultPipelinePolicy);
}
