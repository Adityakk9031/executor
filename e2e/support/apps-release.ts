/**
 * New apps declare the exact `apps` release their host ships. Fixture apps can declare the same
 * release, read from this checkout, which the suite's loopback registry serves; see npm-registry.ts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

const Manifest = Schema.Struct({ version: Schema.NonEmptyString });

/** The version in `packages/apps/package.json`, read from the checkout the suite runs in. */
export const appsVersion = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.resolve("packages/apps/package.json"));
    return (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text)).version;
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** A `package.json` that declares only the host's `apps` release. */
export const appsManifest = {
  path: "package.json",
  content: `${JSON.stringify({ dependencies: { apps: appsVersion } }, null, 2)}\n`,
};

/** Add `apps` to a fixture's own dependencies. */
export const withApps = (dependencies: Readonly<Record<string, string>> = {}) => ({
  apps: appsVersion,
  ...dependencies,
});

const Dependencies = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
);

/** The `apps` version a source's `package.json` declares, if any. */
export const declaredApps = (
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
) => {
  const manifest = files.find((file) => file.path === "package.json");
  return manifest === undefined
    ? undefined
    : Schema.decodeUnknownOption(Dependencies)(manifest.content).pipe(
        Option.map((value) => value.dependencies.apps),
        Option.getOrUndefined,
      );
};
