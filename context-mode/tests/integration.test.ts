import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createIntegrationAudit,
  injectContextModeOnCreate,
  readProviderOverrides,
} from "../server/integration";
import { ContextModeSettingsSchema } from "../shared/settings";

const launch = {
  program: "/usr/bin/node",
  args: ["/plugin/node_modules/context-mode/cli.mjs"],
};

const settings = ContextModeSettingsSchema.parse({});
const noNative = {
  home: "/home/test",
  env: {},
  pathExists: async () => false,
  fileContains: async () => false,
};

function server(platform: string, env: Record<string, string> = {}) {
  return {
    type: "stdio",
    command: "/usr/bin/node",
    args: ["/plugin/node_modules/context-mode/cli.mjs", "server", "--agent", platform],
    env: { CONTEXT_MODE_DATA_DIR: "/home/test/.context-mode", ...env },
  };
}

describe("provider-aware Context Mode activation", () => {
  test.each([
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["copilot", "copilot-cli"],
    ["opencode", "opencode"],
  ])("injects the v2 MCP server for %s as --agent %s", async (provider, platform) => {
    const result = await injectContextModeOnCreate(
      { config: { provider, cwd: "/work", mcpServers: {} } },
      settings,
      launch,
      noNative,
    );

    expect(result.config.mcpServers).toEqual({ "context-mode": server(platform) });
  });

  test.each(["cursor", "pi", "omp", "omp-plugin", "omp-plugin-team", "acp"])(
    "leaves %s unchanged",
    async (provider) => {
      const request = { config: { provider, cwd: "/work", mcpServers: {} } };

      expect(await injectContextModeOnCreate(request, settings, launch, noNative)).toBe(request);
    },
  );

  test("preserves existing MCP servers, request env, and the launch env", async () => {
    const request = {
      config: {
        provider: "codex",
        cwd: "/work",
        mcpServers: { existing: { type: "http", url: "https://example.test/mcp" } },
      },
      env: { KEEP: "yes" },
    };
    const result = await injectContextModeOnCreate(
      request,
      settings,
      { ...launch, env: { ELECTRON_RUN_AS_NODE: "1" } },
      noNative,
    );

    expect(result.env).toBe(request.env);
    expect(result.config.mcpServers).toEqual({
      existing: { type: "http", url: "https://example.test/mcp" },
      "context-mode": server("codex", { ELECTRON_RUN_AS_NODE: "1" }),
    });
  });

  test("pins the data dir agents write to: the provider's, never a per-request one", async () => {
    const inject = async (
      env: Record<string, string> | undefined,
      providers: Record<string, { extends: string; env?: Record<string, string> }>,
    ) => {
      const result = await injectContextModeOnCreate(
        { config: { provider: "claude-work", cwd: "/work", mcpServers: {} }, env },
        settings,
        launch,
        { ...noNative, providers },
      );
      return (result.config.mcpServers as Record<string, { env: Record<string, string> }>)[
        "context-mode"
      ]?.env;
    };

    expect(await inject(undefined, { "claude-work": { extends: "claude" } })).toEqual({
      CONTEXT_MODE_DATA_DIR: "/home/test/.context-mode",
    });
    expect(
      await inject(undefined, {
        "claude-work": { extends: "claude", env: { CONTEXT_MODE_DATA_DIR: "/srv/work" } },
      }),
    ).toEqual({ CONTEXT_MODE_DATA_DIR: "/srv/work" });
    expect(
      await inject(
        { CONTEXT_MODE_DATA_DIR: "/srv/request" },
        { "claude-work": { extends: "claude", env: { CONTEXT_MODE_DATA_DIR: "/srv/work" } } },
      ),
    ).toEqual({ CONTEXT_MODE_DATA_DIR: "/srv/work" });
  });

  test("never replaces an explicitly configured Context Mode MCP server", async () => {
    const request = {
      config: {
        provider: "codex",
        mcpServers: { "context-mode": { type: "http", url: "https://context.example.test/mcp" } },
      },
    };

    expect(await injectContextModeOnCreate(request, settings, launch, noNative)).toBe(request);
  });

  test("does nothing for internal agents or when activation is off", async () => {
    const internal = { config: { provider: "claude", internal: true, mcpServers: {} } };
    const request = { config: { provider: "claude", mcpServers: {} } };

    expect(await injectContextModeOnCreate(internal, settings, launch, noNative)).toBe(internal);
    expect(
      await injectContextModeOnCreate(
        request,
        ContextModeSettingsSchema.parse({ autoInject: false }),
        launch,
        noNative,
      ),
    ).toBe(request);
  });
});

