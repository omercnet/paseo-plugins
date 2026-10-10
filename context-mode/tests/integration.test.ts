import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createIntegrationAudit,
  injectContextModeEnvironment,
  injectContextModeOnCreate,
  readProviderOverrides,
} from "../server/integration";
import { ContextModeSettingsSchema } from "../shared";

const launch = {
  program: "/usr/bin/node",
  args: ["/plugin/node_modules/context-mode/cli.bundle.mjs"],
};

const AMBIENT_ENVIRONMENT = [
  "CONTEXT_MODE_DIR",
  "CONTEXT_MODE_DATA_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_DIR",
];

beforeEach(() => {
  for (const name of AMBIENT_ENVIRONMENT) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  describe("providers derived through extends", () => {
    const settings = ContextModeSettingsSchema.parse({});
    const providers = {
      "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/srv/claude-work" } },
      "codex-full-access": { extends: "codex" },
      mystery: { extends: "acp" },
    };
    const noNative = {
      home: "/home/test",
      pathExists: async () => false,
      fileContains: async () => false,
    };

    test("injects with the base policy and the derived provider's own storage root", async () => {
      const result = await injectContextModeOnCreate(
        { config: { provider: "claude-work", cwd: "/work", mcpServers: {} } },
        settings,
        launch,
        { ...noNative, providers },
      );

      expect(result.config.mcpServers).toMatchObject({
        "context-mode": {
          env: {
            CONTEXT_MODE_PLATFORM: "claude-code",
            CONTEXT_MODE_DIR: join("/srv/claude-work", "context-mode"),
          },
        },
      });
      expect(
        await injectContextModeOnCreate(
          { config: { provider: "codex-full-access", cwd: "/work", mcpServers: {} } },
          settings,
          launch,
          { ...noNative, providers },
        ),
      ).toMatchObject({
        config: {
          mcpServers: {
            "context-mode": {
              env: {
                CONTEXT_MODE_PLATFORM: "codex",
                CONTEXT_MODE_DIR: join("/home/test", ".codex", "context-mode"),
              },
            },
          },
        },
      });
    });

    test("probes native registrations under the derived provider's config directory", async () => {
      const request = { config: { provider: "claude-work", cwd: "/work", mcpServers: {} } };
      const result = await injectContextModeOnCreate(request, settings, launch, {
        ...noNative,
        providers,
        fileContains: async (path) => path === join("/srv/claude-work", "settings.json"),
      });

      expect(result).toBe(request);
    });

    test("lets request env override provider env", async () => {
      const result = await injectContextModeOnCreate(
        {
          config: { provider: "claude-work", cwd: "/work", mcpServers: {} },
          env: { CLAUDE_CONFIG_DIR: "/tmp/req" },
        },
        settings,
        launch,
        { ...noNative, providers },
      );

      expect(result.config.mcpServers).toMatchObject({
        "context-mode": { env: { CONTEXT_MODE_DIR: join("/tmp/req", "context-mode") } },
      });
    });

    test("applies provider env to built-in provider ids as well", async () => {
      const result = await injectContextModeOnCreate(
        { config: { provider: "claude", cwd: "/work", mcpServers: {} } },
        settings,
        launch,
        { ...noNative, providers: { claude: { env: { CLAUDE_CONFIG_DIR: "/srv/builtin" } } } },
      );

      expect(result.config.mcpServers).toMatchObject({
        "context-mode": { env: { CONTEXT_MODE_DIR: join("/srv/builtin", "context-mode") } },
      });
    });

    test("keeps the derived storage root when a session is reopened with an empty env", async () => {
      const result = await injectContextModeEnvironment(
        { provider: "claude-work", cwd: "/work", env: {} },
        settings,
        { home: "/home/test", providers },
      );

      expect(result.env).toEqual({
        CONTEXT_MODE_PLATFORM: "claude-code",
        CONTEXT_MODE_DIR: join("/srv/claude-work", "context-mode"),
      });
    });

    test("leaves providers extending an unsupported base unchanged", async () => {
      const createRequest = { config: { provider: "mystery", cwd: "/work", mcpServers: {} } };
      const openRequest = { provider: "mystery", cwd: "/work", env: {} };

      expect(
        await injectContextModeOnCreate(createRequest, settings, launch, {
          ...noNative,
          providers,
        }),
      ).toBe(createRequest);
      expect(await injectContextModeEnvironment(openRequest, settings, { providers })).toBe(
        openRequest,
      );
    });

    test("audits configured derived providers with their own roots after the canonical rows", async () => {
      const audit = await createIntegrationAudit(
        settings,
        { path: launch.args[0], version: "1.0.169" },
        {
          ...noNative,
          providers,
          fileContains: async (path) => path === join("/srv/claude-work", "settings.json"),
        },
      );
      const ids = audit.providers.map(({ provider }) => provider);

      expect(ids.slice(-2)).toEqual(["claude-work", "codex-full-access"]);
      expect(audit.providers.find(({ provider }) => provider === "claude-work")).toMatchObject({
        platform: "claude-code",
        activation: "native",
        storageRoot: join("/srv/claude-work", "context-mode"),
      });
      expect(audit.providers.find(({ provider }) => provider === "claude")).toMatchObject({
        activation: "mcp",
      });
      expect(
        audit.providers.find(({ provider }) => provider === "codex-full-access"),
      ).toMatchObject({
        activation: "mcp",
      });
    });
  });

  describe("readProviderOverrides", () => {
    test("keeps only string extends and string env values", async () => {
      const paseo = {
        config: {
          get: async () => ({
            config: {
              providers: {
                a: { extends: "claude", env: { X: "1", Y: 2 } },
                b: { extends: 5, env: "bad" },
                c: null,
              },
            },
          }),
        },
      };

      expect(await readProviderOverrides(paseo)).toEqual({
        a: { extends: "claude", env: { X: "1" } },
        b: {},
      });
    });

    test("falls back to no overrides when the daemon config cannot be read", async () => {
      const paseo = {
        config: {
          get: async () => {
            throw new Error("offline");
          },
        },
      };

      expect(await readProviderOverrides(paseo)).toEqual({});
      expect(await readProviderOverrides(undefined)).toEqual({});
    });
  });
});
