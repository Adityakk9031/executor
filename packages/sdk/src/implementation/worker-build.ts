/** Compile server and browser source inside workerd using Cloudflare's dependency resolver. */
import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { SourceFiles } from "../contracts/deployment.ts";
import { prepareUiBuild } from "./ui-build.ts";
import { Effect, Path, Schema } from "effect";
import type { Plugin } from "esbuild";
import {
  PublishedAppFramework,
  WorkerBundle,
  type AppFramework,
} from "../contracts/worker-build.ts";
import { appProtocol } from "./app-protocols.ts";
import { browserBuild } from "./worker-browser-build.ts";
import { wasmBuild } from "./worker-wasm-build.ts";
import { workerDependencies } from "./worker-dependencies.ts";
/** Framework for sources that do not declare their own apps dependency. */
export type WorkerFramework = AppFramework;

/**
 * What the compiling host contributes: its framework for sources that do not declare one, and
 * optionally a registry that replaces the public npm registry.
 */
export interface WorkerHost {
  readonly framework: WorkerFramework;
  readonly registry?: string;
}

const frameworkExports = [
  "apps",
  "apps/host",
  "apps/storage/facet",
  "apps/contracts",
  "apps/mcp",
  "apps/graphql",
  "apps/openapi",
  "apps/skills",
  "apps/skills/effect",
  "apps/operations/approval",
];
const frameworkModules = (framework: AppFramework["server"]) => ({
  ...Object.fromEntries(Object.entries(framework).filter(([name]) => name.endsWith(".js"))),
  ...Object.fromEntries(
    frameworkExports.map((name) => [
      name,
      {
        js: `export * from "${name === "apps" ? "./" : "../".repeat(name.split("/").length - 1)}node_modules/apps/${name === "apps" ? "index" : name.slice(5)}.js";`,
      },
    ]),
  ),
});
const quietCompiler: Plugin = {
  name: "private-build-diagnostics",
  setup(build) {
    build.initialOptions.logLevel = "silent";
  },
};

const selectedFramework = (filesystem: InMemoryFileSystem) =>
  Effect.gen(function* () {
    const selected = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PublishedAppFramework),
    )(filesystem.read("node_modules/apps/runtime.json"));
    for (const modules of [selected.server, selected.browser]) {
      if (
        Object.keys(modules).some(
          (name) =>
            !name.startsWith("node_modules/apps/") ||
            !name.endsWith(".js") ||
            name.split("/").includes(".."),
        )
      )
        return yield* new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" });
    }
    return selected;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(RuntimeBuildFailed)(error)
        ? error
        : new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" }),
    ),
  );

/**
 * Compilation returns browser bytes separately; neither imports nor credentials cross from server
 * execution. The selected framework's protocol must be supported before anything compiles.
 */
export const compileWorkerApp = (files: SourceFiles, host: WorkerHost) =>
  Effect.gen(function* () {
    if (files.some((file) => file.path.split("/").includes("node_modules")))
      return yield* new RuntimeBuildFailed({ stage: "source" });
    const filesystem = new InMemoryFileSystem(
      Object.fromEntries(files.map((file) => [file.path, file.content])),
    );
    const dependencies = yield* workerDependencies(filesystem, host.registry);
    const selected = (yield* dependencies.framework)
      ? yield* selectedFramework(filesystem)
      : host.framework;
    const protocol = yield* appProtocol(selected.protocol);
    filesystem.write("__executor_worker.ts", protocol.workerEntry(files));
    const plan = yield* prepareUiBuild(files);
    const browser =
      plan === undefined
        ? undefined
        : yield* browserBuild(files, filesystem, plan, selected.browser);
    const wasm = wasmBuild(filesystem, yield* Path.Path);
    const compiled = yield* Effect.tryPromise({
      try: () =>
        createApp({
          files: filesystem,
          installDependencies: false,
          server: "__executor_worker.ts",
          externals: frameworkExports,
          minify: true,
          jsx: "automatic",
          define: { "process.env.NODE_ENV": '"production"' },
          ...(plan === undefined ? {} : { client: [...plan.entries] }),
          __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
            quietCompiler,
            dependencies.plugin,
            wasm.plugin,
            ...(browser === undefined ? [] : [browser.plugin]),
          ],
        }),
      catch: () => new RuntimeBuildFailed({ stage: "compile" }),
    });
    const bundle = yield* Schema.decodeUnknownEffect(Schema.toType(WorkerBundle))({
      ...compiled,
      modules: { ...compiled.modules, ...frameworkModules(selected.server), ...wasm.modules },
    }).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));
    const ui = browser === undefined ? undefined : yield* browser.finish();
    return { bundle, ui, protocol: selected.protocol };
  }).pipe(Effect.provide(Path.layer), Effect.withSpan("runtime.cloud.compile"));
