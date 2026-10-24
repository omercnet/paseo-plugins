import { describe, expect, test } from "vitest";
import { credentialSummaries, sandboxEnvironment } from "../server/credentials";
import type { SandboxRecord, State } from "../server/store";
import {
  type CredentialSummary,
  credentialNameSchema,
  credentialNotice,
  credentialValueSchema,
} from "../shared/credentials";

describe("credential input", () => {
  test.each([
    "PASEO_PASSWORD",
    "PATH",
    "HOME",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "DOCKER_HOST",
    "lower",
  ])("rejects %s as a variable name", (name) =>
    expect(credentialNameSchema.safeParse(name).success).toBe(false),
  );

  test("accepts provider variables", () => {
    for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "CUSTOM_1"])
      expect(credentialNameSchema.parse(name)).toBe(name);
  });

  test("a multi-line value cannot add a second variable to the environment", () => {
    expect(credentialValueSchema.safeParse("a\nPASEO_PASSWORD=b").success).toBe(false);
    expect(credentialValueSchema.safeParse("token").success).toBe(true);
  });
});

describe("credential summaries", () => {
  const savedAt = "2026-01-01T00:00:00.000Z";

  test("never carry a value, and only dated tokens get an expiry", () => {
    const summaries = credentialSummaries({
      CLAUDE_CODE_OAUTH_TOKEN: { value: "secret-1", savedAt },
      ANTHROPIC_API_KEY: { value: "secret-2", savedAt },
      MY_VAR: { value: "secret-3", savedAt },
    });
    expect(JSON.stringify(summaries)).not.toContain("secret");
    expect(Object.fromEntries(summaries.map((s) => [s.name, [s.kind, s.expiresAt]]))).toEqual({
      ANTHROPIC_API_KEY: ["model", null],
      CLAUDE_CODE_OAUTH_TOKEN: ["model", "2027-01-01T00:00:00.000Z"],
      MY_VAR: ["other", null],
    });
  });

  test("warns 30 days before expiry and again once expired", () => {
    const summary: CredentialSummary = {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      label: "Claude subscription token",
      kind: "model",
      savedAt,
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const at = (iso: string) => credentialNotice(summary, Date.parse(iso)).warning;
    expect(at("2026-11-01T00:00:00.000Z")).toBeNull();
    expect(at("2026-12-10T00:00:00.000Z")).toContain("Expires in 22 days");
    expect(at("2027-01-02T00:00:00.000Z")).toMatch(/^Expired\./);
    expect(credentialNotice(undefined).hint).toBe("Not set");
  });
});

describe("sandbox environment", () => {
  const sandbox: SandboxRecord = {
    id: "a",
    name: "n",
    repoUrl: "https://github.com/a/b",
    handle: null,
    revision: null,
    password: "pw",
    createdAt: "2026-01-01",
  };
  const state = (hostLogins: string[]): State => ({
    credentials: {},
    hostLogins,
    sandboxes: { a: sandbox },
  });

  test("sharing a login changes the revision, so running sandboxes ask for a restart", () => {
    const off = sandboxEnvironment(state([]), sandbox);
    const on = sandboxEnvironment(state(["codex"]), sandbox);
    expect(on.hostLogins).toEqual(["codex"]);
    expect(on.revision).not.toBe(off.revision);
  });

  test("the order logins were switched on in does not matter, and unknown ids are ignored", () => {
    const first = sandboxEnvironment(state(["opencode", "claude", "gone"]), sandbox);
    const second = sandboxEnvironment(state(["claude", "opencode"]), sandbox);
    expect(first.hostLogins).toEqual(["claude", "opencode"]);
    expect(first.revision).toBe(second.revision);
  });
});
