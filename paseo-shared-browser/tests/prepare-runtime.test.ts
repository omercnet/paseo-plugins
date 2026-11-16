import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let root: string;

beforeEach(async () => {
  // macOS tmpdir is behind a /var -> /private/var symlink, and Node module resolution returns real paths.
  root = await realpath(await mkdtemp(join(tmpdir(), "shared-browser-prepare-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("removes the staging runtime when preparation fails", async () => {
  const script = fileURLToPath(new URL("../scripts/prepare-runtime.mjs", import.meta.url).href);

  await expect(
    execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        PASEO_HOME: root,
        PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY: join(root, "missing-agent-browser"),
      },
    }),
  ).rejects.toThrow(/PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY/);

  expect(await readdir(join(root, "plugin-data", "shared-browser"))).toEqual([]);
});

// Renovate bumps the dependency in package.json, so the tests follow it without a second pin.
const agentBrowserVersion: string = createRequire(import.meta.url)("../package.json").dependencies[
  "agent-browser"
];
const otherVersion = "0.0.1";
const platformPackages = [
  "@agent-browser/cli-darwin-arm64",
  "@agent-browser/cli-darwin-x64",
  "@agent-browser/cli-linux-arm64-gnu",
  "@agent-browser/cli-linux-arm64-musl",
  "@agent-browser/cli-linux-x64-gnu",
  "@agent-browser/cli-linux-x64-musl",
  "@agent-browser/cli-win32-x64-msvc",
];

interface NativeTarget {
  packageName: string;
}
interface UpstreamNative {
  nativeTarget(os: string, cpu: string, libc: string | null): NativeTarget | null;
  findNativeBinary(packageRoot: string, target: NativeTarget): string | null;
}
interface StageOptions {
  agentBrowserRoot: string;
  runtimeModules: string;
  version: string;
  os?: string;
  cpu?: string;
  libc?: string | null;
}
interface AgentBrowserNative {
  stageAgentBrowserPackages(options: StageOptions): Promise<string>;
}

// Imported by URL: the script is plain .mjs without type declarations.
async function loadStaging(): Promise<AgentBrowserNative> {
  const url = new URL("../scripts/agent-browser-native.mjs", import.meta.url).href;
  return await import(url);
}

// The installed agent-browser's own lookup, so the staged layout is checked against the
// launcher. Its path is only known once the dependency is resolved.
async function loadUpstreamNative(): Promise<UpstreamNative> {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("agent-browser/package.json"));
  return await import(pathToFileURL(join(root, "scripts", "native.js")).href);
}

