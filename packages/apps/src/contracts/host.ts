export * from "./skills.ts";
import { SkillLoadFailed, type SkillFile } from "./skills.ts";
import { ProviderError } from "./provider-error.ts";
import { McpError } from "./mcp.ts";
import { OpenapiResponseError } from "./api-response-error.ts";
export { ApiErrorResponse, OpenapiResponseError } from "./api-response-error.ts";
export { ProviderError } from "./provider-error.ts";
export { McpError } from "./mcp.ts";
import {
  WorkflowFailure,
  type WorkflowExecution,
  type WorkflowReplay,
  type WorkflowHostControls,
} from "./workflows.ts";
export * from "./workflows.ts";
export * from "./failure.ts";
import { DatabaseFieldReserved, DatabaseLimitExceeded } from "@executor-js/app-data/contracts";
export { DatabaseFieldReserved, DatabaseLimitExceeded } from "@executor-js/app-data/contracts";
/** Portable framework dispatch contracts. Requests never carry account bindings. */
import { Context, Schema, type Effect, type Redacted } from "effect";
import type { AppStorage } from "./storage.ts";
import type { InvocationTelemetry } from "@executor-js/telemetry";
export { AppStorageError, AppStorageUnavailable, StorageName, type AppStorage } from "./storage.ts";
import { ElicitationFailed, type ElicitationHandler } from "./elicitation.ts";
export {
  ElicitationLimits,
  defaultElicitationLimits,
  FormElicitation,
  ElicitationResponse,
  ElicitationReply,
  ElicitationFailed,
  type ElicitationHandler,
  ApprovalElicitation,
  ApprovalResponse,
  approvalElicitation,
} from "./elicitation.ts";
export { McpClientLimits, defaultMcpClientLimits } from "./mcp.ts";
export * from "./webhook-protocol.ts";

export { AccountId, HttpUrl } from "./schema.ts";
export { OAuthClientAuth, OAuthSecretClientAuth } from "./provider.ts";

/**
 * The host protocol this framework speaks and its wire schemas. A later protocol replaces this
 * re-export; released protocol modules stay unchanged for host adapters.
 */
export { frameworkProtocol } from "./protocol-version.ts";
export { protocol1 } from "./protocols/1.ts";
export { protocol2 } from "./protocols/2.ts";
export { protocol3 } from "./protocols/3.ts";
import {
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostInputInvalid,
  HostOperationFailed,
  HostOperationNotFound,
  HostOutputInvalid,
  HostRequestInvalid,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
  SkillSources,
  type InvocationDeadline,
  ResolvedAccounts,
  type SkillCatalogResponse,
  type TrustedToolApproval,
} from "./protocols/3.ts";
export {
  DeclaredAuthMethod,
  DeclaredProvider,
  DeclaredRequirements,
  ResolvedAccount,
  ResolvedAccounts,
  TrustedToolApproval,
  InvocationDeadline,
  HostedTool,
  HostedToolSummary,
  SkillSources,
  SkillCatalogResponse,
  HostRequest,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
  HostToolNotFound,
  InputProblem,
  maxInputProblems,
  HostInputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  HostOutputInvalid,
  HostError,
  HostResponse,
  HostInvocation,
} from "./protocols/3.ts";
/** Raw host inputs; the host boundary parses and redacts these immediately. */
export type ResolvedAccountsInput = typeof ResolvedAccounts.Encoded;

/** Trusted invocation context, supplied separately from the Request. */
export interface HostContext {
  /** Trusted host deadline; never accepted in public operation JSON. */
  readonly deadline?: typeof InvocationDeadline.Type;
  /** Host-owned cache storage and refresh lifetime, separate from app database transactions. */
  readonly cache?: import("./cache.ts").HostCache;
  /** Packaged app text files supplied by the build bridge. Direct hosts may omit them for an empty package. */
  readonly files?: readonly SkillFile[];
  /** Private delivery capability. It is never accepted in public request JSON or stored in a build. */
  readonly workflowControls?: WorkflowHostControls;
  readonly workflow?: WorkflowExecution;
  readonly replay?: WorkflowReplay;
  readonly elicitation?: ElicitationHandler;
  /** Trusted in-process tracing capability; never decoded from a public request. */
  readonly telemetry?: InvocationTelemetry;
  readonly approval?: TrustedToolApproval;
  readonly storage?: AppStorage;
  readonly accounts: Redacted.Redacted<ResolvedAccounts>;
}

/** Skill commands. Send sources only to builds that declare skillSources. */
export const skillsCommand = (sources: boolean) =>
  sources ? ({ operation: "skills", sources: true } as const) : ({ operation: "skills" } as const);
export interface SkillCatalog {
  readonly skills: SkillSources["skills"];
  readonly dynamic?: boolean;
  readonly cached?: boolean;
}
export const skillCatalog = (response: typeof SkillCatalogResponse.Type): SkillCatalog =>
  Schema.is(SkillSources)(response) ? response : { skills: response };

/**
 * Inspection commands. Send detail or tools only to builds that declare toolIndex,
 * and scheduled only to builds that declare scheduledTools.
 */
export const inspectCommand = (tools?: readonly string[], scheduled?: true) => ({
  operation: "inspect" as const,
  ...(tools === undefined ? {} : { tools: [...tools] }),
  ...(scheduled === undefined ? {} : { scheduled }),
});
export const indexCommand = { operation: "inspect", detail: "summary" } as const;
/** Keep only the requested tools from an inspection that may have described every tool. */
export const selectTools =
  (tools?: readonly string[]) =>
  <A extends { readonly name: string }>(all: readonly A[]): readonly A[] =>
    tools === undefined ? all : all.filter((tool) => tools.includes(tool.name));

/** Declaration reads do not bind accounts or evaluate the app factory. A named declaration
 * problem, such as a reserved database field, is reported so the deploy can explain it. */
export const HostRequirementsError = Schema.Union([
  HostRequestInvalid,
  HostDeclarationInvalid,
  DatabaseFieldReserved,
]);
/** Inspection can fail while binding accounts or evaluating the live definition. */
export const HostInspectError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostRequestInvalid,
  HostDeclarationInvalid,
  HostAccountsInvalid,
  HostEvaluationFailed,
]);
/** Tool invocation adds lookup, input, execution and output failures to inspection. */
export const HostCallError = Schema.Union([
  OpenapiResponseError,
  WorkflowFailure,
  HostInspectError,
  HostToolNotFound,
  HostOperationNotFound,
  HostOperationFailed,
  DatabaseLimitExceeded,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
]);
/** Queries, mutations and agent calls use the same operation failures. */
export const HostDataError = HostCallError;

/** Invocation-owned outcome sink. Framework adapters report semantic failures
 * independently of successful JSON transport; customer output is never inspected. */
export const ToolResultObservation = Context.Reference<{ readonly failed: () => void }>(
  "apps/ToolResultObservation",
  { defaultValue: () => ({ failed: () => {} }) },
);

/** Native handler; context comes from host authority, never from request content. */
export type AppHandler = (request: Request, context: HostContext) => Effect.Effect<Response>;

export { OperationToolPrefixes, type AppOperation, type OperationContext } from "./operations.ts";

export * from "./schedules.ts";
