import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  deleteOmpManagedSkillWithDependencies,
  listOmpSkillsWithDependencies,
  setOmpSkillEnabledWithDependencies,
} from "../server/omp-skills";
import {
  fakeOmp as baseFakeOmp,
  exited,
  type ListName,
  ProjectConfigSchema,
} from "./fake-omp-config";

const SCRATCH_PREFIX = join(tmpdir(), "paseo-omp-rules-");

let root: string;
let agentDir: string;
let project: string;

/** The shared fake, with deletions allowed under this test's temp root only. */
function fakeOmp(skills: unknown[], user: Partial<Record<ListName, string[]>> = {}) {
  return baseFakeOmp(skills, user, root);
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
    const fake = fakeOmp([
      { name: "a", description: "Alpha", baseDir: "/x/a", source: "native:project", hide: false },
      { name: "b", description: null, baseDir: "/x/b", source: "omp-managed:user" },
      { name: "c", baseDir: "/x/c", source: "agents:user" },
      { name: "d", baseDir: "/x/d", source: "registry" },
      { name: "", baseDir: "/x/e", source: "native:user" },
      "junk",
    ]);
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

  test("turning a skill on removes its skill: entry from disabledExtensions", async () => {
    const fake = fakeOmp([], { disabledExtensions: ["skill:old", "extension:keep"] });
    const result = await setOmpSkillEnabledWithDependencies(
      { list: "disabledExtensions", entry: "skill:old", enabled: true },
      fake.dependencies,
    );
    expect(result).toEqual({ status: "ok" });
    expect(fake.userConfig.disabledExtensions).toEqual(["extension:keep"]);
  });

  test("a workspace file changed during the write is reported, not overwritten", async () => {
    const fake = fakeOmp([], { "skills.ignoredSkills": ["user-off"] });
    const file = join(project, ".omp", "config.yml");
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(file, "theme: dark\n");
    fake.dependencies.validateProjectConfig = async () => {
      await writeFile(file, "theme: light\n");
      return exited("{}");
    };
    const result = await setOmpSkillEnabledWithDependencies(
      { cwd: project, list: "skills.ignoredSkills", entry: "x", enabled: false },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
    expect(await readFile(file, "utf8")).toBe("theme: light\n");
  });

  test("an unusable workspace configuration is an error result, not a rejection", async () => {
    const fake = fakeOmp([]);
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(join(project, ".omp", "config.yml"), "skills: [unclosed\n");
    const result = await setOmpSkillEnabledWithDependencies(
      { cwd: project, list: "skills.ignoredSkills", entry: "x", enabled: false },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
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
