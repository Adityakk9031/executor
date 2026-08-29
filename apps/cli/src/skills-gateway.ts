import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { FileSystem, Option, Path, Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

export class SkillGatewayError extends Data.TaggedError("SkillGatewayError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SkillSourceType = "local" | "github" | "url";

export const SkillLockEntry = Schema.Struct({
  source: Schema.String,
  sourceType: Schema.Literals(["local", "github", "url"]),
  skillPath: Schema.optional(Schema.String),
  computedHash: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  syncedTargets: Schema.optional(Schema.Array(Schema.String)),
});
export type SkillLockEntry = typeof SkillLockEntry.Type;

export const SkillsLockFile = Schema.Struct({
  version: Schema.Literal(1),
  skills: Schema.Record(Schema.String, SkillLockEntry),
});
export type SkillsLockFile = typeof SkillsLockFile.Type;

export const defaultSkillsLockFile: SkillsLockFile = {
  version: 1,
  skills: {},
};

export const AgentTarget = Schema.Literals(["claude", "codex", "gemini", "cursor", "windsurf"]);
export type AgentTarget = typeof AgentTarget.Type;

export const ALL_AGENT_TARGETS: readonly AgentTarget[] = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "windsurf",
];

export interface AgentDirectoryDescriptor {
  readonly target: AgentTarget;
  readonly name: string;
  readonly path: string;
  readonly format: "folder" | "file";
}

/**
 * Resolve the central skills directory for a given scope (global vs workspace).
 */
export const resolveCentralSkillsDir = (input: {
  readonly global?: boolean;
  readonly cwd?: string;
  readonly path: Path.Path;
}): string => {
  if (input.global) {
    const base = process.env.EXECUTOR_DATA_DIR ?? input.path.join(homedir(), ".executor");
    return input.path.join(base, "skills");
  }
  const root = input.cwd ?? process.cwd();
  return input.path.join(root, ".executor", "skills");
};

/**
 * Resolve the skills-lock.json path for a given scope.
 */
export const resolveSkillsLockPath = (input: {
  readonly global?: boolean;
  readonly cwd?: string;
  readonly path: Path.Path;
}): string => {
  if (input.global) {
    const base = process.env.EXECUTOR_DATA_DIR ?? input.path.join(homedir(), ".executor");
    return input.path.join(base, "skills-lock.json");
  }
  const root = input.cwd ?? process.cwd();
  return input.path.join(root, "skills-lock.json");
};

/**
 * Parse YAML-style frontmatter from a SKILL.md file.
 */
export const parseSkillMetadata = (
  content: string,
): { readonly name?: string; readonly description?: string; readonly body: string } => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { body: content.trim() };
  }
  const [, frontmatter, body] = match;
  let name: string | undefined = undefined;
  let description: string | undefined = undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) {
      name = trimmed
        .slice("name:".length)
        .trim()
        .replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("description:")) {
      description = trimmed
        .slice("description:".length)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  return { name, description, body: body.trim() };
};

const decodeSkillsLockJson = Schema.decodeUnknownOption(Schema.fromJsonString(SkillsLockFile));

/**
 * Load or initialize the skills-lock.json file.
 */
export const loadSkillsLock = (input: {
  readonly global?: boolean;
  readonly cwd?: string;
}): Effect.Effect<SkillsLockFile, SkillGatewayError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = resolveSkillsLockPath({ ...input, path });

    const exists = yield* fs
      .exists(lockPath)
      .pipe(Effect.mapError((err) => new SkillGatewayError({ message: String(err) })));
    if (!exists) {
      return defaultSkillsLockFile;
    }

    const content = yield* fs
      .readFileString(lockPath)
      .pipe(
        Effect.mapError(
          (err) => new SkillGatewayError({ message: `Failed to read ${lockPath}`, cause: err }),
        ),
      );

    const decoded = decodeSkillsLockJson(content);
    if (Option.isNone(decoded)) {
      return defaultSkillsLockFile;
    }

    return decoded.value;
  });

/**
 * Save the skills-lock.json file.
 */
