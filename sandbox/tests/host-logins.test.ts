import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
      {
        source: join(codex, "config.toml"),
        target: "/home/paseo/.codex/config.toml",
        readOnly: true,
      },
      { source: join(codex, "skills"), target: "/home/paseo/.codex/skills", readOnly: true },
    ]);
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
    ).resolves.toHaveLength(3);
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
