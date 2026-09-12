import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import { zipSync } from "fflate";
import packageJson from "../package.json";
import { validateArchivePath } from "./release-archive";

const output = Bun.argv[2] ?? `dist/paseo-omp-v${packageJson.version}.zip`;
const archiveRoot = "paseo-omp";
const releaseRoots = ["package.json", ...packageJson.files] as const;

const archiveCompileDependencies = [
  "@getpaseo/client",
  "@getpaseo/plugin",
  "@getpaseo/protocol",
  "@tanstack/react-query",
  "react",
  "react-native",
  "zod",
] as const;
function normalizeReleaseRoot(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === "..") ||
    path === "node_modules" ||
    path.startsWith("node_modules/")
  ) {
    throw new Error(`Unsafe release allowlist entry: ${path}`);
  }
  return posix.normalize(path);
}

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
  return stdout;
}

async function trackedReleaseFiles(): Promise<string[]> {
  const roots = releaseRoots.map(normalizeReleaseRoot);
  const tracked = (await run(["git", "ls-files", "--cached", "-z", "--", "."], process.cwd()))
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split(sep).join(posix.sep));
  const selected = tracked.filter((path) =>
    roots.some((root) => path === root || path.startsWith(`${root}/`)),
  );

  for (const root of roots) {
    if (!selected.some((path) => path === root || path.startsWith(`${root}/`))) {
      throw new Error(`Release allowlist entry has no tracked files: ${root}`);
    }
  }
  for (const path of selected) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Tracked release input must be a regular file: ${path}`);
    }
  }
  return selected.sort();
}

async function collectDependencyFiles(root: string, path: string, files: string[]): Promise<void> {
  const relativePath = path
    .slice(root.length + 1)
    .split(sep)
    .join(posix.sep);
  if (relativePath.split("/").includes(".bin")) return;

  const metadata = await lstat(path);
  if (metadata.isSymbolicLink())
    throw new Error(`Production dependency must not be a symlink: ${relativePath}`);
  if (metadata.isFile()) {
    files.push(relativePath);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Unsupported production dependency entry: ${relativePath}`);
  }

  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) await collectDependencyFiles(root, join(path, entry.name), files);
}

async function productionDependencies(): Promise<{ root: string; files: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-production-"));
  await cp("package.json", join(root, "package.json"));
  await cp("bun.lock", join(root, "bun.lock"));
  try {
    await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], root);

    const required = [...Object.keys(packageJson.dependencies), ...archiveCompileDependencies];
    const pending = [...required];
    const included = new Set<string>();
    const files: string[] = [];
    while (pending.length > 0) {
      const dependency = pending.pop();
      if (!dependency || included.has(dependency)) continue;
      const packageRoot = join(root, "node_modules", ...dependency.split("/"));
      const metadataPath = join(packageRoot, "package.json");
      if (!(await Bun.file(metadataPath).exists())) {
        if (required.includes(dependency)) {
          throw new Error(`Required archive dependency was not installed: ${dependency}`);
        }
        continue;
      }

      included.add(dependency);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      pending.push(...Object.keys(metadata.dependencies ?? {}));
      pending.push(...Object.keys(metadata.optionalDependencies ?? {}));
      pending.push(...Object.keys(metadata.peerDependencies ?? {}));
      await collectDependencyFiles(root, packageRoot, files);
    }
    return { root, files: [...new Set(files)].sort() };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const files: Record<string, Uint8Array> = {};
for (const path of await trackedReleaseFiles()) {
  const archivePath = validateArchivePath(posix.join(archiveRoot, path));
  files[archivePath] = await Bun.file(path).bytes();
}

const dependencies = await productionDependencies();
try {
  for (const path of dependencies.files) {
    const archivePath = validateArchivePath(posix.join(archiveRoot, path));
    files[archivePath] = await Bun.file(join(dependencies.root, path)).bytes();
  }
} finally {
  await rm(dependencies.root, { recursive: true, force: true });
}

await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await Bun.write(output, zipSync(files, { level: 9, mtime: new Date(1980, 0, 1) }));
console.log(output);
