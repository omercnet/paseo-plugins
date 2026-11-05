import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveListOmpSessions } from "../server/sessions";

const temporaryDirectories: string[] = [];

async function writeSession(agentDir: string, id: string, cwd: string, prompts: string[]) {
  const directory = join(agentDir, "sessions", cwd.replaceAll("/", "-"));
  await mkdir(directory, { recursive: true });
  const lines = [
    { type: "title", v: 1, title: `Title ${id}` },
    { type: "session", version: 3, id, cwd },
    ...prompts.map((text) => ({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
    })),
  ];
  await writeFile(
    join(directory, `2026-11-05T09-04-17-959Z_${id}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

beforeEach(() => {
  vi.stubEnv("OMP_SESSION_DIR", undefined);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("omp sessions reader", () => {
  test("lists this directory's session files without OMP's interactive prompt history", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "paseo-omp-sessions-"));
    temporaryDirectories.push(agentDir);
    await writeSession(agentDir, "session_a", "/work/a", ["first prompt", "second prompt"]);
    await writeSession(agentDir, "session_b", "/work/b", ["other directory"]);
    vi.stubEnv("PASEO_OMP_AGENT_DIR", agentDir);

    expect(await resolveListOmpSessions({ cwd: "/work/a" })).toEqual({
      sessions: [
        {
          sessionId: "session_a",
          title: "Title session_a",
          prompt: "first prompt",
          updatedAt: expect.any(String),
        },
      ],
    });
  });

  test("returns no sessions when the store has no session root", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "paseo-omp-sessions-empty-"));
    temporaryDirectories.push(agentDir);
    vi.stubEnv("PASEO_OMP_AGENT_DIR", agentDir);

    expect(await resolveListOmpSessions({ cwd: "/work/a" })).toEqual({ sessions: [] });
  });
});
