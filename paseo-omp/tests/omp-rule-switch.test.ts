import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { setOmpRuleEnabledWithDependencies } from "../server/omp-rule-switch";
import { fakeOmp as baseFakeOmp, ProjectConfigSchema } from "./fake-omp-config";

let root: string;
let project: string;

function fakeOmp(disabled: string[]) {
  return baseFakeOmp([], { "ttsr.disabledRules": disabled }, root);
}

async function projectDisabled(): Promise<string[]> {
  const text = await readFile(join(project, ".omp", "config.yml"), "utf8");
  return ProjectConfigSchema.parse(parseYaml(text))?.ttsr?.disabledRules ?? [];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omp-rule-switch-test-"));
  project = join(root, "project");
  await mkdir(project, { recursive: true });
  vi.stubEnv("HOME", join(root, "home"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("turning a rule on or off", () => {
  test("globally, adds and removes the rule in the user list and leaves the others", async () => {
    const fake = fakeOmp(["one"]);
    const off = await setOmpRuleEnabledWithDependencies(
      { name: "two", enabled: false },
      fake.dependencies,
    );
    expect(off).toEqual({ status: "ok" });
    expect(fake.userConfig["ttsr.disabledRules"]).toEqual(["one", "two"]);
    await setOmpRuleEnabledWithDependencies({ name: "one", enabled: true }, fake.dependencies);
    expect(fake.userConfig["ttsr.disabledRules"]).toEqual(["two"]);
  });

  test("turning a rule off twice does not list it twice", async () => {
    const fake = fakeOmp(["one"]);
    await setOmpRuleEnabledWithDependencies({ name: "one", enabled: false }, fake.dependencies);
    expect(fake.userConfig["ttsr.disabledRules"]).toEqual(["one"]);
  });

  test("in a workspace, the project list starts from the user's so their rules stay off", async () => {
    const fake = fakeOmp(["user-off"]);
    await setOmpRuleEnabledWithDependencies(
      { cwd: project, name: "proj-off", enabled: false },
      fake.dependencies,
    );
    expect(await projectDisabled()).toEqual(["user-off", "proj-off"]);
    expect(fake.userConfig["ttsr.disabledRules"]).toEqual(["user-off"]);
  });

  test("turning one rule back on in a workspace does not re-enable the others", async () => {
    const fake = fakeOmp(["user-off"]);
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(
      join(project, ".omp", "config.yml"),
      "ttsr:\n  disabledRules:\n    - user-off\n    - proj-off\nother: 1\n",
    );
    await setOmpRuleEnabledWithDependencies(
      { cwd: project, name: "proj-off", enabled: true },
      fake.dependencies,
    );
    expect(await projectDisabled()).toEqual(["user-off"]);
    expect(await readFile(join(project, ".omp", "config.yml"), "utf8")).toContain("other: 1");
  });

  test("an unusable workspace configuration is an error result, not a rejection", async () => {
    const fake = fakeOmp([]);
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(join(project, ".omp", "config.yml"), "ttsr: [unclosed\n");
    const result = await setOmpRuleEnabledWithDependencies(
      { cwd: project, name: "x", enabled: false },
      fake.dependencies,
    );
    expect(result.status).toBe("error");
  });
});
