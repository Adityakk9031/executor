/** An authored module that reports which loaded Worker served it and what credentials it saw. */
import { Schema } from "effect";

/**
 * One authored observation: the isolate, its call count, the credential seen before this one and,
 * when the app fetches a resource, the authorization that resource received.
 */
export const Observation = Schema.Struct({
  isolate: Schema.String,
  calls: Schema.Number,
  previous: Schema.NullOr(Schema.String),
  token: Schema.String,
  fetched: Schema.NullOr(Schema.String),
});
/** A workflow run's observation, with the run identifier its body received. */
export const RunObservation = Schema.Struct({ ...Observation.fields, run: Schema.String });

/**
 * Module state survives only while the runtime keeps the same loaded Worker. With a resource URL,
 * each observation also fetches it through the Worker's outbound network with the current token.
 */
export const observer = (resource: string | null) => `let isolate;
let calls = 0;
let seen = null;
const resource = ${JSON.stringify(resource)};
const observe = async (token) => {
  isolate ??= crypto.randomUUID();
  const previous = seen;
  seen = token;
  const observation = { isolate, calls: ++calls, previous, token };
  if (resource === null) return { ...observation, fetched: null };
  const response = await fetch(resource, { headers: { authorization: "Bearer " + token } });
  return { ...observation, fetched: (await response.json()).authorization };
};`;

/**
 * A key-account app whose query and workflow both observe the Worker. Queries of an app with a
 * database run in its data facet; without one, queries and workflows share one Worker.
 */
export const observerApp = (options: {
  readonly name: string;
  readonly database: boolean;
  readonly resource: string | null;
}) => `import { defineApp, defineDatabase, defineProvider, secrets, table, object, string, query, workflow } from "apps";
const service = defineProvider({ name: ${JSON.stringify(options.name)}, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
${observer(options.resource)}
export default defineApp({ accounts: { service }${options.database ? ", database: defineDatabase({ marks: table({ label: string() }) })" : ""} }, {
  queries: { probe: query({ input: object({}) }, async (ctx) => observe(ctx.accounts.service.fields.token)) },
  workflows: { probe: workflow({ input: object({}) }, async (ctx) => ({
    ...(await ctx.step.do("probe", async (step) => observe(step.accounts.service.fields.token))),
    run: ctx.runId,
  })) },
});`;
