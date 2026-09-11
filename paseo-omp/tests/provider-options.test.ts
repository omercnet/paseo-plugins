import { describe, expect, test } from "bun:test";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { normalizeOmpSessionConfig } from "../server/provider/config-normalization";
import { buildOmpSpawnRequest } from "../server/provider/omp-rpc";
import { parseOmpProviderOptions } from "../server/provider/provider-options";

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

describe("OMP provider option migration", () => {
  test("maps legacy command, environment, params, modes, and ephemeral sessions to argv", () => {
    const normalized = normalizeOmpSessionConfig(
      sessionConfig({
        env: { SESSION_VALUE: "session-wins" },
        mode: "write",
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
      "write",
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
      PROFILE_VALUE: "profile",
      SESSION_VALUE: "session-wins",
    });
    expect(normalized.readyTimeoutMs).toBe(12_345);
    expect(normalized.requestTimeoutMs).toBe(12_345);
  });

  test("maps every public mode to the matching OMP approval policy", () => {
    const approvalModes = { full: "yolo", write: "write", ask: "always-ask" } as const;
    for (const [mode, approvalMode] of Object.entries(approvalModes)) {
      const normalized = normalizeOmpSessionConfig(sessionConfig({ mode }));
      const request = buildOmpSpawnRequest({ ...normalized, environment: TEST_ENV });
      expect(request.args).toContain("--approval-mode");
      expect(request.args[request.args.indexOf("--approval-mode") + 1]).toBe(approvalMode);
    }
  });

  test("fails visibly for plugin-provider API gaps", () => {
    expect(() => parseOmpProviderOptions({ models: [{ id: "custom" }] })).toThrow(
      "catalog requests do not expose providerOptions",
    );
    expect(() => parseOmpProviderOptions({ additionalModels: [{ id: "custom" }] })).toThrow(
      "catalog requests do not expose providerOptions",
    );
    expect(() => parseOmpProviderOptions({ disallowedTools: ["bash"] })).toThrow(
      "no plugin-provider tool restriction contract",
    );
  });

  test("rejects unknown or malformed options instead of stripping them", () => {
    expect(() => parseOmpProviderOptions({ typo: true })).toThrow(
      "providerOptions: Unrecognized key",
    );
    expect(() => parseOmpProviderOptions({ command: [] })).toThrow("providerOptions.command");
    expect(() => parseOmpProviderOptions({ params: { rpcTimeoutMs: 0 } })).toThrow(
      "providerOptions.params.rpcTimeoutMs",
    );
    expect(() =>
      normalizeOmpSessionConfig(sessionConfig({ settings: { unsupported: true } })),
    ).toThrow("does not expose live provider settings");
  });
});
