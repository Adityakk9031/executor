import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { OnePasswordClient } from "./client";

// 1Password is a CredentialProvider in v2 — its owner-scoped config lives in
// the `providers` reactivity family (the v1 `secrets` key is gone).
export const onepasswordWriteKeys = [ReactivityKey.providers] as const;

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const onepasswordConfigsAtom = OnePasswordClient.query("onepassword", "listConfigs", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.providers],
});

export const onepasswordConfigAtom = (id?: string) =>
  OnePasswordClient.query("onepassword", "getConfig", {
    query: { id },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.providers],
  });

export const onepasswordStatusAtom = (id?: string) =>
  OnePasswordClient.query("onepassword", "status", {
    query: { id },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.providers],
  });

// ---------------------------------------------------------------------------
// Query atoms — vaults
// ---------------------------------------------------------------------------

export const onepasswordVaultsAtom = (
  authKind: "desktop-app" | "service-account",
  account: string,
) =>
  OnePasswordClient.query("onepassword", "listVaults", {
    query: { authKind, account },
    // Long retention on purpose: vault listing goes through the op CLI/SDK and
    // is slow, so a reopened dialog renders the last-known vaults instantly
    // and revalidates in the background instead of flashing a loading state.
    timeToLive: "10 minutes",
    reactivityKeys: [ReactivityKey.providers],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const configureOnePassword = OnePasswordClient.mutation("onepassword", "configure");

export const removeOnePasswordConfig = OnePasswordClient.mutation("onepassword", "removeConfig");
