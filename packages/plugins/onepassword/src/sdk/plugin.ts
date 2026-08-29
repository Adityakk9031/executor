import { Effect, Schema, Exit } from "effect";

import {
  definePlugin,
  StorageError,
  ToolResult,
  tool,
  ProviderItemId,
  ProviderKey,
  type CredentialProvider,
  type Owner,
  type PluginCtx,
  type PluginBlobStore,
  type ProviderEntry,
  type StaticToolSchema,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  OnePasswordAuth,
  OnePasswordConfig,
  RedactedOnePasswordConfig,
  StoredOnePasswordConfig,
  Vault,
  VaultStatus,
  ConnectionStatus,
  normalizeStoredConfigs,
  redactConfig,
} from "./types";
import { OnePasswordError } from "./errors";
import { makeOnePasswordService, type ResolvedAuth, type OnePasswordService } from "./service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIAL_FIELD = "credential";
const DEFAULT_TIMEOUT_MS = 15_000;
const CONFIG_KEY = "config";
const PROVIDER_KEY = ProviderKey.make("onepassword");

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const OnePasswordConfigureInput = OnePasswordConfig;

const OnePasswordConfigureOutput = Schema.Struct({
  configured: Schema.Boolean,
  id: Schema.String,
});

const OnePasswordListConfigsOutput = Schema.Struct({
  configs: Schema.Array(RedactedOnePasswordConfig),
});

const OnePasswordGetConfigInput = Schema.Struct({
  id: Schema.optional(Schema.String),
});

const OnePasswordGetConfigOutput = Schema.Struct({
  config: Schema.NullOr(RedactedOnePasswordConfig),
});

const OnePasswordListVaultsInput = OnePasswordAuth;

const OnePasswordListVaultsOutput = Schema.Struct({
  vaults: Schema.Array(Vault),
});

const OnePasswordRemoveConfigInput = Schema.Struct({
  id: Schema.optional(Schema.String),
});

const OnePasswordRemoveConfigOutput = Schema.Struct({
  removed: Schema.Boolean,
});

const OnePasswordStatusInput = Schema.Struct({
  id: Schema.optional(Schema.String),
});

const OnePasswordStatusOutput = ConnectionStatus;

const OnePasswordConfigureInputStd = schemaToStaticToolSchema<
  typeof OnePasswordConfigureInput.Type,
  typeof OnePasswordConfigureInput.Encoded
>(OnePasswordConfigureInput);
const OnePasswordConfigureOutputStd = schemaToStaticToolSchema(OnePasswordConfigureOutput);
const OnePasswordListConfigsOutputStd = schemaToStaticToolSchema(OnePasswordListConfigsOutput);
const OnePasswordGetConfigInputStd = schemaToStaticToolSchema<
  typeof OnePasswordGetConfigInput.Type,
  typeof OnePasswordGetConfigInput.Encoded
>(OnePasswordGetConfigInput);
const OnePasswordGetConfigOutputStd = schemaToStaticToolSchema(OnePasswordGetConfigOutput);
const OnePasswordListVaultsInputStd = schemaToStaticToolSchema<
  typeof OnePasswordListVaultsInput.Type,
  typeof OnePasswordListVaultsInput.Encoded
>(OnePasswordListVaultsInput);
const OnePasswordListVaultsOutputStd = schemaToStaticToolSchema(OnePasswordListVaultsOutput);
const OnePasswordRemoveConfigInputStd = schemaToStaticToolSchema<
  typeof OnePasswordRemoveConfigInput.Type,
  typeof OnePasswordRemoveConfigInput.Encoded
>(OnePasswordRemoveConfigInput);
const OnePasswordRemoveConfigOutputStd = schemaToStaticToolSchema(OnePasswordRemoveConfigOutput);
const OnePasswordStatusInputStd = schemaToStaticToolSchema<
  typeof OnePasswordStatusInput.Type,
  typeof OnePasswordStatusInput.Encoded
>(OnePasswordStatusInput);
const OnePasswordStatusOutputStd = schemaToStaticToolSchema(OnePasswordStatusOutput);

