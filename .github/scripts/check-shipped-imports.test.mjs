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
    { specifier: "@getpaseo/protocol/hosts", typeOnly: true },
    { specifier: "./local", typeOnly: false },
    { specifier: "@getpaseo/protocol/messages", typeOnly: true },
    { specifier: "side-effect", typeOnly: false },
    { specifier: "lazy-pkg", typeOnly: false },
    { specifier: "req-pkg", typeOnly: false },
  ]);
});

test("readImports reads all-`type` named bindings as type-only, like the host's TypeScript AST", () => {
  const source = [
    'import { type A, type B } from "all-type";',
    'export { type C } from "export-all-type";',
    'import { type D, E } from "mixed";',
    'import F, { type G } from "default-and-type";',
    'import { type as alias } from "value-named-type";',
    'import { type as } from "type-named-as";',
    'import { type as as renamed } from "type-named-as-renamed";',
    'import {} from "empty";',
    'import { type as café } from "value-named-type-unicode";',
    'import { type as \\u0061 } from "value-named-type-escaped";',
  ].join("\n");
  assert.deepEqual(
    readImports(source).map(({ specifier, typeOnly }) => `${specifier} ${typeOnly}`),
    [
      "all-type true",
      "export-all-type true",
      "mixed false",
      "default-and-type false",
      "value-named-type false",
      "type-named-as true",
      "type-named-as-renamed true",
      "empty false",
      "value-named-type-unicode false",
      "value-named-type-escaped false",
    ],
  );
});

