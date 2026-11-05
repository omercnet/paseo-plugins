import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  deleteOmpManagedSkillWithDependencies,
  listOmpSkillsWithDependencies,
  type OmpSkillsDependencies,
  setOmpSkillEnabledWithDependencies,
} from "../server/omp-skills";
import type { BoundedRun } from "../server/provider-diagnostics";

const SCRATCH_PREFIX = join(tmpdir(), "paseo-omp-rules-");

let root: string;
let agentDir: string;
let project: string;

function exited(stdout: string): BoundedRun {
  return {
    outcome: "exited",
    stdout,
    truncated: false,
    exitCode: 0,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
  };
}

const ProjectConfigSchema = z
  .object({
    skills: z.object({ ignoredSkills: z.array(z.string()).optional() }).optional(),
    disabledExtensions: z.array(z.string()).optional(),
  })
  .nullable();

type ListName = "skills.ignoredSkills" | "disabledExtensions";

/** A stand-in for omp: a user config plus the project `.omp/config.yml` that replaces its lists. */
function fakeOmp(skills: unknown[], user: Partial<Record<ListName, string[]>> = {}) {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const userConfig: Record<ListName, string[]> = {
    "skills.ignoredSkills": [],
    disabledExtensions: [],
    ...user,
  };
  const dependencies: OmpSkillsDependencies = {
    resolveExecutable: async () => "/usr/bin/omp",
    run: async (_executable, args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "skill") return exited(JSON.stringify({ skills, warnings: [] }));
      const list: ListName =
        args[2] === "disabledExtensions" ? "disabledExtensions" : "skills.ignoredSkills";
      if (args[1] === "set") {
        userConfig[list] = z.array(z.string()).parse(JSON.parse(args[5] ?? "[]"));
        return exited("{}");
      }
      const projectFile = join(cwd, ".omp", "config.yml");
      const projectText = existsSync(projectFile) ? await readFile(projectFile, "utf8") : "";
      const project = ProjectConfigSchema.parse(parseYaml(projectText) ?? null);
      const projectList =
        list === "skills.ignoredSkills"
          ? project?.skills?.ignoredSkills
          : project?.disabledExtensions;
      return exited(JSON.stringify({ value: projectList ?? userConfig[list] }));
    },
    validateProjectConfig: async () => exited("{}"),
    makeScratchDir: (prefix) => mkdtemp(prefix),
    removeDir: async (path) => {
      const ours = path.startsWith(SCRATCH_PREFIX) || path.startsWith(root + sep);
      if (ours) await rm(path, { recursive: true, force: true });
    },
  };
  return { calls, userConfig, dependencies };
}

