/**
 * Private entry point for the app domain controller. A coordinator that wakes in a fresh isolate
 * loads and initializes only this Worker, not the API with its routes, auth and executor.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { PgClient } from "@effect/sql-pg";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
import { Cause, Clock, Effect, Layer, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { cloudAppUiBase } from "./contracts/app-ui.ts";
import { AppDomainZoneSettings } from "./contracts/app-domains.ts";
import { appDomainCertificates } from "./implementation/app-domain-inventory.ts";
import { appDomainHttpClient } from "./implementation/app-domain-http.ts";
import { appDomainState } from "./implementation/app-domain-state.ts";
import { reconcileAppDomainStack } from "./implementation/app-domain-stack.ts";
import { AppDomainController } from "./infrastructure/app-domain-controller-worker.ts";
import { AppDomainCoordinator, AppDomainDrainFailed, Team } from "./infrastructure/app-domains.ts";
import { appDomainControllerToken, sharedAppDomainZone } from "./infrastructure/app-domain-zone.ts";
import { cloudDatabaseConnection } from "./infrastructure/database.ts";
import { previewLifetime } from "./infrastructure/test-stage-expiry.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";

const DomainObservation = Schema.Struct({
  slug: OrganizationSlug,
  status: Schema.Literals(["pending", "ready", "failed"]),
  checkedAt: Schema.Number,
});

const observeDomainFailure = (phase: string, cause: Cause.Cause<unknown>) =>
  Effect.logError("App domain operation failed", {
    phase,
    errors: Cause.prettyErrors(cause).map((error) => ({
      type: /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name) ? error.name : "Error",
      summary: error.message
        .split("\n", 1)[0]
        ?.replace(/"[^"\n]*"|'[^'\n]*'/g, "<value>")
        .replace(/[A-Za-z0-9._~+/=-]{16,}/g, "<value>")
        .slice(0, 180),
      service: /^Service not found: ([A-Za-z0-9_/:. -]+)/.exec(error.message)?.[1],
      frames: (error.stack ?? "")
        .split("\n")
        .slice(1)
        .filter((line) => /^\s+at [A-Za-z0-9_.$<>]+ \([^\s?]+\.js:\d+:\d+\)$/.test(line))
        .slice(0, 4),
    })),
  });

const makeAppDomainCoordinator = Effect.gen(function* () {
  const base = yield* cloudAppUiBase.pipe(Effect.orDie);
  if (base === undefined || new URL(base).protocol !== "https:") {
    return Effect.succeed({
      status: (_team: typeof Team.Type) => Effect.succeed("ready" as const),
      wake: () => Effect.void,
      heartbeat: () => Effect.void,
      alarm: () => Effect.void,
      drain: () => Effect.void,
      resume: () => Effect.void,
    });
  }
  const suffix = new URL(base).hostname;
  const zone = yield* sharedAppDomainZone;
  // Mapped-output defaults include function source, which changes under minification.
  const zoneBinding = yield* Output.named(
    zone.pipe(Output.map((value) => value.zone)),
    "AppDomainZoneSettings",
  );
  const configuration = zoneBinding.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AppDomainZoneSettings)),
  );
  const tokenBinding = yield* Output.named(
    yield* appDomainControllerToken,
    "AppDomainControllerToken",
  );
  const secret = tokenBinding.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Redacted(Schema.NonEmptyString))),
  );
  const connection = yield* cloudDatabaseConnection;
  // Read during initialization, so deployment binds the preview's deadline and policy here too.
  const lifetime = yield* previewLifetime;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lock = yield* Semaphore.make(1);
    const arm = (milliseconds: number) =>
      Effect.gen(function* () {
        if ((yield* lifetime.isBackgroundStopped) || (yield* state.storage.get<boolean>("stopped")))
          return;
        const now = yield* Clock.currentTimeMillis;
        const due = now + milliseconds;
        const existing = yield* state.storage.getAlarm();
        // An alarm whose retries ran out can stay in the past without ever firing again.
        if (existing === null || existing > due || existing < now - 60_000)
          yield* state.storage.setAlarm(due);
      });
    const applyTeams = (teams: ReadonlyArray<typeof Team.Type>) =>
      Effect.gen(function* () {
        const zone = yield* configuration;
        const apiToken = yield* secret;
        yield* reconcileAppDomainStack({
          stage: suffix,
          accountId: zone.accountId,
          zoneId: zone.id,
          zoneName: zone.domain,
          suffix,
          credentials: apiTokenCredentials({ apiToken: Redacted.value(apiToken) }),
          teams,
          state: appDomainState(state.raw.storage, "executor-team-domains", suffix),
        });
      }).pipe(
        Effect.withSpan("app_domains.dns", { attributes: { "app_domains.teams": teams.length } }),
        Effect.tapCause((cause) => observeDomainFailure("dns", cause)),
      );
    const reconcile = lock.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          if (yield* state.storage.get<boolean>("stopped")) return;
          const zone = yield* configuration;
          if (suffix !== zone.domain && !suffix.endsWith(`.${zone.domain}`))
            return yield* Effect.die(new Error("App domain suffix is outside the managed zone"));
          const teams = yield* Effect.scoped(
            Effect.gen(function* () {
              const db = yield* PgClient.layer({
                url: yield* connection.connectionString,
                maxConnections: 1,
                prepare: false,
              }).pipe(Layer.build);
              const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(db));
              return yield* sql`select id, slug from organization`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Team))),
              );
            }),
          ).pipe(Effect.tapCause((cause) => observeDomainFailure("database", cause)));
          const valid = teams.filter((team) => `*.${team.slug}.${suffix}`.length <= 64);
          yield* Effect.annotateCurrentSpan("app_domains.teams", teams.length);
          const apiToken = yield* secret;
          yield* applyTeams(valid);
          const certificates =
            valid.length === 0
              ? []
              : yield* appDomainCertificates(zone.id).pipe(
                  Effect.provideService(
                    Credentials,
                    Effect.succeed(apiTokenCredentials({ apiToken: Redacted.value(apiToken) })),
                  ),
                  Effect.provide(appDomainHttpClient),
                  Effect.withSpan("app_domains.certificates"),
                  Effect.tapCause((cause) => observeDomainFailure("certificates", cause)),
                );
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.annotateCurrentSpan("app_domains.certificates", certificates.length);
          let pending = false;
          for (const team of teams) {
            const hostname = `*.${team.slug}.${suffix}`;
            const matching = Array.from(certificates).filter((certificate) =>
              certificate.hosts?.includes(hostname),
            );
            const ready = matching.some(
              (pack) =>
                pack.status === "active" &&
                pack.certificates.some(
                  (certificate) =>
                    certificate.status === "active" &&
                    certificate.hosts.includes(hostname) &&
                    certificate.expiresOn !== undefined &&
                    certificate.expiresOn !== null &&
                    Date.parse(certificate.expiresOn) > now,
                ),
            );
            const failed =
              hostname.length > 64 ||
              matching.some((certificate) => certificate.status === "validation_timed_out");
            const status = ready
              ? ("ready" as const)
              : failed
                ? ("failed" as const)
                : ("pending" as const);
            pending ||= status === "pending";
            yield* state.storage.put(`team:${team.id}`, {
              slug: team.slug,
              status,
              checkedAt: now,
            });
          }
          yield* state.storage.delete("reconcileError");
          const ids = new Set(teams.map((team) => `team:${team.id}`));
          for (const key of (yield* state.storage.list({ prefix: "team:" })).keys()) {
            if (!ids.has(key)) yield* state.storage.delete(key);
          }
          return pending ? 15_000 : 300_000;
        }),
      ).pipe(
        // A provider can wait five minutes after HTTP 429. Release the lock so
        // a deployment can stop this controller and drain its durable journal.
        Effect.timeout("60 seconds"),
        Effect.withSpan("app_domains.reconcile"),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* observeDomainFailure("reconcile", cause);
            yield* state.storage.put("reconcileError", true);
            return 30_000;
          }),
        ),
      ),
    );
    return {
      status: (input: typeof Team.Type) =>
        Effect.gen(function* () {
          const team = yield* Schema.decodeUnknownEffect(Team)(input);
          if (yield* state.storage.get<boolean>("stopped")) return "failed" as const;
          if (`*.${team.slug}.${suffix}`.length > 64) return "too_long" as const;
          const saved = yield* state.storage.get(`team:${team.id}`);
          const observation =
            saved === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(DomainObservation)(saved);
          if (observation === undefined || observation.slug !== team.slug) {
            // Coalesce concurrent first visits before reading and applying the desired set.
            yield* arm(1_000);
            if (yield* state.storage.get<boolean>("reconcileError")) return "failed" as const;
            return "pending" as const;
          }
          // An old observation is refreshed in the background. Issued certificates do not lapse
          // because a reconciliation was late, so a ready team keeps its link meanwhile.
          if (observation.checkedAt + 300_000 < (yield* Clock.currentTimeMillis)) yield* arm(1_000);
          else if (observation.status !== "ready") yield* arm(15_000);
          return observation.status;
        }),
      wake: () => arm(1_000),
      heartbeat: () => arm(300_000),
      drain: () =>
        Effect.gen(function* () {
          // Stop new work before waiting for an in-flight reconciliation.
          // Queued alarms must not win the lock and start provisioning again.
          yield* state.storage.put("stopped", true);
          yield* state.storage.deleteAlarm();
          yield* lock.withPermits(1)(applyTeams([]));
        }).pipe(Effect.mapError(() => new AppDomainDrainFailed())),
      resume: () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* state.storage.put("stopped", false);
            yield* arm(1);
          }),
        ),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) {
            yield* state.storage.deleteAlarm();
            return;
          }
          // Retries an interrupted pass. A completed pass replaces it with its own schedule,
          // unless a caller asked for an earlier pass meanwhile.
          const retry = (yield* Clock.currentTimeMillis) + 60_000;
          yield* state.storage.setAlarm(retry);
          const next = yield* reconcile;
          if ((yield* state.storage.getAlarm()) === retry) yield* state.storage.deleteAlarm();
          if (next !== undefined) yield* arm(next);
        }),
    };
  });
}).pipe(Effect.orDie);

const AppDomainCoordinatorLive = AppDomainCoordinator.make(makeAppDomainCoordinator);

export default AppDomainController.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: yield* telemetryBindings,
    };
  }),
  Effect.succeed({}).pipe(Effect.provide(Layer.mergeAll(AppDomainCoordinatorLive, cloudTelemetry))),
);