describe("native registration detection", () => {
  async function detected(
    provider: string,
    match: (path: string, marker: string) => boolean,
    options: { cwd?: string; env?: Record<string, string>; exists?: string } = {},
  ) {
    const request = { config: { provider, cwd: options.cwd, mcpServers: {} } };
    const result = await injectContextModeOnCreate(request, settings, launch, {
      home: "/home/test",
      env: options.env ?? {},
      pathExists: async (path) => path === options.exists,
      fileContains: async (path, marker) => match(path, marker),
    });
    return result === request;
  }

  test("finds the Claude Code marketplace plugin and user MCP entries", async () => {
    expect(
      await detected(
        "claude",
        (path, marker) =>
          path === join("/home/test", ".claude", "plugins", "installed_plugins.json") &&
          marker === '"context-mode@context-mode"',
      ),
    ).toBe(true);
    expect(
      await detected(
        "claude",
        (path, marker) =>
          path === join("/home/test", ".claude.json") && marker === '"context-mode":',
      ),
    ).toBe(true);
    expect(
      await detected(
        "claude",
        (path) => path === join("/srv/claude", "plugins", "installed_plugins.json"),
        { env: { CLAUDE_CONFIG_DIR: "/srv/claude" } },
      ),
    ).toBe(true);
  });

  test("finds the Claude user MCP entry at the end of a ~/.claude.json over 1 MiB", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-context-mode-home-"));
    const create = () => {
      const request = { config: { provider: "claude", mcpServers: {} } };
      return injectContextModeOnCreate(request, settings, launch, { home, env: {} }).then(
        (result) => result === request,
      );
    };
    try {
      const history = JSON.stringify("x".repeat(2 * 1024 * 1024));
      await writeFile(join(home, ".claude.json"), `{"history":${history}}`);
      expect(await create()).toBe(false);

      // A later native install is seen even though the earlier scan was a miss.
      await writeFile(
        join(home, ".claude.json"),
        `{"history":${history},"mcpServers":{"context-mode":{}}}`,
      );
      expect(await create()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("finds the Codex config.toml MCP entry or plugin under CODEX_HOME", async () => {
    const config = join("/srv/codex", "config.toml");
    for (const section of ["[mcp_servers.context-mode]", '[plugins."context-mode@context-mode"]']) {
      expect(
        await detected("codex", (path, marker) => path === config && marker === section, {
          env: { CODEX_HOME: "/srv/codex" },
        }),
      ).toBe(true);
    }
  });

  test("finds the Copilot MCP entry or setup hook file", async () => {
    expect(
      await detected(
        "copilot",
        (path) => path === join("/home/test", ".copilot", "mcp-config.json"),
      ),
    ).toBe(true);
    expect(
      await detected("copilot", () => false, {
        exists: join("/home/test", ".copilot", "hooks", "context-mode.json"),
      }),
    ).toBe(true);
  });

  test("finds the OpenCode plugin in global and project config", async () => {
    expect(
      await detected("opencode", (path) => path === join("/srv/oc", "opencode.json"), {
        env: { OPENCODE_CONFIG_DIR: "/srv/oc", XDG_CONFIG_HOME: "/srv/xdg" },
      }),
    ).toBe(true);
    expect(
      await detected(
        "opencode",
        (path) => path === join("/srv/xdg", "opencode", "opencode.jsonc"),
        {
          env: { XDG_CONFIG_HOME: "/srv/xdg" },
        },
      ),
    ).toBe(true);
    expect(
      await detected("opencode", (path) => path === join("/work", ".opencode", "opencode.json"), {
        cwd: "/work",
      }),
    ).toBe(true);
  });

  test("is skipped when native integrations are not preferred", async () => {
    const request = { config: { provider: "claude", mcpServers: {} } };
    const result = await injectContextModeOnCreate(
      request,
      ContextModeSettingsSchema.parse({ preferNativeIntegrations: false }),
      launch,
      { ...noNative, fileContains: async () => true },
    );

    expect(result.config.mcpServers).toEqual({ "context-mode": server("claude-code") });
  });
});

describe("integration audit", () => {
  test("reports supported mappings and unsupported providers", async () => {
    const audit = await createIntegrationAudit(settings, {
      ...noNative,
      fileContains: async (path) => path === join("/home/test", ".codex", "config.toml"),
    });

    expect(
      audit.providers.map(({ provider, platform, activation }) => [provider, platform, activation]),
    ).toEqual([
      ["claude", "claude-code", "mcp"],
      ["codex", "codex", "native"],
      ["copilot", "copilot-cli", "mcp"],
      ["opencode", "opencode", "mcp"],
      ["cursor", null, "disabled"],
      ["pi", null, "disabled"],
      ["omp", null, "disabled"],
      ["omp-plugin", null, "disabled"],
    ]);
  });

  test("reports every provider disabled when automatic activation is off", async () => {
    const audit = await createIntegrationAudit(
      ContextModeSettingsSchema.parse({ autoInject: false }),
      noNative,
    );
    expect(audit.providers.every(({ activation }) => activation === "disabled")).toBe(true);
  });

  test("reports Pi's own extension and OMP's own server as native, never injected", async () => {
    const piSettings = join("/srv/pi-agent", "settings.json");
    const ompMcp = join("/home/test", ".omp", "agent", "mcp.json");
    const audit = await createIntegrationAudit(settings, {
      ...noNative,
      env: { PI_CODING_AGENT_DIR: "/srv/pi-agent" },
      fileContains: async (path, marker) =>
        (path === piSettings && marker === "context-mode") ||
        (path === ompMcp && marker === '"context-mode"'),
    });
    const row = (id: string) => audit.providers.find(({ provider }) => provider === id);
    expect(row("pi")).toMatchObject({ platform: null, activation: "native" });
    expect(row("cursor")).toMatchObject({ platform: null, activation: "disabled" });

    // OMP honours the same agent-dir variable; without it OMP's default dir is probed.
    const omp = await createIntegrationAudit(settings, {
      ...noNative,
      fileContains: async (path) => path === ompMcp,
    });
    expect(omp.providers.find(({ provider }) => provider === "omp")).toMatchObject({
      activation: "native",
    });
    expect(omp.providers.find(({ provider }) => provider === "omp-plugin")).toMatchObject({
      activation: "native",
    });
    expect(omp.providers.find(({ provider }) => provider === "pi")).toMatchObject({
      activation: "disabled",
    });
  });

  test("never injects into Pi or OMP agents, even with their own install present", async () => {
    for (const provider of ["pi", "omp", "omp-plugin"]) {
      const request = { config: { provider, cwd: "/work", mcpServers: {} } };
      expect(
        await injectContextModeOnCreate(request, settings, launch, {
          ...noNative,
          fileContains: async () => true,
        }),
      ).toBe(request);
    }
  });
});

describe("providers derived through extends", () => {
  const providers = {
    "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/srv/claude-work" } },
    "codex-full-access": { extends: "codex" },
    "pi-work": { extends: "pi" },
    mystery: { extends: "acp" },
  };

  test("inject with the parent's agent id", async () => {
    const result = await injectContextModeOnCreate(
      { config: { provider: "codex-full-access", cwd: "/work", mcpServers: {} } },
      settings,
      launch,
      { ...noNative, providers },
    );

    expect(result.config.mcpServers).toEqual({ "context-mode": server("codex") });
  });

  test("probe native registrations under the derived provider's config dir", async () => {
    const request = { config: { provider: "claude-work", cwd: "/work", mcpServers: {} } };
    const result = await injectContextModeOnCreate(request, settings, launch, {
      ...noNative,
      providers,
      fileContains: async (path) =>
        path === join("/srv/claude-work", "plugins", "installed_plugins.json"),
    });

    expect(result).toBe(request);
  });

  test("leave providers extending an unsupported base unchanged", async () => {
    for (const provider of ["mystery", "pi-work"]) {
      const request = { config: { provider, cwd: "/work", mcpServers: {} } };
      expect(
        await injectContextModeOnCreate(request, settings, launch, { ...noNative, providers }),
      ).toBe(request);
    }
  });

  test("are audited after the canonical rows; unknown bases are skipped", async () => {
    const audit = await createIntegrationAudit(settings, {
      ...noNative,
      providers,
      fileContains: async (path) =>
        path === join("/srv/claude-work", "plugins", "installed_plugins.json"),
    });

    expect(audit.providers.slice(-3)).toMatchObject([
      { provider: "claude-work", platform: "claude-code", activation: "native" },
      { provider: "codex-full-access", platform: "codex", activation: "mcp" },
      { provider: "pi-work", platform: null, activation: "disabled" },
    ]);
    expect(audit.providers.find(({ provider }) => provider === "claude")).toMatchObject({
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
