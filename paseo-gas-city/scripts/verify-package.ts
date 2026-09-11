import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";

const packageRoot = join(import.meta.dir, "..");
const requiredFiles = [
  "bun.lock",
  "CHANGELOG.md",
  "icon.svg",
  "LICENSE",
  "README.md",
  "index.client.tsx",
  "index.server.ts",
  "client/city-operations.tsx",
  "client/contribute.tsx",
  "client/dispatch-intent.ts",
  "client/factory-panel.tsx",
  "client/gas-city-surface.tsx",
  "client/open-in-paseo.ts",
  "client/settings-screen.tsx",
  "client/view-model.ts",
  "server/gas-city-client.ts",
  "server/handlers.ts",
  "server/provider-transport.ts",
  "server/provider.ts",
  "server/workspace-mapping.ts",
  "shared/index.ts",
  "shared/limits.ts",
  "shared/rpc.ts",
  "shared/schemas.ts",
  "shared/settings.ts",
  "package.json",
  "paseo-plugin.json",
] as const;

function normalized(path: string, root = "") {
  const portablePath = path.replaceAll("\\", "/");
  return root && portablePath.startsWith(root) ? portablePath.slice(root.length) : portablePath;
}

function assertRequired(label: string, files: ReadonlySet<string>) {
  const missing = requiredFiles.filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required files:\n- ${missing.join("\n- ")}`);
  }
}

function assertAbsent(
  label: string,
  files: ReadonlySet<string>,
  isForbidden: (path: string) => boolean,
) {
  const forbidden = [...files].filter(isForbidden).sort();
  if (forbidden.length > 0) {
    throw new Error(`${label} contains forbidden files:\n- ${forbidden.join("\n- ")}`);
  }
}

function isInDirectory(path: string, directory: string) {
  return path === directory || path.startsWith(`${directory}/`);
}

function isPlaceholder(path: string) {
  return path === ".gitkeep" || path.endsWith("/.gitkeep");
}

function isForbiddenNpmFile(path: string) {
  return (
    isInDirectory(path, "tests") ||
    isInDirectory(path, "test") ||
    isInDirectory(path, "scripts") ||
    isInDirectory(path, "coverage") ||
    isInDirectory(path, "dist") ||
    isInDirectory(path, "node_modules") ||
    isPlaceholder(path) ||
    /^(?:tsconfig(?:\.[^/]+)?\.json|biome(?:\.[^/]+)?\.json|bunfig\.toml)$/.test(path) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(path)
  );
}

function isForbiddenReleaseFile(path: string) {
  return (
    isInDirectory(path, "tests") ||
    isInDirectory(path, "test") ||
    isInDirectory(path, "node_modules") ||
    isPlaceholder(path) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(path)
  );
}

async function run(command: string[], label: string) {
  const subprocess = (() => {
    try {
      return Bun.spawn({
        cmd: command,
        cwd: packageRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new Error(`${label} could not start: ${String(error)}`);
    }
  })();

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || "no command output";
    throw new Error(`${label} failed with exit code ${exitCode}:\n${detail}`);
  }

  return stdout;
}

function npmPackFiles(stdout: string) {
  let reports: unknown;
  try {
    reports = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${String(error)}`);
  }

  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error(
      `npm pack returned ${Array.isArray(reports) ? reports.length : "a non-array result"}; expected one package report`,
    );
  }

  const report = reports[0] as { files?: Array<{ path?: unknown }> };
  if (!Array.isArray(report.files)) {
    throw new Error("npm pack report does not contain a files array");
  }

  return new Set(
    report.files.map(({ path }, index) => {
      if (typeof path !== "string") {
        throw new Error(`npm pack report file ${index + 1} has no string path`);
      }
      return normalized(path, "package/");
    }),
  );
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-gas-city-package-"));

try {
  const packOutput = await run(["npm", "pack", "--dry-run", "--json"], "npm package verification");
  const packedFiles = npmPackFiles(packOutput);
  assertRequired("npm tarball", packedFiles);
  assertAbsent("npm tarball", packedFiles, isForbiddenNpmFile);

  const releasePath = join(temporaryDirectory, "paseo-gas-city.zip");
  await run([process.execPath, "scripts/package-release.ts", releasePath], "release zip build");

  let releaseFiles: ReadonlySet<string>;
  try {
    const archive = unzipSync(await Bun.file(releasePath).bytes());
    releaseFiles = new Set(Object.keys(archive).map((path) => normalized(path, "paseo-gas-city/")));
  } catch (error) {
    throw new Error(`release zip could not be inspected: ${String(error)}`);
  }

  assertRequired("release zip", releaseFiles);
  assertAbsent("release zip", releaseFiles, isForbiddenReleaseFile);
  console.log("Verified npm tarball and release zip contents.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
