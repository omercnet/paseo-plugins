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

function read(cwd: string | undefined, host = false) {
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

  test("counts an empty file, as OMP does, but not a directory of the same name", async () => {
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "");
    await mkdir(join(agentDir, "SYSTEM.md"));
    await expect(read(undefined)).resolves.toMatchObject({
      appendSystemFile: true,
      systemFile: false,
    });
  });

  test("reads a workspace's .omp/ only for a workspace view", async () => {
    await writeFile(join(project, ".omp", "SYSTEM.md"), "project prompt");
    expect((await read(undefined)).systemFile).toBe(false);
    expect((await read(project)).systemFile).toBe(true);
  });

  test("treats a .omp that is a file as having no prompt files", async () => {
    const odd = join(root, "odd");
    await mkdir(odd);
    await writeFile(join(odd, ".omp"), "not a directory");
    await expect(read(odd)).resolves.toMatchObject({ appendSystemFile: false, systemFile: false });
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

  test("lets a host read failure surface instead of guessing", async () => {
    const refusing = {
      config: {
        get: async () => {
          throw new Error("denied");
        },
      },
    } as never;
    await expect(readHostAppendPrompt(refusing)).rejects.toThrow("denied");
  });
});

describe("promptFileNotices", () => {
  const base = { appendSystemFile: false, systemFile: false, hostAppendPrompt: false };

  test("flags APPEND_SYSTEM.md only when Paseo has an Append system prompt", () => {
    const flagged = promptFileNotices({ ...base, appendSystemFile: true, hostAppendPrompt: true });
    expect(flagged.map((notice) => notice.file)).toEqual(["APPEND_SYSTEM.md"]);
    expect(promptFileNotices({ ...base, appendSystemFile: true })).toEqual([]);
  });

  test("flags SYSTEM.md with or without a host prompt", () => {
    for (const hostAppendPrompt of [true, false]) {
      const notices = promptFileNotices({ ...base, systemFile: true, hostAppendPrompt });
      expect(notices.map((notice) => notice.file)).toEqual(["SYSTEM.md"]);
    }
  });

  test("lists both, and nothing when no prompt file exists", () => {
    expect(
      promptFileNotices({ appendSystemFile: true, systemFile: true, hostAppendPrompt: true }).map(
        (notice) => notice.file,
      ),
    ).toEqual(["APPEND_SYSTEM.md", "SYSTEM.md"]);
    expect(promptFileNotices({ ...base, hostAppendPrompt: true })).toEqual([]);
  });
});
