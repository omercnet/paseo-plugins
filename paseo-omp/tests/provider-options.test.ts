import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  hasOmpProviderSettings,
  normalizeOmpCatalogOptions,
  normalizeOmpSessionConfig,
  withCommittedOmpSelection,
} from "../server/provider/config-normalization";
import { buildOmpSpawnRequest } from "../server/provider/omp-rpc-environment";
import { parseOmpProviderOptions } from "../server/provider/provider-options";
import { createOmpProvider } from "../server/provider/registration";
import {
  configuredOutputRedactionValues,
  OmpPublicDataSerializer,
} from "../server/provider/security";
import { providerLaunchSettingsSchema } from "../shared/provider-launch-settings";

const TEST_ENV: NodeJS.ProcessEnv = {
  HOME: "/home/tester",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/home/tester/.omp/agent",
};

function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    cwd: "/repo",
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
    ...overrides,
  };
}

describe("OMP provider option normalization", () => {
  test("maps command, environment, params, and ephemeral sessions to argv", () => {
    const normalized = normalizeOmpSessionConfig(
      sessionConfig({
        env: { SESSION_VALUE: "session-wins" },
        mode: "full",
        providerOptions: {
          command: ["/usr/bin/env", "omp-custom", "--mode=rpc-ui"],
          env: { PROFILE_VALUE: "profile", SESSION_VALUE: "profile-loses" },
          params: {
            sessionDir: "/var/lib/omp/sessions",
            rpcTimeoutMs: 12_345,
            smolModel: "openai/gpt-5-mini",
            slowModel: "anthropic/claude-opus-5",
            planModel: "openai/gpt-5.4",
          },
        },
        persist: false,
      }),
    );
    const request = buildOmpSpawnRequest({ ...normalized, environment: TEST_ENV });

    expect(request.command).toBe("/usr/bin/env");
    expect(request.args).toEqual([
      "omp-custom",
      "--mode=rpc-ui",
      "--approval-mode",
      "yolo",
      "--smol",
      "openai/gpt-5-mini",
      "--slow",
      "anthropic/claude-opus-5",
      "--plan",
      "openai/gpt-5.4",
      "--session-dir",
      "/var/lib/omp/sessions",
      "--no-session",
    ]);
    expect(request.env).toEqual({
      ...TEST_ENV,
      OMP_NO_WEBP: "1",
      PROFILE_VALUE: "profile",
      SESSION_VALUE: "session-wins",
    });
    expect(normalized.readyTimeoutMs).toBe(12_345);
    expect(normalized.requestTimeoutMs).toBe(12_345);
  });

  test("merges host and profile environment names across catalog and session launches", () => {
    const hostInheritEnv = ["CUSTOM_SETTING", "CUSTOM_API_KEY"];
    const providerOptions = {
      inheritEnv: ["CUSTOM_API_KEY", "OVERRIDE_ME"],
      env: { OVERRIDE_ME: "profile-value" },
    };
    const catalog = normalizeOmpCatalogOptions(
      { scope: "workspace", cwd: "/repo", providerOptions },
      "/repo",
      hostInheritEnv,
    );
    const session = normalizeOmpSessionConfig(
      sessionConfig({
        providerOptions,
        env: { OVERRIDE_ME: "session-value" },
      }),
      false,
      hostInheritEnv,
    );

    expect(catalog.inheritEnv).toEqual(["CUSTOM_SETTING", "CUSTOM_API_KEY", "OVERRIDE_ME"]);
    expect(session.inheritEnv).toEqual(["CUSTOM_SETTING", "CUSTOM_API_KEY", "OVERRIDE_ME"]);

    const daemonEnvironment = {
      ...TEST_ENV,
      CUSTOM_API_KEY: "daemon-credential",
      CUSTOM_SETTING: "daemon-setting",
      OVERRIDE_ME: "daemon-value",
      UNSELECTED_VALUE: "must-not-pass",
    };
    const catalogRequest = buildOmpSpawnRequest({ ...catalog, environment: daemonEnvironment });
    const sessionRequest = buildOmpSpawnRequest({ ...session, environment: daemonEnvironment });

    expect(catalogRequest.env.CUSTOM_API_KEY).toBe("daemon-credential");
    expect(catalogRequest.env.CUSTOM_SETTING).toBe("daemon-setting");
    expect(catalogRequest.env.OVERRIDE_ME).toBe("profile-value");
    expect(sessionRequest.env.OVERRIDE_ME).toBe("session-value");
    expect(catalogRequest.env.UNSELECTED_VALUE).toBeUndefined();
    expect(sessionRequest.env.UNSELECTED_VALUE).toBeUndefined();
  });

  test("keys catalog caches by merged inherited names without resolving daemon values", async () => {
    const catalogOptions = {
      scope: "global" as const,
      providerOptions: { inheritEnv: ["PROFILE_API_KEY"] },
    };
    const firstValueKey = await createOmpProvider({
      environment: { ...TEST_ENV, HOST_API_KEY: "first-secret", PROFILE_API_KEY: "profile-secret" },
      resolveHostInheritEnv: async () => ["HOST_API_KEY"],
    }).getCatalogCacheKey?.(catalogOptions);
    const secondValueKey = await createOmpProvider({
      environment: {
        ...TEST_ENV,
        HOST_API_KEY: "second-secret",
        PROFILE_API_KEY: "profile-secret",
      },
      resolveHostInheritEnv: async () => ["HOST_API_KEY"],
    }).getCatalogCacheKey?.(catalogOptions);
    const differentNameKey = await createOmpProvider({
      environment: {
        ...TEST_ENV,
        OTHER_API_KEY: "first-secret",
        PROFILE_API_KEY: "profile-secret",
      },
      resolveHostInheritEnv: async () => ["OTHER_API_KEY"],
    }).getCatalogCacheKey?.(catalogOptions);

    expect(firstValueKey).toBeDefined();
    expect(firstValueKey).toBe(secondValueKey);
    expect(firstValueKey).not.toBe(differentNameKey);
  });

  test("maps every interactive launch mode after permission bridging", () => {
    for (const [mode, approvalMode] of [
      ["write", "write"],
      ["ask", "always-ask"],
    ] as const) {
      const nativeLaunch = buildOmpSpawnRequest({ cwd: "/repo", mode }, TEST_ENV);
      expect(nativeLaunch.args.slice(-2)).toEqual(["--approval-mode", approvalMode]);
      expect(normalizeOmpSessionConfig(sessionConfig({ mode }), true).mode).toBe(mode);
      const template = {
        cwd: "/repo",
        command: ["/opt/omp", "--mode=rpc-ui"],
        env: { PROFILE: mode },
        mode,
        roleModels: { smol: "fast", slow: "slow", plan: "planner" },
        sessionDir: `/sessions/${mode}`,
        readyTimeoutMs: 12_000,
        requestTimeoutMs: 34_000,
        noSession: true,
        systemPrompt: `system-${mode}`,
      } as const;
      const refreshed = withCommittedOmpSelection(template, {
        model: "provider/first",
        thinkingOption: "medium",
      });
      const recoveredAgain = withCommittedOmpSelection(refreshed, {
        model: "provider/second",
        thinkingOption: "high",
      });
      expect(recoveredAgain).toEqual({
        ...template,
        model: "provider/second",
        thinkingOption: "high",
      });
    }
  });

  test("defaults output redaction to none and accepts only configured-values", () => {
    expect(parseOmpProviderOptions({}).outputRedaction).toBe("none");
    expect(
      normalizeOmpSessionConfig(
        sessionConfig({ providerOptions: { outputRedaction: "configured-values" } }),
      ).outputRedaction,
    ).toBe("configured-values");
    for (const outputRedaction of ["configured", "all", true, null]) {
      expect(() => parseOmpProviderOptions({ outputRedaction })).toThrow(
        "providerOptions.outputRedaction",
      );
    }
  });
  test("collects only explicit credential values and excludes short values", () => {
    const config = sessionConfig({
      env: {
        SESSION_SECRET: "session-secret",
        SHARED_TOKEN: "session-override",
        SHORT_TOKEN: "xyz",
      },
      mcpServers: {
        local: {
          type: "stdio",
          command: "server-secret-is-not-collected",
          args: ["argument-secret-is-not-collected"],
          env: { MCP_VALUE: "mcp-env-secret", SHORT: "abc" },
        },
        remote: {
          type: "http",
          url: "https://url-secret-is-not-collected.example.test",
          headers: { Authorization: "mcp-header-secret", "X-Short": "xyz" },
        },
      },
      providerOptions: {
        outputRedaction: "configured-values",
        env: {
          PROFILE_API_KEY: "profile-secret",
          PROFILE_LABEL: "profile-visible",
          SHARED_TOKEN: "profile-loses",
        },
      },
    });
    const normalized = normalizeOmpSessionConfig(config);

    expect(
      configuredOutputRedactionValues(
        normalized.outputRedaction ?? "none",
        normalized.env,
        config.mcpServers,
      ),
    ).toEqual([
      "profile-secret",
      "session-override",
      "session-secret",
      "mcp-env-secret",
      "mcp-header-secret",
    ]);
    expect(configuredOutputRedactionValues("none", normalized.env, config.mcpServers)).toEqual([]);
  });

  test("does not hold fragmented output for cross-frame redaction", () => {
    const serializer = new OmpPublicDataSerializer(["configured-secret"]);
    expect(serializer.text("configured-")).toBe("configured-");
    expect(serializer.text("secret")).toBe("secret");
    expect(serializer.text("configured-secret")).toBe("<redacted>");
  });
  test("enforces the generic denied tool list in OMP launch arguments", () => {
    const normalized = normalizeOmpSessionConfig({
      ...sessionConfig({ mode: "full" }),
      deniedTools: ["bash", "write", "bash"],
    } as ProviderSessionConfig & { deniedTools: readonly string[] });
    const request = buildOmpSpawnRequest({ ...normalized, environment: TEST_ENV });
    const toolsIndex = request.args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    const enabledTools = request.args[toolsIndex + 1]?.split(",") ?? [];
    expect(enabledTools).toContain("read");
    expect(enabledTools).not.toContain("bash");
    expect(enabledTools).not.toContain("write");
    expect(() =>
      normalizeOmpSessionConfig({
        ...sessionConfig(),
        deniedTools: ["unknown-extension-tool"],
      } as ProviderSessionConfig & { deniedTools: readonly string[] }),
    ).toThrow("cannot enforce unknown denied tools");
  });

  test("keeps host model overrides outside strict provider options", () => {
    for (const field of ["models", "additionalModels", "disallowedTools"] as const) {
      expect(() => parseOmpProviderOptions({ [field]: [] })).toThrow("Unrecognized key");
    }
  });

  test("bounds the host-wide session limit", () => {
    expect(providerLaunchSettingsSchema.parse({})).toEqual({ inheritEnv: [], maxSessions: 32 });
    expect(providerLaunchSettingsSchema.parse({ maxSessions: 64 }).maxSessions).toBe(64);
    for (const maxSessions of [0, 65, 1.5]) {
      expect(() => providerLaunchSettingsSchema.parse({ maxSessions })).toThrow();
    }
  });

  test("rejects unknown or malformed options instead of stripping them", () => {
    expect(() => parseOmpProviderOptions({ typo: true })).toThrow(
      "providerOptions: Unrecognized key",
    );
    expect(() => parseOmpProviderOptions({ command: [] })).toThrow("providerOptions.command");
    expect(() => parseOmpProviderOptions({ params: { rpcTimeoutMs: 0 } })).toThrow(
      "providerOptions.params.rpcTimeoutMs",
    );
    expect(() => parseOmpProviderOptions({ inheritEnv: "CUSTOM_TOKEN" })).toThrow(
      "providerOptions.inheritEnv",
    );
    expect(() => parseOmpProviderOptions({ inheritEnv: ["9INVALID"] })).toThrow(
      "providerOptions.inheritEnv.0",
    );
    expect(() =>
      parseOmpProviderOptions({
        inheritEnv: Array.from({ length: 257 }, (_, index) => `CUSTOM_${index}`),
      }),
    ).toThrow("providerOptions.inheritEnv");
    expect(() =>
      normalizeOmpSessionConfig(
        sessionConfig({ providerOptions: { inheritEnv: ["PROFILE_ENV"] } }),
        false,
        Array.from({ length: 256 }, (_, index) => `HOST_${index}`),
      ),
    ).toThrow("inherited environment has too many entries");
    expect(() => providerLaunchSettingsSchema.parse({ inheritEnv: ["9INVALID"] })).toThrow();
    expect(() =>
      normalizeOmpSessionConfig(sessionConfig({ settings: { unsupported: true } })),
    ).toThrow("does not expose live provider settings");
  });

  test("accepts Paseo 0.16 settings that mirror providerOptions and rejects real settings", () => {
    const providerOptions = { command: ["omp"], params: { rpcTimeoutMs: 5_000 } };
    const mirrored = { command: ["omp"], params: { rpcTimeoutMs: 5_000 } };
    expect(hasOmpProviderSettings({}, undefined)).toBe(false);
    expect(hasOmpProviderSettings(undefined, providerOptions)).toBe(false);
    expect(hasOmpProviderSettings(mirrored, providerOptions)).toBe(false);
    expect(hasOmpProviderSettings({ command: ["omp"] }, providerOptions)).toBe(false);
    expect(hasOmpProviderSettings({ fast: true }, providerOptions)).toBe(true);
    expect(hasOmpProviderSettings({ command: ["other"] }, providerOptions)).toBe(true);
    expect(hasOmpProviderSettings({ command: ["omp"] }, undefined)).toBe(true);

    const normalized = normalizeOmpSessionConfig(
      sessionConfig({ providerOptions, settings: mirrored }),
    );
    expect(normalized.command).toEqual(["omp"]);
    expect(() =>
      normalizeOmpSessionConfig(
        sessionConfig({ providerOptions, settings: { ...mirrored, fast: true } }),
      ),
    ).toThrow("does not expose live provider settings");
  });

  test("compares mirrored settings by own keys and deep strict equality", () => {
    const nested = { params: { rpcTimeoutMs: 5_000, maxBuffer: 1 } };
    expect(hasOmpProviderSettings({ params: { maxBuffer: 1, rpcTimeoutMs: 5_000 } }, nested)).toBe(
      false,
    );
    expect(hasOmpProviderSettings({ command: ["omp", "rpc"] }, { command: ["rpc", "omp"] })).toBe(
      true,
    );
    expect(hasOmpProviderSettings({ env: undefined }, {})).toBe(true);
    expect(hasOmpProviderSettings({ params: { a: undefined } }, { params: {} })).toBe(true);
    expect(hasOmpProviderSettings(JSON.parse('{"__proto__":{"command":["omp"]}}'), {})).toBe(true);
    expect(hasOmpProviderSettings({ toString: "x" }, {})).toBe(true);
    expect(hasOmpProviderSettings({ value: Number.NaN }, { value: Number.NaN })).toBe(false);
    expect(hasOmpProviderSettings({ value: Number.NaN }, { value: 0 })).toBe(true);
    expect(hasOmpProviderSettings({ env: new Map() }, { env: {} })).toBe(true);
    expect(hasOmpProviderSettings({ command: ["omp"] }, null)).toBe(true);
    expect(hasOmpProviderSettings({}, null)).toBe(false);
  });
});
