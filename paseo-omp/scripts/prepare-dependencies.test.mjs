import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { prepareDependencies } from "./prepare-dependencies.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "paseo-omp-dependencies-"));
  temporaryRoots.push(root);
  return root;
}

test("uses locked lifecycle-free installation for a Git checkout", () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "package-lock.json"), "{}");
  const calls = [];

  const installed = prepareDependencies(root, (...args) => calls.push(args));

  expect(installed).toBe(true);
  expect(calls).toEqual([
    [
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--ignore-scripts"],
      { cwd: root, stdio: "inherit" },
    ],
  ]);
});

test("keeps npm-installed production dependencies when no lockfile is packaged", () => {
  const root = temporaryRoot();

  const installed = prepareDependencies(root, () => {
    throw new Error("npm ci must not run without a packaged lockfile");
  });

  expect(installed).toBe(false);
});