// ---------------------------------------------------------------------------
// Shared failure alias.
// ---------------------------------------------------------------------------

export type OnePasswordExtensionFailure = OnePasswordError | StorageFailure;

// ---------------------------------------------------------------------------
// Typed config store — JSON encoded, owner-partitioned list of named configs.
// Reads accept legacy shapes and normalize them to a list of named configs.
// Saves persist the full `{ configs: [...] }` list.
// ---------------------------------------------------------------------------

export interface OnePasswordStore {
  readonly getConfigs: () => Effect.Effect<
    readonly OnePasswordConfig[],
    StorageError | OnePasswordError
  >;
  readonly getConfig: (
    id?: string,
  ) => Effect.Effect<OnePasswordConfig | null, StorageError | OnePasswordError>;
  readonly saveConfig: (
    config: OnePasswordConfig,
    owner: Owner,
  ) => Effect.Effect<void, StorageError>;
  readonly deleteConfig: (
    id: string | undefined,
    owner: Owner,
  ) => Effect.Effect<void, StorageError>;
  readonly deleteAllConfigs: (owner: Owner) => Effect.Effect<void, StorageError>;
}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredOnePasswordConfig));

const blobStorageError =
  (operation: string) =>
  (cause: unknown): StorageError =>
    new StorageError({
      message: `onepassword blob ${operation} failed`,
      cause,
    });

export const makeOnePasswordStore = (blobs: PluginBlobStore): OnePasswordStore => {
  const getConfigs = (): Effect.Effect<
    readonly OnePasswordConfig[],
    StorageError | OnePasswordError
  > =>
    blobs.get(CONFIG_KEY).pipe(
      Effect.mapError(blobStorageError("read")),
      Effect.flatMap((raw) => {
        if (raw === null) return Effect.succeed([] as readonly OnePasswordConfig[]);
        return decodeConfig(raw).pipe(
          Effect.map(normalizeStoredConfigs),
          Effect.mapError(
            () =>
              new OnePasswordError({
                operation: "config decode",
                message: "Failed to decode 1Password config",
              }),
          ),
        );
      }),
    );

  const getConfig = (
    id?: string,
  ): Effect.Effect<OnePasswordConfig | null, StorageError | OnePasswordError> =>
    getConfigs().pipe(
      Effect.map((configs) => {
        if (configs.length === 0) return null;
        if (!id) return configs[0] ?? null;
        return configs.find((c) => c.id === id) ?? null;
      }),
    );

  const saveConfig = (config: OnePasswordConfig, owner: Owner): Effect.Effect<void, StorageError> =>
    getConfigs().pipe(
      Effect.catchTag("OnePasswordError", () => Effect.succeed([] as readonly OnePasswordConfig[])),
      Effect.flatMap((existing) => {
        const id = config.id.trim() || "default";
        const normalizedConfig: OnePasswordConfig = { ...config, id };
        const index = existing.findIndex((c) => c.id === id);
        const updated =
          index >= 0
            ? [...existing.slice(0, index), normalizedConfig, ...existing.slice(index + 1)]
            : [...existing, normalizedConfig];
        return blobs
          .put(CONFIG_KEY, JSON.stringify({ configs: updated }), { owner })
          .pipe(Effect.mapError(blobStorageError("write")));
      }),
    );

  const deleteConfig = (id: string | undefined, owner: Owner): Effect.Effect<void, StorageError> =>
    getConfigs().pipe(
      Effect.catchTag("OnePasswordError", () => Effect.succeed([] as readonly OnePasswordConfig[])),
      Effect.flatMap((existing) => {
        if (existing.length === 0) return Effect.void;
        const targetId = id?.trim();
        const updated = targetId ? existing.filter((c) => c.id !== targetId) : [];
        if (updated.length === 0) {
          return blobs
            .delete(CONFIG_KEY, { owner })
            .pipe(Effect.mapError(blobStorageError("delete")));
        }
        return blobs
          .put(CONFIG_KEY, JSON.stringify({ configs: updated }), { owner })
          .pipe(Effect.mapError(blobStorageError("write")));
      }),
    );

  const deleteAllConfigs = (owner: Owner): Effect.Effect<void, StorageError> =>
    blobs.delete(CONFIG_KEY, { owner }).pipe(Effect.mapError(blobStorageError("delete")));

  return {
    getConfigs,
    getConfig,
    saveConfig,
    deleteConfig,
    deleteAllConfigs,
  };
};

