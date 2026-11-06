import { expect, test, vi } from "vitest";
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
      config: { providers: { "claude-work": { extends: "claude" } } },
    }),
  },
};

test("registers only the agent.create hook", () => {
  expect([...capture().keys()]).toEqual(["agent.create"]);
});

test("agent.create hook resolves derived providers through the hook context", async () => {
  const hook = capture().get("agent.create");
  const result = (await hook?.(
    { request: { config: { provider: "claude-work", cwd: "/work" } } },
    { paseo },
  )) as { config: { mcpServers: Record<string, unknown> } };

  expect(result.config.mcpServers["context-mode"]).toEqual({
    type: "stdio",
    command: "/bin/context-mode",
    args: ["server", "--agent", "claude-code"],
    env: { CONTEXT_MODE_DATA_DIR: expect.any(String) },
  });
});