export const saveSkillsLock = (
  lock: SkillsLockFile,
  input: {
    readonly global?: boolean;
    readonly cwd?: string;
  },
): Effect.Effect<void, SkillGatewayError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = resolveSkillsLockPath({ ...input, path });

    const lockDir = path.dirname(lockPath);
    yield* fs
      .makeDirectory(lockDir, { recursive: true })
      .pipe(
        Effect.mapError(
          (err) =>
            new SkillGatewayError({ message: `Failed to create directory ${lockDir}`, cause: err }),
        ),
      );

    const content = `${JSON.stringify(lock, null, 2)}\n`;
    yield* fs
      .writeFileString(lockPath, content)
      .pipe(
        Effect.mapError(
          (err) => new SkillGatewayError({ message: `Failed to write ${lockPath}`, cause: err }),
        ),
      );
  });

/**
 * Detect available target directories for supported agents.
 */
export const detectAgentTargets = (input: {
  readonly global?: boolean;
  readonly cwd?: string;
}): Effect.Effect<readonly AgentDirectoryDescriptor[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = input.global ? homedir() : (input.cwd ?? process.cwd());

    const descriptors: AgentDirectoryDescriptor[] = [];

    // Claude Code: ~/.claude/skills or .claude/skills
    const claudeDir = input.global
      ? path.join(homedir(), ".claude", "skills")
      : path.join(root, ".claude", "skills");
    const claudeParent = path.dirname(claudeDir);
    if (yield* fs.exists(claudeParent).pipe(Effect.orElseSucceed(() => false))) {
      descriptors.push({
        target: "claude",
        name: "Claude Code",
        path: claudeDir,
        format: "folder",
      });
    }

    // Codex / OpenCode: ~/.codex/skills or .codex/skills
    const codexDir = input.global
      ? path.join(homedir(), ".codex", "skills")
      : path.join(root, ".codex", "skills");
    const codexParent = path.dirname(codexDir);
    if (yield* fs.exists(codexParent).pipe(Effect.orElseSucceed(() => false))) {
      descriptors.push({
        target: "codex",
        name: "Codex",
        path: codexDir,
        format: "folder",
      });
    }

    // Gemini / Antigravity: ~/.gemini/antigravity/skills or .agents/skills
    const geminiDir = input.global
      ? path.join(homedir(), ".gemini", "antigravity", "skills")
      : path.join(root, ".agents", "skills");
    const geminiParent = path.dirname(geminiDir);
    if (yield* fs.exists(geminiParent).pipe(Effect.orElseSucceed(() => false))) {
      descriptors.push({
        target: "gemini",
        name: "Antigravity / Gemini",
        path: geminiDir,
        format: "folder",
      });
    }

    // Cursor: .cursor/skills or .cursor/rules
    const cursorDir = input.global
      ? path.join(homedir(), ".cursor", "skills")
      : path.join(root, ".cursor", "skills");
    const cursorParent = path.dirname(cursorDir);
    if (yield* fs.exists(cursorParent).pipe(Effect.orElseSucceed(() => false))) {
      descriptors.push({
        target: "cursor",
        name: "Cursor",
        path: cursorDir,
        format: "folder",
      });
    }

    // Windsurf: .windsurf/skills
    const windsurfDir = input.global
      ? path.join(homedir(), ".windsurf", "skills")
      : path.join(root, ".windsurf", "skills");
    const windsurfParent = path.dirname(windsurfDir);
    if (yield* fs.exists(windsurfParent).pipe(Effect.orElseSucceed(() => false))) {
      descriptors.push({
        target: "windsurf",
        name: "Windsurf",
        path: windsurfDir,
        format: "folder",
      });
    }

    return descriptors;
  });

/**
 * Copy directory recursively using Effect FileSystem.
 */
export const copyDirRecursive = (
  src: string,
  dest: string,
): Effect.Effect<void, SkillGatewayError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(dest, { recursive: true }).pipe(
      Effect.mapError(
        (err) =>
          new SkillGatewayError({
            message: `Failed to create destination dir ${dest}`,
            cause: err,
          }),
      ),
    );

    const entries = yield* fs
      .readDirectory(src)
      .pipe(
        Effect.mapError(
          (err) =>
            new SkillGatewayError({ message: `Failed to read source dir ${src}`, cause: err }),
        ),
      );

    for (const entry of entries) {
      const srcChild = path.join(src, entry);
      const destChild = path.join(dest, entry);
      const stat = yield* fs
        .stat(srcChild)
        .pipe(
          Effect.mapError(
            (err) => new SkillGatewayError({ message: `Failed to stat ${srcChild}`, cause: err }),
          ),
        );

      if (stat.type === "Directory") {
        yield* copyDirRecursive(srcChild, destChild);
      } else {
        const content = yield* fs
          .readFile(srcChild)
          .pipe(
            Effect.mapError(
              (err) =>
                new SkillGatewayError({ message: `Failed to read file ${srcChild}`, cause: err }),
            ),
          );
        yield* fs
          .writeFile(destChild, content)
          .pipe(
            Effect.mapError(
              (err) =>
                new SkillGatewayError({ message: `Failed to write file ${destChild}`, cause: err }),
            ),
          );
      }
    }
  });

