import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  listOmpRulesWithDependencies,
  type OmpRulesDependencies,
  parseWatchRules,
} from "../server/omp-rules";
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

interface FakeOmp {
  ttsr?: BoundedRun;
  watch?: unknown[];
  disabled?: string[];
  builtinRules?: boolean;
  scratchDir?: string;
}

function fakeOmp(fake: FakeOmp = {}) {
  const calls: { args: readonly string[]; cwd: string; entries: string[] }[] = [];
  const removed: string[] = [];
  const dependencies: OmpRulesDependencies = {
    resolveExecutable: async () => "/usr/bin/omp",
    run: async (_executable, args, cwd) => {
      calls.push({ args, cwd, entries: readdirSync(cwd) });
      if (args[0] === "ttsr") return fake.ttsr ?? exited(JSON.stringify(fake.watch ?? []));
      if (args[2] === "ttsr.disabledRules") {
        return exited(JSON.stringify({ value: fake.disabled ?? [] }));
      }
      return exited(JSON.stringify({ value: fake.builtinRules ?? true }));
    },
    makeScratchDir: async (prefix) => fake.scratchDir ?? mkdtemp(prefix),
    // Records every removal; only ever deletes a directory with the scratch prefix.
    removeDir: async (path) => {
      removed.push(path);
      if (path.startsWith(SCRATCH_PREFIX)) await rm(path, { recursive: true, force: true });
    },
  };
  return { calls, removed, dependencies };
}

function watchRule(name: string, path: string, provider = "native") {
  return {
    name,
    path,
    provider,
    condition: ["CANARY"],
    astCondition: [],
    question: null,
    scope: ["text"],
    globs: [],
    agents: [],
    description: `${name} description`,
  };
}

