import { parentPort, workerData } from "node:worker_threads";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import * as Effect from "effect/Effect";
import { evaluateInQuickJs, type QuickJsExecutorOptions } from "./index";

if (parentPort) {
  const port = parentPort;
  const { code, options } = workerData as {
    code: string;
    options: QuickJsExecutorOptions;
  };

  let nextCallId = 1;
  const pendingCalls = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }
  >();

  port.on("message", (msg) => {
    if (msg && typeof msg === "object" && msg.type === "tool_result") {
      const pending = pendingCalls.get(msg.id);
      if (pending) {
        pendingCalls.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.value);
        } else {
          pending.reject(msg.error);
        }
      }
    }
  });

  const workerToolInvoker: SandboxToolInvoker = {
    invoke: ({ path, args }) =>
      Effect.promise(
        () =>
          new Promise((resolve, reject) => {
            const id = nextCallId++;
            pendingCalls.set(id, { resolve, reject });
            port.postMessage({ type: "tool_call", id, path, args });
          }),
      ),
  };

  const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

  evaluateInQuickJs(options, code, workerToolInvoker, runPromise)
    .then((result) => {
      port.postMessage({ type: "done", result });
    })
    .catch((cause) => {
      port.postMessage({ type: "error", error: String(cause) });
    });
}
