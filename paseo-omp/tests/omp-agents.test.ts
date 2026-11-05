import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listOmpAgentsWithDependencies } from "../server/omp-agents";

describe("OMP agent discovery", () => {
  let root: string;
  let userDir: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-omp-agents-test-"));
    userDir = join(root, "user");
    project = join(root, "project");
    await mkdir(userDir, { recursive: true });
    await mkdir(join(project, ".omp", "agents"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const bundled = async () => ["task", "scout", "reviewer"];

  test("merges bundled, user and project agents, with the most specific source winning", async () => {
    await writeFile(join(userDir, "mine.md"), "x");
    await writeFile(join(userDir, "scout.md"), "x");
    await writeFile(join(project, ".omp", "agents", "scout.md"), "x");
    await writeFile(join(project, ".omp", "agents", "team-helper.md"), "x");

    const result = await listOmpAgentsWithDependencies(
      { cwd: project },
      { bundledNames: bundled, userAgentsDir: () => userDir },
    );

    expect(result).toEqual({
      agents: [
        { name: "mine", source: "user" },
        { name: "reviewer", source: "bundled" },
        { name: "scout", source: "project" },
        { name: "task", source: "bundled" },
        { name: "team-helper", source: "project" },
      ],
    });
  });

  test("ignores non-markdown files, folders and unusable names, and tolerates missing folders", async () => {
    await writeFile(join(userDir, "notes.txt"), "x");
    await writeFile(join(userDir, " padded .md"), "x");
    await mkdir(join(userDir, "folder.md"));

    const result = await listOmpAgentsWithDependencies(
      { cwd: join(root, "no-such-project") },
      { bundledNames: bundled, userAgentsDir: () => join(root, "no-such-user") },
    );

    expect(result.agents.map(({ name }) => name)).toEqual(["reviewer", "scout", "task"]);
  });

  test("still lists user and project agents when the bundled set cannot be read", async () => {
    await writeFile(join(userDir, "mine.md"), "x");

    const result = await listOmpAgentsWithDependencies(
      {},
      {
        bundledNames: async () => {
          throw new Error("omp missing");
        },
        userAgentsDir: () => userDir,
      },
    );

    expect(result).toEqual({
      agents: [{ name: "mine", source: "user" }],
      error: "Bundled agents could not be listed.",
    });
  });

  test("does not read a project folder for a relative workspace path", async () => {
    const result = await listOmpAgentsWithDependencies(
      { cwd: "relative/project" },
      { bundledNames: bundled, userAgentsDir: () => userDir },
    );
    expect(result.agents.every(({ source }) => source === "bundled")).toBe(true);
  });
});
