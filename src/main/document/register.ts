// Public registrations for the document module (01 §6.2; HOOK-DOC-01, HOOK-DOC-02).
import type { CapabilityRegistry } from '../editions';
import { defaultReferenceFormatter } from './references';
import { defaultDocTheme } from './theme';

export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerDocTheme(defaultDocTheme); // HOOK-DOC-01
  reg.registerReferenceFormatter(defaultReferenceFormatter); // HOOK-DOC-02
}
