/**
 * Refuse to ship a host whose `apps` release is not on npm exactly as this checkout builds it.
 * New apps pin the version in `packages/apps/package.json`. A host shipping an unpublished version
 * cannot build them, and a host whose framework changed after that version was published pins
 * new apps to code other than its own.
 *
 * Run `bun run apps:build` first. The staged package is packed as npm would publish it, and every
 * file is compared byte for byte with the published archive. npm packs `package.json` unchanged
 * and publishes the packed archive, so no field is exempt. Comparing unpacked files keeps the
 * check independent of the npm version's tar and gzip output.
 *
 * Pull requests run it with `--allow-unpublished`: a version that is not on npm yet only warns,
 * because a change that bumps the version is published before it merges. A published version
 * whose content differs still fails, so a framework change that forgot the bump fails its PR.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import apps from "../../packages/apps/package.json" with { type: "json" };

const staged = "packages/apps/dist";
const allowUnpublished = process.argv.includes("--allow-unpublished");
const Version = Schema.Struct({ version: Schema.String });
const Published = Schema.Struct({
  dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }),
});
const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));

class AppsReleaseMismatch extends Schema.TaggedError<AppsReleaseMismatch>()("AppsReleaseMismatch", {
  message: Schema.String,
}) {}

const changed = (files: readonly string[]) =>
  new AppsReleaseMismatch({
    message: `packages/apps changed since apps@${apps.version} was published; bump the version in packages/apps/package.json and publish it before releasing or deploying this host. See notes/apps-publishing.md. Differing files (${files.length}): ${files.slice(0, 20).join(", ")}${files.length > 20 ? ", ..." : ""}`,
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;

    const stagedVersion = yield* fs.readFileString(path.join(staged, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Version))),
      Effect.mapError(
        () =>
          new AppsReleaseMismatch({
            message: `${staged} is missing; run bun run apps:build first.`,
          }),
      ),
    );
    if (stagedVersion.version !== apps.version)
      return yield* new AppsReleaseMismatch({
        message: `${staged} holds apps@${stagedVersion.version}, not ${apps.version}; run bun run apps:build again.`,
      });

    const response = yield* http.get(`https://registry.npmjs.org/apps/${apps.version}`);
    const unpublished = `apps@${apps.version} is not published on npm (status ${response.status}). New apps pin this version; publish it before releasing or deploying this host. See notes/apps-publishing.md.`;
    if (response.status === 404 && allowUnpublished)
      return yield* Console.log(`::warning::${unpublished}`);
    if (response.status !== 200) return yield* new AppsReleaseMismatch({ message: unpublished });
    const published = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Published)),
    );
    const archive = yield* http.get(published.dist.tarball);
    const bytes = new Uint8Array(yield* archive.arrayBuffer);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (archive.status !== 200 || integrity !== published.dist.integrity)
      return yield* new AppsReleaseMismatch({
        message: `The npm archive of apps@${apps.version} does not match its registry integrity.`,
      });

    const directory = yield* fs.makeTempDirectoryScoped();
    const unpack = (archivePath: string, name: string) =>
      Effect.gen(function* () {
        const target = path.join(directory, name);
        yield* fs.makeDirectory(target);
        yield* processes.string(ChildProcess.make("tar", ["-xzf", archivePath, "-C", target]));
        return target;
      });
    const packed = yield* processes
      .string(
        ChildProcess.make(
          "npm",
          ["pack", staged, "--json", "--ignore-scripts", "--pack-destination", directory],
          { stdout: "pipe", stderr: "ignore" },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    yield* fs.writeFile(path.join(directory, "published.tgz"), bytes);
    const local = yield* unpack(path.join(directory, packed[0].filename), "staged");
    const remote = yield* unpack(path.join(directory, "published.tgz"), "published");

    const files = (root: string) =>
      fs.readDirectory(root, { recursive: true }).pipe(
        Effect.flatMap((entries) =>
          Effect.filter(entries, (entry) =>
            fs.stat(path.join(root, entry)).pipe(Effect.map((info) => info.type === "File")),
          ),
        ),
        Effect.map((entries) => new Set(entries)),
      );
    const ours = yield* files(local);
    const theirs = yield* files(remote);
    const differing: string[] = [];
    for (const file of [...new Set([...ours, ...theirs])].toSorted()) {
      if (!ours.has(file) || !theirs.has(file)) {
        differing.push(file);
        continue;
      }
      const [left, right] = yield* Effect.all([
        fs.readFile(path.join(local, file)),
        fs.readFile(path.join(remote, file)),
      ]);
      if (Buffer.compare(left, right) !== 0) differing.push(file);
    }
    if (differing.length > 0) return yield* changed(differing);
    yield* Effect.log(`apps@${apps.version} is published on npm and matches ${staged}.`);
  }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
