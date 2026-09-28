import { registerPublic as registerLLM } from '../llm';
import { registerPublic as registerSources } from '../sources';
import { registerPublic as registerExtract } from '../extract';
import { registerPublic as registerFetch } from '../fetch';
import { registerPublic as registerPipeline } from '../pipeline';
import { registerPublic as registerDocument } from '../document';
import { registerPublic as registerLibrary } from '../library';
import { registerPublic as registerPublish } from '../publish';
import { registerPublic as registerPhotos } from '../photos';
import type { CapabilityRegistry } from './registry';

/**
 * Bootstrap step 2 (01 §6.3): every module registers its public implementations, stubs and the
 * public default for each policy slot it owns.
 */
export function registerPublicCapabilities(reg: CapabilityRegistry): void {
  registerLLM(reg);
  registerSources(reg);
  registerExtract(reg);
  registerFetch(reg);
  registerPipeline(reg);
  registerDocument(reg);
  registerLibrary(reg);
  registerPublish(reg);
  registerPhotos(reg);
}
