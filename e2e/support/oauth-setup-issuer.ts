/** A scoped external OAuth issuer for setup checks; Executor still uses its real HTTP and storage paths. */
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

type TokenAuth = "client_secret_basic" | "client_secret_post" | "none";

/** Start a loopback issuer with controllable discovery and registration metadata. */
export const oauthSetupIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  let registration = true;
  let postChallenge = false;
  let challenge = true;
  let probes = 0;
  let mcpStatus: 520 | undefined;
  let expiresAt = 0;
  let registrationStatus: 200 | 201 | 400 = 201;
  let malformedRegistration = false;
  let registrationError: "invalid_client_metadata" | "invalid_redirect_uri" =
    "invalid_client_metadata";
  let omitSecretExpiry = false;
  let nonceRequested: boolean | undefined;
  let idTokenAlgorithms: readonly string[] | undefined;
  let includeIdToken = false;
  let invalidNonce = false;
  /** The ID token `iss`; Google names its sign-in host rather than the token endpoint origin. */
  let idTokenIssuer: string | undefined;
  /** Google signs RS256; a declared server advertises no algorithms, so RS256 is the only default. */
  let idTokenAlgorithm: "ES256" | "RS256" = "ES256";
  let refreshTokens = false;
  let expiresIn = 3600;
  let tokenExchanges = 0;
  let tokenChecks: Readonly<Record<string, boolean>> = {};
  let refreshes = 0;
  let refreshChecks: Readonly<Record<string, boolean>> = {};
  /** Client authentication on the latest code exchange; background refreshes do not overwrite it. */
  let lastExchangeAuth: TokenAuth | undefined;
  /** Appended to the authorization redirect as RFC 9207 `iss`, as Google does. */
  let callbackIssuer: string | undefined;
  /** Origin of the browser page that relays a callback to the advertised redirect URI. */
  let browserReturn: string | undefined;
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let rsaKey: KeyObject | undefined;
  /** Refresh tokens issued for each client; like Google, refreshes do not rotate them. */
  const refreshGrants = new Map<string, string>();
  const refreshedAccessTokens = new Set<string>();
  const clients = new Map<
    string,
    {
      readonly redirects: readonly string[];
      readonly secret: string | null;
      readonly methods: readonly TokenAuth[];
    }
  >();
  const codes = new Map<
    string,
    { clientId: string; redirect: string; challenge: string; nonce: string | null }
  >();
  let discovery:
    | "available"
    | "unavailable"
    | "missing"
    | "no-oauth"
    | "invalid-json"
    | "invalid-metadata"
    | "blocked" = "available";
  let scopes = ["read"];
  let registrations = 0;
  let discoveries = 0;
  let authMethods = ["client_secret_basic"];
  let lastRegistration: { scope: string; method: string } | undefined;
  const resource = Effect.gen(function* () {
    if (discovery === "missing" || discovery === "no-oauth")
      return HttpServerResponse.empty({ status: 404 });
    const origin = yield* Deferred.await(address);
    return yield* HttpServerResponse.json({
      resource: `${origin}/mcp`,
      authorization_servers: [discovery === "blocked" ? "http://blocked.internal:8081" : origin],
      scopes_supported: scopes,
    });
  });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/jwks",
      HttpServerResponse.json({
        keys: [
          {
            ...keyPair.publicKey.export({ format: "jwk" }),
            alg: "ES256",
            use: "sig",
            kid: "synthetic-key",
          },
        ],
      }),
    ),
    HttpRouter.add(
      "GET",
      "/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URL(request.url, "http://localhost").searchParams;
        const clientId = params.get("client_id"),
          redirect = params.get("redirect_uri"),
          challenge = params.get("code_challenge");
        if (
          clientId === null ||
          redirect === null ||
          challenge === null ||
          params.get("code_challenge_method") !== "S256" ||
          !clients.get(clientId)?.redirects.includes(redirect)
        )
          return HttpServerResponse.empty({ status: 400 });
        const code = randomUUID();
        nonceRequested = params.get("nonce") !== null;
        codes.set(code, { clientId, redirect, challenge, nonce: params.get("nonce") });
        const callback = new URL(redirect);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", params.get("state") ?? "");
        if (callbackIssuer !== undefined) callback.searchParams.set("iss", callbackIssuer);
        // The managed host advertises a separate callback relay; model its browser return.
        const location =
          browserReturn === undefined
            ? callback
            : Object.assign(new URL("/oauth/callback", browserReturn), { search: callback.search });
        return HttpServerResponse.empty({ status: 302, headers: { location: location.href } });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = new URLSearchParams(yield* request.text);
        const refreshing = input.get("grant_type") === "refresh_token";
        if (refreshing) refreshes++;
        else tokenExchanges++;
        const code = input.get("code"),
          verifier = input.get("code_verifier"),
          presentedRefresh = input.get("refresh_token");
        const issued = refreshing || code === null ? undefined : codes.get(code);
        const refreshClient =
          refreshing && presentedRefresh !== null ? refreshGrants.get(presentedRefresh) : undefined;
        const clientId = refreshing ? refreshClient : issued?.clientId;
        const authorization = request.headers.authorization;
        const decoded = authorization?.startsWith("Basic ")
          ? Buffer.from(authorization.slice(6), "base64").toString("utf8")
          : "";
        const separator = decoded.indexOf(":");
        const username =
          separator < 0
            ? undefined
            : decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " "));
        const password =
          separator < 0
            ? undefined
            : decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " "));
        const method: TokenAuth =
          authorization !== undefined
            ? "client_secret_basic"
            : input.has("client_secret")
              ? "client_secret_post"
              : "none";
        if (!refreshing) lastExchangeAuth = method;
        const client = clientId === undefined ? undefined : clients.get(clientId);
        const presented =
          method === "client_secret_basic"
            ? { clientId: username, secret: password }
            : { clientId: input.get("client_id"), secret: input.get("client_secret") };
        const authChecks = {
          authScheme:
            method !== "client_secret_basic" || authorization?.startsWith("Basic ") === true,
          authMethod: client?.methods.includes(method) === true,
          authClient: clientId !== undefined && presented.clientId === clientId,
          authSecret:
            client !== undefined &&
            (client.secret === null ? method === "none" : presented.secret === client.secret),
        };
        if (refreshing) refreshChecks = { issued: refreshClient !== undefined, ...authChecks };
        else
          tokenChecks = {
            issued: issued !== undefined,
            grant: input.get("grant_type") === "authorization_code",
            redirect: issued !== undefined && input.get("redirect_uri") === issued.redirect,
            pkce:
              issued !== undefined &&
              verifier !== null &&
              createHash("sha256").update(verifier).digest("base64url") === issued.challenge,
            ...authChecks,
          };
        if (
          clientId === undefined ||
          !Object.values(refreshing ? refreshChecks : tokenChecks).every(Boolean)
        )
          return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
        if (code !== null) codes.delete(code);
        const origin = yield* Deferred.await(address);
        const now = Math.floor(Date.now() / 1000);
        // A refreshed ID token carries no nonce (OpenID Connect Core 12.2).
        const nonce = issued?.nonce ?? null;
        const jwt = [
          { alg: idTokenAlgorithm, kid: "synthetic-key", typ: "JWT" },
          {
            iss: idTokenIssuer ?? origin,
            aud: clientId,
            sub: "synthetic-subject",
            iat: now,
            exp: now + 3600,
            ...(nonce === null ? {} : { nonce: invalidNonce ? "wrong-nonce" : nonce }),
          },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
          .join(".");
        const signature =
          idTokenAlgorithm === "ES256"
            ? sign("sha256", Buffer.from(jwt), {
                key: keyPair.privateKey,
                dsaEncoding: "ieee-p1363",
              }).toString("base64url")
            : sign(
                "sha256",
                Buffer.from(jwt),
                (rsaKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey),
              ).toString("base64url");
        const accessToken = refreshing
          ? `synthetic-refreshed-token-${refreshes}`
          : "synthetic-access-token";
        if (refreshing) refreshedAccessTokens.add(accessToken);
        const refreshToken =
          refreshTokens && !refreshing ? `synthetic-refresh-${randomUUID()}` : undefined;
        if (refreshToken !== undefined) refreshGrants.set(refreshToken, clientId);
        return yield* HttpServerResponse.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: expiresIn,
          ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
          ...(includeIdToken ? { id_token: `${jwt}.${signature}` } : {}),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/resource",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        return yield* HttpServerResponse.json({ refreshed: refreshedAccessTokens.has(token) });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/mcp",
      Effect.gen(function* () {
        probes++;
        if (mcpStatus !== undefined) return HttpServerResponse.empty({ status: mcpStatus });
        if (postChallenge) return HttpServerResponse.empty({ status: 405 });
        if (discovery === "no-oauth") return HttpServerResponse.empty({ status: 200 });
        const origin = yield* Deferred.await(address);
        return HttpServerResponse.empty({
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        probes++;
        if (mcpStatus !== undefined) return HttpServerResponse.empty({ status: mcpStatus });
        const origin = yield* Deferred.await(address);
        return HttpServerResponse.empty({
          status: 401,
          headers: challenge
            ? {
                "www-authenticate": `Bearer resource_metadata="${origin}/challenge-resource"`,
              }
            : {},
        });
      }),
    ),
    HttpRouter.add("GET", "/challenge-resource", resource),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      Effect.suspend(() =>
        postChallenge ? Effect.succeed(HttpServerResponse.empty({ status: 404 })) : resource,
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        discoveries++;
        if (discovery === "unavailable") return HttpServerResponse.empty({ status: 503 });
        if (discovery === "missing" || discovery === "no-oauth")
          return HttpServerResponse.empty({ status: 404 });
        if (discovery === "invalid-json")
          return HttpServerResponse.text("PRIVATE_UPSTREAM_DIAGNOSTIC", {
            contentType: "application/json",
          });
        const origin = yield* Deferred.await(address);
        return yield* HttpServerResponse.json({
          issuer: discovery === "invalid-metadata" ? `${origin}/wrong-issuer` : origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: authMethods,
          ...(idTokenAlgorithms === undefined
            ? {}
            : { id_token_signing_alg_values_supported: idTokenAlgorithms }),
          jwks_uri: `${origin}/jwks`,
          scopes_supported: scopes,
          ...(registration
            ? { registration_endpoint: `${origin}/register?fixture=PRIVATE_QUERY` }
            : {}),
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/register",
      Effect.gen(function* () {
        registrations++;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                redirect_uris: Schema.Array(Schema.String),
                token_endpoint_auth_method: Schema.String,
                scope: Schema.optional(Schema.String),
              }),
            ),
          ),
        );
        lastRegistration = { scope: input.scope ?? "", method: input.token_endpoint_auth_method };
        if (registrationStatus === 400)
          return yield* HttpServerResponse.json(
            {
              error: registrationError,
              error_description: "PRIVATE_PROVIDER_ERROR",
            },
            { status: 400 },
          );
        if (!malformedRegistration)
          clients.set(`synthetic-client-${registrations}`, {
            redirects: input.redirect_uris,
            secret: "synthetic-client-secret",
            methods: ["client_secret_basic"],
          });
        return yield* HttpServerResponse.json(
          {
            ...(malformedRegistration ? {} : { client_id: `synthetic-client-${registrations}` }),
            client_secret: "synthetic-client-secret",
            ...(omitSecretExpiry ? {} : { client_secret_expires_at: expiresAt }),
            token_endpoint_auth_method: input.token_endpoint_auth_method,
            redirect_uris: input.redirect_uris,
          },
          { status: registrationStatus },
        );
      }),
    ),
  );
  const listener = yield* Effect.sync(() => createServer());
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
    ),
  );
  // Scenario work has ended. Release unfinished provider requests before the
  // HTTP adapter waits for its listener to close.
  yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("OAuth fixture needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, origin);
  return {
    origin,
    configure: (input: {
      readonly registration?: boolean;
      readonly registrationStatus?: typeof registrationStatus;
      readonly malformedRegistration?: boolean;
      readonly registrationError?: typeof registrationError;
      readonly omitSecretExpiry?: boolean;
      readonly idTokenAlgorithms?: readonly string[];
      readonly includeIdToken?: boolean;
      readonly idTokenIssuer?: string | null;
      readonly idTokenAlgorithm?: "ES256" | "RS256";
      readonly refreshTokens?: boolean;
      readonly expiresIn?: number;
      readonly invalidNonce?: boolean;
      readonly postChallenge?: boolean;
      readonly challenge?: boolean;
      readonly mcpStatus?: 520 | null;
      readonly expiresAt?: number;
      readonly discovery?: typeof discovery;
      readonly scopes?: readonly string[];
      readonly authMethods?: readonly string[];
      readonly callbackIssuer?: string | null;
      readonly browserReturn?: string | null;
    }) =>
      Effect.sync(() => {
        if (input.mcpStatus !== undefined)
          mcpStatus = input.mcpStatus === null ? undefined : input.mcpStatus;
        if (input.postChallenge !== undefined) postChallenge = input.postChallenge;
        if (input.challenge !== undefined) challenge = input.challenge;
        if (input.idTokenAlgorithms !== undefined) idTokenAlgorithms = input.idTokenAlgorithms;
        if (input.includeIdToken !== undefined) includeIdToken = input.includeIdToken;
        if (input.idTokenIssuer !== undefined)
          idTokenIssuer = input.idTokenIssuer === null ? undefined : input.idTokenIssuer;
        if (input.idTokenAlgorithm !== undefined) idTokenAlgorithm = input.idTokenAlgorithm;
        if (input.refreshTokens !== undefined) refreshTokens = input.refreshTokens;
        if (input.expiresIn !== undefined) expiresIn = input.expiresIn;
        if (input.invalidNonce !== undefined) invalidNonce = input.invalidNonce;
        if (input.registrationStatus !== undefined) registrationStatus = input.registrationStatus;
        if (input.malformedRegistration !== undefined)
          malformedRegistration = input.malformedRegistration;
        if (input.registrationError !== undefined) registrationError = input.registrationError;
        if (input.omitSecretExpiry !== undefined) omitSecretExpiry = input.omitSecretExpiry;
        if (input.registration !== undefined) registration = input.registration;
        if (input.expiresAt !== undefined) expiresAt = input.expiresAt;
        if (input.discovery !== undefined) discovery = input.discovery;
        if (input.scopes !== undefined) scopes = [...input.scopes];
        if (input.authMethods !== undefined) authMethods = [...input.authMethods];
        if (input.callbackIssuer !== undefined)
          callbackIssuer = input.callbackIssuer === null ? undefined : input.callbackIssuer;
        if (input.browserReturn !== undefined)
          browserReturn = input.browserReturn === null ? undefined : input.browserReturn;
      }),
    /**
     * Accept a client configured by hand at the service. One with a secret may authenticate with
     * HTTP Basic or the request body, as Google allows; one without is a public PKCE client.
     */
    allowClient: (input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly redirect: string;
    }) =>
      Effect.sync(() => {
        clients.set(input.clientId, {
          redirects: [input.redirect],
          secret: input.clientSecret ?? null,
          methods:
            input.clientSecret === undefined
              ? ["none"]
              : ["client_secret_basic", "client_secret_post"],
        });
      }),
    metrics: Effect.sync(() => ({
      registrations,
      discoveries,
      lastRegistration,
      probes,
      tokenExchanges,
      tokenChecks,
      refreshes,
      refreshChecks,
      lastExchangeAuth,
      nonceRequested,
    })),
  };
});