// ---------------------------------------------------------------------------
// Helpers — auth resolution + service construction
// ---------------------------------------------------------------------------

const resolveAuth = (auth: OnePasswordAuth): ResolvedAuth =>
  auth.kind === "desktop-app"
    ? { kind: "desktop-app", accountName: auth.accountName }
    : { kind: "service-account", token: auth.token };

const getServiceFromConfig = (
  config: OnePasswordConfig,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  makeOnePasswordService(resolveAuth(config.auth), { timeoutMs, preferSdk });

// ---------------------------------------------------------------------------
// Explicit ref resolution across named configurations.
// ---------------------------------------------------------------------------

export type RefResolution =
  | { readonly kind: "resolved"; readonly value: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "outside-vaults" }
  | {
      readonly kind: "ambiguous";
      readonly matches: readonly {
        readonly configId: string;
        readonly configName: string;
        readonly vaultId: string;
        readonly vaultName: string;
        readonly itemId: string;
        readonly itemTitle: string;
      }[];
    };

export const ambiguityMessage = (
  ref: string,
  matches: Extract<RefResolution, { kind: "ambiguous" }>["matches"],
): string =>
  [
    `1Password ref "${ref}" is ambiguous: it matches`,
    matches
      .map((m) => `"${m.itemTitle}" in config "${m.configName}" (vault "${m.vaultName}")`)
      .join(", "),
    `. Use op://<configId>/<itemId> to pick one.`,
  ].join(" ");

export const resolveConfiguredRef = (
  getService: (config: OnePasswordConfig) => Effect.Effect<OnePasswordService, OnePasswordError>,
  configs: readonly OnePasswordConfig[],
  ref: string,
): Effect.Effect<RefResolution, OnePasswordError> => {
  if (ref.startsWith("op://")) {
    const raw = ref.slice("op://".length);
    const segments = raw.split("/").filter((s) => s.length > 0);
    if (segments.length < 2) {
      return Effect.succeed({ kind: "not-found" });
    }

    // 1. Check if first segment matches a config ID
    const configById = configs.find((c) => c.id === segments[0]);
    if (configById) {
      return Effect.gen(function* () {
        const svc = yield* getService(configById);
        if (segments.length === 2) {
          const itemId = segments[1]!;
          const uri = `op://${configById.vaultId}/${itemId}/${CREDENTIAL_FIELD}`;
          const value = yield* svc.resolveSecret(uri);
          return { kind: "resolved", value } as const;
        }

        const secondIsVault =
          segments[1] === configById.vaultId ||
          (configById.vaultName !== undefined && segments[1] === configById.vaultName);

        if (secondIsVault) {
          const itemId = segments[2]!;
          const field = segments.slice(3).join("/") || CREDENTIAL_FIELD;
          const uri = `op://${configById.vaultId}/${itemId}/${field}`;
          const value = yield* svc.resolveSecret(uri);
          return { kind: "resolved", value } as const;
        }

        const itemId = segments[1]!;
        const field = segments.slice(2).join("/") || CREDENTIAL_FIELD;
        const uri = `op://${configById.vaultId}/${itemId}/${field}`;
        const value = yield* svc.resolveSecret(uri);
        return { kind: "resolved", value } as const;
      });
    }

    // 2. Check if first segment matches a vaultId or vaultName across configs
    const configsWithVault = configs.filter(
      (c) =>
        c.vaultId === segments[0] || (c.vaultName !== undefined && c.vaultName === segments[0]),
    );
    if (configsWithVault.length > 0) {
      return Effect.gen(function* () {
        const config = configsWithVault[0]!;
        const svc = yield* getService(config);
        const itemId = segments[1]!;
        const field = segments.slice(2).join("/") || CREDENTIAL_FIELD;
        const uri = `op://${config.vaultId}/${itemId}/${field}`;
        const value = yield* svc.resolveSecret(uri);
        return { kind: "resolved", value } as const;
      });
    }

    return Effect.succeed({ kind: "outside-vaults" });
  }

  // Bare ref lookup (title or id)
  return Effect.gen(function* () {
    const matches = (yield* Effect.forEach(configs, (config) =>
      getService(config).pipe(
        Effect.flatMap((svc) => svc.listItems(config.vaultId)),
        Effect.map((items) =>
          items
            .filter((item) => item.id === ref || item.title === ref)
            .map((item) => ({
              configId: config.id,
              configName: config.name,
              vaultId: config.vaultId,
              vaultName: config.vaultName ?? config.name,
              itemId: item.id,
              itemTitle: item.title,
              config,
            })),
        ),
        Effect.catch(() => Effect.succeed([])),
      ),
    )).flat();

    const [only, ...extra] = matches;
    if (only === undefined) return { kind: "not-found" } as const;
    if (extra.length > 0) {
      return {
        kind: "ambiguous",
        matches: matches.map((m) => ({
          configId: m.configId,
          configName: m.configName,
          vaultId: m.vaultId,
          vaultName: m.vaultName,
          itemId: m.itemId,
          itemTitle: m.itemTitle,
        })),
      } as const;
    }

    const svc = yield* getService(only.config);
    const value = yield* svc.resolveSecret(
      `op://${only.vaultId}/${only.itemId}/${CREDENTIAL_FIELD}`,
    );
    return { kind: "resolved", value } as const;
  });
};

// ---------------------------------------------------------------------------
// CredentialProvider — read-only, resolves op:// URIs or vault-scoped lookups.
// ---------------------------------------------------------------------------

const makeProvider = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): CredentialProvider => ({
  key: PROVIDER_KEY,
  writable: false,

  get: (id: ProviderItemId): Effect.Effect<string | null, StorageFailure> =>
    ctx.storage.getConfigs().pipe(
      Effect.catchTag("OnePasswordError", () => Effect.succeed([] as readonly OnePasswordConfig[])),
      Effect.flatMap((configs) => {
        if (configs.length === 0) return Effect.succeed(null as string | null);
        const getSvc = (config: OnePasswordConfig) =>
          getServiceFromConfig(config, timeoutMs, preferSdk);
        return resolveConfiguredRef(getSvc, configs, id).pipe(
          Effect.catch(() => Effect.succeed({ kind: "not-found" } as RefResolution)),
          Effect.flatMap(
            (resolution): Effect.Effect<string | null, StorageError> =>
              resolution.kind === "ambiguous"
                ? Effect.fail(
                    new StorageError({
                      message: ambiguityMessage(id, resolution.matches),
                      cause: undefined,
                    }),
                  )
                : Effect.succeed(resolution.kind === "resolved" ? resolution.value : null),
          ),
        );
      }),
    ),

  list: (): Effect.Effect<readonly ProviderEntry[], StorageFailure> =>
    ctx.storage.getConfigs().pipe(
      Effect.flatMap((configs) => {
        if (configs.length === 0) return Effect.succeed([] as readonly ProviderEntry[]);
        return Effect.forEach(configs, (config) =>
          getServiceFromConfig(config, timeoutMs, preferSdk).pipe(
            Effect.flatMap((svc) =>
              svc.listItems(config.vaultId).pipe(
                Effect.map((items) =>
                  items.map(
                    (item): ProviderEntry => ({
                      id: ProviderItemId.make(`op://${config.id}/${item.id}`),
                      name: item.title,
                      group: `${config.name} (${config.vaultName ?? config.vaultId})`,
                    }),
                  ),
                ),
              ),
            ),
            Effect.catch(() => Effect.succeed([] as readonly ProviderEntry[])),
          ),
        ).pipe(Effect.map((groups): readonly ProviderEntry[] => groups.flat()));
      }),
      Effect.catch(() => Effect.succeed([] as readonly ProviderEntry[])),
    ),
});

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

