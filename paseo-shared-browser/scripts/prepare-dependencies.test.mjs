import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { prepareDependencies, resolveDependencyRoot } from "./prepare-dependencies.mjs";

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "shared-browser-dependencies-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

test("uses npm ci for a Git checkout with a lockfile", (t) => {
  const root = temporaryRoot(t);
  writeFileSync(join(root, "package-lock.json"), "{}");
  const calls = [];

  const installed = prepareDependencies(root, (...args) => calls.push(args));

  assert.equal(installed, true);
  assert.deepEqual(calls, [
    [
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--include=dev"],
      { cwd: root, stdio: "inherit" },
    ],
  ]);
});

test("keeps npm-installed production dependencies when no lockfile is packaged", (t) => {
  const root = temporaryRoot(t);

  const installed = prepareDependencies(root, () => {
    throw new Error("npm ci must not run without a packaged lockfile");
  });

  assert.equal(installed, false);
});

test("resolves a dependency hoisted above the installed plugin", (t) => {
  const root = temporaryRoot(t);
  const packageRoot = join(root, "node_modules", "example-runtime");
  const pluginScript = join(
    root,
    "node_modules",
    "@omercnet",
    "paseo-shared-browser",
    "scripts",
    "prepare-runtime.mjs",
  );
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(dirname(pluginScript), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"example-runtime"}');

  assert.equal(
    resolveDependencyRoot("example-runtime", pathToFileURL(pluginScript).href),
    realpathSync(packageRoot),
  );
});
