/** App domain status for API callers; the AppDomainController Worker hosts the coordinator. */
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { AppUiAddressInvalid } from "@executor-js/hosted-server/app-ui/contracts";
import { OrganizationId, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { UiFailed } from "apps/ui/contracts";
import { Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { timingSafeEqual } from "node:crypto";
import { AppDomainController } from "./app-domain-controller-worker.ts";
import { appDomainControlSecret } from "./app-domain-control.ts";

export const Team = Schema.Struct({ id: OrganizationId, slug: OrganizationSlug });

/** Team DNS could not be emptied; the controller logged the provider failure. */
export class AppDomainDrainFailed extends Schema.TaggedError<AppDomainDrainFailed>()(
  "AppDomainDrainFailed",
  {},
) {}

interface Coordinator {
  /** The team's domain readiness; an unknown or renamed team wakes reconciliation. */
  readonly status: (
    team: typeof Team.Type,
  ) => Effect.Effect<
    "pending" | "ready" | "failed" | "too_long",
    Schema.SchemaError,
    RuntimeContext
  >;
  /** Reconcile soon: a team was created or renamed, or a visitor found no record. */
  readonly wake: () => Effect.Effect<void, never, RuntimeContext>;
  /** Restore a missing schedule without starting an extra pass. */
  readonly heartbeat: () => Effect.Effect<void, never, RuntimeContext>;
  /** Stop reconciliation and remove every team record before the stage is destroyed. */
  readonly drain: () => Effect.Effect<void, AppDomainDrainFailed, RuntimeContext>;
  readonly resume: () => Effect.Effect<void, never, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

/**
 * A single durable object serializes desired-state reconciliation for this deployed stage. The
 * namespace, with its Alchemy resource journal, moved here from the API Worker.
 */
export class AppDomainCoordinator extends Cloudflare.DurableObject<
  AppDomainCoordinator,
  Coordinator
>()("AppDomainCoordinator", { transferredFrom: "Api" }) {}

/**
 * Team creation and renames wake provisioning through the durable provisioning outbox, and visitors
 * wake it on a missing record. The coordinator's own alarm runs a full pass every five minutes,
 * which also removes deleted teams; the cron heartbeat only restores that schedule if it was lost.
 */
export const cloudAppDomains = Effect.gen(function* () {
  const coordinator = yield* AppDomainCoordinator.from(AppDomainController);
  const controlSecret = yield* (yield* appDomainControlSecret).text;
  const heartbeat = Effect.suspend(() => coordinator.getByName("domains").heartbeat()).pipe(
    Effect.provide(RuntimeContext.phantom),
    Effect.withSpan("app_domains.heartbeat.rpc"),
  );
  yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
    heartbeat.pipe(Effect.catchCause(() => Effect.logError("App domain heartbeat failed"))),
  );
  const status = (team: typeof Team.Type) =>
    Effect.suspend(() => coordinator.getByName("domains").status(team)).pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.withSpan("app_domains.status.rpc"),
      Effect.mapError(() => new UiFailed({ reason: "unavailable" })),
      // Expected domain outcomes must survive the Durable Object's RPC serialization.
      Effect.flatMap((status) =>
        status === "too_long"
          ? Effect.fail(new AppUiAddressInvalid({ reason: "too_long" }))
          : Effect.succeed(status),
      ),
    );
  const control = (operation: "resume" | "drain") =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const expected = Buffer.from(`Bearer ${Redacted.value(yield* controlSecret)}`);
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return HttpServerResponse.empty({ status: 404 });
      yield* coordinator.getByName("domains")[operation]();
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))));
  return { status, control };
});
