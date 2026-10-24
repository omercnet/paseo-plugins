import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { hostGithubToken, hostLoginMounts } from "../server/host-logins";

/** The uid that owns the fixtures, so the ownership check passes on any machine and CI runner. */
const owner = process.getuid?.() ?? 0;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sandbox-logins-"));
  const codex = join(root, "codex");
  await mkdir(join(codex, "skills"), { recursive: true });
  await writeFile(join(codex, "auth.json"), "{}");
  await writeFile(join(codex, "config.toml"), "");
  return { root, codex, env: { CODEX_HOME: codex } };
}

describe("host login mounts", () => {
  test("share the folder read-write and the files a host agent would obey read-only", async () => {
    const { codex, env } = await fixture();
    const mounts = await hostLoginMounts({
      enabled: ["codex"],
      env,
      platform: "linux",
      sandboxUid: owner,
    });

    expect(mounts).toEqual([
      { source: codex, target: "/home/paseo/.codex", readOnly: false },
      { source: join(codex, "prompts"), target: "/home/paseo/.codex/prompts", readOnly: true },
      { source: join(codex, "skills"), target: "/home/paseo/.codex/skills", readOnly: true },
      {
        source: join(codex, "config.toml"),
        target: "/home/paseo/.codex/config.toml",
        readOnly: true,
      },
    ]);
    // hooks.json does not exist, and an empty one is not a valid settings file for every tool.
    await expect(stat(join(codex, "hooks.json"))).rejects.toThrow("ENOENT");
  });

  test("a protected folder that does not exist yet is created, so the sandbox cannot plant it", async () => {
    const { codex, env } = await fixture();
    await expect(stat(join(codex, "prompts"))).rejects.toThrow("ENOENT");

    await hostLoginMounts({ enabled: ["codex"], env, platform: "linux", sandboxUid: owner });

    expect((await stat(join(codex, "prompts"))).isDirectory()).toBe(true);
  });

  test("honor the tool's own location variable, and mount nothing when nothing is shared", async () => {
    const { root } = await fixture();
    const data = join(root, "data");
    await mkdir(join(data, "opencode"), { recursive: true });

    expect(await hostLoginMounts({ enabled: [], env: {}, platform: "linux" })).toEqual([]);
    expect(
      await hostLoginMounts({
        enabled: ["opencode"],
        env: { XDG_DATA_HOME: data },
        platform: "linux",
        sandboxUid: owner,
      }),
    ).toEqual([
      {
        source: join(data, "opencode"),
        target: "/home/paseo/.local/share/opencode",
        readOnly: false,
      },
    ]);
  });

  test("OMP shares its agent folder, found the way OMP itself finds it", async () => {
    const { root } = await fixture();
    const agent = join(root, "omp-agent");
    await mkdir(join(agent, "hooks"), { recursive: true });
    await writeFile(join(agent, "agent.db"), "");
    await writeFile(join(agent, "mcp.json"), "{}");
    await writeFile(join(agent, "sessions.txt"), "");
    const request = { enabled: ["omp"], platform: "linux", sandboxUid: owner } as const;

    const mounts = await hostLoginMounts({ ...request, env: { PI_CODING_AGENT_DIR: agent } });

    expect(mounts[0]).toEqual({ source: agent, target: "/home/paseo/.omp-agent", readOnly: false });
    const locked = mounts.slice(1).map((mount) => mount.target.split("/").pop());
    // Folders are created if missing, so extensions cannot be planted. Files only if they exist.
    expect(locked).toContain("extensions");
    expect(locked).toContain("hooks");
    expect(locked).toContain("mcp.json");
    expect(locked).not.toContain("config.yml");
    expect(mounts.slice(1).every((mount) => mount.readOnly)).toBe(true);
    expect((await stat(join(agent, "extensions"))).isDirectory()).toBe(true);
    // The login store and sessions stay writable, so a refreshed token reaches the host.
    await expect(
      hostLoginMounts({ ...request, env: { PI_CODING_AGENT_DIR: join(root, "none") } }),
    ).rejects.toThrow("does not exist on this host");
  });

  test("refuse a missing folder instead of letting Docker create it on the host", async () => {
    const { root } = await fixture();
    await expect(
      hostLoginMounts({
        enabled: ["claude"],
        env: { CLAUDE_CONFIG_DIR: join(root, "none") },
        platform: "linux",
      }),
    ).rejects.toThrow("does not exist on this host");
  });

  test("refuse a path Docker would misread as several mount options", async () => {
    const { root } = await fixture();
    for (const name of ["a,b", 'a"b']) {
      const dir = join(root, name);
      await mkdir(dir);
      await expect(
        hostLoginMounts({
          enabled: ["claude"],
          env: { CLAUDE_CONFIG_DIR: dir },
          platform: "linux",
          sandboxUid: owner,
        }),
      ).rejects.toThrow("contains a comma or quote");
    }
  });

  test("refuse a folder the sandbox user could not write", async () => {
    const { codex, env } = await fixture();
    const other = owner + 1;
    await expect(
      hostLoginMounts({ enabled: ["codex"], env, platform: "linux", sandboxUid: other }),
    ).rejects.toThrow(`sandbox agents run as uid ${other}`);
    await chmod(codex, 0o777);
    await expect(
      hostLoginMounts({ enabled: ["codex"], env, platform: "linux", sandboxUid: other }),
    ).resolves.toHaveLength(4);
  });

  test("refuse hosts where the logins are not plain files", async () => {
    const { env } = await fixture();
    await expect(hostLoginMounts({ enabled: ["codex"], env, platform: "darwin" })).rejects.toThrow(
      "Linux hosts only",
    );
  });
});

describe("host GitHub token", () => {
  test("asks gh for github.com and trims the answer", async () => {
    const calls: (readonly string[])[] = [];
    const token = await hostGithubToken(async (args) => {
      calls.push(args);
      return "gho_abc\n";
    });
    expect(token).toBe("gho_abc");
    expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
  });

  test("says whether gh is missing or signed out", async () => {
    const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    await expect(
      hostGithubToken(async () => {
        throw missing;
      }),
    ).rejects.toThrow("not installed");
    await expect(
      hostGithubToken(async () => {
        throw new Error("exit 1");
      }),
    ).rejects.toThrow("not signed in");
  });

  test("rejects an empty or multi-line answer instead of passing it on as a token", async () => {
    await expect(hostGithubToken(async () => "\n")).rejects.toThrow("no usable token");
    await expect(hostGithubToken(async () => "a\nPASEO_PASSWORD=b")).rejects.toThrow("no usable");
  });
});