const ownerForCtx = (ctx: PluginCtx<OnePasswordStore>): Owner =>
  ctx.owner.subject === null ? "org" : "user";

const makeOnePasswordExtension = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
) => {
  return {
    listConfigs: (): Effect.Effect<
      readonly RedactedOnePasswordConfig[],
      StorageError | OnePasswordError
    > => ctx.storage.getConfigs().pipe(Effect.map((configs) => configs.map(redactConfig))),

    getConfig: (
      id?: string,
    ): Effect.Effect<RedactedOnePasswordConfig | null, StorageError | OnePasswordError> =>
      ctx.storage
        .getConfig(id)
        .pipe(Effect.map((config) => (config ? redactConfig(config) : null))),

    configure: (config: OnePasswordConfig) => ctx.storage.saveConfig(config, ownerForCtx(ctx)),

    removeConfig: (id?: string) => ctx.storage.deleteConfig(id, ownerForCtx(ctx)),

    status: (id?: string) =>
      Effect.gen(function* () {
        const configs = yield* ctx.storage.getConfigs();
        if (configs.length === 0) {
          return ConnectionStatus.make({
            connected: false,
            error: "Not configured",
          });
        }
        const targetConfigs = id ? configs.filter((c) => c.id === id) : configs;
        if (targetConfigs.length === 0) {
          return ConnectionStatus.make({
            connected: false,
            error: `Configuration "${id}" not found`,
          });
        }

        const vaultStatuses = yield* Effect.forEach(targetConfigs, (config) =>
          Effect.gen(function* () {
            const svcExit = yield* getServiceFromConfig(config, timeoutMs, preferSdk).pipe(
              Effect.exit,
            );
            if (Exit.isFailure(svcExit)) {
              return VaultStatus.make({
                id: config.id,
                name: config.name,
                vaultId: config.vaultId,
                vaultName: config.vaultName,
                connected: false,
                error: "Failed to initialize 1Password service",
              });
            }
            const svc = svcExit.value;
            const liveExit = yield* svc.listVaults().pipe(Effect.exit);
            if (Exit.isFailure(liveExit)) {
              return VaultStatus.make({
                id: config.id,
                name: config.name,
                vaultId: config.vaultId,
                vaultName: config.vaultName,
                connected: false,
                error: "Failed to reach 1Password vaults",
              });
            }
            const live = liveExit.value;
            const found = live.find((v) => v.id === config.vaultId);
            if (!found) {
              return VaultStatus.make({
                id: config.id,
                name: config.name,
                vaultId: config.vaultId,
                vaultName: config.vaultName,
                connected: true,
                error: `Vault "${config.vaultName ?? config.vaultId}" not found in account`,
              });
            }
            return VaultStatus.make({
              id: config.id,
              name: config.name,
              vaultId: config.vaultId,
              vaultName: found.title,
              connected: true,
            });
          }),
        );

        const allConnected = vaultStatuses.every((v) => v.connected && !v.error);
        const anyError = vaultStatuses.find((v) => v.error)?.error;

        return ConnectionStatus.make({
          connected: allConnected,
          vaults: vaultStatuses,
          ...(anyError ? { error: anyError } : {}),
        });
      }),

    listVaults: (auth: OnePasswordAuth) =>
      Effect.gen(function* () {
        const svc = yield* makeOnePasswordService(resolveAuth(auth), {
          timeoutMs,
          preferSdk,
        });
        const vaults = yield* svc.listVaults();
        return vaults
          .map((v) => Vault.make({ id: v.id, name: v.title }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),

    resolve: (uri: string) =>
      Effect.gen(function* () {
        const configs = yield* ctx.storage.getConfigs();
        if (configs.length === 0) {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: "1Password is not configured",
          });
        }
        const getSvc = (config: OnePasswordConfig) =>
          getServiceFromConfig(config, timeoutMs, preferSdk);
        const resolution = yield* resolveConfiguredRef(getSvc, configs, uri);
        if (resolution.kind === "resolved") return resolution.value;
        if (resolution.kind === "outside-vaults") {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: "1Password secret URI is outside the configured vaults",
          });
        }
        if (resolution.kind === "ambiguous") {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: ambiguityMessage(uri, resolution.matches),
          });
        }
        return yield* new OnePasswordError({
          operation: "resolve",
          message: `1Password item "${uri}" was not found in the configured vaults`,
        });
      }),
  };
};

