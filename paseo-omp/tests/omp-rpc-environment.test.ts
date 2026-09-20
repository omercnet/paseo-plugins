import { describe, expect, test } from "vitest";
import { buildOmpSpawnRequest } from "../server/provider/omp-rpc-environment";
import { TEST_RUNTIME_ENV } from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
  test("builds argv-only launches with a minimal allowlisted environment", () => {
    const proxy = "https://proxy-user:proxy-pass@example.test?token=proxy-token";
    const request = buildOmpSpawnRequest(
      {
        cwd: "/repo",
        mode: "full",
        model: "provider/model; touch /tmp/not-run",
        env: {
          TEST_ENV: "explicit",
          CUSTOMER_API_KEY: "session-secret",
          OMP_NO_WEBP: "0",
        },
      },
      {
        ...TEST_RUNTIME_ENV,
        OMP_COMMAND: "/opt/omp/bin/omp",
        HOME: "/home/runner",
        HTTPS_PROXY: proxy,
        OPENAI_API_KEY: "daemon-secret",
        ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-secret",
        CLOUDFLARE_AI_GATEWAY_API_KEY: "cloudflare-secret",
        PLEXUS_API_KEY: "plexus-secret",
        UNRELATED_DAEMON_VALUE: "must-not-pass",
        NODE_OPTIONS: "--require attacker.js",
        RANDOM_TOKEN: "must-not-pass-either",
        node_options: "--require lower-case-attacker.js",
      },
    );

    expect(request.command).toBe("/opt/omp/bin/omp");
    expect(request.args).toContain("provider/model; touch /tmp/not-run");
    expect(request.env).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
      PI_CONFIG_DIR: ".omp-no-config",
      HOME: "/home/runner",
      HTTPS_PROXY: proxy,
      OPENAI_API_KEY: "daemon-secret",
      PLEXUS_API_KEY: "plexus-secret",
      ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-secret",
      CLOUDFLARE_AI_GATEWAY_API_KEY: "cloudflare-secret",
      OMP_NO_WEBP: "1",
      TEST_ENV: "explicit",
      CUSTOMER_API_KEY: "session-secret",
    });

    expect(request.env.UNRELATED_DAEMON_VALUE).toBeUndefined();
    expect(request.env.NODE_OPTIONS).toBeUndefined();
    expect(request.env.RANDOM_TOKEN).toBeUndefined();
    expect(request.env.node_options).toBeUndefined();
    const benignShortValues = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: { DEBUG: "1", NODE_ENV: "dev" } },
      TEST_RUNTIME_ENV,
    );
    expect(benignShortValues.env).toEqual({
      ...TEST_RUNTIME_ENV,
      DEBUG: "1",
      NODE_ENV: "dev",
      OMP_NO_WEBP: "1",
    });
    expect(
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { API_TOKEN: "x" } },
        TEST_RUNTIME_ENV,
      ).env.API_TOKEN,
    ).toBe("x");
    const fullSessionEnvironment = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`SESSION_VALUE_${index}`, "x"]),
    );
    const fullEnvironmentRequest = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: fullSessionEnvironment },
      TEST_RUNTIME_ENV,
    );
    expect(fullEnvironmentRequest.env.OMP_NO_WEBP).toBe("1");
    expect(fullEnvironmentRequest.env.SESSION_VALUE_255).toBe("x");
    for (const proxy of [
      "https://abc:long-password@example.test",
      "https://example.test?token=xyz",
    ]) {
      expect(
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", env: { HTTPS_PROXY: proxy } },
          TEST_RUNTIME_ENV,
        ).env.HTTPS_PROXY,
      ).toBe(proxy);
    }
    const benignShortProxy = "https://example.test/abc?arbitrary=xyz#abc";
    const benignProxyRequest = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: { HTTPS_PROXY: benignShortProxy } },
      TEST_RUNTIME_ENV,
    );
    expect(benignProxyRequest.env.HTTPS_PROXY).toBe(benignShortProxy);
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { LD_PRELOAD: "/tmp/evil.so" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("forbidden variable");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { node_options: "--require attacker.js" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("forbidden variable");
    for (const name of [
      "PI_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
      "PI_CONFIG_FILES",
      "PI_SHELL_PREFIX",
      "PI_BASH_NO_CI",
      "PI_BASH_NO_LOGIN",
      "PI_SUBPROCESS_CMD",
      "PI_PACKAGE_DIR",
      "PI_PROFILE",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_PROJECT_DIR",
      "PI_WORKTREE_DIR",
      "PI_SESSION_ID",
      "PI_GIT_COMMON_DIR",
      "CLAUDE_BASH_NO_CI",
      "CLAUDE_BASH_NO_LOGIN",
      "CLAUDE_CODE_SHELL_PREFIX",
      "OMP_PROFILE",
      "OMP_AUTORESEARCH_DB_DIR",
      "OMP_GITHUB_CACHE_DB",
      "OMP_WORKTREE_DIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "XDG_STATE_HOME",
      "PWD",
      "PATH",
      "HOME",
      "SHELL",
      "VISUAL",
      "EDITOR",
      "LD_PRELOAD",
      "NODE_OPTIONS",
    ].flatMap((name) => [name, name.toLowerCase()])) {
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", env: { [name]: "/tmp/redirect" } },
          TEST_RUNTIME_ENV,
        ),
      ).toThrow("forbidden variable");
    }
    expect(
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full" },
        { ...TEST_RUNTIME_ENV, OPENAI_API_KEY: "x" },
      ).env.OPENAI_API_KEY,
    ).toBe("x");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "x".repeat(64 * 1024 + 1) },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("system prompt");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "é".repeat(40_000) },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("system prompt");
    expect(() => buildOmpSpawnRequest({ cwd: "relative", mode: "full" }, TEST_RUNTIME_ENV)).toThrow(
      "absolute",
    );
  });

  test("inherits only selected daemon values and skips shadowed daemon values", () => {
    const request = buildOmpSpawnRequest(
      {
        cwd: "/repo",
        mode: "full",
        inheritEnv: ["CUSTOM_SECRET", "CUSTOM_URL", "OVERRIDDEN"],
        env: { OVERRIDDEN: "explicit-value" },
      },
      {
        ...TEST_RUNTIME_ENV,
        CUSTOM_SECRET: "selected-secret",
        CUSTOM_URL: "https://user:pass@example.test",
        OVERRIDDEN: "x",
        UNSELECTED_SECRET: "must-not-pass",
      },
    );

    expect(request.env.CUSTOM_SECRET).toBe("selected-secret");
    expect(request.env.CUSTOM_URL).toBe("https://user:pass@example.test");
    expect(request.env.OVERRIDDEN).toBe("explicit-value");
    expect(request.env.UNSELECTED_SECRET).toBeUndefined();
    expect(request.inheritedRedactionValues).toEqual([
      "selected-secret",
      "https://user:pass@example.test",
    ]);

    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", inheritEnv: ["SHORT_VALUE"] },
        { ...TEST_RUNTIME_ENV, SHORT_VALUE: "xyz" },
      ),
    ).toThrow("too short for safe redaction");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", inheritEnv: ["OVERSIZED_VALUE"] },
        { ...TEST_RUNTIME_ENV, OVERSIZED_VALUE: "x".repeat(64 * 1024 + 1) },
      ),
    ).toThrow("invalid value");
    for (const name of ["NODE_OPTIONS", "node_options", "PaTh"]) {
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", inheritEnv: [name] },
          { ...TEST_RUNTIME_ENV, [name]: "blocked-value" },
        ),
      ).toThrow("forbidden variable");
    }
  });
});
