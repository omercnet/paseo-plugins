import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promptFileNotices } from "../client/provider-diagnostics-state";
import { readHostAppendPrompt, readOmpPromptFiles } from "../server/omp-prompt-files";
import { withOmpStore } from "../server/paths";

const SCRATCH_PREFIX = join(tmpdir(), "omp-prompt-files-test-");

let root: string;
let agentDir: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(SCRATCH_PREFIX);
  agentDir = join(root, "agent");
  project = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(project, ".omp"), { recursive: true });
});

afterEach(async () => {
  // Only ever removes the scratch directory this test created.
  if (root.startsWith(SCRATCH_PREFIX)) await rm(root, { recursive: true, force: true });
});

function read(cwd: string | undefined, host: boolean | null) {
  return withOmpStore({ agentDir }, () => readOmpPromptFiles(cwd, host));
}

describe("readOmpPromptFiles", () => {
  test("finds APPEND_SYSTEM.md and SYSTEM.md in the agent directory", async () => {
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "be terse");
    await writeFile(join(agentDir, "SYSTEM.md"), "you are a pirate");
    await expect(read(undefined, true)).resolves.toEqual({
      appendSystemFile: true,
      systemFile: true,
      hostAppendPrompt: true,
    });
  });

  test("ignores a missing file, an empty file, and a directory of the same name", async () => {
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "");
    await mkdir(join(agentDir, "SYSTEM.md"));
    await expect(read(undefined, false)).resolves.toEqual({
      appendSystemFile: false,
      systemFile: false,
      hostAppendPrompt: false,
    });
  });

  test("reads a workspace's .omp/ only for a workspace view", async () => {
    await writeFile(join(project, ".omp", "SYSTEM.md"), "project prompt");
    expect((await read(undefined, null)).systemFile).toBe(false);
    expect((await read(project, null)).systemFile).toBe(true);
  });
});

describe("readHostAppendPrompt", () => {
  const host = (prompt: string) =>
    ({ config: { get: async () => ({ config: { appendSystemPrompt: prompt } }) } }) as never;

  test("reports whether Paseo has an Append system prompt, never its text", async () => {
    await expect(readHostAppendPrompt(host("always run tests"))).resolves.toBe(true);
    await expect(readHostAppendPrompt(host(""))).resolves.toBe(false);
    await expect(readHostAppendPrompt(host("  \n"))).resolves.toBe(false);
  });

  test("reports unknown when the host config cannot be read", async () => {
    const refusing = {
      config: {
        get: async () => {
          throw new Error("denied");
        },
      },
    } as never;
    await expect(readHostAppendPrompt(refusing)).resolves.toBeNull();
  });
});

describe("promptFileNotices", () => {
  const base = { appendSystemFile: false, systemFile: false, hostAppendPrompt: false };

  test("says APPEND_SYSTEM.md is replaced when Paseo has an Append system prompt", () => {
    const [notice] = promptFileNotices({ ...base, appendSystemFile: true, hostAppendPrompt: true });
    expect(notice?.file).toBe("APPEND_SYSTEM.md");
    expect(notice?.text).toMatch(/^Replaced by/);
  });

  test("words it as a possibility when the host setting could not be read", () => {
    const [notice] = promptFileNotices({ ...base, appendSystemFile: true, hostAppendPrompt: null });
    expect(notice?.text).toMatch(/^May be replaced/);
  });

  test("raises no APPEND_SYSTEM.md notice when Paseo has no Append system prompt", () => {
    expect(promptFileNotices({ ...base, appendSystemFile: true })).toEqual([]);
  });

  test("says SYSTEM.md turns the default tool policy off, with or without a host prompt", () => {
    for (const hostAppendPrompt of [true, false, null]) {
      const notices = promptFileNotices({ ...base, systemFile: true, hostAppendPrompt });
      expect(notices).toHaveLength(1);
      expect(notices[0]?.file).toBe("SYSTEM.md");
      expect(notices[0]?.text).toContain("tool policy is off");
    }
  });

  test("raises nothing when no prompt file exists", () => {
    expect(promptFileNotices({ ...base, hostAppendPrompt: true })).toEqual([]);
  });
});
