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
