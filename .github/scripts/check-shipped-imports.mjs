// Fails when a plugin's shipped code imports a package the installed plugin cannot resolve.
//
// The daemon compiles each plugin with a runtime-boundary esbuild plugin
// (@getpaseo/server dist/server/server/plugins/compiler-build.js and compiler-imports.js,
// identical in 0.14.0, 0.15.0 and 0.16.0-beta.2). It reads imports with the TypeScript AST and resolves every
// one, type-only imports included, from the plugin's install directory unless the host
// provides it. A package that is only a devDependency resolves in this monorepo but not in an
// npm install, so the install fails with `Could not resolve type dependency "<pkg>"` (#396, #581).
//
// Specifiers that resolve inside the install are allowed: `#name` entries of the package.json
// `imports` field with relative targets, and `compilerOptions.paths` aliases of the plugin's own
// tsconfig.json when `files` ships it (its `extends` chain is not read). Without a shipped
// tsconfig.json, neither esbuild nor TypeScript sees the alias in the install.
//
// Limits:
// - `files` entries must be literal paths that exist in the checkout. Globs, negations and
//   missing paths fail the check instead of silently scanning nothing.
// - Generated output is not scanned. Only files committed to the checkout are read, so anything a
//   pack- or install-time script writes (paseo-shared-browser's scripts/prepare-*.mjs, for
//   example) ships unchecked. Commit generated sources, as sandbox does with server/docker/image.ts.
// - Imports are found with regular expressions, not a parser. `import("pkg")` in a type position
//   counts as a runtime import, so the guard can be stricter than the host there.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

// Mirrors PLUGIN_SDK_SPECIFIERS and the host-module rule in the boundary plugin.
const hostSdkSpecifiers = new Set([
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/usage",
  "@getpaseo/plugin/server/acp",
]);
const hostModule = /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/;
const sourceFile = /\.[cm]?[jt]sx?$/;
const testFile = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Replaces comments with spaces and keeps strings, so specifiers survive and commented-out imports do not. */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Whether every binding in `{ ... }` is `type`-marked, as TypeScript reads `import { type A } from`. */
function onlyTypeBindings(clause) {
  const braces = clause?.trim().match(/^\{([^{}]*)\}$/);
  if (!braces) return false;
  const elements = braces[1]
    .split(",")
    .map((element) => element.trim())
    .filter(Boolean);
  // `type as x` imports a value named `type`; `type as`, `type as as x` and `type A` are type-only.
  return (
    elements.length > 0 && elements.every((element) => /^type\s/.test(element) && !/^type\s+as\s+[\w$]+$/.test(element))
  );
}

/**
 * Module specifiers in a source file, with whether the import is erased like the host's TypeScript
 * AST sees it: `import type`, `export type`, all-`type` named bindings, and anything in a `.d.ts` file.
 */
export function readImports(source, { declaration = false } = {}) {
  const imports = [];
  for (const match of source.matchAll(/^\s*\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/gm)) {
    imports.push({ specifier: `@types/${match[1].replace(/^@/, "").replace("/", "__")}`, typeOnly: true });
  }
  const code = stripComments(source);
  const statement = /(?:^|[;\s}])(?:import|export)\s+(type\s+)?(?:([^;"'`]*?)\sfrom\s*)?["']([^"']+)["']/g;
  for (const match of code.matchAll(statement)) {
    imports.push({ specifier: match[3], typeOnly: declaration || Boolean(match[1]) || onlyTypeBindings(match[2]) });
  }
  for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push({ specifier: match[1], typeOnly: declaration });
  }
  return imports;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Whether `specifier` matches an `imports` or tsconfig `paths` key, which may hold one `*`. */
function matchesPattern(pattern, specifier) {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === specifier;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
  );
}

/** Why the boundary plugin would fail to resolve this import from an npm install, or null. */
export function importProblem({ specifier, typeOnly }, installed, { aliases = [], unshippedAliases = [] } = {}) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (aliases.some((pattern) => matchesPattern(pattern, specifier))) return null;
  if (specifier.startsWith("#")) return `${specifier} is not defined in package.json "imports" with a relative target`;
  if (hostSdkSpecifiers.has(specifier) || hostModule.test(specifier) || isBuiltin(specifier)) return null;
  if (specifier === "@types/node") return null;
  if (typeOnly && specifier.startsWith("@getpaseo/protocol/")) return null;
  if (installed.has(packageName(specifier))) return null;
  if (unshippedAliases.some((pattern) => matchesPattern(pattern, specifier))) {
    return `${specifier} is a tsconfig.json "paths" alias, but package.json "files" does not ship tsconfig.json`;
  }
  return `${packageName(specifier)} is not a dependency or peerDependency and the host does not provide it`;
}

