// Generates or checks the npm-shrinkwrap.json shipped in a plugin's npm package.
//
//   node ../scripts/shrinkwrap.mjs [--check] [plugin-dir]
//
// The shrinkwrap locks the production dependency tree (resolved registry URLs and integrity) so
// installing the published package cannot float to newer transitive versions. It is generated from
// the manifest `bun pm pack` publishes: `catalog:` specs resolved, devDependencies removed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SHRINKWRAP = "npm-shrinkwrap.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function publishedManifest(
  pluginDirectory,
  catalog = readJson(join(repositoryRoot, "package.json")).catalog,
) {
  const manifest = readJson(join(pluginDirectory, "package.json"));
  const dependencies = {};
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (spec !== "catalog:") {
      dependencies[name] = spec;
    } else if (typeof catalog?.[name] === "string") {
      dependencies[name] = catalog[name];
    } else {
      throw new Error(`Missing catalog entry for ${name}`);
    }
  }
  return { name: manifest.name, version: manifest.version, dependencies };
}

export function shrinkwrapDrift(pluginDirectory, catalog) {
  const expected = publishedManifest(pluginDirectory, catalog).dependencies;
  const locked = readJson(join(pluginDirectory, SHRINKWRAP)).packages?.[""]?.dependencies ?? {};
  const names = new Set([...Object.keys(expected), ...Object.keys(locked)]);
  return [...names]
    .filter((name) => expected[name] !== locked[name])
    .map(
      (name) =>
        `${name}: package.json ${expected[name] ?? "(none)"}, ${SHRINKWRAP} ${locked[name] ?? "(none)"}`,
    );
}

export function writeShrinkwrap(pluginDirectory) {
  const staging = mkdtempSync(join(tmpdir(), "paseo-shrinkwrap-"));
  try {
    writeFileSync(
      join(staging, "package.json"),
      `${JSON.stringify(publishedManifest(pluginDirectory), null, 2)}\n`,
    );
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--package-lock-only",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--workspaces=false",
        "--registry=https://registry.npmjs.org/",
      ],
      { cwd: staging, stdio: "inherit" },
    );
    writeFileSync(
      join(pluginDirectory, SHRINKWRAP),
      readFileSync(join(staging, "package-lock.json")),
    );
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const pluginDirectory = resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  if (check) {
    const drift = shrinkwrapDrift(pluginDirectory);
    if (drift.length > 0) {
      console.error(
        `${SHRINKWRAP} is out of date. Run \`node ../scripts/shrinkwrap.mjs\` in the plugin directory.\n- ${drift.join("\n- ")}`,
      );
      process.exit(1);
    }
  } else {
    writeShrinkwrap(pluginDirectory);
  }
}
