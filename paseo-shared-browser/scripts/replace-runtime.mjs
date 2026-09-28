import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

export async function replaceRuntime(stagingRoot, runtimeRoot) {
  const previousRuntimeRoot = join(runtimeRoot, "..", `.runtime-previous-${process.pid}`);
  await rm(previousRuntimeRoot, { recursive: true, force: true });
  let replacedExistingRuntime = false;
  try {
    await rename(runtimeRoot, previousRuntimeRoot);
    replacedExistingRuntime = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagingRoot, runtimeRoot);
  } catch (error) {
    if (replacedExistingRuntime) await rename(previousRuntimeRoot, runtimeRoot);
    throw error;
  }
  if (replacedExistingRuntime) {
    await rm(previousRuntimeRoot, { recursive: true, force: true }).catch((error) => {
      console.warn(`Could not remove previous Shared Browser runtime: ${error}`);
    });
  }
}
