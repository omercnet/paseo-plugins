import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { ContextModeSettingsSchema } from "../shared";

vi.mock("../server/binary", () => ({
  resolveContextModeBinary: async () => ({
    state: "found",
    path: "/bin/context-mode",
    source: "path",
    launch: { program: "/bin/context-mode", args: [] },
  }),
}));

beforeEach(() => {
  for (const name of ["CONTEXT_MODE_DIR", "CONTEXT_MODE_DATA_DIR", "CLAUDE_CONFIG_DIR"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type BeforeHandler = (input: { request: unknown }, context: { paseo: unknown }) => Promise<unknown>;

function capture() {
  const before = new Map<string, BeforeHandler>();
  const server = {
    registerSettings: () => ({
      read: async () => ({
        status: "ready",
        revision: "test",
        values: ContextModeSettingsSchema.parse({ preferNativeIntegrations: false }),
      }),
      subscribe: () => () => {},
    }),
    handle: () => {},
    before: (name: string, handler: BeforeHandler) => before.set(name, handler),
  };
  contribute(server as never);
  return before;
}

const paseo = {
  config: {
    get: async () => ({
      config: {
        providers: {
          "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/srv/claude-work" } },
        },
      },
    }),
  },
};

test("agent.create hook resolves derived providers through the hook context", async () => {
  const hook = capture().get("agent.create");
  const result = (await hook?.(
    { request: { config: { provider: "claude-work", cwd: "/work" } } },
    { paseo },
  )) as { config: { mcpServers: Record<string, { env: Record<string, string> }> } };

  expect(result.config.mcpServers["context-mode"].env).toEqual({
    CONTEXT_MODE_PLATFORM: "claude-code",
    CONTEXT_MODE_DIR: join("/srv/claude-work", "context-mode"),
  });
});

test("agent.session_open hook resolves derived providers through the hook context", async () => {
  const hook = capture().get("agent.session_open");
  const result = (await hook?.(
    { request: { provider: "claude-work", cwd: "/work", env: {} } },
    { paseo },
  )) as { env: Record<string, string> };

  expect(result.env.CONTEXT_MODE_DIR).toBe(join("/srv/claude-work", "context-mode"));
});
