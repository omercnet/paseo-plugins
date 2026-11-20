import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type RoutingScriptLimits,
  resolveRoutingScript,
  runRoutingScriptHandler,
  waitForRoutingScriptIdleForTests,
} from "../server/routing-script";
import { listLocalDirs, prepareWorkspaceCwd, runRoutingScript } from "../shared/viewer-scope";

const tempDirs: string[] = [];

// The handler reads the routing script from server-side settings.
let routingScript = "";
const readSettings = async () => ({
  sourceCodeDir: "/nonexistent-source-dir",
  routingScriptPath: routingScript,
});

afterEach(async () => {
  await waitForRoutingScriptIdleForTests();
  vi.unstubAllEnvs();
  routingScript = "";
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-radar-routing-")));
  tempDirs.push(root);
  return root;
}

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
    routingScript = script;
    return runRoutingScriptHandler({ payload }, readSettings, limits);
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
    ).rejects.toThrow("Routing script timed out after 400ms.");
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
    await expect(
      route(script, {}, { timeoutMs: 400, outputBytes: 1024, killGraceMs: 200 }),
    ).rejects.toThrow("Routing script timed out after 400ms.");
    const descendant = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(
      () => {
        expect(() => process.kill(descendant, 0)).toThrow();
      },
      { timeout: 3_000, interval: 50 },
    );
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

  test("keeps the one-at-a-time guard until the stubborn script has been killed", async () => {
    const root = makeRoot();
    const stubborn = writeScript(
      root,
      "stubborn2.sh",
      `trap '' TERM\nwhile :; do sleep 0.05; done`,
    );
    const limits = { timeoutMs: 300, outputBytes: 1024, killGraceMs: 400 };
    await expect(route(stubborn, {}, limits)).rejects.toThrow(/timed out/);
    // The call failed, but the script ignoring SIGTERM is still alive until SIGKILL goes out.
    await expect(route(stubborn, {}, limits)).rejects.toThrow(/already running/);
    const quick = writeScript(root, "quick.sh", "echo '{}'");
    await vi.waitFor(async () => expect(await route(quick, {}, limits)).toEqual({}), {
      timeout: 3_000,
      interval: 100,
    });
  });

  test("runs one script at a time", async () => {
    const root = makeRoot();
    const started = join(root, "started");
    const slow = writeScript(root, "slow.sh", `touch "${started}"\nsleep 0.5\necho '{}'`);
    const first = route(slow, {}, FAST_LIMITS);
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    await expect(route(slow, {}, FAST_LIMITS)).rejects.toThrow(/already running/);
    await expect(first).resolves.toEqual({});
    rmSync(started);
    await expect(route(slow, {}, FAST_LIMITS)).resolves.toEqual({});
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
