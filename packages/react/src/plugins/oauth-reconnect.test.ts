import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  type Connection,
  type OAuthClientSummary,
} from "@executor-js/sdk/shared";

import {
  missingScopes,
  oauthReconnectPayload,
  reconnectAllowsAutomaticRegistration,
  reconnectMode,
  reconnectStoredClient,
  reconsentRequiredScopes,
} from "./oauth-reconnect";

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  owner: "user",
  name: ConnectionName.make("personal-github"),
  integration: IntegrationSlug.make("github"),
  template: AuthTemplateSlug.make("oauth"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.github.user.personal-github"),
  identityLabel: "Personal GitHub",
  expiresAt: 123,
  oauthClient: OAuthClientSlug.make("github-app"),
  ...overrides,
});

describe("reconnectMode (OAuth vs non-OAuth branch)", () => {
  // The single field `oauthClient` decides the path: OAuth connections must
  // re-consent (a refresh cannot widen scopes / fails with no refresh token).
  it("returns 'oauth' when the connection carries an oauthClient slug", () => {
    expect(reconnectMode(connection())).toBe("oauth");
  });

  it("returns 'refresh' when oauthClient is null (static credential)", () => {
    expect(reconnectMode(connection({ oauthClient: null }))).toBe("refresh");
  });

  it("returns 'refresh' when oauthClient is absent", () => {
    const { oauthClient: _drop, ...rest } = connection();
    expect(reconnectMode(rest as Connection)).toBe("refresh");
  });
});

describe("oauthReconnectPayload (re-mint the SAME connection)", () => {
  // The payload re-runs oauth.start with the SAME owner/integration/name so the
  // backend mint upserts the existing row (widened union + fresh refresh token).
  it("builds the start payload from an OAuth connection's own fields", () => {
    const payload = oauthReconnectPayload(connection());
    expect(payload).not.toBeNull();
    expect(payload!.client).toBe(OAuthClientSlug.make("github-app"));
    expect(payload!.owner).toBe("user");
    expect(payload!.name).toBe(ConnectionName.make("personal-github"));
    expect(payload!.integration).toBe(IntegrationSlug.make("github"));
    expect(payload!.template).toBe(AuthTemplateSlug.make("oauth"));
    expect(payload!.identityLabel).toBe("Personal GitHub");
  });

  it("maps a null identityLabel to undefined (optional payload field)", () => {
    const payload = oauthReconnectPayload(connection({ identityLabel: null }));
    expect(payload!.identityLabel).toBeUndefined();
  });

  it("returns null for a non-OAuth connection (no oauthClient)", () => {
    expect(oauthReconnectPayload(connection({ oauthClient: null }))).toBeNull();
  });
});

const clientSummary = (overrides: Partial<OAuthClientSummary> = {}): OAuthClientSummary => ({
  owner: "user",
  slug: OAuthClientSlug.make("github-app"),
  grant: "authorization_code",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  resource: null,
  clientId: "client-123",
  origin: { kind: "manual", integration: null },
  ...overrides,
});

describe("reconnectStoredClient (resolve a connection's stored app)", () => {
  it("finds the stored row by slug and the app's stored owner", () => {
    const stored = clientSummary();
    expect(reconnectStoredClient([clientSummary({ owner: "org" }), stored], connection())).toBe(
      stored,
    );
  });

  it("matches against oauthClientOwner when the app is shared (org app, user connection)", () => {
    const shared = clientSummary({ owner: "org" });
    expect(reconnectStoredClient([shared], connection({ oauthClientOwner: "org" }))).toBe(shared);
    // Without the stored app owner, the connection's own owner is the key.
    expect(reconnectStoredClient([shared], connection())).toBeUndefined();
  });

  it("matches a first-party app on slug alone (config-declared, deployment-scoped)", () => {
    const firstParty = clientSummary({
      owner: "org",
      slug: OAuthClientSlug.make("first-party:github"),
      origin: { kind: "first_party" },
    });
    expect(
      reconnectStoredClient(
        [firstParty],
        connection({ oauthClient: OAuthClientSlug.make("first-party:github") }),
      ),
    ).toBe(firstParty);
  });

  it("is undefined for a non-OAuth connection and for a binding whose row is gone", () => {
    expect(
      reconnectStoredClient([clientSummary()], connection({ oauthClient: null })),
    ).toBeUndefined();
    expect(reconnectStoredClient([], connection())).toBeUndefined();
  });
});

