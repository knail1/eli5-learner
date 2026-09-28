export {
  SettingsSchema,
  ProviderIdSchema,
  DEFAULTS,
  DEFAULT_MODELS,
  DORMANT_NAMESPACES,
  CURRENT_SCHEMA_VERSION,
  effectiveModel,
  isDormantPath,
} from './schema';
export type { Settings, DeepPartial, ProviderId, DormantNamespace } from './schema';
export type { SettingsExtension } from './extension';
export { SettingsStore, SettingsError } from './store';
export {
  KeychainKeyStore,
  MemoryKeyStore,
  KeychainUnavailable,
  KEYCHAIN_SERVICE,
  account,
  createKeyStore,
} from './keystore';
export type { KeyStore, KeyAccount } from './keystore';
export { findSecrets, looksLikeSecret, redact, checkApiKeyFormat } from './guards';
export { resourcePath, initPaths, resolveUserDataDir } from './paths';
export { edition } from './edition';
