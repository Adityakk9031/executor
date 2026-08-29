export {
  onepasswordPlugin,
  makeOnePasswordStore,
  resolveConfiguredRef,
  ambiguityMessage,
  type RefResolution,
  type OnePasswordExtension,
  type OnePasswordPluginOptions,
  type OnePasswordStore,
} from "./plugin";
export {
  OnePasswordConfig,
  LegacySingleVaultConfig,
  LegacyMultiVaultConfig,
  StoredOnePasswordConfig,
  normalizeStoredConfigs,
  normalizeStoredConfig,
  RedactedOnePasswordConfig,
  RedactedOnePasswordAuth,
  redactConfig,
  Vault,
  VaultStatus,
  ConnectionStatus,
  OnePasswordAuth,
  DesktopAppAuth,
  ServiceAccountAuth,
} from "./types";
export { OnePasswordError } from "./errors";
export {
  makeOnePasswordService,
  makeNativeSdkService,
  makeCliService,
  OnePasswordServiceTag,
  type OnePasswordService,
  type ResolvedAuth,
} from "./service";
