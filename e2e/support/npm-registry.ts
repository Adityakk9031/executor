/**
 * A loopback npm registry for product builds. It serves the `apps` package staged from this checkout
 * (`bun run e2e:prepare`) as the version the hosts ship, which new apps pin, so scenarios run before
 * that version is published. Every other request is forwarded to the public registry unchanged.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const upstream = "https://registry.npmjs.org";
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Manifest = Schema.Struct({ name: Schema.Literal("apps"), version: Schema.NonEmptyString });
class RegistryFailed extends Schema.TaggedError<RegistryFailed>()("RegistryFailed", {
  reason: Schema.String,
}) {}

type Reply = { readonly status: number; readonly type: string; readonly body: Uint8Array };

/** Start the registry for the scope and return its origin. */
export const localNpmRegistry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const archive = path.resolve(".local/test-runtime/apps.tgz");
  if (!(yield* fs.exists(archive)))
    return yield* new RegistryFailed({
      reason: "Run bun run e2e:prepare, or apps:build and e2e:apps, to stage apps first.",
    });
  const bytes = yield* fs.readFile(archive);
  const text = yield* processes.string(
    // A relative archive path: GNU tar on Windows reads a drive letter as a remote host.
    ChildProcess.make("tar", ["-xzOf", path.basename(archive), "package/package.json"], {
      cwd: path.dirname(archive),
    }),
  );
  const raw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(text);
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(raw);
  const tarballPath = `/apps/-/apps-${manifest.version}.tgz`;
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");

  const forward = (url: string) =>
    Effect.gen(function* () {
      const response = yield* http.get(`${upstream}${url}`);
      return {
        status: response.status,
        type: response.headers["content-type"] ?? "application/json",
        body: new Uint8Array(yield* response.arrayBuffer),
      } satisfies Reply;
    }).pipe(
      Effect.scoped,
      Effect.catch(() =>
        Effect.succeed({ status: 502, type: "text/plain", body: new Uint8Array() } satisfies Reply),
      ),
    );

  const reply = (url: string, base: string): Effect.Effect<Reply> =>
    Effect.gen(function* () {
      if (url === tarballPath)
        return { status: 200, type: "application/octet-stream", body: bytes } satisfies Reply;
      if (url !== "/apps") return yield* forward(url);
      // Published versions stay as npm serves them; the staged package is added as its version.
      const published = yield* forward(url);
      const packument: typeof JsonObject.Type =
        published.status === 200
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
              new TextDecoder().decode(published.body),
            ).pipe(Effect.orElseSucceed((): typeof JsonObject.Type => ({})))
          : {};
      const versions = Schema.is(JsonObject)(packument.versions) ? packument.versions : {};
      const body = JSON.stringify({
        ...packument,
        name: "apps",
        versions: {
          ...versions,
          [manifest.version]: {
            ...raw,
            dist: { tarball: `${base}${tarballPath}`, integrity, shasum },
          },
        },
      });
      return {
        status: 200,
        type: "application/json",
        body: new TextEncoder().encode(body),
      } satisfies Reply;
    });

  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, response) => {
            const url = request.url ?? "/";
            const address = server.address();
            const base =
              address === null || typeof address === "string"
                ? ""
                : `http://127.0.0.1:${address.port}`;
            Effect.runPromise(reply(url, base)).then(
              (result) => {
                response.writeHead(result.status, { "Content-Type": result.type });
                response.end(result.body);
              },
              () => {
                response.writeHead(500);
                response.end();
              },
            );
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
      catch: () => new RegistryFailed({ reason: "registry listener" }),
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* new RegistryFailed({ reason: "registry address" });
  return { url: `http://127.0.0.1:${address.port}`, version: manifest.version };
});
