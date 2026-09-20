import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createIntegrationAudit,
  injectContextModeEnvironment,
  injectContextModeOnCreate,
} from "../server/integration";
import { ContextModeSettingsSchema } from "../shared";

const launch = {
  program: "/usr/bin/node",
  args: ["/plugin/node_modules/context-mode/cli.bundle.mjs"],
};

describe("provider-aware Context Mode activation", () => {
  test("prefers a native registration found in the provider's authoritative config", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const request = {
      config: { provider: "claude", cwd: "/work", mcpServers: {} },
    };
    const probes: Array<[string, string]> = [];
    const result = await injectContextModeOnCreate(request, settings, launch, {
      home: "/home/test",
      pathExists: async () => false,
      fileContains: async (path, marker) => {
        probes.push([path, marker]);
        return path === join("/home/test", ".claude", "settings.json") && marker === "context-mode";
      },
    });

    expect(result).toBe(request);
    expect(probes).toEqual([[join("/home/test", ".claude", "settings.json"), "context-mode"]]);
  });

  test("injects the bundled MCP fallback while preserving existing MCP and request environment", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const request = {
      config: {
        provider: "cursor",
        cwd: "/work",
        mcpServers: { existing: { type: "http", url: "https://example.test/mcp" } },
      },
      env: { KEEP: "yes" },
    };
    const result = await injectContextModeOnCreate(request, settings, launch, {
      home: "/home/test",
      pathExists: async (path) => path === join("/home/test", ".cursor", "context-mode"),
      fileContains: async () => false,
    });

    expect(result.env).toBe(request.env);
    expect(result.config.mcpServers).toEqual({
      existing: { type: "http", url: "https://example.test/mcp" },
      "context-mode": {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/plugin/node_modules/context-mode/cli.bundle.mjs"],
        env: {
          CONTEXT_MODE_PLATFORM: "cursor",
          CONTEXT_MODE_DIR: join("/home/test", ".cursor", "context-mode"),
        },
      },
    });
  });

  test("never replaces an explicitly configured Context Mode MCP server", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const request = {
      config: {
        provider: "codex",
        mcpServers: {
          "context-mode": { type: "http", url: "https://context.example.test/mcp" },
          existing: { type: "http", url: "https://example.test/mcp" },
        },
      },
      env: { KEEP: "yes" },
    };

    expect(await injectContextModeOnCreate(request, settings, launch)).toBe(request);
  });

  test("leaves unknown providers unchanged on creation and session open", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const createRequest = {
      config: { provider: "omp-pluginish", cwd: "/work", mcpServers: {} },
      env: { KEEP: "yes" },
    };
    const openRequest = {
      provider: "omp-pluginish",
      cwd: "/work",
      env: { KEEP: "yes" },
    };

    expect(await injectContextModeOnCreate(createRequest, settings, launch)).toBe(createRequest);
    expect(await injectContextModeEnvironment(openRequest, settings)).toBe(openRequest);
  });

  test("maps OMP plugin profile provider IDs to the OMP adapter", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const request = {
      config: { provider: "omp-plugin-team-beta", cwd: "/work", mcpServers: {} },
    };
    const result = await injectContextModeOnCreate(request, settings, launch, {
      home: "/home/test",
      pathExists: async (path) => path === join("/home/test", ".omp", "context-mode"),
      fileContains: async () => false,
    });

    expect(result.config.mcpServers).toMatchObject({
      "context-mode": {
        env: {
          CONTEXT_MODE_PLATFORM: "omp",
          CONTEXT_MODE_DIR: join("/home/test", ".omp", "context-mode"),
        },
      },
    });
  });

  test("honors explicit Context Mode environment values over generated defaults", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const createRequest = {
      config: { provider: "codex", cwd: "/work", mcpServers: {} },
      env: {
        CONTEXT_MODE_PLATFORM: "manual-platform",
        CONTEXT_MODE_DIR: "/data/manual-context-mode",
        KEEP: "yes",
      },
    };
    const created = await injectContextModeOnCreate(createRequest, settings, launch, {
      home: "/home/test",
      pathExists: async () => true,
      fileContains: async () => false,
    });
    expect(created.config.mcpServers).toMatchObject({
      "context-mode": {
        env: {
          CONTEXT_MODE_PLATFORM: "manual-platform",
          CONTEXT_MODE_DIR: "/data/manual-context-mode",
        },
      },
    });
    expect(created.env).toEqual({
      CONTEXT_MODE_PLATFORM: "manual-platform",
      CONTEXT_MODE_DIR: "/data/manual-context-mode",
      KEEP: "yes",
    });

    const openRequest = {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      provider: "codex",
      cwd: "/work",
      reason: "resume",
      purpose: "interactive",
      env: createRequest.env,
    };
    const opened = await injectContextModeEnvironment(openRequest, settings, {
      home: "/home/test",
      pathExists: async () => true,
    });
    expect(opened.env).toEqual(createRequest.env);
  });

  test("reuses storage under an explicitly configured provider root", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const request = {
      config: { provider: "codex", cwd: "/work", mcpServers: {} },
      env: { CODEX_HOME: "/srv/codex-profile" },
    };
    const result = await injectContextModeOnCreate(request, settings, launch, {
      home: "/home/test",
      pathExists: async (path) => path === join("/srv/codex-profile", "context-mode"),
      fileContains: async () => false,
    });

    expect(result.config.mcpServers).toMatchObject({
      "context-mode": {
        env: {
          CONTEXT_MODE_PLATFORM: "codex",
          CONTEXT_MODE_DIR: join("/srv/codex-profile", "context-mode"),
        },
      },
    });
  });

  test("reports current adapter mappings and the existing-agent activation limitation", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const audit = await createIntegrationAudit(
      settings,
      { path: launch.args[0], version: "1.0.169" },
      {
        home: "/home/test",
        pathExists: async (path) => path === join("/home/test", ".omp", "context-mode"),
        fileContains: async (path, marker) =>
          path === join("/home/test", ".omp", "agent", "mcp.json") && marker === "context-mode",
        now: () => new Date("2026-09-20T00:00:00.000Z"),
      },
    );

    expect(audit.providers.map(({ provider, platform }) => [provider, platform])).toEqual([
      ["claude", "claude-code"],
      ["codex", "codex"],
      ["copilot", "copilot-cli"],
      ["cursor", "cursor"],
      ["opencode", "opencode"],
      ["pi", "pi"],
      ["omp", "omp"],
      ["omp-plugin", "omp"],
    ]);
    expect(audit.providers.find(({ provider }) => provider === "omp-plugin")).toMatchObject({
      activation: "native",
      reusesExistingStorage: true,
      detail: expect.stringContaining("Already-running agents"),
    });
    expect(audit.providers.find(({ provider }) => provider === "claude")).toMatchObject({
      activation: "mcp",
      reusesExistingStorage: false,
      detail: expect.stringContaining("only when a new Paseo agent is created"),
    });
    expect(audit.checkedAt).toBe("2026-09-20T00:00:00.000Z");
  });
});
