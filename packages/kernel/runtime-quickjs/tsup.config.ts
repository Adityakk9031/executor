import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  noExternal: [/^@executor-js\//],
  external: [/^effect/, /^@effect\//, "quickjs-emscripten"],
});