async function skillFolder(parent: string, name: string): Promise<string> {
  const folder = join(parent, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return folder;
}

async function projectIgnored(): Promise<string[]> {
  const text = await readFile(join(project, ".omp", "config.yml"), "utf8");
  return ProjectConfigSchema.parse(parseYaml(text))?.skills?.ignoredSkills ?? [];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-skills-test-"));
  agentDir = join(root, "agent");
  project = join(root, "project");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  for (const name of [
    "PASEO_OMP_AGENT_DIR",
    "OMP_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_DIR",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("listing skills", () => {
  test("reports source, level and the managed flag, and skips entries it cannot read", async () => {
    const fake = fakeOmp(
      [
        { name: "a", description: "Alpha", baseDir: "/x/a", source: "native:project", hide: false },
        { name: "b", description: null, baseDir: "/x/b", source: "omp-managed:user" },
        { name: "c", baseDir: "/x/c", source: "agents:user" },
        { name: "d", baseDir: "/x/d", source: "registry" },
        { name: "", baseDir: "/x/e", source: "native:user" },
        "junk",
      ],
      {},
    );
    const result = await listOmpSkillsWithDependencies({ cwd: project }, fake.dependencies);
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(
      result.skills.map(({ name, source, level, managed }) => [name, source, level, managed]),
    ).toEqual([
      ["a", "native", "project", false],
      ["b", "omp-managed", "user", true],
      ["c", "agents", "user", false],
      ["d", "registry", "other", false],
    ]);
  });

  test("shows turned-off skills from both lists, only skill entries of disabledExtensions", async () => {
    const fake = fakeOmp([], {
      "skills.ignoredSkills": ["hyper*", " padded ", "hyper*"],
      disabledExtensions: ["skill:learned", "extension:other", "skill:"],
    });
    const result = await listOmpSkillsWithDependencies({ cwd: project }, fake.dependencies);
    expect(result).toEqual({
      status: "ready",
      skills: [],
      off: [
        { list: "skills.ignoredSkills", entry: "hyper*" },
        { list: "skills.ignoredSkills", entry: "padded" },
        { list: "disabledExtensions", entry: "skill:learned" },
      ],
    });
  });

  test("a global listing runs where no project's files can be found", async () => {
    const fake = fakeOmp([]);
    await listOmpSkillsWithDependencies({}, fake.dependencies);
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) expect(call.cwd.startsWith(SCRATCH_PREFIX)).toBe(true);
  });
});

describe("turning a skill on or off", () => {
  test("a user-level change edits the user list through omp", async () => {
    const fake = fakeOmp([], { "skills.ignoredSkills": ["one"] });
    const off = await setOmpSkillEnabledWithDependencies(
      { list: "skills.ignoredSkills", entry: "two", enabled: false },
      fake.dependencies,
    );
    expect(off).toEqual({ status: "ok" });
    expect(fake.userConfig["skills.ignoredSkills"]).toEqual(["one", "two"]);
    await setOmpSkillEnabledWithDependencies(
      { list: "skills.ignoredSkills", entry: "one", enabled: true },
      fake.dependencies,
    );
    expect(fake.userConfig["skills.ignoredSkills"]).toEqual(["two"]);
  });

  test("a workspace change keeps the user's turned-off skills turned off", async () => {
    const fake = fakeOmp([], { "skills.ignoredSkills": ["user-off"] });
    await setOmpSkillEnabledWithDependencies(
      { cwd: project, list: "skills.ignoredSkills", entry: "proj-off", enabled: false },
      fake.dependencies,
    );
    expect(await projectIgnored()).toEqual(["user-off", "proj-off"]);
    expect(fake.userConfig["skills.ignoredSkills"]).toEqual(["user-off"]);
  });

  test("turning a skill on in a workspace builds on the project list, not the user list", async () => {
    const fake = fakeOmp([], { "skills.ignoredSkills": ["user-off"] });
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(
      join(project, ".omp", "config.yml"),
      "skills:\n  ignoredSkills:\n    - keep\n    - drop\nother: 1\n",
    );
    await setOmpSkillEnabledWithDependencies(
      { cwd: project, list: "skills.ignoredSkills", entry: "drop", enabled: true },
      fake.dependencies,
    );
    expect(await projectIgnored()).toEqual(["keep"]);
    expect(await readFile(join(project, ".omp", "config.yml"), "utf8")).toContain("other: 1");
  });

  test("disabledExtensions only takes skill entries", async () => {
    const fake = fakeOmp([]);
    const result = await setOmpSkillEnabledWithDependencies(
      { list: "disabledExtensions", entry: "extension:x", enabled: false },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
    expect(fake.userConfig.disabledExtensions).toEqual([]);
  });

  test("reports an invalid workspace path instead of writing", async () => {
    const fake = fakeOmp([]);
    const result = await setOmpSkillEnabledWithDependencies(
      { cwd: join(root, "missing"), list: "skills.ignoredSkills", entry: "x", enabled: false },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
    expect(existsSync(join(root, "missing"))).toBe(false);
  });
});

describe("deleting a learned skill", () => {
  test("removes a listed managed skill folder", async () => {
    const folder = await skillFolder(join(agentDir, "managed-skills"), "learned");
    const fake = fakeOmp([{ name: "learned", baseDir: folder, source: "omp-managed:user" }]);
    const result = await deleteOmpManagedSkillWithDependencies({ path: folder }, fake.dependencies);
    expect(result).toEqual({ status: "ok" });
    expect(existsSync(folder)).toBe(false);
  });

  test("refuses a skill that is not managed, even if listed", async () => {
    const folder = await skillFolder(join(agentDir, "skills"), "authored");
    const fake = fakeOmp([{ name: "authored", baseDir: folder, source: "native:user" }]);
    const result = await deleteOmpManagedSkillWithDependencies({ path: folder }, fake.dependencies);
    expect(result.status).toBe("error");
    expect(existsSync(folder)).toBe(true);
  });

  test("refuses a path omp does not list", async () => {
    const folder = await skillFolder(join(agentDir, "managed-skills"), "unlisted");
    const fake = fakeOmp([]);
    const result = await deleteOmpManagedSkillWithDependencies({ path: folder }, fake.dependencies);
    expect(result.status).toBe("error");
    expect(existsSync(folder)).toBe(true);
  });

  test("refuses a managed-looking skill outside the managed skills folder", async () => {
    const folder = await skillFolder(join(root, "elsewhere"), "stray");
    const fake = fakeOmp([{ name: "stray", baseDir: folder, source: "omp-managed:user" }]);
    const result = await deleteOmpManagedSkillWithDependencies({ path: folder }, fake.dependencies);
    expect(result.status).toBe("error");
    expect(existsSync(folder)).toBe(true);
  });

  test("refuses a symlinked skill folder and leaves its target alone", async () => {
    const target = await skillFolder(join(root, "elsewhere"), "victim");
    await mkdir(join(agentDir, "managed-skills"), { recursive: true });
    const link = join(agentDir, "managed-skills", "linked");
    await symlink(target, link);
    const fake = fakeOmp([{ name: "linked", baseDir: link, source: "omp-managed:user" }]);
    const result = await deleteOmpManagedSkillWithDependencies({ path: link }, fake.dependencies);
    expect(result.status).toBe("error");
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
  });

  test("refuses when the managed skills folder itself is a symlink", async () => {
    const real = await skillFolder(join(root, "real-managed"), "inside");
    await symlink(join(root, "real-managed"), join(agentDir, "managed-skills"));
    const viaLink = join(agentDir, "managed-skills", "inside");
    const fake = fakeOmp([{ name: "inside", baseDir: viaLink, source: "omp-managed:user" }]);
    const result = await deleteOmpManagedSkillWithDependencies(
      { path: viaLink },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
    expect(existsSync(real)).toBe(true);
  });
});