async function rule(dir: string, file: string, text: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-rules-test-"));
  agentDir = join(root, "agent");
  project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
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

describe("OMP watch rule parsing", () => {
  test("keeps valid entries, drops odd ones, and bounds text", () => {
    const long = "x".repeat(5_000);
    const parsed = parseWatchRules([
      { ...watchRule("ok", "builtin-defaults:ok.md", "builtin-defaults"), question: long },
      { name: "", path: "x", provider: "native" },
      "not a rule",
      { ...watchRule("lists", "/r/lists.md"), condition: Array(80).fill("a") },
    ]);
    expect(parsed.map((entry) => entry.name)).toEqual(["ok", "lists"]);
    expect(parsed[0]?.question).toHaveLength(2_000);
    expect(parsed[1]?.condition).toHaveLength(50);
  });

  test("rejects output that is not a list", () => {
    expect(() => parseWatchRules({ rules: [] })).toThrow("omp ttsr list");
  });
});

describe("OMP rule listing", () => {
  test("classifies OMP's rule files around the watch list", async () => {
    const projectRules = join(project, ".omp", "rules");
    await rule(
      projectRules,
      "migrations.md",
      '---\ndescription: How we write migrations\nglobs: ["db/**"]\n---\nUse up and down.\n',
    );
    await rule(projectRules, "terse.md", "---\nalwaysApply: true\n---\nBe terse.\n");
    await rule(projectRules, "shared.md", "---\ndescription: Project wins\n---\nbody\n");
    await rule(projectRules, "off.md", "---\nenabled: false\ndescription: Off\n---\nbody\n");
    await rule(projectRules, "plain.md", "No frontmatter, so OMP does not load it.\n");
    await rule(projectRules, "watched.md", "---\ndescription: Also a file\n---\nbody\n");
    await rule(join(agentDir, "rules"), "shared.md", "---\ndescription: User loses\n---\nbody\n");
    await rule(join(agentDir, "rules"), "off.md", "---\ndescription: User copy shows\n---\nx\n");
    await rule(join(agentDir, "rules"), "go-add-cleanup.md", "---\ndescription: Off\n---\nx\n");
    await rule(agentDir, "RULES.md", "---\ndescription: ignored\n---\nUser sticky.\n");
    await rule(join(project, ".omp"), "RULES.md", "Project sticky.\n");
    const { dependencies } = fakeOmp({
      watch: [
        watchRule("watched", join(projectRules, "watched.md")),
        watchRule("no-canary", join(agentDir, "rules", "no-canary.md")),
        watchRule("go-ioutil", "builtin-defaults:go-ioutil.md", "builtin-defaults"),
        watchRule("from-cursor", "/elsewhere/.cursor/rules/x.mdc", "cursor"),
      ],
      disabled: ["go-add-cleanup"],
    });

    const result = await listOmpRulesWithDependencies({ cwd: project }, dependencies);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.disabled).toEqual(["go-add-cleanup"]);
    expect(result.rules.map(({ name, kind, source }) => [name, kind, source])).toEqual([
      ["watched", "watch", "project"],
      ["no-canary", "watch", "user"],
      ["go-ioutil", "watch", "builtin"],
      ["from-cursor", "watch", "imported"],
      ["migrations", "rulebook", "project"],
      ["shared", "rulebook", "project"],
      ["terse", "always", "project"],
      ["off", "rulebook", "user"],
      ["RULES", "always", "user"],
      ["RULES@project", "always", "project"],
    ]);
    expect(result.rules.find((entry) => entry.name === "migrations")).toMatchObject({
      description: "How we write migrations",
      globs: ["db/**"],
      path: join(projectRules, "migrations.md"),
    });
    expect(result.rules.find((entry) => entry.name === "shared")?.description).toBe("Project wins");
  });

  test("does not follow a symlinked rule file", async () => {
    await rule(root, "target.md", "---\ndescription: Linked\n---\nbody\n");
    await mkdir(join(agentDir, "rules"), { recursive: true });
    await symlink(join(root, "target.md"), join(agentDir, "rules", "linked.md"));
    await symlink(join(root, "target.md"), join(agentDir, "RULES.md"));
    const { dependencies } = fakeOmp();

    const result = await listOmpRulesWithDependencies({}, dependencies);

    expect(result).toMatchObject({ status: "ready", rules: [] });
  });

  test("does not read a project whose .omp or .omp/rules is a symlinked directory", async () => {
    const elsewhere = join(root, "elsewhere");
    await rule(elsewhere, "secret.md", "---\ndescription: Not a project rule\n---\nx\n");
    await mkdir(join(project, ".omp"), { recursive: true });
    await symlink(elsewhere, join(project, ".omp", "rules"));
    const other = join(root, "other");
    await mkdir(join(other, ".git"), { recursive: true });
    await mkdir(join(root, "fake-omp"), { recursive: true });
    await symlink(elsewhere, join(root, "fake-omp", "rules"));
    await symlink(join(root, "fake-omp"), join(other, ".omp"));
    const { dependencies } = fakeOmp();

    for (const cwd of [project, other]) {
      await expect(listOmpRulesWithDependencies({ cwd }, dependencies)).resolves.toMatchObject({
        status: "ready",
        rules: [],
      });
    }
  });

  test("lists a workspace opened through a symlinked path", async () => {
    await rule(join(project, ".omp", "rules"), "local.md", "---\nalwaysApply: true\n---\nx\n");
    const link = join(root, "project-link");
    await symlink(project, link);
    const { dependencies } = fakeOmp();

    const result = await listOmpRulesWithDependencies({ cwd: link }, dependencies);

    expect(result.status === "ready" && result.rules.map((entry) => entry.name)).toEqual(["local"]);
  });

  test("the global listing runs in a fresh empty directory and reads no project files", async () => {
    await rule(join(project, ".omp", "rules"), "local.md", "---\nalwaysApply: true\n---\nx\n");
    await rule(join(agentDir, "rules"), "mine.md", "---\ndescription: Mine\n---\nx\n");
    const { calls, removed, dependencies } = fakeOmp({ builtinRules: false });

    const result = await listOmpRulesWithDependencies({}, dependencies);

    expect(result).toMatchObject({ status: "ready", builtinRules: false });
    if (result.status !== "ready") return;
    expect(result.rules.map((entry) => [entry.name, entry.source])).toEqual([["mine", "user"]]);
    expect(calls).toHaveLength(3);
    const scratch = calls[0]?.cwd ?? "";
    expect(scratch.startsWith(SCRATCH_PREFIX)).toBe(true);
    expect(calls.every((call) => call.cwd === scratch && call.entries.length === 0)).toBe(true);
    expect(removed).toEqual([scratch]);
    expect(existsSync(scratch)).toBe(false);
  });

  test.each([
    ["a project directory", () => project],
    ["the temp root", () => tmpdir()],
    ["the bare prefix", () => SCRATCH_PREFIX],
    ["a nested look-alike", () => join(root, "paseo-omp-rules-x")],
  ])("never removes %s handed back as the scratch directory", async (_label, scratch) => {
    const { removed, dependencies } = fakeOmp({ scratchDir: scratch() });

    // The fake omp reads the directory, which may not exist; only the removal matters here.
    await listOmpRulesWithDependencies({}, dependencies).catch(() => undefined);

    expect(removed).toEqual([]);
    expect(existsSync(project)).toBe(true);
  });

  test("a failed cleanup does not hide a successful listing", async () => {
    const { dependencies } = fakeOmp();
    const failing = {
      ...dependencies,
      removeDir: async () => {
        throw new Error("EBUSY");
      },
    };

    await expect(listOmpRulesWithDependencies({}, failing)).resolves.toMatchObject({
      status: "ready",
    });
  });

  test.each([
    ["timeout", { ...exited(""), outcome: "timeout" as const }, "omp ttsr list --json timed out"],
    ["failure", { ...exited(""), exitCode: 1 }, "omp ttsr list --json failed"],
    ["bad JSON", exited("not json"), "omp ttsr list --json gave output the plugin can't read"],
  ])("a %s is reported, never an empty list", async (_label, ttsr, message) => {
    const { dependencies } = fakeOmp({ ttsr });
    await expect(listOmpRulesWithDependencies({ cwd: project }, dependencies)).resolves.toEqual({
      status: "error",
      message,
    });
  });

  test("a missing omp or an invalid workspace is reported", async () => {
    const { dependencies } = fakeOmp();
    await expect(
      listOmpRulesWithDependencies({}, { ...dependencies, resolveExecutable: async () => null }),
    ).resolves.toEqual({ status: "error", message: "The omp command was not found on this host" });
    await expect(
      listOmpRulesWithDependencies({ cwd: "relative/path" }, dependencies),
    ).resolves.toEqual({ status: "error", message: "The workspace path is invalid" });
  });
});
