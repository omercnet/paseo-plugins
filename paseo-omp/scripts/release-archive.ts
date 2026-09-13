import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";

export function validateArchivePath(archivePath: string): string {
  if (
    !archivePath ||
    archivePath.includes("\0") ||
    archivePath.includes("\\") ||
    /^[A-Za-z]:/u.test(archivePath) ||
    archivePath.startsWith("/") ||
    posix.normalize(archivePath) !== archivePath
  ) {
    throw new Error(`Unsafe ZIP entry path: ${archivePath}`);
  }
  return archivePath;
}

export function resolveArchiveDestination(extractionRoot: string, archivePath: string): string {
  validateArchivePath(archivePath);
  const root = resolve(extractionRoot);
  const destination = resolve(root, ...archivePath.split("/"));
  if (destination === root || !destination.startsWith(`${root}${sep}`)) {
    throw new Error(`ZIP entry escapes extraction root: ${archivePath}`);
  }
  return destination;
}

export async function extractArchiveFiles(
  archive: Record<string, Uint8Array>,
  extractionRoot: string,
): Promise<void> {
  for (const [archivePath, contents] of Object.entries(archive)) {
    const destination = resolveArchiveDestination(extractionRoot, archivePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, { flag: "wx" });
  }
}
