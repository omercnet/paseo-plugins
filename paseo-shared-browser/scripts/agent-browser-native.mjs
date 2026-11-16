import { existsSync } from "node:fs";
import { chmod, cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Detects the C library the way agent-browser's own launcher does
 * (scripts/native.js hostLibc), so the staged platform package is the one it
 * looks up at run time.
 */
export function hostLibc() {
  if (process.platform !== "linux") return null;
  process.report.excludeNetwork = true;
  const report = process.report.getReport();
  if (report.header.glibcVersionRuntime) return "glibc";
  if (report.sharedObjects.some((path) => /(?:^|\/)ld-musl-|libc\.musl-/.test(path))) return "musl";
  const loaderArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return existsSync(`/lib/ld-musl-${loaderArch}.so.1`) ? "musl" : "glibc";
}

/**
 * Names the optional dependency that carries the native agent-browser binary
 * for a host, mirroring agent-browser's nativeTarget(). Windows ARM64 runs the
 * x64 build through emulation.
 */
export function agentBrowserPlatformPackage(os, cpu, libc) {
  const archKey = cpu === "x64" || cpu === "arm64" ? cpu : null;
  if (!archKey) return null;
  switch (os) {
    case "darwin":
      return { name: `@agent-browser/cli-darwin-${archKey}`, file: "agent-browser" };
    case "linux":
      return {
        name: `@agent-browser/cli-linux-${archKey}-${libc === "musl" ? "musl" : "gnu"}`,
        file: "agent-browser",
      };
    case "win32":
      return { name: "@agent-browser/cli-win32-x64-msvc", file: "agent-browser.exe" };
    default:
      return null;
  }
}

/**
 * Copies agent-browser and the host's platform package into runtimeModules,
 * side by side, which is the layout agent-browser's launcher resolves the
 * native binary from. The platform package is found from the installed
 * agent-browser, so hoisted, nested and isolated (Bun) layouts all work.
 * Returns the staged native binary.
 */
export async function stageAgentBrowserPackages({
  agentBrowserRoot,
  runtimeModules,
  version,
  os = process.platform,
  cpu = process.arch,
  libc = os === "linux" ? hostLibc() : null,
}) {
  const target = agentBrowserPlatformPackage(os, cpu, libc);
  if (!target) throw new Error(`Unsupported agent-browser platform: ${os}-${cpu}`);

  let manifestPath;
  try {
    manifestPath = createRequire(join(agentBrowserRoot, "package.json")).resolve(
      `${target.name}/package.json`,
    );
  } catch {
    throw new Error(
      `agent-browser ${version} needs its optional dependency ${target.name}, which is not installed. ` +
        "Reinstall the plugin dependencies without omitting optional packages.",
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== target.name || manifest.version !== version) {
    throw new Error(
      `Expected ${target.name} ${version}, found ${manifest.name ?? "unknown"} ${manifest.version ?? "unknown"} at ${manifestPath}`,
    );
  }
  const packageRoot = dirname(manifestPath);
  if (!existsSync(join(packageRoot, "bin", target.file))) {
    throw new Error(`${target.name} ${version} has no bin/${target.file}`);
  }

  await cp(agentBrowserRoot, join(runtimeModules, "agent-browser"), {
    recursive: true,
    force: true,
  });
  const stagedPackage = join(runtimeModules, ...target.name.split("/"));
  await cp(packageRoot, stagedPackage, { recursive: true, force: true });
  const binary = join(stagedPackage, "bin", target.file);
  // Package managers do not always keep the execute bit; the staged copy is ours to fix.
  if (os !== "win32") await chmod(binary, 0o700);
  return binary;
}
