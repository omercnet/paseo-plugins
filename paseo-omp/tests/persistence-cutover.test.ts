import { describe, expect, test } from "bun:test";
import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import { ompPersistenceSessionId } from "../server/provider/session";

const SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;

function openWithPersistence(persistence: SessionOpenInput["persistence"]): SessionOpenInput {
  return {
    type: "session.open",
    requestId: "open-cutover",
    sessionId: "paseo-session",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    persistence,
    history: "replay",
  };
}

describe("Paseo core OMP persistence cutover", () => {
  test("accepts a stored bundled-provider native handle without changing its session id", () => {
    expect(
      ompPersistenceSessionId(
        openWithPersistence({
          version: 0,
          data: {
            source: "paseo-core",
            kind: "resume",
            sessionId: SESSION_ID,
            nativeHandle: `/sessions/2026-09-12T00-00-00-000Z_${SESSION_ID}.jsonl`,
            metadata: { cwd: "/repo", model: "anthropic/claude-sonnet-4-5" },
          },
        }),
      ),
    ).toBe(SESSION_ID);
  });

  test("converts a legacy import file handle to its native session id", () => {
    expect(
      ompPersistenceSessionId(
        openWithPersistence({
          version: 0,
          data: {
            source: "paseo-core",
            kind: "import",
            providerHandleId: `/sessions/2026-09-12T00-00-00-000Z_${SESSION_ID}.jsonl`,
          },
        }),
      ),
    ).toBe(SESSION_ID);
  });

  test("rejects malformed or extended core persistence envelopes", () => {
    const cases: NonNullable<SessionOpenInput["persistence"]>[] = [
      {
        version: 0,
        data: { source: "other", kind: "resume", sessionId: SESSION_ID },
      },
      {
        version: 0,
        data: { source: "paseo-core", kind: "resume", sessionId: SESSION_ID, extra: true },
      },
      {
        version: 0,
        data: { source: "paseo-core", kind: "import", providerHandleId: "/sessions/not-an-id" },
      },
    ];
    for (const persistence of cases) {
      expect(() => ompPersistenceSessionId(openWithPersistence(persistence))).toThrow();
    }
  });
});
