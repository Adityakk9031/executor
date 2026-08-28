import { betterAuth } from "better-auth";

import {
  makeBetterAuthSharedOptions,
  seedOrgAndAdmin,
  ensureInviteCodeTable,
  findRedeemableCode,
  consumeInviteCode,
  type BetterAuthInstance,
  type BetterAuthDbClient,
  type SignupGate,
  type BetterAuthHandle,
} from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";

export const d1ClientAdapter = (db: D1Database): BetterAuthDbClient => ({
  execute: async (sql, args) => {
    const stmt = db.prepare(sql).bind(...(args ?? []));
    const result = await stmt.all();
    return {
      rows: result.results ?? [],
      rowsAffected: result.meta?.changes ?? 0,
    };
  },
});

export const buildD1BetterAuth = async (
  db: D1Database,
  config: CloudflareConfig,
): Promise<BetterAuthHandle> => {
  const dbClient = d1ClientAdapter(db);

  let auth: BetterAuthInstance | null = null;
  const orgRef = { id: "" };
  const gate: SignupGate = {
    get organizationId() {
      return orgRef.id;
    },
    getAuth: () => auth,
    findRedeemableCode: (code) => findRedeemableCode(dbClient, code),
    consumeInviteCode: (code, by) => consumeInviteCode(dbClient, code, by),
  };

  const sharedOptions = makeBetterAuthSharedOptions(
    () => orgRef.id,
    { authSecret: config.betterAuthSecret!, webBaseUrl: config.webBaseUrl! },
    gate,
  );

  const authOptions = {
    ...sharedOptions,
    database: db,
  };

  auth = betterAuth(authOptions);
  await (await auth.$context).runMigrations();
  await ensureInviteCodeTable(dbClient);

  const seedConfig = {
    orgSlug: config.organizationSlug,
    organizationName: config.organizationName,
    bootstrapAdminEmail: config.bootstrapAdminEmail,
    bootstrapAdminPassword: config.bootstrapAdminPassword,
    bootstrapAdminName: config.bootstrapAdminName,
  };

  const { organizationId, organizationName } = await seedOrgAndAdmin(auth, dbClient, seedConfig);
  orgRef.id = organizationId;

  return {
    auth,
    organizationId,
    organizationName,
    organizationSlug: config.organizationSlug,
    handler: auth.handler,
    dbClient,
  };
};
