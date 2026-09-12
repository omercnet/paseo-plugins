import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { extractArchiveFiles } from "./release-archive";

const executeFile = promisify(execFile);
const pluginRoot = join(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const ignoredCheckoutEntries: Record<string, true> = {
  ".git": true,
  coverage: true,
  dist: true,
  node_modules: true,
};

async function run(
  command: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const [file, ...args] = command;
  if (!file) throw new Error("Command must not be empty");
  try {
    const { stdout } = await executeFile(file, args, {
      cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    throw new Error(
      `${command.join(" ")} failed (${String(failure.code ?? "unknown")})\n${failure.stderr || failure.stdout || failure.message}`,
    );
  }
}

async function buildCommands(root: string): Promise<string[][]> {
  const manifest = JSON.parse(await readFile(join(root, "paseo-plugin.json"), "utf8")) as {
    build?: unknown;
  };
  if (!Array.isArray(manifest.build) || manifest.build.length === 0) {
    throw new Error("paseo-plugin.json must declare Git preparation commands");
  }
  for (const command of manifest.build) {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((part) => typeof part === "string")
    ) {
      throw new Error("paseo-plugin.json build commands must be non-empty argv arrays");
    }
  }
  return manifest.build as string[][];
}

async function verifyRuntimeDependencies(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const probe = join(root, ".package-install-smoke.mjs");
  await writeFile(probe, 'import "@modelcontextprotocol/sdk/server/index.js";\nimport "yaml";\n');
  try {
    await run([process.execPath, probe], root, environment);
  } finally {
    await rm(probe, { force: true });
  }
}

async function verifyArchiveInstall(temporaryDirectory: string): Promise<void> {
  const archivePath = join(temporaryDirectory, "paseo-omp.zip");
  await run(
    [process.execPath, "--import", "tsx", "scripts/package-release.ts", archivePath],
    pluginRoot,
  );
  const extractionRoot = join(temporaryDirectory, "archive");
  const archive = unzipSync(await readFile(archivePath));
  await extractArchiveFiles(archive, extractionRoot);

  const extractedPlugin = join(extractionRoot, "paseo-omp");
  const offlineEnvironment = {
    ...process.env,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  };
  await verifyRuntimeDependencies(extractedPlugin, offlineEnvironment);
  const offlineBundle = join(extractedPlugin, ".offline-server.cjs");
  try {
    await build({
      absWorkingDir: extractedPlugin,
      entryPoints: ["index.server.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: offlineBundle,
      external: [
        "@getpaseo/plugin",
        "@getpaseo/plugin/server",
        "@getpaseo/plugin/server/provider",
        "zod",
      ],
      logLevel: "silent",
    });
  } finally {
    await rm(offlineBundle, { force: true });
  }
}

async function verifyGitCheckoutInstall(temporaryDirectory: string): Promise<void> {
  const sourceRoot = join(temporaryDirectory, "source");
  const sourcePlugin = join(sourceRoot, "paseo-omp");
  await mkdir(sourceRoot, { recursive: true });
  await cp(pluginRoot, sourcePlugin, {
    recursive: true,
    filter: (source) => source === pluginRoot || !ignoredCheckoutEntries[basename(source)],
  });
  await run(["git", "init", "--quiet"], sourceRoot);
  await run(["git", "add", "paseo-omp"], sourceRoot);
  await run(
    [
      "git",
      "-c",
      "user.name=Paseo OMP smoke",
      "-c",
      "user.email=paseo-omp-smoke@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test fixture",
    ],
    sourceRoot,
  );

  const checkoutRoot = join(temporaryDirectory, "checkout");
  await run(
    ["git", "clone", "--quiet", "--no-hardlinks", sourceRoot, checkoutRoot],
    temporaryDirectory,
  );
  const checkoutPlugin = join(checkoutRoot, "paseo-omp");
  const commands = await buildCommands(checkoutPlugin);
  if (!commands.some((command) => command.includes("--ignore-scripts"))) {
    throw new Error("Git dependency installation must disable lifecycle scripts");
  }
  for (const command of commands) await run(command, checkoutPlugin);
  await verifyRuntimeDependencies(checkoutPlugin);
  await run([npmCommand, "run", "typecheck"], checkoutPlugin);
  await run([npmCommand, "test", "--", "tests/server-bundle.test.ts"], checkoutPlugin);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-install-"));
try {
  await verifyArchiveInstall(temporaryDirectory);
  await verifyGitCheckoutInstall(temporaryDirectory);
  console.log("offline archive and Git checkout package installs passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
