import type { CapabilityRegistry } from '../editions';
import { defaultLibraryPolicy, defaultMergeEligibility } from './policy';

/** Registers the public library defaults (HOOK-LIB-01, HOOK-LIB-02; 09 §3, §10.2). */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerLibraryPolicy(defaultLibraryPolicy);
  reg.registerMergeEligibility(defaultMergeEligibility);
}
