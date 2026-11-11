import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkPlugin, discoverPluginDirs, importProblem, readImports } from "./check-shipped-imports.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function plugin(pkg, files) {
  const dir = mkdtempSync(join(tmpdir(), "shipped-imports-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

test("readImports finds static, type-only, re-export, dynamic and reference imports, not comments", () => {
  const source = [
    '/// <reference types="node" />',
    'import type { PaseoApi } from "@getpaseo/client";',
    "import {",
    "  type HostSummary,",
    '} from "@getpaseo/protocol/hosts";',
    'export * from "./local";',
    'export type { X } from "@getpaseo/protocol/messages";',
    'import "side-effect";',
    'const lazy = await import("lazy-pkg");',
    'const req = require("req-pkg");',
    '// import type { Gone } from "commented-out";',
    '/* import { Gone } from "block-comment"; */',
    'const url = "https://example.com/x";',
  ].join("\n");
  assert.deepEqual(readImports(source), [
    { specifier: "@types/node", typeOnly: true },
    { specifier: "@getpaseo/client", typeOnly: true },
    { specifier: "@getpaseo/protocol/hosts", typeOnly: false },
    { specifier: "./local", typeOnly: false },
    { specifier: "@getpaseo/protocol/messages", typeOnly: true },
    { specifier: "side-effect", typeOnly: false },
    { specifier: "lazy-pkg", typeOnly: false },
    { specifier: "req-pkg", typeOnly: false },
  ]);
});

test("importProblem allows what the host provides and flags everything else that is not installed", () => {
  const installed = new Set(["yaml"]);
  const ok = (specifier, typeOnly = false) => importProblem({ specifier, typeOnly }, installed) === null;
  for (const specifier of [
    "@getpaseo/plugin",
    "@getpaseo/plugin/client",
    "@getpaseo/plugin/client/ui",
    "@getpaseo/plugin/server",
    "react",
    "react/jsx-runtime",
    "react-native",
    "@tanstack/react-query",
    "zod",
    "node:fs",
    "fs",
    "@types/node",
    "yaml",
    "./local",
  ]) {
    assert.ok(ok(specifier), specifier);
  }
  assert.ok(ok("@getpaseo/protocol/hosts", true));
  assert.ok(!ok("@getpaseo/protocol/hosts"), "value import of protocol must be a dependency");
  assert.ok(!ok("@getpaseo/client", true), "type-only import of a devDependency still fails the install");
  assert.ok(!ok("@getpaseo/client"));
  assert.ok(!ok("@getpaseo/plugin/internal"));
  assert.ok(!ok("@types/react", true));
});

test("checkPlugin scans shipped files only and honours dependencies", (t) => {
  const dir = plugin(
    {
      files: ["client", "index.client.tsx"],
      dependencies: { yaml: "1" },
      devDependencies: { "@getpaseo/client": "1" },
    },
    {
      "index.client.tsx": 'import { parse } from "yaml";\nimport type { PaseoApi } from "@getpaseo/client";\n',
      "client/a.test.ts": 'import { test } from "vitest";\n',
      "client/b.ts": 'export type { HostSummary } from "@getpaseo/client";\n',
      "tests/c.test.ts": 'import type { PaseoApi } from "@getpaseo/client";\n',
      "scripts/d.mjs": 'import "not-shipped";\n',
    },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(
    checkPlugin(dir).map(({ file, specifier }) => `${file} ${specifier}`),
    ["client/b.ts @getpaseo/client", "index.client.tsx @getpaseo/client"],
  );
});

test("every plugin's shipped code imports only host modules and its own dependencies", () => {
  const dirs = discoverPluginDirs(repoRoot);
  assert.ok(dirs.length > 0);
  assert.deepEqual(
    dirs.flatMap((dir) => checkPlugin(dir).map(({ file, specifier }) => `${dir.slice(repoRoot.length + 1)}/${file}: ${specifier}`)),
    [],
  );
});
