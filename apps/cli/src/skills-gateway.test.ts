import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  addSkill,
  detectAgentTargets,
  listSkills,
  loadSkillsLock,
  parseSkillMetadata,
  removeSkill,
  toggleSkill,
} from "./skills-gateway";

const withTmpDir = <A, E, R>(
  body: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "exec-skill-test-"))),
    body,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

describe("parseSkillMetadata", () => {
  it("parses YAML frontmatter name and description", () => {
    const raw = `---
name: "my-custom-skill"
description: "A skill for custom refactorings"
---

# My Custom Skill
Instructions go here.
`;
    const meta = parseSkillMetadata(raw);
    expect(meta.name).toBe("my-custom-skill");
    expect(meta.description).toBe("A skill for custom refactorings");
    expect(meta.body).toContain("# My Custom Skill");
  });

  it("handles markdown without frontmatter", () => {
    const raw = `# Plain Skill\nJust markdown body.`;
    const meta = parseSkillMetadata(raw);
    expect(meta.name).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.body).toBe(raw);
  });
});

describe("skills-gateway operations", () => {
  it.effect(
    "installs a local directory skill, syncs to detected agents, and updates lockfile",
    () =>
      withTmpDir((cwd) =>
        Effect.gen(function* () {
          // Setup source skill
          const sourceSkillDir = join(cwd, "my-source-skill");
          mkdirSync(sourceSkillDir, { recursive: true });
          writeFileSync(
            join(sourceSkillDir, "SKILL.md"),
            `---\nname: "test-skill"\ndescription: "Test skill description"\n---\n# Test Skill Body\n`,
          );
          writeFileSync(join(sourceSkillDir, "helper.sh"), `echo "helper script"`);

          // Setup simulated agent directories in workspace: Claude and Gemini/Agents
          mkdirSync(join(cwd, ".claude"), { recursive: true });
          mkdirSync(join(cwd, ".agents"), { recursive: true });

          // Add skill
          const addResult = yield* addSkill({
            source: sourceSkillDir,
            cwd,
          });

          expect(addResult.name).toBe("test-skill");
          expect(addResult.description).toBe("Test skill description");
          expect(addResult.syncedTargets).toContain("claude");
          expect(addResult.syncedTargets).toContain("gemini");

          // Verify central store has skill
          const lock = yield* loadSkillsLock({ cwd });
          expect(lock.skills["test-skill"]).toBeDefined();
          expect(lock.skills["test-skill"]?.enabled).toBe(true);

          // Verify target folders received the skill and helper scripts
          const list = yield* listSkills({ cwd });
          expect(list).toHaveLength(1);
          expect(list[0]?.name).toBe("test-skill");
          expect(list[0]?.enabled).toBe(true);

          // Toggle disable
          yield* toggleSkill({ name: "test-skill", enabled: false, cwd });
          const listDisabled = yield* listSkills({ cwd });
          expect(listDisabled[0]?.enabled).toBe(false);

          // Toggle re-enable
          yield* toggleSkill({ name: "test-skill", enabled: true, cwd });
          const listReenabled = yield* listSkills({ cwd });
          expect(listReenabled[0]?.enabled).toBe(true);

          // Remove skill
          yield* removeSkill({ name: "test-skill", cwd });
          const listAfterRemove = yield* listSkills({ cwd });
          expect(listAfterRemove).toHaveLength(0);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("detects multiple agent directory formats in workspace", () =>
    withTmpDir((cwd) =>
      Effect.gen(function* () {
        mkdirSync(join(cwd, ".claude"), { recursive: true });
        mkdirSync(join(cwd, ".codex"), { recursive: true });
        mkdirSync(join(cwd, ".cursor"), { recursive: true });

        const targets = yield* detectAgentTargets({ cwd });
        const names = targets.map((t) => t.target);
        expect(names).toContain("claude");
        expect(names).toContain("codex");
        expect(names).toContain("cursor");
        expect(names).not.toContain("windsurf");
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
