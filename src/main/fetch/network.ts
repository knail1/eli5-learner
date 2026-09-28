import type { NetworkConfigurator } from './types';

/**
 * Public network configuration (05 §4.2, HOOK-FETCH-01): system proxy and Chromium's default
 * certificate verification. No custom CA, no proxy credentials, no certificate-verify override.
 */
export const configureSession: NetworkConfigurator = async (ses) => {
  await ses.setProxy({ mode: 'system' });
};
