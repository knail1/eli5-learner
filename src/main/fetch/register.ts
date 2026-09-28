import type { CapabilityRegistry } from '../editions';
import { configureSession } from './network';

/**
 * Public fetch registrations (01 §6.2): the default network configurator (HOOK-FETCH-01).
 * No login signatures: the public list is [] (HOOK-FETCH-02).
 */
export function registerPublic(reg: CapabilityRegistry): void {
  reg.registerNetworkConfigurator(configureSession);
}
