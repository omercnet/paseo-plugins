import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

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
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(file),
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
    throw new Error("paseo-plugin.json must declare source preparation commands");
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

async function verifyRuntimeDependencies(root: string): Promise<void> {
  const probe = join(root, ".package-install-smoke.mjs");
  await writeFile(probe, 'import "@modelcontextprotocol/sdk/server/index.js";\nimport "yaml";\n');
  try {
    await run([process.execPath, probe], root);
  } finally {
    await rm(probe, { force: true });
  }
}

async function verifyServerBundle(root: string): Promise<void> {
  await build({
    absWorkingDir: root,
    entryPoints: ["index.server.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: [
      "@getpaseo/plugin",
      "@getpaseo/protocol/*",
      "@getpaseo/plugin/server",
      "@getpaseo/plugin/server/provider",
      "zod",
    ],
    logLevel: "silent",
  });
}

async function verifyNpmPackageInstall(temporaryDirectory: string): Promise<void> {
  const packed = JSON.parse(
    await run([npmCommand, "pack", "--json", "--pack-destination", temporaryDirectory], pluginRoot),
  ) as Array<{ filename?: string }>;
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a package filename");

  const consumerRoot = join(temporaryDirectory, "consumer");
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
  await run(
    [npmCommand, "install", join(temporaryDirectory, filename), "--ignore-scripts"],
    consumerRoot,
  );

  const installedPlugin = join(consumerRoot, "node_modules", "@omercnet", "paseo-omp");
  const commands = await buildCommands(installedPlugin);
  for (const command of commands) await run(command, installedPlugin);
  await verifyRuntimeDependencies(installedPlugin);
  await verifyServerBundle(installedPlugin);
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
  for (const command of commands) await run(command, checkoutPlugin);
  await verifyRuntimeDependencies(checkoutPlugin);
  await run([npmCommand, "run", "typecheck"], checkoutPlugin);
  await run([npmCommand, "test", "--", "tests/server-bundle.test.ts"], checkoutPlugin);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-install-"));
try {
  await verifyNpmPackageInstall(temporaryDirectory);
  await verifyGitCheckoutInstall(temporaryDirectory);
  console.log("npm package and Git checkout installs passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
