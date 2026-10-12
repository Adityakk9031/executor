// ---------------------------------------------------------------------------
// The dashboard's link to Executor v2's workspace import.
//
// v2 imports a v1 organization only when all of these hold (v2's
// `V1Import.choices`), and v1 shows the link under exactly the same rules:
//   1. the signed-in user's email is verified,
//   2. the organization has exactly one active member, and it is that user,
//   3. the organization is not on a paid v1 plan: no Autumn subscription to a
//      plan outside v2's free list that has not expired.
// Every failure to read one of them hides the link. Only the yes/no answer
// leaves the server; memberships and billing never do.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { parseV2Edge, type V2EdgeEnv } from "../edge/marketing";
import { AutumnService, type AutumnSubscription } from "../extensions/billing/service";
import { WorkOSClient } from "./workos";

/** v2's import page, on v2's app host. */
const V2_IMPORT_PATH = "/v1-import";

/**
 * The absolute URL of v2's import page, or `null` where v1 does not hand
 * requests to v2 (local dev without the v2 settings, test workers, or broken
 * settings). v2's app host is the origin of its sign-up page, the same host
 * the edge sends v2 dashboard links to.
 */
export const v2ImportUrl = (env: V2EdgeEnv): URL | null => {
  const edge = parseV2Edge(env);
  if (edge === null || typeof edge === "string") return null;
  return new URL(V2_IMPORT_PATH, edge.signUpUrl.origin);
};

/** v1's plans that cost nothing, as v2's import counts them (v2's
 *  `freePlans`). Every other plan, including one added later, is paid. */
export const V2_IMPORT_FREE_PLAN_IDS: ReadonlyArray<string> = ["free", "free-pay-as-you-go"];

export type V2ImportSubscription = AutumnSubscription;

/** Whether v2 treats the organization as on a paid v1 plan. */
export const isPaidForV2Import = (subscriptions: ReadonlyArray<V2ImportSubscription>): boolean =>
  subscriptions.some(
    (subscription) =>
      !V2_IMPORT_FREE_PLAN_IDS.includes(subscription.planId) && subscription.status !== "expired",
  );

/** The reads the eligibility check makes, each against the system of record. */
export interface V2ImportSource {
  readonly emailVerified: (userId: string) => Effect.Effect<boolean, unknown>;
  /** The user ids of the organization's active members. */
  readonly activeMemberIds: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly subscriptions: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<V2ImportSubscription>, unknown>;
}

/**
 * Whether v2 would let this user import this organization. Reads in order and
 * stops at the first refusal, so most refusals cost one or two calls. Never
 * fails: an unavailable read answers `false`.
 */
export const v2ImportEligible = (
  source: V2ImportSource,
  userId: string,
  organizationId: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* source.emailVerified(userId))) return false;
    const members = yield* source.activeMemberIds(organizationId);
    if (members.length !== 1 || members[0] !== userId) return false;
    return !isPaidForV2Import(yield* source.subscriptions(organizationId));
  }).pipe(
    Effect.orElseSucceed(() => false),
    Effect.withSpan("v2Import.eligible"),
  );

/** The reads over v1's WorkOS (live, not the membership mirror, as v2 reads
 *  them) and Autumn. Billing is read without provisioning: an organization
 *  Autumn has never seen has no subscriptions, so it is free, the same answer
 *  v2 gives for a missing customer. */
export const liveV2ImportSource = Effect.gen(function* () {
  const workos = yield* WorkOSClient;
  const autumn = yield* AutumnService;
  return {
    emailVerified: (userId) =>
      workos.getUser(userId).pipe(Effect.map((user) => user.emailVerified)),
    activeMemberIds: (organizationId) =>
      workos
        .listOrgMembers(organizationId, ["active"])
        .pipe(
          Effect.map((list) =>
            list.data
              .filter((membership) => membership.status === "active")
              .map((membership) => membership.userId),
          ),
        ),
    subscriptions: (organizationId) =>
      autumn
        .findCustomer(organizationId)
        .pipe(Effect.map((customer) => customer?.subscriptions ?? [])),
  } satisfies V2ImportSource;
});