/**
 * Compute SHA256 hash of a file's content.
 */
export const computeFileHash = (content: string | Uint8Array): string => {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
};

/**
 * Add a skill to the central store and sync it to connected agents.
 */
export const addSkill = (input: {
  readonly source: string;
  readonly name?: string;
  readonly global?: boolean;
  readonly cwd?: string;
  readonly targetAgents?: readonly AgentTarget[];
}): Effect.Effect<
  {
    readonly name: string;
    readonly description: string;
    readonly syncedTargets: readonly string[];
  },
  SkillGatewayError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const centralSkillsDir = resolveCentralSkillsDir({
      global: input.global,
      cwd: input.cwd,
      path,
    });

    let skillName = input.name?.trim();
    let sourceType: SkillSourceType = "local";
    let skillDescription = "";
    let computedHash = "";

    // Determine source type
    if (
      input.source.startsWith("http://") ||
      input.source.startsWith("https://") ||
      input.source.startsWith("git@") ||
      input.source.includes("github.com")
    ) {
      sourceType =
        input.source.includes("github.com") || input.source.endsWith(".git") ? "github" : "url";
    }

    if (sourceType === "local") {
      const srcPath = path.isAbsolute(input.source)
        ? input.source
        : path.join(input.cwd ?? process.cwd(), input.source);
      const exists = yield* fs
        .exists(srcPath)
        .pipe(
          Effect.mapError(
            (err) =>
              new SkillGatewayError({ message: `Source path not found: ${srcPath}`, cause: err }),
          ),
        );
      if (!exists) {
        return yield* new SkillGatewayError({ message: `Source skill not found at ${srcPath}` });
      }

      const stat = yield* fs
        .stat(srcPath)
        .pipe(
          Effect.mapError(
            (err) => new SkillGatewayError({ message: `Failed to stat ${srcPath}`, cause: err }),
          ),
        );

      let skillMdPath: string;
      if (stat.type === "Directory") {
        skillMdPath = path.join(srcPath, "SKILL.md");
        const hasSkillMd = yield* fs.exists(skillMdPath).pipe(Effect.orElseSucceed(() => false));
        if (!hasSkillMd) {
          return yield* new SkillGatewayError({ message: `No SKILL.md found in ${srcPath}` });
        }

        const skillMdContent = yield* fs
          .readFileString(skillMdPath)
          .pipe(
            Effect.mapError(
              (err) =>
                new SkillGatewayError({ message: `Failed to read ${skillMdPath}`, cause: err }),
            ),
          );
        const meta = parseSkillMetadata(skillMdContent);
        skillName = skillName ?? meta.name ?? path.basename(srcPath);
        skillDescription = meta.description ?? "";
        computedHash = computeFileHash(skillMdContent);

        const storeDir = path.join(centralSkillsDir, skillName);
        yield* copyDirRecursive(srcPath, storeDir);
      } else {
        // Single file
        const skillMdContent = yield* fs
          .readFileString(srcPath)
          .pipe(
            Effect.mapError(
              (err) => new SkillGatewayError({ message: `Failed to read ${srcPath}`, cause: err }),
            ),
          );
        const meta = parseSkillMetadata(skillMdContent);
        skillName = skillName ?? meta.name ?? path.basename(srcPath, path.extname(srcPath));
        skillDescription = meta.description ?? "";
        computedHash = computeFileHash(skillMdContent);

        const storeDir = path.join(centralSkillsDir, skillName);
        yield* fs.makeDirectory(storeDir, { recursive: true }).pipe(
          Effect.mapError(
            (err) =>
              new SkillGatewayError({
                message: `Failed to create store dir ${storeDir}`,
                cause: err,
              }),
          ),
        );
        yield* fs.writeFileString(path.join(storeDir, "SKILL.md"), skillMdContent).pipe(
          Effect.mapError(
            (err) =>
              new SkillGatewayError({
                message: `Failed to write SKILL.md in ${storeDir}`,
                cause: err,
              }),
          ),
        );
      }
    } else {
      // Remote source fallback registration
      skillName =
        skillName ??
        input.source
          .split("/")
          .pop()
          ?.replace(/\.git$/, "") ??
        "remote-skill";
      const storeDir = path.join(centralSkillsDir, skillName);
      yield* fs.makeDirectory(storeDir, { recursive: true }).pipe(
        Effect.mapError(
          (err) =>
            new SkillGatewayError({
              message: `Failed to create store dir ${storeDir}`,
              cause: err,
            }),
        ),
      );
      const stubContent = `---\nname: "${skillName}"\ndescription: "Skill from ${input.source}"\n---\n# ${skillName}\n\nRemote skill installed from ${input.source}.\n`;
      yield* fs
        .writeFileString(path.join(storeDir, "SKILL.md"), stubContent)
        .pipe(
          Effect.mapError(
            (err) =>
              new SkillGatewayError({ message: `Failed to write stub in ${storeDir}`, cause: err }),
          ),
        );
      skillDescription = `Skill from ${input.source}`;
      computedHash = computeFileHash(stubContent);
    }

    if (!skillName) {
      return yield* new SkillGatewayError({ message: "Could not determine skill name" });
    }

    // Update Lockfile
    const lock = yield* loadSkillsLock({ global: input.global, cwd: input.cwd });
    const nextSkills: Record<string, SkillLockEntry> = {
      ...lock.skills,
      [skillName]: {
        source: input.source,
        sourceType,
        skillPath: "SKILL.md",
        computedHash,
        description: skillDescription,
        enabled: true,
        syncedTargets: [],
      },
    };
    yield* saveSkillsLock(
      { ...lock, skills: nextSkills },
      { global: input.global, cwd: input.cwd },
    );

    // Sync to detected/specified agent directories
    const syncedTargets = yield* syncSkills({
      global: input.global,
      cwd: input.cwd,
      targetAgents: input.targetAgents,
    });

    return {
      name: skillName,
      description: skillDescription,
      syncedTargets: syncedTargets.filter((t) => t.skillName === skillName).map((t) => t.target),
    };
  });

