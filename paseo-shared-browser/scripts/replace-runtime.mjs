import { access, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function replaceRuntime(stagingRoot, runtimeRoot) {
  await access(stagingRoot);
  const pluginDataRoot = dirname(runtimeRoot);
  const pointer = join(pluginDataRoot, "runtime-current");
  const pendingPointer = join(pluginDataRoot, `.runtime-current-${process.pid}`);
  await writeFile(pendingPointer, `${basename(stagingRoot)}\n`, { mode: 0o600 });
  try {
    await rename(pendingPointer, pointer);
  } finally {
    await rm(pendingPointer, { force: true });
  }
}

/**
 * Removes a staging runtime after a failed preparation and rethrows the
 * preparation error. Windows file locks can outlast the retries; a cleanup
 * failure is reported but never replaces the original diagnostic.
 */
export async function discardRuntime(stagingRoot, preparationError, remove = rm) {
  try {
    await remove(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (cleanupError) {
    console.warn(
      `Could not remove the failed Shared Browser runtime at ${stagingRoot}:`,
      cleanupError,
    );
  }
  throw preparationError;
}