test("readImports reads every import in a declaration file as type-only, like the host", () => {
  const source = 'import { X } from "@getpaseo/protocol/x";\nexport type Y = typeof import("lazy");\n';
  assert.deepEqual(readImports(source, { declaration: true }), [
    { specifier: "@getpaseo/protocol/x", typeOnly: true },
    { specifier: "lazy", typeOnly: true },
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

test("checkPlugin fails on files globs, negations and missing paths instead of scanning nothing", (t) => {
  for (const [files, message] of [
    [["client/**"], /"client\/\*\*" is a glob or negation/],
    [["client/*.ts"], /"client\/\*\.ts" is a glob or negation/],
    [["client", "!client/a.ts"], /"!client\/a\.ts" is a glob or negation/],
    [["client", "dist"], /"dist" does not exist/],
  ]) {
    const dir = plugin({ files }, { "client/a.ts": 'import type { PaseoApi } from "@getpaseo/client";\n' });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => checkPlugin(dir), message, JSON.stringify(files));
  }
});

test("checkPlugin allows #imports the package.json imports field maps to shipped package files", (t) => {
  const dir = plugin(
    {
      files: ["client", "shared"],
      imports: {
        "#shared/*": "./shared/*.ts",
        "#conditional": { types: "./shared/x.d.ts", default: "./shared/x.ts" },
        "#bare": "some-package",
        "#excluded": null,
      },
    },
    {
      "shared/x.ts": "export const x = 1;\n",
      "shared/x.d.ts": "export declare const x: number;\n",
      "client/a.ts": [
        'import { x } from "#shared/x";',
        'import type { X } from "#conditional";',
        'import "#bare";',
        'import "#excluded";',
        'import "#undefined";',
      ].join("\n"),
    },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(
    checkPlugin(dir).map(({ file, specifier }) => `${file} ${specifier}`),
    ["client/a.ts #bare", "client/a.ts #excluded", "client/a.ts #undefined"],
  );
});

test("checkPlugin flags #imports whose targets an npm install does not have", (t) => {
  const dir = plugin(
    {
      files: ["client", "shared"],
      imports: {
        "#shared/*": "./shared/*.ts",
        "#unshipped": "./dev/x.ts",
        "#missing": "./missing.ts",
        "#dot-dot": "./../outside.ts",
        "#dot-dot-inside": "./shared/../shared/x.ts",
        "#types-only": { types: "./shared/x.ts" },
        "#missing-condition": { node: "./missing.ts", default: "./shared/x.ts" },
        "#missing-fallback": ["./missing.ts", "./shared/x.ts"],
        "#no-extension": "./shared/x",
      },
    },
    {
      "shared/x.ts": "export const x = 1;\n",
      "dev/x.ts": "export const x = 1;\n",
      "client/a.ts": [
        "#shared/missing",
        "#unshipped",
        "#missing",
        "#dot-dot",
        "#dot-dot-inside",
        "#types-only",
        "#missing-condition",
        "#missing-fallback",
        "#no-extension",
      ]
        .map((specifier) => `import "${specifier}";`)
        .join("\n"),
    },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const problems = checkPlugin(dir);
  assert.deepEqual(
    problems.map(({ specifier }) => specifier),
    [
      "#shared/missing",
      "#unshipped",
      "#missing",
      "#dot-dot",
      "#dot-dot-inside",
      "#types-only",
      "#missing-condition",
      "#missing-fallback",
      "#no-extension",
    ],
  );
  assert.match(problems[1].problem, /maps to "\.\/dev\/x\.ts", which package\.json "files" does not ship/);
  assert.match(problems[3].problem, /not a file path inside the package/);
  assert.match(problems[5].problem, /without "default"/);
});

test("checkPlugin allows only tsconfig paths aliases a shipped tsconfig.json maps to shipped files", (t) => {
  const tsconfig = [
    "{",
    "  // Comments and trailing commas are valid tsconfig.json.",
    '  "compilerOptions": { "paths": {',
    '    "@/*": ["./shared/*"],',
    '    "~exact": ["./shared/x.ts"],',
    '    "~unshipped": ["./dev/x.ts"],',
    '    "~missing": ["./missing.ts"],',
    '    "~package": ["some-package"],',
    '    "~missing-fallback": ["./missing.ts", "./shared/x.ts"],',
    '    "~outside": ["../outside.ts"],',
    "  }, },",
    "}",
  ].join("\n");
  const source = [
    'import { x } from "@/x";',
    'import { y } from "@/dir";',
    'import type { Y } from "~exact";',
    'import "~/x";',
    'import "~unshipped";',
    'import "~missing";',
    'import "~package";',
    'import "~missing-fallback";',
    'import "~outside";',
  ].join("\n");
  const sources = {
    "tsconfig.json": tsconfig,
    "client/a.ts": source,
    "shared/x.ts": "",
    "shared/dir/index.ts": "",
    "dev/x.ts": "",
  };
  const shipped = plugin({ files: ["client", "shared", "tsconfig.json"] }, sources);
  const unshipped = plugin({ files: ["client", "shared"] }, sources);
  t.after(() => {
    rmSync(shipped, { recursive: true, force: true });
    rmSync(unshipped, { recursive: true, force: true });
  });
  assert.deepEqual(
    checkPlugin(shipped).map(({ specifier }) => specifier),
    ["~/x", "~unshipped", "~missing", "~package", "~missing-fallback", "~outside"],
  );
  const problems = checkPlugin(unshipped);
  assert.deepEqual(
    problems.map(({ specifier }) => specifier),
    ["@/x", "@/dir", "~exact", "~/x", "~unshipped", "~missing", "~package", "~missing-fallback", "~outside"],
  );
  assert.match(
    problems[0].problem,
    /tsconfig\.json "paths" alias, but package\.json "files" does not ship tsconfig\.json/,
  );
});

test("checkPlugin reads declaration files as type-only", (t) => {
  const dir = plugin(
    { files: ["client"] },
    { "client/types.d.ts": 'import { HostSummary } from "@getpaseo/protocol/hosts";\n' },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(checkPlugin(dir), []);
});

test("every plugin's shipped code imports only host modules and its own dependencies", () => {
  const dirs = discoverPluginDirs(repoRoot);
  assert.ok(dirs.length > 0);
  assert.deepEqual(
    dirs.flatMap((dir) =>
      checkPlugin(dir).map(({ file, specifier }) => `${dir.slice(repoRoot.length + 1)}/${file}: ${specifier}`),
    ),
    [],
  );
});