async function writeFileIn(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// An agent-browser 0.43 install as Bun's isolated linker lays it out: the launcher has no
// native binaries of its own, and every platform package sits beside it.
async function fakeAgentBrowserInstall(store: string, version = agentBrowserVersion) {
  const modules = join(store, "node_modules");
  const agentBrowserRoot = join(modules, "agent-browser");
  await writeFileIn(
    join(agentBrowserRoot, "package.json"),
    JSON.stringify({
      name: "agent-browser",
      version: agentBrowserVersion,
      optionalDependencies: Object.fromEntries(platformPackages.map((name) => [name, version])),
    }),
  );
  await writeFileIn(join(agentBrowserRoot, "bin", "agent-browser.js"), "");
  for (const name of platformPackages) {
    const packageRoot = join(modules, ...name.split("/"));
    const file = name.includes("win32") ? "agent-browser.exe" : "agent-browser";
    await writeFileIn(join(packageRoot, "package.json"), JSON.stringify({ name, version }));
    await writeFileIn(join(packageRoot, "bin", file), name);
  }
  return agentBrowserRoot;
}

describe("agent-browser platform package staging", () => {
  it.each([
    ["linux", "x64", "glibc", "@agent-browser/cli-linux-x64-gnu"],
    ["linux", "x64", "musl", "@agent-browser/cli-linux-x64-musl"],
    ["linux", "arm64", "glibc", "@agent-browser/cli-linux-arm64-gnu"],
    ["linux", "arm64", "musl", "@agent-browser/cli-linux-arm64-musl"],
    ["darwin", "arm64", null, "@agent-browser/cli-darwin-arm64"],
    ["darwin", "x64", null, "@agent-browser/cli-darwin-x64"],
    ["win32", "x64", null, "@agent-browser/cli-win32-x64-msvc"],
    ["win32", "arm64", null, "@agent-browser/cli-win32-x64-msvc"],
  ])("stages the %s-%s (%s) binary where the launcher looks", async (os, cpu, libc, expected) => {
    const { stageAgentBrowserPackages } = await loadStaging();
    const upstream = await loadUpstreamNative();
    const agentBrowserRoot = await fakeAgentBrowserInstall(join(root, "store"));
    const runtimeModules = join(root, "runtime", "node_modules");

    const binary = await stageAgentBrowserPackages({
      agentBrowserRoot,
      runtimeModules,
      version: agentBrowserVersion,
      os,
      cpu,
      libc,
    });

    const target = upstream.nativeTarget(os, cpu, libc);
    expect(target?.packageName).toBe(expected);
    if (!target) throw new Error("agent-browser has no target for this host");
    expect(upstream.findNativeBinary(join(runtimeModules, "agent-browser"), target)).toBe(binary);
    expect(await readFile(binary, "utf8")).toBe(expected);
    // Fixtures are written without the execute bit, so this proves staging sets it.
    if (os !== "win32" && process.platform !== "win32") {
      expect((await stat(binary)).mode & 0o111).not.toBe(0);
    }
    expect(await readdir(join(runtimeModules, "@agent-browser"))).toEqual([expected.split("/")[1]]);
  });

  it("names the missing platform package", async () => {
    const { stageAgentBrowserPackages } = await loadStaging();
    const agentBrowserRoot = await fakeAgentBrowserInstall(join(root, "store"));
    await rm(join(root, "store", "node_modules", "@agent-browser", "cli-linux-x64-musl"), {
      recursive: true,
    });

    await expect(
      stageAgentBrowserPackages({
        agentBrowserRoot,
        runtimeModules: join(root, "runtime", "node_modules"),
        version: agentBrowserVersion,
        os: "linux",
        cpu: "x64",
        libc: "musl",
      }),
    ).rejects.toThrow(/@agent-browser\/cli-linux-x64-musl, which is not installed/);
  });

  it("rejects a platform package from another release", async () => {
    const { stageAgentBrowserPackages } = await loadStaging();
    const agentBrowserRoot = await fakeAgentBrowserInstall(join(root, "store"), otherVersion);

    await expect(
      stageAgentBrowserPackages({
        agentBrowserRoot,
        runtimeModules: join(root, "runtime", "node_modules"),
        version: agentBrowserVersion,
        os: "darwin",
        cpu: "arm64",
        libc: null,
      }),
    ).rejects.toThrow(
      `Expected @agent-browser/cli-darwin-arm64 ${agentBrowserVersion}, found @agent-browser/cli-darwin-arm64 ${otherVersion}`,
    );
  });

  it("rejects a package that names a different package", async () => {
    const { stageAgentBrowserPackages } = await loadStaging();
    const agentBrowserRoot = await fakeAgentBrowserInstall(join(root, "store"));
    await writeFile(
      join(root, "store", "node_modules", "@agent-browser", "cli-linux-x64-gnu", "package.json"),
      JSON.stringify({ name: "@agent-browser/cli-linux-x64-musl", version: agentBrowserVersion }),
    );

    await expect(
      stageAgentBrowserPackages({
        agentBrowserRoot,
        runtimeModules: join(root, "runtime", "node_modules"),
        version: agentBrowserVersion,
        os: "linux",
        cpu: "x64",
        libc: "glibc",
      }),
    ).rejects.toThrow(
      `Expected @agent-browser/cli-linux-x64-gnu ${agentBrowserVersion}, found @agent-browser/cli-linux-x64-musl`,
    );
  });

  it("rejects a platform package without its binary", async () => {
    const { stageAgentBrowserPackages } = await loadStaging();
    const agentBrowserRoot = await fakeAgentBrowserInstall(join(root, "store"));
    await rm(
      join(
        root,
        "store",
        "node_modules",
        "@agent-browser",
        "cli-win32-x64-msvc",
        "bin",
        "agent-browser.exe",
      ),
    );

    await expect(
      stageAgentBrowserPackages({
        agentBrowserRoot,
        runtimeModules: join(root, "runtime", "node_modules"),
        version: agentBrowserVersion,
        os: "win32",
        cpu: "x64",
        libc: null,
      }),
    ).rejects.toThrow(
      `@agent-browser/cli-win32-x64-msvc ${agentBrowserVersion} has no bin/agent-browser.exe`,
    );
  });

  it("rejects an unsupported architecture", async () => {
    const { stageAgentBrowserPackages } = await loadStaging();
    const agentBrowserRoot = await fakeAgentBrowserInstall(join(root, "store"));

    await expect(
      stageAgentBrowserPackages({
        agentBrowserRoot,
        runtimeModules: join(root, "runtime", "node_modules"),
        version: agentBrowserVersion,
        os: "win32",
        cpu: "ia32",
        libc: null,
      }),
    ).rejects.toThrow(/Unsupported agent-browser platform: win32-ia32/);
  });
});

it("prepares a relocatable runtime whose agent-browser entry runs the native binary", async () => {
  const script = fileURLToPath(new URL("../scripts/prepare-runtime.mjs", import.meta.url).href);
  // A stand-in Chromium keeps the test offline; only agent-browser is real.
  const chromium = join(root, process.platform === "win32" ? "chrome.exe" : "chrome");
  await writeFile(chromium, '#!/bin/sh\necho "Chromium 0.0.0"\n');
  await chmod(chromium, 0o755);

  await execFileAsync(process.execPath, [script], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PASEO_HOME: root,
      PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE: chromium,
    },
  });

  const pluginData = join(root, "plugin-data", "shared-browser");
  const runtime = join(
    pluginData,
    (await readFile(join(pluginData, "runtime-current"), "utf8")).trim(),
  );
  const entry = join(
    runtime,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
  );
  if (process.platform !== "win32") {
    // Validation must not let the upstream launcher rewrite the entry to an absolute path.
    expect(isAbsolute(await readlink(entry))).toBe(false);
  }

  // A moved runtime keeps working and cannot fall back to binaries at the old location.
  const moved = join(root, "moved-runtime");
  await rename(runtime, moved);
  const movedEntry = join(moved, relative(runtime, entry));
  const { stdout } = await execFileAsync(movedEntry, ["--version"], { encoding: "utf8" });
  expect(stdout).toContain(agentBrowserVersion);
  expect(await readdir(join(moved, "node_modules", "@agent-browser"))).toHaveLength(1);
}, 120_000);

it.each(["EBUSY", "EPERM"])(
  "keeps the preparation error when removing the stage fails with %s",
  async (code) => {
    const script = new URL("../scripts/replace-runtime.mjs", import.meta.url).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { discardRuntime } from ${JSON.stringify(script)};
const code = process.argv[1];
const removals = [];
async function remove(path, options) {
  removals.push(options);
  throw Object.assign(new Error(code + ": resource busy or locked"), { code });
}
try {
  await discardRuntime("stage", new Error("PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY is missing"), remove);
} catch (error) {
  process.stdout.write(JSON.stringify({ message: error.message, removals }));
}`,
        code,
      ],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout)).toEqual({
      message: "PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY is missing",
      removals: [{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }],
    });
    expect(stderr).toContain(`${code}: resource busy or locked`);
  },
);
