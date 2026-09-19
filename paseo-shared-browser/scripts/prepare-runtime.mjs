import { resolveDependencyRoot } from "./prepare-dependencies.mjs";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { arch, homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const expectedVersion = "0.37.1";
const hostPlatform = platform();
const hostArch = arch();
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
const pluginDataRoot = join(paseoHome, "plugin-data", "shared-browser");
const runtimeRoot = join(pluginDataRoot, "runtime");
const stagingRoot = join(pluginDataRoot, `.runtime-${process.pid}`);
const runtimeModules = join(stagingRoot, "node_modules");
const packagedAgentBrowser = resolveDependencyRoot("agent-browser");
const runtimeEntry = join(
  runtimeModules,
  ".bin",
  hostPlatform === "win32" ? "agent-browser.exe" : "agent-browser",
);
const runtimeChromiumEntry = join(
  stagingRoot,
  "chromium",
  hostPlatform === "win32" ? "chrome.exe" : "chrome",
);
const supervisorEntry = join(projectRoot, "server", "supervisor-entry.ts");
const mcpEntry = join(projectRoot, "server", "mcp-entry.ts");

async function requireExecutable(path, label) {
  const absolutePath = resolve(path);
  try {
    await access(absolutePath, constants.X_OK);
  } catch {
    throw new Error(`${label} is missing or not executable: ${absolutePath}`);
  }
  return absolutePath;
}

async function validateAgentBrowser(path) {
  const { stdout } = await execFileAsync(path, ["--version"], { encoding: "utf8" });
  const version = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (version !== expectedVersion) {
    throw new Error(`Expected agent-browser ${expectedVersion}, received ${version ?? "unknown"}`);
  }
}

async function validateChromium(path) {
  await execFileAsync(path, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
}

async function bundleRuntimeEntries() {
  await build({
    entryPoints: {
      supervisor: supervisorEntry,
      "shared-browser-mcp": mcpEntry,
    },
    outdir: stagingRoot,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    logLevel: "silent",
  });
}

async function applyPrivatePermissions(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      await applyPrivatePermissions(join(path, entry));
    }
    return;
  }
  await chmod(path, metadata.mode & 0o111 ? 0o700 : 0o600);
}

async function stageChromiumExecutable(executable) {
  const chromiumRoot = join(stagingRoot, "chromium");
  await mkdir(chromiumRoot, { recursive: true, mode: 0o700 });
  if (hostPlatform === "darwin") {
    const quotedExecutable = `'${executable.replaceAll("'", `'"'"'`)}'`;
    await writeFile(runtimeChromiumEntry, `#!/bin/sh\nexec ${quotedExecutable} "$@"\n`);
    await chmod(runtimeChromiumEntry, 0o700);
  } else {
    await symlink(executable, runtimeChromiumEntry);
  }
  return runtimeChromiumEntry;
}

async function findLinuxArm64Chromium() {
  if (hostPlatform !== "linux" || hostArch !== "arm64") return null;

  const candidate = "/usr/bin/chromium";
  try {
    return await requireExecutable(candidate, "System Chromium executable");
  } catch {
    throw new Error(
      `Linux ARM64 requires native Chromium at ${candidate}. ` +
        "Install a non-Snap Chromium build or set " +
        "PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE to its absolute path.",
    );
  }
}

function installedChromiumExecutable(releaseDir) {
  switch (hostPlatform) {
    case "darwin":
      return join(
        releaseDir,
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      );
    case "linux":
      return join(releaseDir, "chrome");
    case "win32":
      return join(releaseDir, "chrome.exe");
    default:
      throw new Error(`Unsupported Chromium platform: ${hostPlatform}`);
  }
}

async function installChromium() {
  const override = process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE;
  if (override) {
    const executable = await requireExecutable(
      override,
      "PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE",
    );
    if (hostPlatform === "win32") return executable;
    return stageChromiumExecutable(executable);
  }

  const systemChromium = await findLinuxArm64Chromium();
  if (systemChromium) {
    const executable = await stageChromiumExecutable(systemChromium);
    console.log(`Using system Chromium at ${systemChromium}`);
    return executable;
  }

  // Rust's dirs::home_dir() ignores HOME on Windows and resolves the profile
  // through SHGetKnownFolderPath. Use that cache there; Unix stays isolated.
  const installHome =
    hostPlatform === "win32" ? userInfo().homedir : join(stagingRoot, "install-home");
  if (hostPlatform !== "win32") {
    await mkdir(installHome, { recursive: true, mode: 0o700 });
  }
  await execFileAsync(runtimeEntry, ["install"], {
    env: hostPlatform === "win32" ? process.env : { ...process.env, HOME: installHome },
    timeout: 180_000,
    windowsHide: true,
  });

  const browsersRoot = join(installHome, ".agent-browser", "browsers");
  const releases = (await readdir(browsersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chrome-"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  const releaseDir = releases[0] && join(browsersRoot, releases[0]);
  if (!releaseDir) throw new Error("agent-browser install did not produce a Chromium release");
  const chrome = installedChromiumExecutable(releaseDir);
  await requireExecutable(chrome, "Installed Chromium executable");
  await cp(releaseDir, join(stagingRoot, "chromium"), { recursive: true, force: true });
  if (hostPlatform === "darwin") {
    // chrome can't be a symlink to the .app's real binary here: macOS dyld
    // resolves @executable_path from the invoked path's own directory, so a
    // symlink at chromium/chrome would break the bundle's relative Frameworks
    // lookup. Exec the real binary by its actual path instead.
    await writeFile(
      runtimeChromiumEntry,
      `#!/bin/sh\nexec "$(cd "$(dirname "$0")" && pwd)/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" "$@"\n`,
    );
    await chmod(runtimeChromiumEntry, 0o700);
  }
  if (hostPlatform !== "win32") await rm(installHome, { recursive: true, force: true });
  return runtimeChromiumEntry;
}

async function stageAgentBrowserEntry() {
  if (hostPlatform === "win32") {
    const executableArch = hostArch === "arm64" ? "x64" : hostArch;
    if (executableArch !== "x64") {
      throw new Error(`Unsupported agent-browser Windows architecture: ${hostArch}`);
    }
    await cp(
      join(packagedAgentBrowser, "bin", `agent-browser-win32-${executableArch}.exe`),
      runtimeEntry,
      { force: true },
    );
  } else {
    await symlink("../agent-browser/bin/agent-browser.js", runtimeEntry);
  }
  await chmod(runtimeEntry, 0o700);
}

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(join(runtimeModules, ".bin"), { recursive: true, mode: 0o700 });
await chmod(pluginDataRoot, 0o700);
await cp(packagedAgentBrowser, join(runtimeModules, "agent-browser"), {
  recursive: true,
  force: true,
});
await stageAgentBrowserEntry();

const binaryOverride = process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY;
if (binaryOverride)
  await validateAgentBrowser(
    await requireExecutable(binaryOverride, "PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY"),
  );
await validateAgentBrowser(await requireExecutable(runtimeEntry, "Packaged agent-browser entry"));
const chromiumEntry = await installChromium();
await bundleRuntimeEntries();

await writeFile(
  join(stagingRoot, "package.json"),
  `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
  { mode: 0o600 },
);
await applyPrivatePermissions(stagingRoot);
if (hostPlatform !== "win32") {
  await validateChromium(await requireExecutable(chromiumEntry, "Staged Chromium executable"));
}
await rename(stagingRoot, runtimeRoot);

console.log(`Prepared immutable Shared Browser runtime assets in ${runtimeRoot}`);
