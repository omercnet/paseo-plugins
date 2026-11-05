import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  listOmpExtensionsWithDependencies,
  scanExtensions,
  setOmpExtensionEnabledWithDependencies,
} from "../server/omp-extensions";
import { fakeOmp, ProjectConfigSchema } from "./fake-omp-config";

let root: string;
let agentDir: string;
let project: string;

async function file(path: string, text = "export default () => {};\n") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function projectDisabled(): Promise<string[]> {
  const text = await readFile(join(project, ".omp", "config.yml"), "utf8");
  return ProjectConfigSchema.parse(parseYaml(text))?.disabledExtensions ?? [];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-extensions-test-"));
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

describe("scanning the documented folders", () => {
  test("names and ids follow OMP: modules, pre/post hooks by file, tools by file or folder", async () => {
    const omp = join(project, ".omp");
    await file(join(omp, "extensions", "safety.ts"));
    await file(join(omp, "extensions", "pack", "index.js"));
    await file(join(omp, "hooks", "pre", "bash.ts"));
    await file(join(omp, "hooks", "post", "format.sh"));
    await file(join(omp, "tools", "lint.py"));
    await file(join(omp, "tools", "deploy", "index.ts"));
    await file(join(agentDir, "extensions", "personal.js"));
    const items = await scanExtensions(project, agentDir);
    expect(items.map(({ kind, level, name, id }) => [kind, level, name, id])).toEqual([
      ["extension", "project", "safety", "extension-module:safety"],
      ["extension", "project", "pack", "extension-module:pack"],
      ["hook", "project", "pre/bash.ts", "hook:pre:bash:bash.ts"],
      ["hook", "project", "post/format.sh", "hook:post:format:format.sh"],
      ["tool", "project", "lint", "tool:lint"],
      ["tool", "project", "deploy", "tool:deploy"],
      ["extension", "user", "personal", "extension-module:personal"],
    ]);
  });

  test("leaves out what OMP does not load as that kind", async () => {
    const omp = join(project, ".omp");
    await file(join(omp, "extensions", ".hidden.ts"));
    await file(join(omp, "extensions", "types.d.ts"));
    await file(join(omp, "extensions", "notes.md"));
    await file(join(omp, "extensions", "no-index", "helper.ts"));
    await file(join(omp, "hooks", "stray.ts"));
    await file(join(omp, "hooks", "pre", ".dotfile.ts"));
    await file(join(omp, "tools", "metadata.json"));
    await file(join(omp, "tools", "readme.md"));
    expect(await scanExtensions(project, agentDir)).toEqual([]);
  });

  test("a global scan reads only the agent directory", async () => {
    await file(join(project, ".omp", "extensions", "project-only.ts"));
    await file(join(agentDir, "tools", "user-tool.sh"));
    const items = await scanExtensions(undefined, agentDir);
    expect(items.map((item) => item.id)).toEqual(["tool:user-tool"]);
  });

  test("never follows a symlink, at any level", async () => {
    const outside = join(root, "outside");
    await file(join(outside, "real.ts"));
    await file(join(outside, "pack", "index.ts"));
    await file(join(outside, "pre", "bash.ts"));
    const omp = join(project, ".omp");
    await mkdir(join(omp, "extensions"), { recursive: true });
    await symlink(join(outside, "real.ts"), join(omp, "extensions", "linked-file.ts"));
    await symlink(join(outside, "pack"), join(omp, "extensions", "linked-dir"));
    await mkdir(join(omp, "hooks"), { recursive: true });
    await symlink(join(outside, "pre"), join(omp, "hooks", "pre"));
    await symlink(outside, join(omp, "tools"));
    await mkdir(join(agentDir, "hooks"), { recursive: true });
    await symlink(outside, join(agentDir, "hooks", "post"));
    expect(await scanExtensions(project, agentDir)).toEqual([]);
  });

  test("a symlinked .omp directory is not read", async () => {
    const elsewhere = join(root, "elsewhere");
    await file(join(elsewhere, "extensions", "sneaky.ts"));
    await symlink(elsewhere, join(project, ".omp"));
    expect(await scanExtensions(project, agentDir)).toEqual([]);
  });

  test("one row per name: a direct file beats a folder index, then TypeScript beats JavaScript", async () => {
    const ext = join(agentDir, "extensions");
    await file(join(ext, "dup.js"));
    await file(join(ext, "dup.ts"));
    await file(join(ext, "dup2", "index.ts"));
    await file(join(ext, "dup2.js"));
    await file(join(agentDir, "tools", "same.sh"));
    await file(join(agentDir, "tools", "same.py"));
    const items = await scanExtensions(undefined, agentDir);
    const relativeToAgent = (path: string) => relative(agentDir, path).split(sep).join("/");
    expect(items.map(({ id, path }) => [id, relativeToAgent(path)])).toEqual([
      ["extension-module:dup", "extensions/dup.ts"],
      ["extension-module:dup2", "extensions/dup2.js"],
      ["tool:same", "tools/same.py"],
    ]);
  });

  test("a folder whose package.json OMP would read for entries is left out", async () => {
    const ext = join(agentDir, "extensions");
    await file(join(ext, "declared", "index.ts"));
    await file(join(ext, "declared", "package.json"), '{"omp":{"extensions":["./main.ts"]}}');
    await file(join(ext, "declared-pi", "index.ts"));
    await file(join(ext, "declared-pi", "package.json"), '{"pi":{"extensions":["./main.ts"]}}');
    await file(join(ext, "both", "index.ts"));
    await file(join(ext, "both", "package.json"), '{"omp":{"extensions":["./main.ts"]},"pi":{}}');
    await file(join(ext, "oversize", "index.ts"));
    await file(join(ext, "oversize", "package.json"), `{"name":"${"x".repeat(300_000)}"}`);
    const outside = join(root, "outside");
    await file(join(outside, "package.json"), '{"omp":{"extensions":["./main.ts"]}}');
    await file(join(ext, "linked", "index.ts"));
    await symlink(join(outside, "package.json"), join(ext, "linked", "package.json"));
    expect(await scanExtensions(undefined, agentDir)).toEqual([]);
  });

  test("a folder with a plain, empty, broken or pi-only-after-omp manifest is listed", async () => {
    const ext = join(agentDir, "extensions");
    await file(join(ext, "plain", "index.ts"));
    await file(join(ext, "plain", "package.json"), '{"name":"plain"}');
    await file(join(ext, "empty", "index.ts"));
    await file(join(ext, "empty", "package.json"), '{"omp":{"extensions":[]}}');
    await file(join(ext, "broken", "index.ts"));
    await file(join(ext, "broken", "package.json"), "{ not json");
    await file(join(ext, "omp-first", "index.ts"));
    await file(
      join(ext, "omp-first", "package.json"),
      '{"omp":{},"pi":{"extensions":["./main.ts"]}}',
    );
    const items = await scanExtensions(undefined, agentDir);
    expect(items.map((item) => item.name)).toEqual(["broken", "empty", "omp-first", "plain"]);
  });

  test("a symlinked index file or hook file is not listed", async () => {
    const outside = join(root, "outside");
    await file(join(outside, "real.ts"));
    await mkdir(join(agentDir, "extensions", "pack"), { recursive: true });
    await symlink(join(outside, "real.ts"), join(agentDir, "extensions", "pack", "index.ts"));
    await mkdir(join(agentDir, "hooks", "pre"), { recursive: true });
    await symlink(join(outside, "real.ts"), join(agentDir, "hooks", "pre", "bash.ts"));
    expect(await scanExtensions(undefined, agentDir)).toEqual([]);
  });

  test("a folder with a flood of entries is capped", async () => {
    for (let i = 0; i < 230; i += 1) {
      await file(join(agentDir, "extensions", `ext-${String(i).padStart(3, "0")}.ts`));
    }
    const items = await scanExtensions(undefined, agentDir);
    expect(items).toHaveLength(200);
    expect(items[0]?.name).toBe("ext-000");
  });
});

describe("listing", () => {
  test("marks what disabledExtensions turns off, and lists it anyway", async () => {
    await file(join(agentDir, "extensions", "keep.ts"));
    await file(join(agentDir, "extensions", "gone.ts"));
    const fake = fakeOmp([], { disabledExtensions: [" extension-module:gone ", "skill:other"] });
    const result = await listOmpExtensionsWithDependencies({}, fake.dependencies);
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.items.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["gone", false],
      ["keep", true],
    ]);
  });

  test("a workspace list replaces the user list when it has one", async () => {
    await file(join(agentDir, "extensions", "a.ts"));
    await file(join(agentDir, "extensions", "b.ts"));
    const fake = fakeOmp([], { disabledExtensions: ["extension-module:a"] });
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(
      join(project, ".omp", "config.yml"),
      "disabledExtensions:\n  - extension-module:b\n",
    );
    const result = await listOmpExtensionsWithDependencies({ cwd: project }, fake.dependencies);
    if (result.status !== "ready") throw new Error("expected a list");
    expect(result.items.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

describe("turning one on or off", () => {
  test("a user-level change edits the user list through omp", async () => {
    await file(join(agentDir, "tools", "lint.sh"));
    const fake = fakeOmp([], { disabledExtensions: ["context-file:user:CLAUDE.md"] });
    const off = await setOmpExtensionEnabledWithDependencies(
      { id: "tool:lint", enabled: false },
      fake.dependencies,
    );
    expect(off).toEqual({ status: "ok" });
    expect(fake.userConfig.disabledExtensions).toEqual([
      "context-file:user:CLAUDE.md",
      "tool:lint",
    ]);
    await setOmpExtensionEnabledWithDependencies(
      { id: "tool:lint", enabled: true },
      fake.dependencies,
    );
    expect(fake.userConfig.disabledExtensions).toEqual(["context-file:user:CLAUDE.md"]);
  });

  test("a workspace change keeps the user's turned-off entries turned off", async () => {
    await file(join(project, ".omp", "hooks", "pre", "bash.ts"));
    const fake = fakeOmp([], { disabledExtensions: ["extension-module:user-off"] });
    await setOmpExtensionEnabledWithDependencies(
      { cwd: project, id: "hook:pre:bash:bash.ts", enabled: false },
      fake.dependencies,
    );
    expect(await projectDisabled()).toEqual(["extension-module:user-off", "hook:pre:bash:bash.ts"]);
    expect(fake.userConfig.disabledExtensions).toEqual(["extension-module:user-off"]);
  });

  test("refuses an id the scan does not find and writes nothing", async () => {
    await file(join(project, ".omp", "extensions", "real.ts"));
    const fake = fakeOmp([]);
    const before = await readFile(join(project, ".omp", "extensions", "real.ts"), "utf8");
    const result = await setOmpExtensionEnabledWithDependencies(
      { cwd: project, id: "extension-module:invented", enabled: false },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
    expect(fake.userConfig.disabledExtensions).toEqual([]);
    expect(existsSync(join(project, ".omp", "config.yml"))).toBe(false);
    expect(await readFile(join(project, ".omp", "extensions", "real.ts"), "utf8")).toBe(before);
  });
});
