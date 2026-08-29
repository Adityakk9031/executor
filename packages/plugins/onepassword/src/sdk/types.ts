import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Auth — how to talk to 1Password
// ---------------------------------------------------------------------------

export const DesktopAppAuth = Schema.Struct({
  kind: Schema.Literal("desktop-app"),
  /** 1Password account domain, e.g. "my.1password.com" */
  accountName: Schema.String,
});
export type DesktopAppAuth = typeof DesktopAppAuth.Type;

export const ServiceAccountAuth = Schema.Struct({
  kind: Schema.Literal("service-account"),
  /** The service account token. Persisted in the plugin's owner-partitioned
   *  config blob — never surfaced to agents (`getConfig` / `listConfigs` redacts it).
   *  v1 stored this behind a separate secret id; v2 has no secrets table, so the
   *  plugin-owned config row carries it directly. */
  token: Schema.String,
});
export type ServiceAccountAuth = typeof ServiceAccountAuth.Type;

export const OnePasswordAuth = Schema.Union([DesktopAppAuth, ServiceAccountAuth]);
export type OnePasswordAuth = typeof OnePasswordAuth.Type;

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const Vault = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type Vault = typeof Vault.Type;

// ---------------------------------------------------------------------------
// Named Stored config — persisted via KV
// ---------------------------------------------------------------------------

export const OnePasswordConfig = Schema.Struct({
  /** Stable identifier for this named configuration (e.g. "default", "personal", "work") */
  id: Schema.String,
  /** Human display label for this named configuration */
  name: Schema.String,
  auth: OnePasswordAuth,
  /** Selected 1Password vault ID */
  vaultId: Schema.String,
  /** Human label for the selected vault */
  vaultName: Schema.optional(Schema.String),
});
export type OnePasswordConfig = typeof OnePasswordConfig.Type;

/** Legacy multi-vault stored shape: `{ auth, vaults, name }`. */
export const LegacyMultiVaultConfig = Schema.Struct({
  auth: OnePasswordAuth,
  vaults: Schema.NonEmptyArray(Vault),
  name: Schema.String,
});
export type LegacyMultiVaultConfig = typeof LegacyMultiVaultConfig.Type;

/** Pre-multi-vault stored shape: `{ auth, vaultId, name }`. */
export const LegacySingleVaultConfig = Schema.Struct({
  auth: OnePasswordAuth,
  vaultId: Schema.String,
  name: Schema.String,
});
export type LegacySingleVaultConfig = typeof LegacySingleVaultConfig.Type;

export const StoredConfigsWrapper = Schema.Struct({
  configs: Schema.Array(OnePasswordConfig),
});
export type StoredConfigsWrapper = typeof StoredConfigsWrapper.Type;

export const StoredOnePasswordConfig = Schema.Union([
  StoredConfigsWrapper,
  Schema.Array(OnePasswordConfig),
  LegacyMultiVaultConfig,
  LegacySingleVaultConfig,
  OnePasswordConfig,
]);
export type StoredOnePasswordConfig = typeof StoredOnePasswordConfig.Type;

export const normalizeStoredConfigs = (
  stored: StoredOnePasswordConfig,
): readonly OnePasswordConfig[] => {
  if ("configs" in stored && Array.isArray(stored.configs)) {
    return stored.configs;
  }
  if (Array.isArray(stored)) {
    return stored;
  }
  if ("vaults" in stored && Array.isArray(stored.vaults)) {
    return stored.vaults.map((vault, index) => ({
      id: index === 0 ? "default" : vault.id,
      name: index === 0 ? stored.name : vault.name,
      auth: stored.auth,
      vaultId: vault.id,
      vaultName: vault.name,
    }));
  }
  if ("vaultId" in stored) {
    if ("id" in stored && typeof stored.id === "string") {
      return [stored as OnePasswordConfig];
    }
    return [
      {
        id: "default",
        name: stored.name,
        auth: stored.auth,
        vaultId: stored.vaultId,
        vaultName: stored.name,
      },
    ];
  }
  return [];
};

export const normalizeStoredConfig = normalizeStoredConfigs;

// ---------------------------------------------------------------------------
// Redacted config — what `getConfig` / `listConfigs` returns to agents / the UI.
// The service-account token is stripped; only the auth kind + account metadata
// is surfaced.
// ---------------------------------------------------------------------------

export const RedactedDesktopAppAuth = DesktopAppAuth;

export const RedactedServiceAccountAuth = Schema.Struct({
  kind: Schema.Literal("service-account"),
});

export const RedactedOnePasswordAuth = Schema.Union([
  RedactedDesktopAppAuth,
  RedactedServiceAccountAuth,
]);

export const RedactedOnePasswordConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  auth: RedactedOnePasswordAuth,
  vaultId: Schema.String,
  vaultName: Schema.optional(Schema.String),
});
export type RedactedOnePasswordConfig = typeof RedactedOnePasswordConfig.Type;

/** Strip the service-account token from a stored config for external exposure. */
export const redactConfig = (config: OnePasswordConfig): RedactedOnePasswordConfig => ({
  id: config.id,
  name: config.name,
  auth:
    config.auth.kind === "desktop-app"
      ? { kind: "desktop-app", accountName: config.auth.accountName }
      : { kind: "service-account" },
  vaultId: config.vaultId,
  ...(config.vaultName !== undefined ? { vaultName: config.vaultName } : {}),
});

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export const VaultStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  vaultId: Schema.String,
  vaultName: Schema.optional(Schema.String),
  connected: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type VaultStatus = typeof VaultStatus.Type;

export const ConnectionStatus = Schema.Struct({
  connected: Schema.Boolean,
  vaults: Schema.optional(Schema.Array(VaultStatus)),
  error: Schema.optional(Schema.String),
});
export type ConnectionStatus = typeof ConnectionStatus.Type;