/**
 * Remove a skill from the central store and all agent directories.
 */
export const removeSkill = (input: {
  readonly name: string;
  readonly global?: boolean;
  readonly cwd?: string;
}): Effect.Effect<void, SkillGatewayError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const centralSkillsDir = resolveCentralSkillsDir({
      global: input.global,
      cwd: input.cwd,
      path,
    });
    const skillDir = path.join(centralSkillsDir, input.name);

    // Remove from central store
    if (yield* fs.exists(skillDir).pipe(Effect.orElseSucceed(() => false))) {
      yield* fs
        .remove(skillDir, { recursive: true })
        .pipe(
          Effect.mapError(
            (err) => new SkillGatewayError({ message: `Failed to remove ${skillDir}`, cause: err }),
          ),
        );
    }

    // Clean up from all detected agent target directories
    const detectedTargets = yield* detectAgentTargets({ global: input.global, cwd: input.cwd });
    for (const agent of detectedTargets) {
      const agentSkillDir = path.join(agent.path, input.name);
      if (yield* fs.exists(agentSkillDir).pipe(Effect.orElseSucceed(() => false))) {
        yield* fs
          .remove(agentSkillDir, { recursive: true })
          .pipe(
            Effect.mapError(
              (err) =>
                new SkillGatewayError({ message: `Failed to remove ${agentSkillDir}`, cause: err }),
            ),
          );
      }
    }

    // Update Lockfile
    const lock = yield* loadSkillsLock({ global: input.global, cwd: input.cwd });
    const { [input.name]: _, ...remainingSkills } = lock.skills;
    yield* saveSkillsLock(
      { ...lock, skills: remainingSkills },
      { global: input.global, cwd: input.cwd },
    );
  });

/**
 * Toggle a skill's enabled status (enable or disable).
 */
