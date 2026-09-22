import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectAffected, discoverPlugins } from "./detect-affected.mjs";

test("discovers plugins implementing the common CI contract", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paseo-plugins-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pluginRoot = join(root, "new-plugin");
  mkdirSync(pluginRoot);
  writeFileSync(join(pluginRoot, "paseo-plugin.json"), '{"id":"new-plugin"}');
  writeFileSync(
    join(pluginRoot, "package.json"),
    JSON.stringify({
      scripts: {
        check: "biome check .",
        build: "node ../.github/scripts/build-plugin.mjs",
        typecheck: "tsc --noEmit",
        test: "run-s test:ci:*",
        "test:ci:unit": "vitest run",
      },
      devDependencies: {
        "@biomejs/biome": "2.5.14",
        "@getpaseo/server": "0.9.0-beta.1",
        "npm-run-all2": "9.0.3",
      },
    }),
  );

  assert.deepEqual(discoverPlugins(root), [
    {
      plugin: "new-plugin",
      kind: "npm",
    },
  ]);
});

test("rejects plugins missing common CI entries", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paseo-plugins-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pluginRoot = join(root, "incomplete-plugin");
  mkdirSync(pluginRoot);
  writeFileSync(join(pluginRoot, "paseo-plugin.json"), '{"id":"incomplete-plugin"}');
  writeFileSync(
    join(pluginRoot, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );

  assert.throws(
    () => discoverPlugins(root),
    /script:check, script:build, script:typecheck, script:test, script:test:ci:\*, devDependency:@biomejs\/biome, devDependency:@getpaseo\/server, devDependency:npm-run-all2/,
  );
});

test("rejects a plugin using a different build command", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paseo-plugins-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pluginRoot = join(root, "wrong-build");
  mkdirSync(pluginRoot);
  writeFileSync(join(pluginRoot, "paseo-plugin.json"), '{"id":"wrong-build"}');
  writeFileSync(
    join(pluginRoot, "package.json"),
    JSON.stringify({
      scripts: {
        check: "biome check .",
        build: "npm pack --dry-run",
        typecheck: "tsc --noEmit",
        test: "run-s test:ci:*",
        "test:ci:unit": "vitest run",
      },
      devDependencies: {
        "@biomejs/biome": "2.5.14",
        "@getpaseo/server": "0.9.0-beta.1",
        "npm-run-all2": "9.0.3",
      },
    }),
  );

  assert.throws(() => discoverPlugins(root), /script:build/);
});

test("rejects a ranged host compiler dependency", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paseo-plugins-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pluginRoot = join(root, "ranged-compiler");
  mkdirSync(pluginRoot);
  writeFileSync(join(pluginRoot, "paseo-plugin.json"), '{"id":"ranged-compiler"}');
  writeFileSync(
    join(pluginRoot, "package.json"),
    JSON.stringify({
      scripts: {
        check: "biome check .",
        build: "node ../.github/scripts/build-plugin.mjs",
        typecheck: "tsc --noEmit",
        test: "run-s test:ci:*",
        "test:ci:unit": "vitest run",
      },
      devDependencies: {
        "@biomejs/biome": "2.5.14",
        "@getpaseo/server": "^0.9.0-beta.1",
        "npm-run-all2": "9.0.3",
      },
    }),
  );

  assert.throws(() => discoverPlugins(root), /devDependency:@getpaseo\/server/);
});

test("selects only changed plugins", () => {
  const result = detectAffected([
    "agent-monitor/server/index.ts",
    "paseo-beads/package.json",
  ]);

  assert.deepEqual(result.pluginMatrix, ["agent-monitor", "paseo-beads"]);
  assert.deepEqual(result.changed, ["agent-monitor", "paseo-beads"]);
  assert.equal(result.pluginsAffected, true);
  assert.equal(result.ompAffected, false);
  assert.equal(result.sharedBrowserAffected, false);
});

test("selects platform-specific jobs independently", () => {
  const omp = detectAffected(["paseo-omp/index.server.ts"]);
  const sharedBrowser = detectAffected([
    "paseo-shared-browser/server/index.ts",
  ]);

  assert.equal(omp.ompAffected, true);
  assert.equal(omp.pluginsAffected, true);
  assert.deepEqual(omp.pluginMatrix, ["paseo-omp"]);
  assert.equal(sharedBrowser.sharedBrowserAffected, true);
  assert.equal(sharedBrowser.pluginsAffected, true);
  assert.deepEqual(sharedBrowser.pluginMatrix, ["paseo-shared-browser"]);
});

test("ignores changes outside plugin and CI paths", () => {
  const result = detectAffected(["SECURITY.md"]);

  assert.deepEqual(result.affected, []);
  assert.deepEqual(result.pluginMatrix, []);
  assert.equal(result.pluginsAffected, false);
  assert.equal(result.workflowAffected, false);
});

test("workflow changes enable security analysis", () => {
  const result = detectAffected([".github/workflows/release-please.yml"]);

  assert.equal(result.workflowAffected, true);
  assert.deepEqual(result.affected, []);
  assert.deepEqual(result.changed, []);
});

test("CI implementation changes select every discovered plugin", () => {
  const plugins = discoverPlugins();

  for (const file of [
    ".github/workflows/ci.yml",
    ".github/scripts/detect-affected.mjs",
  ]) {
    const result = detectAffected([file], plugins);

    assert.equal(result.pluginMatrix.length, plugins.length);
    assert.equal(result.ompAffected, true);
    assert.equal(result.sharedBrowserAffected, true);
    assert.equal(result.affected.length, plugins.length);
    assert.deepEqual(result.changed, []);
  }
});
