import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { compilePlugin } from "../node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js";

const executeFile = promisify(execFile);
const pluginRoot = join(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const sdkStub = {
  defineRpc: (definition: unknown) => definition,
  defineSettings: (definition: unknown) => definition,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
};

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

async function verifyProductionOnly(root: string, source: string): Promise<void> {
  const installedDevDependency = await access(join(root, "node_modules", "typescript")).then(
    () => true,
    () => false,
  );
  if (installedDevDependency) throw new Error(`${source} preparation installed devDependencies`);
}

async function verifyHostCompilationAndServerLoad(root: string): Promise<void> {
  const { clientBundle, serverBundle } = await compilePlugin({
    client: join(root, "index.client.tsx"),
    server: join(root, "index.server.ts"),
  });
  if (!clientBundle || !serverBundle) {
    throw new Error("Paseo host compilation did not produce both plugin bundles");
  }
  const installedRequire = createRequire(join(root, "package.json"));
  // biome-ignore lint/security/noGlobalEval: mirrors the Paseo host's plugin bundle loader
  const factory = globalThis.eval(serverBundle) as (require: (name: string) => unknown) => {
    default?: unknown;
  };
  const loaded = factory((name) =>
    name.startsWith("@getpaseo/plugin") ? sdkStub : installedRequire(name),
  );
  if (typeof loaded.default !== "function") {
    throw new Error("Paseo host compilation produced no server contribution");
  }
}

async function verifyNpmPackageInstall(temporaryDirectory: string): Promise<void> {
  const packed: unknown = JSON.parse(
    await run([npmCommand, "pack", "--json", "--pack-destination", temporaryDirectory], pluginRoot),
  );
  const artifact = Array.isArray(packed) ? packed[0] : undefined;
  const filename =
    artifact && typeof artifact === "object" && "filename" in artifact
      ? artifact.filename
      : undefined;
  if (typeof filename !== "string" || !filename) throw new Error("npm pack returned no artifact");

  const consumerRoot = join(temporaryDirectory, "consumer");
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
  await run(
    [npmCommand, "install", join(temporaryDirectory, filename), "--ignore-scripts"],
    consumerRoot,
  );

  const installedPlugin = join(consumerRoot, "node_modules", "@omercnet", "paseo-omp");
  const packagedLockfile = await access(join(installedPlugin, "package-lock.json")).then(
    () => true,
    () => false,
  );
  if (packagedLockfile) throw new Error("npm artifact unexpectedly contains package-lock.json");
  const commands = await buildCommands(installedPlugin);
  for (const command of commands) await run(command, installedPlugin);
  const generatedLockfile = await access(join(installedPlugin, "package-lock.json")).then(
    () => true,
    () => false,
  );
  if (generatedLockfile) throw new Error("npm preparation generated package-lock.json");
  await verifyProductionOnly(installedPlugin, "npm artifact");
  await verifyRuntimeDependencies(installedPlugin);
  await verifyHostCompilationAndServerLoad(installedPlugin);
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
  await verifyProductionOnly(checkoutPlugin, "Git");
  await verifyRuntimeDependencies(checkoutPlugin);
  await verifyHostCompilationAndServerLoad(checkoutPlugin);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-install-"));
try {
  await verifyNpmPackageInstall(temporaryDirectory);
  await verifyGitCheckoutInstall(temporaryDirectory);
  console.log("npm package and Git checkout installs passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
