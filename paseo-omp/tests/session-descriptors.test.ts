import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listOmpSessionDescriptors,
  readOmpPersistedSubagentTranscript,
} from "../server/provider/session-descriptors";

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

    const sessions = await listOmpSessionDescriptors(
      { cwd: "/repo", limit: 10 },
      { OMP_SESSION_DIR: sessionRoot },
    );
    expect(sessions).toEqual([
      expect.objectContaining({ id: SESSION_ID, cwd: "/repo", title: "Safe Title" }),
    ]);
    expect(
      await listOmpSessionDescriptors(
        { cwd: "/repo ", limit: 10 },
        { OMP_SESSION_DIR: sessionRoot },
      ),
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
      await listOmpSessionDescriptors({ cwd: "/repo", limit: 1 }, { OMP_AGENT_DIR: agentDir }),
    ).toHaveLength(1);

    const piRoot = await temporaryRoot();
    const piAgentDir = join(piRoot, "pi-agent");
    await writeSession(join(piAgentDir, "sessions"), "nested", OTHER_ID, "/repo");
    expect(
      (
        await listOmpSessionDescriptors(
          { cwd: "/repo", limit: 1 },
          { PI_CODING_AGENT_DIR: piAgentDir },
        )
      )[0]?.id,
    ).toBe(OTHER_ID);
  });
  test("yields while bounding large junk-root retention", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "large-root");
    await mkdir(sessionRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 1_500 }, (_, index) =>
        writeFile(join(sessionRoot, `junk-${index}.txt`), "junk"),
      ),
    );
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        writeSession(sessionRoot, `nested-${index}`, `bulk_session_${index}`, "/repo"),
      ),
    );
    const yielded = Promise.withResolvers<void>();
    setImmediate(yielded.resolve);
    const scan = listOmpSessionDescriptors(
      { cwd: "/repo", limit: 7 },
      { OMP_SESSION_DIR: sessionRoot },
    );
    await yielded.promise;
    const sessions = await scan;
    expect(sessions.length).toBeLessThanOrEqual(7);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(sessions.length);
  });

  test("reads only canonically owned child transcripts", async () => {
    const root = await temporaryRoot();
    const sessionRoot = join(root, "sessions");
    await writeSession(sessionRoot, "", SESSION_ID, "/repo");
    const parentFile = join(sessionRoot, `2026-09-11T00-00-00-000Z_${SESSION_ID}.jsonl`);
    const childDirectory = parentFile.slice(0, -".jsonl".length);
    await mkdir(childDirectory);
    const childFile = join(childDirectory, "ChildOne.jsonl");
    await writeFile(
      childFile,
      `${JSON.stringify({ type: "session", version: 3, id: OTHER_ID, cwd: "/repo" })}\n${JSON.stringify(
        {
          type: "message",
          message: { role: "assistant", content: "safe child output" },
        },
      )}\n`,
    );

    await expect(
      readOmpPersistedSubagentTranscript(parentFile, "ChildOne", "/repo"),
    ).resolves.toEqual({
      sessionFile: childFile,
      nativeSessionId: OTHER_ID,
      byteLength: expect.any(Number),
      messages: [{ role: "assistant", content: "safe child output" }],
    });
    await expect(
      readOmpPersistedSubagentTranscript(parentFile, "../outside", "/repo"),
    ).rejects.toThrow("Invalid OMP child transcript descriptor");

    const outside = join(root, "outside.jsonl");
    await writeFile(
      outside,
      `${JSON.stringify({ type: "session", version: 3, id: OTHER_ID, cwd: "/repo" })}\n`,
    );
    await symlink(outside, join(childDirectory, "Linked.jsonl"));
    await expect(readOmpPersistedSubagentTranscript(parentFile, "Linked", "/repo")).rejects.toThrow(
      "could not be opened",
    );
  });

  test("rejects unscoped listing", async () => {
    await expect(
      listOmpSessionDescriptors({ cwd: "" }, { OMP_SESSION_DIR: "/tmp/unused" }),
    ).rejects.toThrow("requires an absolute working directory");
  });
});
