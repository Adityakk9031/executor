/** Compile with the app's selected npm framework, or this Cloud deployment's own. */
import { compileWorkerApp, type WorkerFramework } from "@executor-js/sdk/workerd/build";
import type { SourceFiles } from "@executor-js/sdk/core";
import { frameworkProtocol } from "apps/contracts";
import manifest from "apps/package.json" with { type: "json" };
import server from "../../.generated/framework.json" with { type: "json" };
import browser from "../../.generated/browser-framework.json" with { type: "json" };

/** This deployment's framework, for sources that do not declare one. */
const framework: WorkerFramework = {
  protocol: frameworkProtocol,
  version: manifest.version,
  server,
  browser,
};

export const compileCloudApp = (files: SourceFiles, registry: string | undefined) =>
  compileWorkerApp(files, registry === undefined ? { framework } : { framework, registry });