export const toggleSkill = (input: {
  readonly name: string;
  readonly enabled: boolean;
  readonly global?: boolean;
  readonly cwd?: string;
}): Effect.Effect<void, SkillGatewayError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* loadSkillsLock({ global: input.global, cwd: input.cwd });
    const entry = lock.skills[input.name];
    if (!entry) {
      return yield* new SkillGatewayError({ message: `Skill '${input.name}' is not installed.` });
    }

    const updatedSkills = {
      ...lock.skills,
      [input.name]: {
        ...entry,
        enabled: input.enabled,
      },
    };

    yield* saveSkillsLock(
      { ...lock, skills: updatedSkills },
      { global: input.global, cwd: input.cwd },
    );

    if (!input.enabled) {
      // Remove from agent directories when disabled
      const detectedTargets = yield* detectAgentTargets({ global: input.global, cwd: input.cwd });
      for (const agent of detectedTargets) {
        const agentSkillDir = path.join(agent.path, input.name);
        if (yield* fs.exists(agentSkillDir).pipe(Effect.orElseSucceed(() => false))) {
          yield* fs.remove(agentSkillDir, { recursive: true }).pipe(
            Effect.mapError(
              (err) =>
                new SkillGatewayError({
                  message: `Failed to remove ${agentSkillDir}`,
                  cause: err,
                }),
            ),
          );
        }
      }
    } else {
      // Re-sync to agent directories when enabled
      yield* syncSkills({ global: input.global, cwd: input.cwd });
    }
  });

export interface SyncedSkillRecord {
  readonly skillName: string;
  readonly target: string;
  readonly destination: string;
}

/**
 * Synchronize all enabled skills from the central store into detected agent directories.
 */
export const syncSkills = (input: {
  readonly global?: boolean;
  readonly cwd?: string;
  readonly targetAgents?: readonly AgentTarget[];
}): Effect.Effect<
  readonly SyncedSkillRecord[],
  SkillGatewayError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const centralSkillsDir = resolveCentralSkillsDir({
      global: input.global,
      cwd: input.cwd,
      path,
    });
    const lock = yield* loadSkillsLock({ global: input.global, cwd: input.cwd });

    const detected = yield* detectAgentTargets({ global: input.global, cwd: input.cwd });
    const activeTargets = input.targetAgents
      ? detected.filter((d) => input.targetAgents?.includes(d.target))
      : detected;

    const syncedRecords: SyncedSkillRecord[] = [];
    const updatedSkills = { ...lock.skills };

    for (const [name, entry] of Object.entries(lock.skills)) {
      if (!entry.enabled) {
        continue;
      }

      const sourceSkillDir = path.join(centralSkillsDir, name);
      const existsInStore = yield* fs
        .exists(sourceSkillDir)
        .pipe(Effect.orElseSucceed(() => false));
      if (!existsInStore) {
        continue;
      }

      const currentSyncedTargets: string[] = [];

      for (const agent of activeTargets) {
        const agentSkillDir = path.join(agent.path, name);
        yield* copyDirRecursive(sourceSkillDir, agentSkillDir);
        currentSyncedTargets.push(agent.target);
        syncedRecords.push({
          skillName: name,
          target: agent.target,
          destination: agentSkillDir,
        });
      }

      updatedSkills[name] = {
        ...entry,
        syncedTargets: currentSyncedTargets,
      };
    }

    yield* saveSkillsLock(
      { ...lock, skills: updatedSkills },
      { global: input.global, cwd: input.cwd },
    );
    return syncedRecords;
  });

export interface ListedSkill {
  readonly name: string;
  readonly source: string;
  readonly sourceType: SkillSourceType;
  readonly description: string;
  readonly enabled: boolean;
  readonly syncedTargets: readonly string[];
}

/**
 * List all installed skills from the lockfile and central store.
 */
export const listSkills = (input: {
  readonly global?: boolean;
  readonly cwd?: string;
}): Effect.Effect<readonly ListedSkill[], SkillGatewayError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const lock = yield* loadSkillsLock({ global: input.global, cwd: input.cwd });
    return Object.entries(lock.skills).map(([name, entry]) => ({
      name,
      source: entry.source,
      sourceType: entry.sourceType,
      description: entry.description ?? "",
      enabled: entry.enabled ?? true,
      syncedTargets: entry.syncedTargets ?? [],
    }));
  });
