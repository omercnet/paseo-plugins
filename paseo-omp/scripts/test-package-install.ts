import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { unzipSync } from "fflate";

const pluginRoot = join(import.meta.dirname, "..");
const ignoredCheckoutEntries: Record<string, true> = {
  ".git": true,
  coverage: true,
  dist: true,
  node_modules: true,
};

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  }
  return stdout.trim();
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

async function verifyInstalledPackage(root: string): Promise<void> {
  for (const command of await buildCommands(root)) await run(command, root);
  const probe = join(root, ".package-install-smoke.ts");
  await writeFile(probe, 'import "@modelcontextprotocol/sdk/server/index.js";\nimport "yaml";\n');
  try {
    await run([process.execPath, probe], root);
  } finally {
    await rm(probe, { force: true });
  }
}

async function verifyArchiveInstall(temporaryDirectory: string): Promise<void> {
  const archivePath = join(temporaryDirectory, "paseo-omp.zip");
  await run([process.execPath, "scripts/package-release.ts", archivePath], pluginRoot);
  const extractionRoot = join(temporaryDirectory, "archive");
  const archive = unzipSync(await Bun.file(archivePath).bytes());
  for (const [path, contents] of Object.entries(archive)) {
    const destination = join(extractionRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await verifyInstalledPackage(join(extractionRoot, "paseo-omp"));
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
  await verifyInstalledPackage(join(checkoutRoot, "paseo-omp"));
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-install-"));
try {
  await verifyArchiveInstall(temporaryDirectory);
  await verifyGitCheckoutInstall(temporaryDirectory);
  console.log("archive and Git checkout package installs passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