describe("reconnectAllowsAutomaticRegistration (which bindings may re-register)", () => {
  // Only an auto-minted DCR binding may re-run probe/registration; a manual
  // (static/BYO) or first-party binding must keep the direct stored-client
  // path — re-registering would silently rebind the connection.
  it("allows an auto-minted DCR binding", () => {
    expect(
      reconnectAllowsAutomaticRegistration(
        clientSummary({ origin: { kind: "dynamic_client_registration", integration: null } }),
      ),
    ).toBe(true);
  });

  it("allows a binding whose stored row is gone (nothing to start directly against)", () => {
    expect(reconnectAllowsAutomaticRegistration(undefined)).toBe(true);
  });

  it("keeps a manual (static/BYO) binding on the direct path", () => {
    expect(reconnectAllowsAutomaticRegistration(clientSummary())).toBe(false);
  });

  it("keeps a first-party binding on the direct path", () => {
    expect(
      reconnectAllowsAutomaticRegistration(clientSummary({ origin: { kind: "first_party" } })),
    ).toBe(false);
  });
});

describe("missingScopes (Part 2 informational subset warning)", () => {
  // The app's scopes are a STRICT subset of the integration's → list what's
  // missing, in the integration's declared order.
  it("lists scopes the integration declares that the app does not grant", () => {
    expect(missingScopes(["a", "b", "c"], ["a"])).toEqual(["b", "c"]);
  });

  it("is empty when the app covers everything the integration declares", () => {
    expect(missingScopes(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("is empty when the app is a SUPERSET of the integration's scopes", () => {
    expect(missingScopes(["a"], ["a", "b", "c"])).toEqual([]);
  });

  it("is empty when the integration declares no scopes", () => {
    expect(missingScopes(undefined, ["a"])).toEqual([]);
    expect(missingScopes([], ["a"])).toEqual([]);
  });

  it("treats undefined/empty client scopes as granting nothing", () => {
    expect(missingScopes(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(missingScopes(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("normalizes whitespace and dedupes before comparing (sets, not lists)", () => {
    expect(missingScopes([" a ", "a", "b", ""], ["a"])).toEqual(["b"]);
    expect(missingScopes(["a", "b"], [" a ", "a", ""])).toEqual(["b"]);
  });

  it("treats Google's expanded userinfo scopes as OIDC profile/email grants", () => {
    expect(
      missingScopes(
        ["profile", "email", "https://www.googleapis.com/auth/calendar"],
        [
          "https://www.googleapis.com/auth/userinfo.profile",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/calendar",
          "openid",
        ],
      ),
    ).toEqual([]);
  });
});

describe("reconsentRequiredScopes", () => {
  it("treats spec-derived oauth scopes as NOT required (opportunistic catalog)", () => {
    // An OpenAPI integration (e.g. PostHog) declares the full per-operation scope
    // catalog. A narrower grant is healthy and must not nag for reconnect.
    expect(
      reconsentRequiredScopes({
        source: "spec",
        oauth: { scopes: ["insight:read", "insight:write", "person:read"] },
      }),
    ).toBeUndefined();
  });

  it("keeps custom (user-configured) oauth scopes required", () => {
    expect(
      reconsentRequiredScopes({
        source: "custom",
        oauth: { scopes: ["read", "write"] },
      }),
    ).toEqual(["read", "write"]);
  });

  it("returns undefined when there is no oauth method", () => {
    expect(reconsentRequiredScopes(undefined)).toBeUndefined();
  });
});
