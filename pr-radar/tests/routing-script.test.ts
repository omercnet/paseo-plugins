import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type RoutingScriptLimits,
  resolveRoutingScript,
  runRoutingScriptHandler,
  startRoutingScripts,
  stopRoutingScripts,
  trustedScriptPath,
  waitForRoutingScriptIdleForTests,
} from "../server/routing-script";
import { listLocalDirs, prepareWorkspaceCwd, runRoutingScript } from "../shared/viewer-scope";

const tempDirs: string[] = [];

afterEach(async () => {
  await waitForRoutingScriptIdleForTests();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-radar-routing-")));
  tempDirs.push(root);
  return root;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("runRoutingScriptHandler", () => {
  function writeScript(root: string, name: string, body: string, mode = 0o755): string {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, mode);
    return path;
  }

  function route(
    script: string,
    payload: Record<string, unknown> = {},
    limits?: RoutingScriptLimits,
  ) {
    return runRoutingScriptHandler(
      { payload },
      async () => ({ sourceCodeDir: "/nonexistent-source-dir", routingScriptPath: script }),
      limits,
    );
  }

  const FAST_LIMITS: RoutingScriptLimits = {
    timeoutMs: 5_000,
    outputBytes: 1024,
    killGraceMs: 200,
  };

  test("requires a script configured in the server-side settings", async () => {
    await expect(route("")).rejects.toThrow("No routing script is configured");
  });

  test("rejects a relative script path and a missing script", async () => {
    await expect(route("bin/route.sh")).rejects.toThrow(
      "Routing script path must be an absolute or ~/ path: bin/route.sh",
    );
    const missing = join(makeRoot(), "nope.sh");
    await expect(route(missing)).rejects.toThrow(`Routing script not found: ${missing}`);
  });

  test("takes no script path from the request", () => {
    expect(runRoutingScript.input.shape).not.toHaveProperty("scriptPath");
    expect(listLocalDirs.input.shape).not.toHaveProperty("sourceCodeDir");
    expect(prepareWorkspaceCwd.input.shape).not.toHaveProperty("sourceCodeDir");
  });

  test("feeds the payload on stdin and parses the JSON result", async () => {
    const root = makeRoot();
    const captured = join(root, "stdin.json");
    const script = writeScript(
      root,
      "route.sh",
      `cat > "${captured}"\nprintf '{"profile":"fast","provider":"codex","options":{"a":1},"reason":"cheap"}'`,
    );
    const result = await route(script, { pr: 7 });
    expect(result).toEqual({
      profile: "fast",
      provider: "codex",
      options: { a: 1 },
      reason: "cheap",
    });
    expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({ pr: 7 });
  });

  test("refuses a payload one byte over the input cap without running the script", async () => {
    const root = makeRoot();
    const ran = join(root, "ran.txt");
    const script = writeScript(root, "cap.sh", `echo ran > "${ran}"\ncat > /dev/null\necho '{}'`);
    const cap = 200;
    const limits = { ...FAST_LIMITS, inputBytes: cap };
    // What the script is sent: the JSON text and a newline. Each payload below is built to a byte
    // count, so the test sits on the boundary rather than somewhere safely either side of it.
    const serialized = (payload: Record<string, unknown>) =>
      Buffer.byteLength(`${JSON.stringify(payload)}\n`);
    const overhead = serialized({ pr: "" });
    const atCap = { pr: "x".repeat(cap - overhead) };
    const overCap = { pr: "x".repeat(cap - overhead + 1) };
    expect(serialized(atCap)).toBe(cap);
    expect(serialized(overCap)).toBe(cap + 1);

    await expect(route(script, overCap, limits)).rejects.toThrow(
      `input is ${cap + 1} bytes, over the ${cap} byte limit`,
    );
    expect(existsSync(ran)).toBe(false);
    // The refusal took no place in line, and a payload of exactly the cap goes through.
    await expect(route(script, atCap, limits)).resolves.toEqual({});
    expect(existsSync(ran)).toBe(true);
  });

  test("counts the input cap in bytes, so a multi-byte character spends two", async () => {
    const root = makeRoot();
    const script = writeScript(root, "cap2.sh", "cat > /dev/null\necho '{}'");
    const cap = 200;
    const limits = { ...FAST_LIMITS, inputBytes: cap };
    const serialized = (payload: Record<string, unknown>) =>
      Buffer.byteLength(`${JSON.stringify(payload)}\n`);
    const overhead = serialized({ pr: "" });
    // "\u00e9" is two bytes, so half the room holds as many characters as it takes to fill the cap.
    const atCap = { pr: "\u00e9".repeat((cap - overhead) / 2) };
    const overCap = { pr: `${atCap.pr}x` };
    expect(serialized(atCap)).toBe(cap);
    expect(serialized(overCap)).toBe(cap + 1);
    expect(overCap.pr.length).toBeLessThan(cap);
    await expect(route(script, atCap, limits)).resolves.toEqual({});
    await expect(route(script, overCap, limits)).rejects.toThrow(
      `input is ${cap + 1} bytes, over the ${cap} byte limit`,
    );
  });

  test("sends a payload of 256 KiB whole when no cap is passed", async () => {
    const root = makeRoot();
    const captured = join(root, "stdin.json");
    const script = writeScript(root, "big.sh", `cat > "${captured}"\necho '{}'`);
    const pr = "x".repeat(256 * 1024);
    await expect(route(script, { pr }, FAST_LIMITS)).resolves.toEqual({});
    expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({ pr });
  });

  test("treats empty output as no routing decision", async () => {
    const script = writeScript(makeRoot(), "empty.sh", "cat > /dev/null");
    await expect(route(script)).resolves.toEqual({});
  });

  test("reports stderr, or the exit code, when the script fails", async () => {
    const root = makeRoot();
    await expect(route(writeScript(root, "noisy.sh", "echo boom >&2\nexit 3"))).rejects.toThrow(
      "boom",
    );
    await expect(route(writeScript(root, "quiet.sh", "exit 4"))).rejects.toThrow(
      "Routing script exited with code 4.",
    );
  });

  test("rejects output that is not JSON or does not match the schema", async () => {
    const root = makeRoot();
    await expect(route(writeScript(root, "notjson.sh", "echo 'not json'"))).rejects.toThrow(
      SyntaxError,
    );
    await expect(route(writeScript(root, "shape.sh", `echo '{"provider": 5}'`))).rejects.toThrow(
      /provider/,
    );
  });

  test("refuses a script that is not executable", async () => {
    const script = writeScript(makeRoot(), "plain.sh", "echo {}", 0o644);
    await expect(route(script)).rejects.toThrow(/is not executable/);
  });

  test("refuses a script that group or others can write", async () => {
    const root = makeRoot();
    const grouped = writeScript(root, "group.sh", "echo {}", 0o775);
    await expect(route(grouped)).rejects.toThrow(/must not be writable by group or others/);
    const open = writeScript(root, "open.sh", "echo {}", 0o757);
    await expect(route(open)).rejects.toThrow(/must not be writable by group or others/);
  });

  test("refuses a script owned by another user", async () => {
    // Stands in for a script a different user created: the checking user is not the owner.
    if (process.getuid?.() === 0) return;
    const script = writeScript(makeRoot(), "owned.sh", "echo {}");
    const otherUid = (process.getuid?.() ?? 0) + 1000;
    await expect(resolveRoutingScript(script, otherUid)).rejects.toThrow(
      /is owned by another user; run chown/,
    );
    await expect(resolveRoutingScript(script)).resolves.toBe(script);
  });

  test("refuses a script under a directory that group or others can write", async () => {
    const root = makeRoot();
    const shared = join(root, "shared");
    mkdirSync(shared);
    const script = writeScript(shared, "route.sh", "echo {}");
    chmodSync(shared, 0o775);
    await expect(route(script)).rejects.toThrow(
      `Routing script directory ${shared} must not be writable by group or others; run chmod go-w`,
    );
    // A writable ancestor further up counts too.
    const nested = join(shared, "nested");
    mkdirSync(nested);
    const deep = writeScript(nested, "deep.sh", "echo {}");
    await expect(route(deep)).rejects.toThrow(/must not be writable by group or others/);
  });

  test("allows a directory that is writable but sticky, like /tmp", async () => {
    const root = makeRoot();
    const shared = join(root, "sticky");
    mkdirSync(shared);
    const script = writeScript(shared, "route.sh", "echo '{}'");
    chmodSync(shared, 0o1777);
    await expect(route(script)).resolves.toEqual({});
  });

  test("refuses a path that is not a regular file", async () => {
    const root = makeRoot();
    const dir = join(root, "adir");
    mkdirSync(dir);
    await expect(route(dir)).rejects.toThrow(/is not a regular file/);
  });

  test("checks the symlink target, not the link", async () => {
    const root = makeRoot();
    const target = writeScript(root, "real.sh", "echo {}", 0o775);
    const link = join(root, "link.sh");
    symlinkSync(target, link);
    await expect(route(link)).rejects.toThrow(/must not be writable by group or others/);
  });

  describe("symlinks on the configured path", () => {
    function dirs(root: string, ...names: string[]): string[] {
      return names.map((name) => {
        const dir = join(root, name);
        mkdirSync(dir);
        return dir;
      });
    }

    test("refuses a symlink held in a directory that group or others can write", async () => {
      const root = makeRoot();
      const [safe, shared] = dirs(root, "safe", "shared");
      const real = writeScript(safe, "real.sh", "echo '{}'");
      chmodSync(shared, 0o775);
      const link = join(shared, "link.sh");
      symlinkSync(real, link);
      await expect(route(link)).rejects.toThrow(
        `Routing script directory ${shared} must not be writable by group or others; run chmod go-w`,
      );
    });

    test("refuses a chain whose middle hop sits in a writable directory", async () => {
      // /a/l1 -> /b/l2 -> /c/file: /b is on neither the lexical path nor the real path.
      const root = makeRoot();
      const [a, b, c] = dirs(root, "a", "b", "c");
      const real = writeScript(c, "file.sh", "echo '{}'");
      symlinkSync(real, join(b, "l2"));
      symlinkSync(join(b, "l2"), join(a, "l1"));
      chmodSync(b, 0o777);
      await expect(route(join(a, "l1"))).rejects.toThrow(
        `Routing script directory ${b} must not be writable by group or others`,
      );
    });

    test("refuses a link inside a writable ancestor, not only its own parent", async () => {
      const root = makeRoot();
      const [outer, safe] = dirs(root, "outer", "safe");
      const inner = join(outer, "inner");
      mkdirSync(inner);
      const real = writeScript(safe, "real.sh", "echo '{}'");
      symlinkSync(real, join(inner, "link.sh"));
      chmodSync(outer, 0o775);
      await expect(route(join(inner, "link.sh"))).rejects.toThrow(
        `Routing script directory ${outer} must not be writable by group or others`,
      );
    });

    test("refuses a symlink owned by another user even in a sticky directory", async () => {
      // Stands in for a link a different user created in a sticky directory such as /tmp.
      if (process.getuid?.() === 0) return;
      const root = makeRoot();
      const [safe, sticky] = dirs(root, "safe", "sticky");
      const real = writeScript(safe, "real.sh", "echo '{}'");
      chmodSync(sticky, 0o1777);
      const link = join(sticky, "link.sh");
      symlinkSync(real, link);
      const otherUid = (process.getuid?.() ?? 0) + 1000;
      await expect(resolveRoutingScript(link, otherUid)).rejects.toThrow(
        `symbolic link ${link}, which is owned by another user`,
      );
      // Owned by us and held in a sticky directory, nobody else can replace it.
      await expect(resolveRoutingScript(link)).resolves.toBe(real);
    });

    test("checks a directory that a later '..' leaves", async () => {
      const root = makeRoot();
      const [open, safe] = dirs(root, "open", "safe");
      chmodSync(open, 0o777);
      const real = writeScript(safe, "real.sh", "echo '{}'");
      const link = join(safe, "link.sh");
      // The link target walks through the writable directory and back out again.
      symlinkSync(`${open}/../safe/real.sh`, link);
      await expect(resolveRoutingScript(link)).rejects.toThrow(
        `Routing script directory ${open} must not be writable by group or others`,
      );
      expect(real).toBeTruthy();
    });

    test("accepts a clean multi-hop chain with absolute and relative links", async () => {
      const root = makeRoot();
      const [a, b, c] = dirs(root, "a", "b", "c");
      const real = writeScript(c, "file.sh", "echo '{}'");
      symlinkSync("../c/file.sh", join(b, "l2"));
      symlinkSync(join(b, "l2"), join(a, "l1"));
      await expect(resolveRoutingScript(join(a, "l1"))).resolves.toBe(real);
      // The path itself may reach the link through `..` and another link.
      const viaDotDot = `${a}/../a/l1`;
      await expect(resolveRoutingScript(viaDotDot)).resolves.toBe(real);
      await expect(route(join(a, "l1"))).resolves.toEqual({});
    });
  });

  test("runs the script with an allow-listed environment", async () => {
    const root = makeRoot();
    const envFile = join(root, "env.txt");
    vi.stubEnv("PR_RADAR_TEST_SECRET", "leak-me");
    vi.stubEnv("GITHUB_TOKEN", "token-for-gh-only");
    vi.stubEnv("LC_ALL", "C");
    const script = writeScript(root, "env.sh", `env > "${envFile}"\necho '{}'`);
    await route(script);
    const seen = readFileSync(envFile, "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).toContain("LC_ALL=C");
    expect(seen).not.toContain("PR_RADAR_TEST_SECRET");
    expect(seen).not.toContain("GITHUB_TOKEN");
  });

  test("runs the script with a fixed PATH, not the daemon's", async () => {
    const root = makeRoot();
    const pathFile = join(root, "path.txt");
    const evil = join(root, "evil-bin");
    mkdirSync(evil);
    vi.stubEnv("PATH", `${evil}:/usr/bin:/bin`);
    const script = writeScript(root, "path.sh", `echo "$PATH" > "${pathFile}"\necho '{}'`);
    await route(script);
    const seen = readFileSync(pathFile, "utf8").trim();
    expect(seen).toBe(await trustedScriptPath());
    expect(seen.split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/bin"]));
    expect(seen.split(":").every((dir) => dir.startsWith("/"))).toBe(true);
    expect(seen).not.toContain(evil);
  });

  test("refuses to run the script when no PATH directory is trusted", async () => {
    const root = makeRoot();
    const ran = join(root, "ran.txt");
    const script = writeScript(root, "nopath.sh", `echo ran > "${ran}"\necho '{}'`);
    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    // Every candidate is missing or writable by others, so the kept PATH is the empty string.
    const noneTrusted = { ...FAST_LIMITS, pathDirs: [open, join(root, "missing")] };
    await expect(trustedScriptPath(undefined, noneTrusted.pathDirs)).resolves.toBe("");
    await expect(route(script, {}, noneTrusted)).rejects.toThrow(
      /None of the system directories the routing script searches for tools/,
    );
    expect(existsSync(ran)).toBe(false);
    // The refused call passed its turn on: the next one runs normally.
    await expect(route(script, {}, FAST_LIMITS)).resolves.toEqual({});
    expect(existsSync(ran)).toBe(true);
  });

  test("never keeps a relative PATH entry", async () => {
    // A relative entry is searched from the script's working directory, not from where it was read.
    await expect(trustedScriptPath(undefined, ["bin", "./", "", "/usr/bin"])).resolves.toBe(
      "/usr/bin",
    );
    await expect(trustedScriptPath(undefined, ["bin", "./", ""])).resolves.toBe("");
  });

  test("runs the script from a fixed directory, not the daemon's", async () => {
    const root = makeRoot();
    const cwdFile = join(root, "cwd.txt");
    const script = writeScript(root, "cwd.sh", `pwd -P > "${cwdFile}"\necho '{}'`);
    await route(script);
    const seen = readFileSync(cwdFile, "utf8").trim();
    expect(seen).toBe("/");
    expect(seen).not.toBe(realpathSync(process.cwd()));
  });

  test("drops a PATH directory that another user owns or can write", async () => {
    if (process.getuid?.() === 0) return;
    const otherUid = (process.getuid?.() ?? 0) + 1000;
    // Stands in for another user: everything this user owns is then someone else's, root's stays.
    const path = await trustedScriptPath(otherUid);
    for (const dir of path.split(":").filter(Boolean)) {
      expect(statSync(dir).uid).toBe(0);
    }
    expect(await trustedScriptPath()).toContain("/usr/bin");
  });

  test("excludes a PATH directory that others can write even when it is sticky", async () => {
    const root = makeRoot();
    const plain = join(root, "plain");
    const sticky = join(root, "sticky");
    const open = join(root, "open");
    for (const dir of [plain, sticky, open]) mkdirSync(dir);
    chmodSync(plain, 0o755);
    chmodSync(sticky, 0o1777);
    chmodSync(open, 0o777);
    const uid = process.getuid?.();
    // The temp root's own ancestors (/tmp is sticky and world-writable on Linux) are marked as
    // already settled, so only the directory under test decides.
    expect(await trustedScriptPath(uid, [plain, sticky, open], new Set([root]))).toBe(plain);
    // A sticky directory is still fine for the script's own directory chain (like /tmp).
    const script = writeScript(sticky, "route.sh", "echo '{}'");
    await expect(resolveRoutingScript(script)).resolves.toBe(script);
  });

  describe("a symbolic link in the fixed PATH", () => {
    // The temp root's own ancestors are marked settled (see above); only what is below it decides.
    function setup() {
      const root = makeRoot();
      const uid = process.getuid?.();
      const settled = new Set([root]);
      const safeBin = join(root, "safe", "bin");
      mkdirSync(safeBin, { recursive: true });
      chmodSync(join(root, "safe"), 0o755);
      chmodSync(safeBin, 0o755);
      return { root, uid, settled, safeBin };
    }

    test.each([
      ["group-writable", 0o775],
      ["other-writable", 0o777],
    ])("is dropped when its target sits under a %s parent", async (_label, parentMode) => {
      const { root, uid, settled, safeBin } = setup();
      const wide = join(root, "wide");
      mkdirSync(join(wide, "bin"), { recursive: true });
      chmodSync(join(wide, "bin"), 0o755);
      chmodSync(wide, parentMode);
      // The link's own directory and the target directory both look fine; only the target's real
      // parent can be swapped by someone else.
      const links = join(root, "links");
      mkdirSync(links);
      chmodSync(links, 0o755);
      const risky = join(links, "risky");
      const fine = join(links, "fine");
      symlinkSync(join(wide, "bin"), risky);
      symlinkSync(safeBin, fine);
      expect(await trustedScriptPath(uid, [risky, fine], settled)).toBe(fine);
    });

    test("is dropped when a link on the way sits in a writable directory", async () => {
      const { root, uid, settled, safeBin } = setup();
      const open = join(root, "open");
      mkdirSync(open);
      chmodSync(open, 0o777);
      const hop = join(open, "hop");
      symlinkSync(safeBin, hop);
      const links = join(root, "links");
      mkdirSync(links);
      chmodSync(links, 0o755);
      // links/entry -> open/hop -> safe/bin: the real target and its parents are all fine, but
      // anyone can replace open/hop.
      const entry = join(links, "entry");
      symlinkSync(hop, entry);
      expect(await trustedScriptPath(uid, [entry, safeBin], settled)).toBe(safeBin);
    });

    test("a failed walk does not vouch for the directories below the failure", async () => {
      const { root, uid, settled } = setup();
      const wide = join(root, "wide");
      const real = join(wide, "real");
      mkdirSync(join(real, "bin"), { recursive: true });
      chmodSync(real, 0o755);
      chmodSync(join(real, "bin"), 0o755);
      chmodSync(wide, 0o775);
      const links = join(root, "links");
      mkdirSync(links);
      chmodSync(links, 0o755);
      const alias = join(links, "alias");
      symlinkSync(join(real, "bin"), alias);
      // wide/real/bin fails on its group-writable parent. The directories it passed on the way up
      // (bin, real) must not be remembered as trusted, or the entries that reach them next would
      // stop there and never see wide.
      expect(await trustedScriptPath(uid, [join(real, "bin"), alias], settled)).toBe("");
      expect(await trustedScriptPath(uid, [join(real, "bin"), real], settled)).toBe("");
    });

    test("is kept when every link, its directory and the target's real parents are trusted", async () => {
      const { root, uid, settled, safeBin } = setup();
      const links = join(root, "links");
      mkdirSync(links);
      chmodSync(links, 0o755);
      const entry = join(links, "entry");
      symlinkSync(safeBin, entry);
      expect(await trustedScriptPath(uid, [entry], settled)).toBe(entry);
    });
  });

  test("resolves the interpreter on the fixed PATH, not through the daemon's", async () => {
    const root = makeRoot();
    const evil = join(root, "evil-bin");
    mkdirSync(evil);
    const marker = join(root, "planted-ran");
    // A planted interpreter that would answer if `env` searched the inherited PATH.
    const planted = join(evil, "pr-radar-test-interpreter");
    writeFileSync(planted, `#!/bin/sh\ntouch "${marker}"\necho '{}'\n`);
    chmodSync(planted, 0o755);
    vi.stubEnv("PATH", `${evil}:/usr/bin:/bin`);
    const script = join(root, "env-shebang.sh");
    writeFileSync(script, "#!/usr/bin/env pr-radar-test-interpreter\n");
    chmodSync(script, 0o755);
    await expect(route(script)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  test("kills the script and fails once its output passes the byte cap", async () => {
    const root = makeRoot();
    const script = writeScript(
      root,
      "flood.sh",
      'while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done',
    );
    await expect(route(script, {}, FAST_LIMITS)).rejects.toThrow(
      "Routing script output exceeded 1024 bytes.",
    );
  });

  test("counts bytes, not characters, against the cap", async () => {
    const root = makeRoot();
    // 600 two-byte characters are 600 characters but 1200 bytes.
    const script = writeScript(
      root,
      "wide.sh",
      `i=0\nwhile [ $i -lt 600 ]; do printf '\\303\\251'; i=$((i+1)); done`,
    );
    await expect(route(script, {}, FAST_LIMITS)).rejects.toThrow(/exceeded 1024 bytes/);
  });

  test("sends SIGTERM on timeout, then SIGKILL after the grace period", async () => {
    const root = makeRoot();
    const pidFile = join(root, "pid.txt");
    const script = writeScript(
      root,
      "stubborn.sh",
      `echo $$ > "${pidFile}"\ntrap '' TERM\nwhile :; do sleep 0.05; done`,
    );
    await expect(
      route(script, {}, { timeoutMs: 400, outputBytes: 1024, killGraceMs: 200 }),
    ).rejects.toThrow(/^Routing script timed out after \d{3}ms\.$/);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  test("kills a descendant that would outlive the script when it times out", async () => {
    const root = makeRoot();
    const pidFile = join(root, "child-pid.txt");
    const script = writeScript(root, "spawner.sh", `sleep 60 &\necho $! > "${pidFile}"\nwait`);
    // The timeout must outlast the shell's start-up on a busy machine: the script writes the
    // descendant's pid before it can be timed out, and the test reads it only after the timeout.
    await expect(
      route(script, {}, { timeoutMs: 2_000, outputBytes: 1024, killGraceMs: 200 }),
    ).rejects.toThrow(/^Routing script timed out after \d+ms\.$/);
    const descendant = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(
      () => {
        expect(() => process.kill(descendant, 0)).toThrow();
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  async function expectGone(pid: number): Promise<void> {
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 3_000, interval: 50 },
    );
  }

  test("kills a descendant with redirected stdio after the script exits successfully", async () => {
    const root = makeRoot();
    const pidFile = join(root, "bg-pid.txt");
    const script = writeScript(
      root,
      "bg-detached.sh",
      `sleep 60 >/dev/null 2>&1 </dev/null &\necho $! > "${pidFile}"\necho '{}'`,
    );
    await expect(route(script, {}, FAST_LIMITS)).resolves.toEqual({});
    await expectGone(Number(readFileSync(pidFile, "utf8").trim()));
  });

  test("a descendant holding the pipes neither delays the result nor outlives the script", async () => {
    const root = makeRoot();
    const pidFile = join(root, "bg-pipe-pid.txt");
    // The background sleep inherits stdout and stderr, so 'close' cannot fire until it is killed.
    const script = writeScript(
      root,
      "bg-pipes.sh",
      `sleep 60 &\necho $! > "${pidFile}"\nprintf '{"profile":"fast"}'`,
    );
    const started = Date.now();
    await expect(
      route(script, {}, { timeoutMs: 20_000, outputBytes: 1024, killGraceMs: 200 }),
    ).resolves.toEqual({ profile: "fast" });
    // Well under the 20 s timeout: the group was killed on exit, not at the timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    await expectGone(Number(readFileSync(pidFile, "utf8").trim()));
  });

  test("a hung settings read neither outlasts the budget nor blocks the next call", async () => {
    const root = makeRoot();
    const quick = writeScript(root, "quick4.sh", "echo '{}'");
    const hung = runRoutingScriptHandler({ payload: {} }, () => new Promise(() => {}), {
      timeoutMs: 300,
      outputBytes: 1024,
      killGraceMs: 100,
    });
    const hungFailure = expect(hung).rejects.toThrow(/took longer than the time budget/);
    // Started while the first call is still hung, so it waits behind it and must be let through
    // when the first call gives up.
    const next = route(quick, {}, FAST_LIMITS);
    await hungFailure;
    await expect(next).resolves.toEqual({});
  });

  test("work abandoned when the budget is already spent cannot raise an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      // The settings read fails only when the test lets it, after the call has given up on it.
      const release = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const failing = async () => {
        await release.promise;
        failed.resolve();
        throw new Error("settings went away");
      };
      await expect(
        runRoutingScriptHandler({ payload: {} }, failing, {
          timeoutMs: 0,
          outputBytes: 1024,
          killGraceMs: 100,
        }),
      ).rejects.toThrow(/took longer than the time budget/);
      release.resolve();
      await failed.promise;
      // Node reports an unhandled rejection once the microtask queue has drained after the turn in
      // which it happened; a later macrotask has therefore seen it reported, had it been.
      await new Promise((done) => setImmediate(done));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("signals the process group once after a script exits, never again at close", async () => {
    const root = makeRoot();
    const script = writeScript(root, "quick3.sh", "echo '{}'");
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(route(script, {}, FAST_LIMITS)).resolves.toEqual({});
      await waitForRoutingScriptIdleForTests();
      const groupKills = kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
      expect(groupKills.map(([, signal]) => signal)).toEqual(["SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });

  test("keeps all of the output a script wrote just before it exited", async () => {
    const root = makeRoot();
    const reason = "x".repeat(800);
    const script = writeScript(root, "big.sh", `sleep 60 &\nprintf '%s' '{"reason":"${reason}"}'`);
    await expect(
      route(script, {}, { timeoutMs: 5_000, outputBytes: 4096, killGraceMs: 200 }),
    ).resolves.toEqual({
      reason,
    });
  });

  test("arms one kill timer however many chunks pass the byte cap", async () => {
    const root = makeRoot();
    const script = writeScript(
      root,
      "flood2.sh",
      'while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done',
    );
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        route(script, {}, { timeoutMs: 5_000, outputBytes: 1024, killGraceMs: 777 }),
      ).rejects.toThrow(/exceeded 1024 bytes/);
      await vi.waitFor(() => expect(spy.mock.calls.filter(([, ms]) => ms === 777).length).toBe(1));
      await new Promise((done) => setTimeout(done, 100));
      expect(spy.mock.calls.filter(([, ms]) => ms === 777)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a call queued behind a timed-out stubborn script starts only after it has been killed", async () => {
    const root = makeRoot();
    const pidFile = join(root, "stubborn.pid");
    const stubborn = writeScript(
      root,
      "stubborn2.sh",
      `echo $$ > "${pidFile}"\ntrap '' TERM\nwhile :; do sleep 0.05; done`,
    );
    const first = route(stubborn, {}, { timeoutMs: 300, outputBytes: 1024, killGraceMs: 400 });
    const firstResult = expect(first).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    // The next call queues behind the script that ignores SIGTERM and must not overlap it.
    const probe = writeScript(
      root,
      "probe.sh",
      `if kill -0 "$(cat "${pidFile}")" 2>/dev/null; then echo '{"reason":"overlap"}'; else echo '{}'; fi`,
    );
    const second = route(probe, {}, { timeoutMs: 5_000, outputBytes: 1024, killGraceMs: 200 });
    await firstResult;
    await expect(second).resolves.toEqual({});
  });

  describe("queue", () => {
    const LONG = { timeoutMs: 5_000, outputBytes: 1024, killGraceMs: 200 };

    // Appends "start NAME" / "end NAME" to one log so the order of the runs can be read back.
    function logging(root: string, name: string, log: string, seconds: string): string {
      return writeScript(
        root,
        `${name}.sh`,
        `echo "start ${name}" >> "${log}"\nsleep ${seconds}\necho "end ${name}" >> "${log}"\necho '{"reason":"${name}"}'`,
      );
    }

    // A script that logs its start, then blocks until the test writes to the gate (a named pipe),
    // then logs its end. Nothing about its length depends on the clock.
    function makeGate(root: string): string {
      const gate = join(root, "gate.fifo");
      execFileSync("mkfifo", [gate]);
      return gate;
    }

    async function openGate(gate: string): Promise<void> {
      await writeFile(gate, "go\n");
    }

    function gated(root: string, name: string, log: string, gate: string): string {
      return writeScript(
        root,
        `${name}.sh`,
        `echo "start ${name}" >> "${log}"\ncat "${gate}" > /dev/null\necho "end ${name}" >> "${log}"\necho '{"reason":"${name}"}'`,
      );
    }

    test("runs a second call after the first, in order, and refuses a fourth", async () => {
      const root = makeRoot();
      const log = join(root, "log.txt");
      // A holds its turn until the test opens the gate, so B and C are queued and D is refused
      // for as long as the test likes, not for as long as a sleep happens to last.
      const gate = makeGate(root);
      const a = gated(root, "a", log, gate);
      const b = logging(root, "b", log, "0.1");
      const c = logging(root, "c", log, "0.1");
      const d = logging(root, "d", log, "0.1");
      const first = route(a, {}, LONG);
      await vi.waitFor(() => expect(existsSync(log)).toBe(true));
      // A call takes its place in line before its first await, so these are queued on return.
      const second = route(b, {}, LONG);
      const third = route(c, {}, LONG);
      await expect(route(d, {}, LONG)).rejects.toThrow(/already running/);
      await openGate(gate);
      await expect(first).resolves.toEqual({ reason: "a" });
      await expect(second).resolves.toEqual({ reason: "b" });
      await expect(third).resolves.toEqual({ reason: "c" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "start a",
        "end a",
        "start b",
        "end b",
        "start c",
        "end c",
      ]);
      // The queue drained: a later call goes straight through.
      await expect(route(d, {}, LONG)).resolves.toEqual({ reason: "d" });
    });

    test("keeps arrival order and counts waiters from the first await, however slow each preflight is", async () => {
      const root = makeRoot();
      const log = join(root, "log.txt");
      const a = logging(root, "a", log, "0.8");
      const b = logging(root, "b", log, "0.1");
      const c = logging(root, "c", log, "0.1");
      const d = logging(root, "d", log, "0.1");
      const first = route(a, {}, LONG);
      await vi.waitFor(() => expect(existsSync(log)).toBe(true));
      const slowSettings = async () => {
        await pause(250);
        return { sourceCodeDir: "/nonexistent-source-dir", routingScriptPath: b };
      };
      // B arrives first but reads its settings slowly; C and D arrive in the same tick.
      const second = runRoutingScriptHandler({ payload: {} }, slowSettings, LONG);
      const third = route(c, {}, LONG);
      const fourth = route(d, {}, LONG);
      await expect(fourth).rejects.toThrow(/already running/);
      await first;
      await expect(second).resolves.toEqual({ reason: "b" });
      await expect(third).resolves.toEqual({ reason: "c" });
      expect(
        readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("start")),
      ).toEqual(["start a", "start b", "start c"]);
    });

    test("refuses a queued call whose wait would outlast its budget, and keeps the order", async () => {
      const root = makeRoot();
      const pidFile = join(root, "stubborn.pid");
      const stubborn = writeScript(
        root,
        "stubborn3.sh",
        `echo $$ > "${pidFile}"\ntrap '' TERM\nwhile :; do sleep 0.05; done`,
      );
      // Killed 300 + 800 ms after it starts; the second call only has 500 ms in all.
      const first = route(stubborn, {}, { timeoutMs: 300, outputBytes: 1024, killGraceMs: 800 });
      const firstResult = expect(first).rejects.toThrow(/timed out/);
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const quick = writeScript(root, "quick2.sh", "echo '{}'");
      await expect(
        route(quick, {}, { timeoutMs: 500, outputBytes: 1024, killGraceMs: 200 }),
      ).rejects.toThrow(/already running/);
      await firstResult;
      // The refused call left the queue without letting a later one overtake the stubborn script.
      const probe = writeScript(
        root,
        "probe2.sh",
        `if kill -0 "$(cat "${pidFile}")" 2>/dev/null; then echo '{"reason":"overlap"}'; else echo '{}'; fi`,
      );
      await expect(route(probe, {}, LONG)).resolves.toEqual({});
    });

    test("a first call's script gets only what is left after its own preflight", async () => {
      const root = makeRoot();
      const hang = writeScript(root, "hang-first.sh", "sleep 30");
      const slowSettings = async () => {
        await pause(600);
        return { sourceCodeDir: "/nonexistent-source-dir", routingScriptPath: hang };
      };
      const startedAt = Date.now();
      const failure = await runRoutingScriptHandler({ payload: {} }, slowSettings, {
        timeoutMs: 1_000,
        outputBytes: 1024,
        killGraceMs: 200,
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toMatch(/timed out after \d+ms/);
      expect(Number(failure?.message.match(/after (\d+)ms/)?.[1])).toBeLessThan(500);
      // The host gives the whole call 1 s; untrimmed it would have run for 0.6 + 1 s.
      expect(Date.now() - startedAt).toBeLessThan(1_300);
    });

    test("a queued call's script gets only what is left of its budget", async () => {
      const root = makeRoot();
      const log = join(root, "log.txt");
      const slow = logging(root, "slow", log, "0.8");
      const hang = writeScript(root, "hang.sh", "sleep 30");
      const limits = { timeoutMs: 1_200, outputBytes: 1024, killGraceMs: 200 };
      const first = route(slow, {}, limits);
      await vi.waitFor(() => expect(existsSync(log)).toBe(true));
      const startedAt = Date.now();
      const second = route(hang, {}, limits);
      const failure = await second.then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toMatch(/timed out after \d+ms/);
      const ranFor = Number(failure?.message.match(/after (\d+)ms/)?.[1]);
      expect(ranFor).toBeLessThan(1_200);
      // Unshortened the call would have run for its own 1.2 s after waiting for the first one.
      expect(Date.now() - startedAt).toBeLessThan(1_700);
      await first;
    });
  });

  describe("shutdown", () => {
    // Settings the plugin was stopped under must not leak into the next test.
    afterEach(() => {
      startRoutingScripts();
    });

    test("ends a running script and its descendants, even one that ignores SIGTERM", async () => {
      const root = makeRoot();
      const pidFile = join(root, "pids.txt");
      const stubborn = writeScript(
        root,
        "stubborn-stop.sh",
        `trap '' TERM\nsleep 60 &\necho "$$ $!" > "${pidFile}"\nwhile :; do sleep 0.05; done`,
      );
      const running = route(
        stubborn,
        {},
        { timeoutMs: 20_000, outputBytes: 1024, killGraceMs: 5_000 },
      );
      const failure = expect(running).rejects.toThrow(/shutting down/);
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const started = Date.now();
      await stopRoutingScripts();
      await failure;
      // Sent SIGKILL after the shutdown grace (1 s), not after its own 5 s grace or 20 s timeout.
      expect(Date.now() - started).toBeLessThan(2_500);
      for (const pid of readFileSync(pidFile, "utf8").trim().split(" ")) {
        await expectGone(Number(pid));
      }
    });

    test("kills at once a script that a timeout already asked to end and that ignores SIGTERM", async () => {
      const root = makeRoot();
      const pidFile = join(root, "pid2.txt");
      const stubborn = writeScript(
        root,
        "stubborn-timeout.sh",
        `trap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 0.05; done`,
      );
      // The timeout sends SIGTERM at 2 s (long enough for the script to have written its pid on a
      // busy machine) and would send SIGKILL 20 s later.
      const timedOut = route(
        stubborn,
        {},
        { timeoutMs: 2_000, outputBytes: 1024, killGraceMs: 20_000 },
      );
      await expect(timedOut).rejects.toThrow(/timed out/);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).not.toThrow();
      const started = Date.now();
      await stopRoutingScripts();
      expect(Date.now() - started).toBeLessThan(1_500);
      await expectGone(pid);
    });

    test("refuses a later call, and a queued one never starts its script", async () => {
      const root = makeRoot();
      const log = join(root, "log.txt");
      const first = writeScript(root, "first-stop.sh", `echo first >> "${log}"\nsleep 30`);
      const second = writeScript(root, "second-stop.sh", `echo second >> "${log}"\necho '{}'`);
      const limits = { timeoutMs: 20_000, outputBytes: 1024, killGraceMs: 200 };
      const running = route(first, {}, limits);
      const runningFailure = expect(running).rejects.toThrow(/shutting down/);
      await vi.waitFor(() => expect(existsSync(log)).toBe(true));
      const queuedFailure = expect(route(second, {}, limits)).rejects.toThrow(/shutting down/);
      await stopRoutingScripts();
      await runningFailure;
      await queuedFailure;
      await expect(route(second, {}, limits)).rejects.toThrow(/shutting down/);
      expect(readFileSync(log, "utf8").trim()).toBe("first");
    });

    test("does nothing when no script is running", async () => {
      await expect(stopRoutingScripts()).resolves.toBeUndefined();
    });
  });

  test("reports an unsupported platform on Windows", async () => {
    const script = writeScript(makeRoot(), "any.sh", "echo {}");
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(route(script)).rejects.toThrow("Routing scripts are not supported on Windows.");
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });
});
