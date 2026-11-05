import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

/** The bytes of a regular file of at most `maxBytes`; a symlink, FIFO, directory or larger file reads as nothing. */
export function readRegularFile(path: string, maxBytes: number): Buffer | undefined {
  // O_NONBLOCK keeps a FIFO planted under the file's name from hanging the worker.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined;
    descriptor = openSync(path, flags);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    // A file another user planted in a shared directory is not ours to read.
    if (process.getuid !== undefined && stat.uid !== process.getuid()) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
