import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listOmpAgentsWithDependencies, scratchOmpEnvironment } from "../server/omp-agents";

function agentFile(name: string, description = "does things"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;
}

describe("OMP agent discovery", () => {
  let root: string;
  let userDir: string;
  let projectAgents: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-omp-agents-test-"));
    userDir = join(root, "user");
    project = join(root, "project");
    projectAgents = join(project, ".omp", "agents");
    await mkdir(userDir, { recursive: true });
    await mkdir(projectAgents, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const bundled = async () => ["task", "scout", "reviewer"];

  test("merges bundled, user and project agents, with the most specific source winning", async () => {
    await writeFile(join(userDir, "mine.md"), agentFile("mine"));
    await writeFile(join(userDir, "scout.md"), agentFile("scout"));
    await writeFile(join(projectAgents, "scout.md"), agentFile("scout"));
    await writeFile(join(projectAgents, "team-helper.md"), agentFile("team-helper"));

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

  test("uses the frontmatter name OMP registers, not the file name", async () => {
    await writeFile(join(userDir, "helper.md"), agentFile("reviewer"));
    await writeFile(join(userDir, "spaced.md"), agentFile("  padded  "));

    const result = await listOmpAgentsWithDependencies(
      {},
      { bundledNames: async () => [], userAgentsDir: () => userDir },
    );

    expect(result.agents).toEqual([
      { name: "padded", source: "user" },
      { name: "reviewer", source: "user" },
    ]);
  });

  test("skips files OMP would not load as agents", async () => {
    await writeFile(join(userDir, "notes.txt"), agentFile("notes"));
    await writeFile(join(userDir, "no-frontmatter.md"), "just text");
    await writeFile(join(userDir, "no-description.md"), "---\nname: nodesc\n---\nBody\n");
    await writeFile(join(userDir, "no-name.md"), "---\ndescription: x\n---\nBody\n");
    await writeFile(join(userDir, "bad-yaml.md"), "---\nname: [unclosed\ndescription: x\n---\n");
    await writeFile(join(userDir, "non-string.md"), "---\nname: 42\ndescription: x\n---\n");
    await mkdir(join(userDir, "folder.md"));
    await writeFile(join(userDir, "ok.md"), agentFile("ok"));

    const result = await listOmpAgentsWithDependencies(
      {},
      { bundledNames: async () => [], userAgentsDir: () => userDir },
    );

    expect(result.agents).toEqual([{ name: "ok", source: "user" }]);
  });

  test("tolerates missing user and project folders", async () => {
    const result = await listOmpAgentsWithDependencies(
      { cwd: join(root, "no-such-project") },
      { bundledNames: bundled, userAgentsDir: () => join(root, "no-such-user") },
    );

    expect(result.agents.map(({ name }) => name)).toEqual(["reviewer", "scout", "task"]);
  });

  test("still lists user and project agents when the bundled set cannot be read", async () => {
    await writeFile(join(userDir, "mine.md"), agentFile("mine"));

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

describe("bundled agent unpack environment", () => {
  test("drops every inherited variable that can relocate OMP and homes it in the scratch folder", () => {
    const environment = scratchOmpEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/real",
        OMP_PROFILE: "work",
        PI_PROFILE: "work",
        PI_CONFIG_DIR: "../../outside",
        PI_CODING_AGENT_DIR: "/home/real/.omp/agent",
        PASEO_OMP_AGENT_DIR: "/home/real/agent",
        XDG_DATA_HOME: "/home/real/.local/share",
        XDG_STATE_HOME: "/home/real/.local/state",
        XDG_CACHE_HOME: "/home/real/.cache",
        XDG_CONFIG_HOME: "/home/real/.config",
      },
      "/tmp/scratch",
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/scratch",
      USERPROFILE: "/tmp/scratch",
      PI_CODING_AGENT_DIR: join("/tmp/scratch", "agent"),
    });
  });
});
