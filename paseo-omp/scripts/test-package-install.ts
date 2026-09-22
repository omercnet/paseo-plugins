import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const artifact = join(temporaryDirectory, "paseo-omp.tgz");
  await run(["bun", "pm", "pack", "--ignore-scripts", "--filename", artifact], pluginRoot);

  const consumerRoot = join(temporaryDirectory, "consumer");
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
  await run([npmCommand, "install", artifact, "--ignore-scripts"], consumerRoot);

  const installedPlugin = join(consumerRoot, "node_modules", "@omercnet", "paseo-omp");
  await verifyProductionOnly(installedPlugin, "npm artifact");
  await verifyRuntimeDependencies(installedPlugin);
  await verifyHostCompilationAndServerLoad(installedPlugin);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-install-"));
try {
  await verifyNpmPackageInstall(temporaryDirectory);
  console.log("npm package install passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
