export { Registry, OVERLAY_API_VERSION } from './registry';
export type { CapabilityRegistry, EditionOverlay, EditionInfo, UiFeature, RegistryOptions } from './registry';
export { NotAvailableInEdition } from './errors';
export { edition } from './types';
export type { Edition } from './types';
// Bootstrap-only entry points (load-overlay.ts, public.ts) are imported directly by src/main/index.ts:
// public.ts imports every module, and modules import this index, so re-exporting them here would cycle.