export type OnePasswordExtension = ReturnType<typeof makeOnePasswordExtension>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OnePasswordPluginOptions {
  /** Request timeout in ms (default: 15000) */
  readonly timeoutMs?: number;
  /** Force use of the native SDK instead of the CLI (default: false) */
  readonly preferSdk?: boolean;
}

export const onepasswordPlugin = definePlugin((options?: OnePasswordPluginOptions) => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const preferSdk = options?.preferSdk;

  return {
    id: "onepassword" as const,
    packageName: "@executor-js/plugin-onepassword",
    storage: ({ blobs }) => makeOnePasswordStore(blobs),

    extension: (ctx) => makeOnePasswordExtension(ctx, timeoutMs, preferSdk),

    staticIntegrations: (self) => [
      {
        id: "onepassword",
        kind: "executor",
        name: "1Password",
        tools: [
          tool({
            name: "status",
            description:
              "Check whether the 1Password credential provider is configured and can reach its selected vaults. This returns status only, never secret values.",
            inputSchema: OnePasswordStatusInputStd,
            outputSchema: OnePasswordStatusOutputStd,
            execute: (input) => Effect.map(self.status(input?.id), ToolResult.ok),
          }),
          tool({
            name: "listConfigs",
            description:
              "List all configured 1Password vault configurations for the acting owner. Metadata only; service-account tokens are never returned.",
            outputSchema: OnePasswordListConfigsOutputStd,
            execute: () =>
              Effect.map(self.listConfigs(), (configs) => ToolResult.ok({ configs: [...configs] })),
          }),
          tool({
            name: "getConfig",
            description:
              "Read a 1Password provider configuration by ID (or the default configuration). This returns metadata only; service-account tokens are never returned.",
            inputSchema: OnePasswordGetConfigInputStd,
            outputSchema: OnePasswordGetConfigOutputStd,
            execute: (input) =>
              Effect.map(self.getConfig(input?.id), (config) => ToolResult.ok({ config })),
          }),
          tool({
            name: "listVaults",
            description:
              "List available 1Password vaults before configuring the provider. For service-account auth, pass the service account token directly.",
            inputSchema: OnePasswordListVaultsInputStd,
            outputSchema: OnePasswordListVaultsOutputStd,
            execute: (input) =>
              Effect.map(self.listVaults(input), (vaults) => ToolResult.ok({ vaults })),
          }),
          tool({
            name: "configure",
            description:
              "Add or update a named 1Password vault configuration for the acting owner. Use desktop-app auth for local biometric access, or service-account auth with the token. The token is stored in the plugin's owner-partitioned config and never surfaced again.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Configure a 1Password vault",
            },
            inputSchema: OnePasswordConfigureInputStd,
            outputSchema: OnePasswordConfigureOutputStd,
            execute: (input) =>
              Effect.as(self.configure(input), ToolResult.ok({ configured: true, id: input.id })),
          }),
          tool({
            name: "removeConfig",
            description:
              "Remove a named 1Password provider configuration for the acting owner (or all if omitted).",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Remove a 1Password provider configuration",
            },
            inputSchema: OnePasswordRemoveConfigInputStd,
            outputSchema: OnePasswordRemoveConfigOutputStd,
            execute: (input) =>
              Effect.as(self.removeConfig(input?.id), ToolResult.ok({ removed: true })),
          }),
        ],
      },
    ],

    credentialProviders: (ctx) => [makeProvider(ctx, timeoutMs, preferSdk)],
  };
});
