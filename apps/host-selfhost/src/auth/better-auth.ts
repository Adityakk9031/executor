import { betterAuth } from "better-auth";
import { type Client } from "@libsql/client";
import { LibsqlDialect, type LibsqlDialectConfig } from "@libsql/kysely-libsql";

import {
  makeBetterAuthSharedOptions,
  seedOrgAndAdmin,
  ensureInviteCodeTable,
  findRedeemableCode,
  consumeInviteCode,
  type BetterAuthInstance,
  type BetterAuthDbClient,
  type SignupGate,
  BetterAuth as SharedBetterAuth,
  type BetterAuthHandle as SharedBetterAuthHandle,
} from "@executor-js/api/server";

import { loadConfig } from "../config";

export const libSqlClientAdapter = (client: Client): BetterAuthDbClient => ({
  execute: async (sql, args) => {
    const result = await client.execute({ sql, args: args ?? [] });
    return { rows: result.rows as any[], rowsAffected: result.rowsAffected };
  },
});

export const buildBetterAuth = async (client: Client): Promise<BetterAuthHandle> => {
  const config = loadConfig();
  const dbClient = libSqlClientAdapter(client);

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
    { authSecret: config.authSecret, webBaseUrl: config.webBaseUrl },
    gate,
  );

  const authOptions = {
    ...sharedOptions,
    database: {
      // oxlint-disable-next-line executor/no-double-cast -- boundary: version structural compatibility
      dialect: new LibsqlDialect({ client } as unknown as LibsqlDialectConfig),
      type: "sqlite" as const,
    },
  };

  auth = betterAuth(authOptions);
  await (await auth.$context).runMigrations();
  await ensureInviteCodeTable(dbClient);
  const { organizationId, organizationName } = await seedOrgAndAdmin(auth, dbClient, config);
  orgRef.id = organizationId;

  return {
    auth,
    organizationId,
    organizationName,
    organizationSlug: config.orgSlug,
    handler: auth.handler,
    dbClient,
  };
};

export type Auth = BetterAuthInstance;
export type BetterAuthHandle = SharedBetterAuthHandle;
export const BetterAuth = SharedBetterAuth;

export { countOrgMembers } from "@executor-js/api/server";
