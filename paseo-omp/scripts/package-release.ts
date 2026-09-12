import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { zipSync } from "fflate";
import packageJson from "../package.json";

const output = Bun.argv[2] ?? `dist/paseo-omp-v${packageJson.version}.zip`;
const archiveRoot = "paseo-omp";
const releaseRoots = ["package.json", ...packageJson.files] as const;

async function collectReleaseFiles(path: string, files: string[]): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Release input must not be a symlink: ${path}`);
  if (metadata.isFile()) {
    files.push(path);
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`Unsupported release input: ${path}`);

  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) await collectReleaseFiles(join(path, entry.name), files);
}

const releaseFiles: string[] = [];
for (const path of releaseRoots) await collectReleaseFiles(path, releaseFiles);
releaseFiles.sort();

const files: Record<string, Uint8Array> = {};
for (const path of releaseFiles) {
  const archivePath = posix.join(archiveRoot, path.split(sep).join(posix.sep));
  files[archivePath] = await Bun.file(path).bytes();
}

await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await Bun.write(output, zipSync(files, { level: 9 }));
console.log(output);
