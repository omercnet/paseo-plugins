import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectAffected, discoverPlugins } from "./detect-affected.mjs";

test("discovers new plugins and derives their checks from package scripts", (t) => {
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
        typecheck: "tsc --noEmit",
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        "verify:package": "node verify.mjs",
      },
    }),
  );

  assert.deepEqual(discoverPlugins(root), [
    {
      plugin: "new-plugin",
      kind: "npm",
      check: true,
      lint: false,
      format_check: false,
      typecheck: true,
      coverage: true,
      test_unit: false,
      test: false,
      verify_package: true,
      platform: false,
    },
  ]);
});

test("plugins with a test:platform script also run on macOS and Windows", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paseo-plugins-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const [name, scripts] of [
    ["with-platform", { "test:platform": "vitest run" }],
    ["without", {}],
  ]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "paseo-plugin.json"), "{}");
    writeFileSync(
      join(root, name, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest run", ...scripts } }),
    );
  }
  const plugins = discoverPlugins(root);

  const changed = detectAffected(["with-platform/index.ts"], plugins);
  assert.equal(changed.platformAffected, true);
  assert.deepEqual(changed.platformMatrix.include, [
    { plugin: "with-platform", os: "macos-latest" },
    { plugin: "with-platform", os: "macos-15-intel" },
    { plugin: "with-platform", os: "windows-latest" },
    { plugin: "with-platform", os: "windows-11-arm" },
  ]);

  const other = detectAffected(["without/index.ts"], plugins);
  assert.equal(other.platformAffected, false);
  assert.deepEqual(other.platformMatrix, { include: [] });
});

test("selects only changed npm plugins", () => {
  const result = detectAffected([
    "agent-monitor/server/index.ts",
    "paseo-beads/package.json",
  ]);

  assert.deepEqual(
    result.npmMatrix.include.map(({ plugin }) => plugin),
    ["agent-monitor", "paseo-beads"],
  );
  assert.deepEqual(result.changed, ["agent-monitor", "paseo-beads"]);
  assert.equal(result.npmAffected, true);
  assert.equal(result.ompAffected, false);
  assert.equal(result.sharedBrowserAffected, false);
});

test("selects platform-specific jobs independently", () => {
  const omp = detectAffected(["paseo-omp/index.server.ts"]);
  const sharedBrowser = detectAffected([
    "paseo-shared-browser/server/index.ts",
  ]);

  assert.equal(omp.ompAffected, true);
  assert.equal(omp.npmAffected, false);
  assert.equal(sharedBrowser.sharedBrowserAffected, true);
  assert.equal(sharedBrowser.npmAffected, false);
});

test("ignores changes outside plugin and CI paths", () => {
  const result = detectAffected(["SECURITY.md"]);

  assert.deepEqual(result.affected, []);
  assert.deepEqual(result.npmMatrix, { include: [] });
  assert.equal(result.workflowAffected, false);
});

test("workflow and script changes enable security analysis", () => {
  for (const file of [
    ".github/workflows/release-please.yml",
    ".github/scripts/run-release-please.mjs",
  ]) {
    assert.equal(detectAffected([file]).workflowAffected, true);
  }
});

test("root package manager changes select every discovered plugin", () => {
  const plugins = discoverPlugins();

  for (const file of ["package.json", "bun.lock"]) {
    const result = detectAffected([file], plugins);

    assert.equal(
      result.npmMatrix.include.length,
      plugins.filter(({ kind }) => kind === "npm").length,
    );
    assert.equal(result.ompAffected, true);
    assert.equal(result.sharedBrowserAffected, true);
    assert.equal(result.affected.length, plugins.length);
    assert.deepEqual(result.changed, []);
  }
});

test("CI implementation changes select every discovered plugin", () => {
  const plugins = discoverPlugins();

  for (const file of [
    ".github/workflows/ci.yml",
    ".github/scripts/detect-affected.mjs",
  ]) {
    const result = detectAffected([file], plugins);

    assert.equal(
      result.npmMatrix.include.length,
      plugins.filter(({ kind }) => kind === "npm").length,
    );
    assert.equal(result.ompAffected, true);
    assert.equal(result.sharedBrowserAffected, true);
    assert.equal(result.affected.length, plugins.length);
    assert.deepEqual(result.changed, []);
  }
});
