import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { ProviderKey, ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeInMemoryBlobStore, pluginBlobStore } from "@executor-js/sdk/core";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { makeOnePasswordStore, onepasswordPlugin, resolveConfiguredRef } from "./plugin";
import type { OnePasswordService } from "./service";
import { OnePasswordError } from "./errors";
import { OnePasswordConfig, DesktopAppAuth, ServiceAccountAuth } from "./types";

const ONEPASSWORD = ProviderKey.make("onepassword");

const personalConfig = OnePasswordConfig.make({
  id: "personal",
  name: "Personal",
  auth: DesktopAppAuth.make({
    kind: "desktop-app",
    accountName: "my.1password.com",
  }),
  vaultId: "vault-personal",
  vaultName: "Personal Vault",
});

const workConfig = OnePasswordConfig.make({
  id: "work",
  name: "Work",
  auth: ServiceAccountAuth.make({
    kind: "service-account",
    token: "ops_work_token",
  }),
  vaultId: "vault-work",
  vaultName: "Work Vault",
});

const fakeService = (
  itemsByVault: Readonly<Record<string, readonly { id: string; title: string }[]>>,
  onResolve?: (uri: string) => void,
): OnePasswordService => ({
  resolveSecret: (uri) => {
    onResolve?.(uri);
    return Effect.succeed(`secret:${uri}`);
  },
  listVaults: () => Effect.succeed(Object.keys(itemsByVault).map((id) => ({ id, title: id }))),
  listItems: (vaultId) => {
    const items = itemsByVault[vaultId];
    return items === undefined
      ? Effect.fail(new OnePasswordError({ operation: "item listing", message: "no such vault" }))
      : Effect.succeed(items);
  },
});

describe("onepassword plugin — multiple named configurations", () => {
  it.effect("registers onepassword as a credential provider", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );
      const providers = yield* executor.providers.list();
      expect(providers).toContain(ONEPASSWORD);
    }),
  );

  it.effect("supports adding, listing, and removing multiple named configurations", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      const initial = yield* executor.onepassword.listConfigs();
      expect(initial).toEqual([]);

      // Add personal configuration
      yield* executor.onepassword.configure(personalConfig);

      const afterFirst = yield* executor.onepassword.listConfigs();
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]?.id).toBe("personal");
      expect(afterFirst[0]?.name).toBe("Personal");
      expect(afterFirst[0]?.vaultId).toBe("vault-personal");

      // Add work configuration (should not overwrite personal)
      yield* executor.onepassword.configure(workConfig);

      const afterSecond = yield* executor.onepassword.listConfigs();
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond.map((c) => c.id)).toEqual(["personal", "work"]);

      // Get individual config by id
      const singlePersonal = yield* executor.onepassword.getConfig("personal");
      expect(singlePersonal?.id).toBe("personal");

      const singleWork = yield* executor.onepassword.getConfig("work");
      expect(singleWork?.id).toBe("work");

      // Update personal config
      yield* executor.onepassword.configure({
        ...personalConfig,
        name: "Personal Updated",
      });

      const afterUpdate = yield* executor.onepassword.listConfigs();
      expect(afterUpdate).toHaveLength(2);
      expect(afterUpdate.find((c) => c.id === "personal")?.name).toBe("Personal Updated");
      expect(afterUpdate.find((c) => c.id === "work")?.name).toBe("Work");

      // Remove personal config without affecting work
      yield* executor.onepassword.removeConfig("personal");

      const afterRemoveOne = yield* executor.onepassword.listConfigs();
      expect(afterRemoveOne).toHaveLength(1);
      expect(afterRemoveOne[0]?.id).toBe("work");

      // Remove work config
      yield* executor.onepassword.removeConfig("work");
      const afterRemoveAll = yield* executor.onepassword.listConfigs();
      expect(afterRemoveAll).toEqual([]);
    }),
  );

  it.effect("redacts service-account tokens across all config listing and retrieval", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      yield* executor.onepassword.configure(workConfig);

      const list = yield* executor.onepassword.listConfigs();
      expect(list[0]?.auth.kind).toBe("service-account");
      expect(JSON.stringify(list)).not.toContain("ops_work_token");

      const single = yield* executor.onepassword.getConfig("work");
      expect(single?.auth.kind).toBe("service-account");
      expect(JSON.stringify(single)).not.toContain("ops_work_token");
    }),
  );

  it.effect("exposes multi-config tools on the static integration", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      const configuredPersonal = yield* executor.execute(
        ToolAddress.make("executor.onepassword.configure"),
        personalConfig,
        { onElicitation: "accept-all" },
      );
      expect(configuredPersonal).toEqual({
        ok: true,
        data: { configured: true, id: "personal" },
      });

      const configuredWork = yield* executor.execute(
        ToolAddress.make("executor.onepassword.configure"),
        workConfig,
        { onElicitation: "accept-all" },
      );
      expect(configuredWork).toEqual({
        ok: true,
        data: { configured: true, id: "work" },
      });

      const listResult = yield* executor.execute(
        ToolAddress.make("executor.onepassword.listConfigs"),
        {},
      );
      expect(listResult).toMatchObject({
        ok: true,
        data: {
          configs: [
            { id: "personal", name: "Personal", vaultId: "vault-personal" },
            { id: "work", name: "Work", vaultId: "vault-work" },
          ],
        },
      });

      const removed = yield* executor.execute(
        ToolAddress.make("executor.onepassword.removeConfig"),
        { id: "personal" },
        { onElicitation: "accept-all" },
      );
      expect(removed).toEqual({ ok: true, data: { removed: true } });

      const afterRemove = yield* executor.onepassword.listConfigs();
      expect(afterRemove).toHaveLength(1);
      expect(afterRemove[0]?.id).toBe("work");
    }),
  );
});

