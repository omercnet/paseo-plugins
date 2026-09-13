import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { ompPersistenceSessionId } from "../server/provider/session";

const SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;

function openWithPersistence(persistence: SessionOpenInput["persistence"]): SessionOpenInput {
  return {
    type: "session.open",
    requestId: "open-persisted",
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

describe("OMP plugin persistence", () => {
  test("accepts the plugin's versioned native session id", () => {
    expect(
      ompPersistenceSessionId(
        openWithPersistence({
          version: 1,
          data: { sessionId: SESSION_ID },
        }),
      ),
    ).toBe(SESSION_ID);
  });

  test("rejects bundled-provider migration envelopes", () => {
    expect(() =>
      ompPersistenceSessionId(
        openWithPersistence({
          version: 0,
          data: {
            source: "paseo-core",
            kind: "resume",
            sessionId: SESSION_ID,
          },
        }),
      ),
    ).toThrow("Unsupported OMP persistence version");
  });
});
