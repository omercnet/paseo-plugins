import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOmpSessionDescriptors } from "../server/provider/session-descriptors";

const roots: string[] = [];
const SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
const OTHER_ID = "native_session_01";
const EXACT_CWD_ID = "native_exact_cwd_01";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-sessions-"));
  roots.push(root);
  return root;
}

async function writeSession(
  root: string,
  relativeDirectory: string,
  id: string,
  cwd: string,
  preambles: object[] = [],
  suffix: Uint8Array = new Uint8Array(),
): Promise<void> {
  const directory = join(root, relativeDirectory);
  await mkdir(directory, { recursive: true });
  const prefix = `${preambles.map((entry) => JSON.stringify(entry)).join("\n")}${
    preambles.length ? "\n" : ""
  }${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`;
  await writeFile(
    join(directory, `2026-09-11T00-00-00-000Z_${id}.jsonl`),
    Buffer.concat([Buffer.from(prefix), suffix]),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP session descriptor discovery", () => {
  test("discovers nested transcripts only for the requested cwd and sanitizes preamble titles", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "custom-sessions");
    const preamble = [
      { type: "title", title: "  Safe\nTitle\u0007  " },
      { type: "session_info", title: "ignored fallback" },
    ];
    const prefixBytes = Buffer.byteLength(
      `${preamble.map((entry) => JSON.stringify(entry)).join("\n")}\n${JSON.stringify({
        type: "session",
        version: 3,
        id: SESSION_ID,
        cwd: "/repo",
      })}\n`,
    );
    const splitUtf8Suffix = Buffer.concat([
      Buffer.alloc(64 * 1024 - prefixBytes - 1, 0x78),
      Buffer.from("é"),
    ]);
    await writeSession(
      sessionRoot,
      "nested/subagent",
      SESSION_ID,
      "/repo",
      preamble,
      splitUtf8Suffix,
    );
    await writeSession(sessionRoot, "other", OTHER_ID, "/other");
    await writeSession(sessionRoot, "exact", EXACT_CWD_ID, "/repo ");

    const sessions = listOmpSessionDescriptors(
      { cwd: "/repo", limit: 10 },
      { OMP_SESSION_DIR: sessionRoot },
    );
    expect(sessions).toEqual([
      expect.objectContaining({ id: SESSION_ID, cwd: "/repo", title: "Safe Title" }),
    ]);
    expect(
      listOmpSessionDescriptors({ cwd: "/repo ", limit: 10 }, { OMP_SESSION_DIR: sessionRoot }),
    ).toEqual([expect.objectContaining({ id: EXACT_CWD_ID, cwd: "/repo " })]);
  });

  test("resolves configured and environment-specific session roots", async () => {
    const root = await temporaryRoot();
    const agentDir = join(root, "agent");
    const configured = join(root, "configured");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify({ sessionDir: "configured" }));
    await writeSession(configured, "nested", SESSION_ID, "/repo");
    expect(
      listOmpSessionDescriptors({ cwd: "/repo", limit: 1 }, { OMP_AGENT_DIR: agentDir }),
    ).toHaveLength(1);

    const piRoot = await temporaryRoot();
    const piAgentDir = join(piRoot, "pi-agent");
    await writeSession(join(piAgentDir, "sessions"), "nested", OTHER_ID, "/repo");
    expect(
      listOmpSessionDescriptors({ cwd: "/repo", limit: 1 }, { PI_CODING_AGENT_DIR: piAgentDir })[0]
        ?.id,
    ).toBe(OTHER_ID);
  });

  test("rejects unscoped listing", () => {
    expect(() =>
      listOmpSessionDescriptors({ cwd: "" }, { OMP_SESSION_DIR: "/tmp/unused" }),
    ).toThrow("requires an absolute working directory");
  });
});