describe("onepassword store — backward compatibility", () => {
  const makeStore = () => {
    const blobs = pluginBlobStore(
      makeInMemoryBlobStore(),
      { org: "org_test", user: null },
      "onepassword",
    );
    return { blobs, store: makeOnePasswordStore(blobs) };
  };

  it.effect("normalizes legacy single-vault blob on read", () =>
    Effect.gen(function* () {
      const { blobs, store } = makeStore();
      yield* blobs.put(
        "config",
        JSON.stringify({
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaultId: "vault-123",
          name: "Personal",
        }),
        { owner: "org" },
      );

      const configs = yield* store.getConfigs();
      expect(configs).toEqual([
        {
          id: "default",
          name: "Personal",
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaultId: "vault-123",
          vaultName: "Personal",
        },
      ]);
    }),
  );

  it.effect("normalizes legacy multi-vault array blob on read", () =>
    Effect.gen(function* () {
      const { blobs, store } = makeStore();
      yield* blobs.put(
        "config",
        JSON.stringify({
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaults: [
            { id: "v-1", name: "Primary" },
            { id: "v-2", name: "Secondary" },
          ],
          name: "1Password",
        }),
        { owner: "org" },
      );

      const configs = yield* store.getConfigs();
      expect(configs).toHaveLength(2);
      expect(configs[0]).toEqual({
        id: "default",
        name: "1Password",
        auth: { kind: "desktop-app", accountName: "my.1password.com" },
        vaultId: "v-1",
        vaultName: "Primary",
      });
      expect(configs[1]).toEqual({
        id: "v-2",
        name: "Secondary",
        auth: { kind: "desktop-app", accountName: "my.1password.com" },
        vaultId: "v-2",
        vaultName: "Secondary",
      });
    }),
  );

  it.effect("persists and reads back multiple named configurations", () =>
    Effect.gen(function* () {
      const { store } = makeStore();
      yield* store.saveConfig(personalConfig, "org");
      yield* store.saveConfig(workConfig, "org");

      const configs = yield* store.getConfigs();
      expect(configs).toEqual([personalConfig, workConfig]);
    }),
  );
});

describe("resolveConfiguredRef — multi-configuration resolution", () => {
  const configs = [personalConfig, workConfig];
  const itemsByVault = {
    "vault-personal": [{ id: "item-p1", title: "GitHub Token" }],
    "vault-work": [{ id: "item-w1", title: "Stripe Key" }],
  };

  const getSvc = (_config: OnePasswordConfig) => Effect.succeed(fakeService(itemsByVault));

  it.effect("resolves op://<configId>/<itemId> directly", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(getSvc, configs, "op://personal/item-p1");
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-personal/item-p1/credential",
      });
    }),
  );

  it.effect("resolves op://<configId>/<vaultId>/<itemId> directly", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        getSvc,
        configs,
        "op://work/vault-work/item-w1/api-key",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-work/item-w1/api-key",
      });
    }),
  );

  it.effect("resolves legacy op://<vaultId>/<itemId> by matching vaultId across configs", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        getSvc,
        configs,
        "op://vault-personal/item-p1/password",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-personal/item-p1/password",
      });
    }),
  );

  it.effect("rejects an op:// URI referencing an unconfigured vault (strict isolation)", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        getSvc,
        configs,
        "op://vault-unknown/item-123/password",
      );
      expect(result).toEqual({ kind: "outside-vaults" });
    }),
  );

  it.effect("resolves a bare ref when it matches in exactly one vault", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(getSvc, configs, "Stripe Key");
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-work/item-w1/credential",
      });
    }),
  );

  it.effect("detects ambiguity when a bare ref matches in multiple configured vaults", () =>
    Effect.gen(function* () {
      const ambiguousItems = {
        "vault-personal": [{ id: "item-1", title: "Shared Key" }],
        "vault-work": [{ id: "item-2", title: "Shared Key" }],
      };
      const ambiguousSvc = (_config: OnePasswordConfig) =>
        Effect.succeed(fakeService(ambiguousItems));

      const result = yield* resolveConfiguredRef(ambiguousSvc, configs, "Shared Key");
      expect(result).toEqual({
        kind: "ambiguous",
        matches: [
          {
            configId: "personal",
            configName: "Personal",
            vaultId: "vault-personal",
            vaultName: "Personal Vault",
            itemId: "item-1",
            itemTitle: "Shared Key",
          },
          {
            configId: "work",
            configName: "Work",
            vaultId: "vault-work",
            vaultName: "Work Vault",
            itemId: "item-2",
            itemTitle: "Shared Key",
          },
        ],
      });
    }),
  );
});
