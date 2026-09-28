import overlay from '@eli5/overlay';
import { OVERLAY_API_VERSION, type Registry } from './registry';

/** Bootstrap step 3 (01 §6.3, §6.5). The overlay is bundled at build time, never loaded from disk. */
export async function loadOverlay(reg: Registry): Promise<void> {
  if (__ELI5_EDITION__ !== 'enterprise') return;
  if (!overlay) throw new Error('Enterprise build without overlay');
  if (overlay.apiVersion !== OVERLAY_API_VERSION) {
    throw new Error(`Overlay API ${overlay.apiVersion} != ${OVERLAY_API_VERSION}`);
  }
  reg.setOverlayName(overlay.name);
  await overlay.register(reg);
}