function walk(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules")
    .flatMap((entry) => walk(join(path, entry.name)));
}

/** Files npm packs for these `files` entries. Only literal, existing paths can be scanned. */
function shippedFiles(pluginDir, entries) {
  return entries.flatMap((entry) => {
    if (/[*?[\]{}!]/.test(entry)) {
      throw new Error(
        `"files" entry "${entry}" is a glob or negation, which this check does not expand. List the shipped paths literally.`,
      );
    }
    const path = join(pluginDir, entry);
    if (!existsSync(path)) {
      throw new Error(
        `"files" entry "${entry}" does not exist, so its imports cannot be checked. Commit it or remove the entry.`,
      );
    }
    return walk(path);
  });
}

/** Leaf targets of a package.json `imports` value: a string, an array, or a conditions object. */
function importTargets(value) {
  if (Array.isArray(value)) return value.flatMap(importTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(importTargets);
  return [value];
}

/** Keys of `compilerOptions.paths` in a tsconfig.json, which allows comments and trailing commas. */
function tsconfigPaths(file) {
  if (!existsSync(file)) return [];
  let config;
  try {
    config = JSON.parse(stripComments(readFileSync(file, "utf8")).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return []; // Unreadable here means no aliases are trusted, so their imports stay flagged.
  }
  return Object.entries(config.compilerOptions?.paths ?? {})
    .filter(([, targets]) => Array.isArray(targets) && targets.length > 0)
    .map(([pattern]) => pattern);
}

/** Imports in a plugin's shipped (package.json `files`) source that an npm install cannot resolve. */
export function checkPlugin(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const installed = new Set(
    [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((deps) => Object.keys(deps ?? {})),
  );
  const shipped = shippedFiles(pluginDir, pkg.files ?? ["."]);
  // esbuild and TypeScript both resolve `#name` through the package's own `imports` field.
  const packageImports = Object.entries(pkg.imports ?? {})
    .filter(([key, value]) => {
      const targets = importTargets(value);
      return (
        key.startsWith("#") && targets.length > 0 && targets.every((t) => typeof t === "string" && t.startsWith("./"))
      );
    })
    .map(([key]) => key);
  const tsconfig = join(pluginDir, "tsconfig.json");
  const paths = tsconfigPaths(tsconfig);
  const tsconfigShipped = shipped.includes(tsconfig);
  const aliases = {
    aliases: [...packageImports, ...(tsconfigShipped ? paths : [])],
    unshippedAliases: tsconfigShipped ? [] : paths,
  };
  const problems = [];
  for (const file of shipped) {
    const rel = relative(pluginDir, file).split("\\").join("/");
    if (!sourceFile.test(rel) || testFile.test(rel)) continue;
    const imports = readImports(readFileSync(file, "utf8"), { declaration: /\.d\.[cm]?ts$/.test(rel) });
    for (const entry of imports) {
      const problem = importProblem(entry, installed, aliases);
      if (problem) problems.push({ file: rel, specifier: entry.specifier, problem });
    }
  }
  return problems;
}

export function discoverPluginDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "paseo-plugin.json")))
    .map((entry) => join(root, entry.name))
    .sort();
}

function main() {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : discoverPluginDirs(process.cwd());
  let failed = false;
  for (const dir of dirs) {
    const name = relative(process.cwd(), dir);
    let problems;
    try {
      problems = checkPlugin(dir);
    } catch (error) {
      failed = true;
      console.error(`${join(name, "package.json")}: ${error.message}`);
      continue;
    }
    for (const { file, specifier, problem } of problems) {
      failed = true;
      console.error(`${join(name, file)}: imports "${specifier}": ${problem}`);
    }
  }
  if (failed) {
    console.error(
      "Shipped plugin code must not import devDependencies, not even `import type`. See .agents/skills/plugin-development.",
    );
    process.exit(1);
  }
  console.log(`Shipped imports resolve for ${dirs.length} plugin(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
