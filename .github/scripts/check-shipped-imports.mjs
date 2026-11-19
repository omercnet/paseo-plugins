// Fails when a plugin's shipped code imports a package the installed plugin cannot resolve.
//
// The daemon compiles each plugin with a runtime-boundary esbuild plugin
// (@getpaseo/server dist/server/server/plugins/compiler-build.js). It reads imports with the
// TypeScript AST (compiler-imports.js) and resolves every one, type-only imports included, from
// the plugin's install directory unless the host provides it. compiler-imports.js is identical in
// 0.14.0, 0.15.0 and 0.16.0-beta.2; the import-boundary code of compiler-build.js is the same in all
// three (0.15 only adds a client minify step). A package that is only a devDependency resolves in
// this monorepo but not in an npm install, so the install fails with
// `Could not resolve type dependency "<pkg>"` (#396, #581).
//
// Specifiers that resolve inside the install are allowed when every target is a shipped file:
// `#name` entries of the package.json `imports` field, and `compilerOptions.paths` aliases of the
// plugin's own tsconfig.json when `files` ships it (its `extends` chain is not read). Without a
// shipped tsconfig.json, neither esbuild nor TypeScript sees the alias in the install. An `imports`
// conditions object needs a `default` at every level, and every condition and array fallback must
// be shipped, so whichever one a resolver picks exists.
// A bare specifier whose `paths` alias does not resolve to a shipped file falls back to node_modules
// in esbuild and TypeScript, so it passes when it is a declared dependency and fails otherwise.
//
// Limits:
// - `files` entries must be literal paths that exist in the checkout. Globs, negations and
//   missing paths fail the check instead of silently scanning nothing.
// - Generated output is not scanned. Only files committed to the checkout are read, so anything a
//   pack- or install-time script writes (paseo-shared-browser's scripts/prepare-*.mjs, for
//   example) ships unchecked. Commit generated sources, as sandbox does with server/docker/image.ts.
// - Imports are found with regular expressions, not a parser. Stricter than the host:
//   `import("pkg")` in a type position and `import type x = require("pkg")` count as runtime
//   imports. Missed: statements without whitespace around keywords, such as `import{a}from"m"`
//   or `import"m"`; formatted sources (Biome) always have it.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix, relative } from "node:path";
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
    elements.length > 0 && elements.every((element) => /^type\s/.test(element) && !/^type\s+as\s+\S+$/.test(element))
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

/** The `*` capture when `specifier` matches a key that may hold one `*`, or null. */
function patternCapture(pattern, specifier) {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return null;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** The most specific key matching `specifier`, as Node and TypeScript pick it, with its `*` capture. */
function bestMatch(entries, specifier) {
  let best = null;
  for (const [pattern, value] of entries) {
    const capture = patternCapture(pattern, specifier);
    if (capture === null) continue;
    const specificity = pattern.includes("*") ? pattern.indexOf("*") : Number.POSITIVE_INFINITY;
    if (!best || specificity > best.specificity) best = { value, capture, specificity };
  }
  return best;
}

const moduleExtensions = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/**
 * Whether a plugin-relative module path is a shipped file. `.js` targets also match their `.ts`
 * source; `probe` adds the extension and index lookups that tsconfig `paths` targets get. A `.d.ts`
 * only satisfies a type-only import: esbuild bundles runtime imports and has no code in it.
 */
function shipsModule(rel, shipped, probe, typeOnly) {
  const candidates = [rel];
  const js = rel.match(/^(.*)\.([cm]?)js(x?)$/);
  if (js) candidates.push(`${js[1]}.${js[2]}ts${js[3]}`, `${js[1]}.d.${js[2]}ts`);
  if (probe) {
    candidates.push(...moduleExtensions.flatMap((ext) => [rel + ext, `${rel}/index${ext}`]));
  }
  return candidates.some((candidate) => (typeOnly || !/\.d\.[cm]?ts$/.test(candidate)) && shipped.has(candidate));
}

/**
 * Why a package.json `imports` value may not resolve to a shipped file, or null. A runtime import
 * skips the `types` condition, which esbuild does not match.
 */
function importsTargetProblem(value, capture, shipped, typeOnly) {
  if (typeof value === "string") {
    const target = value.replaceAll("*", capture);
    const segments = target.split("/");
    if (
      segments[0] !== "." ||
      segments.slice(1).some((s) => s === "" || s === "." || s === ".." || s === "node_modules")
    ) {
      return `maps to "${target}", which is not a file path inside the package`;
    }
    if (!shipsModule(posix.normalize(target), shipped, false, typeOnly)) {
      return `maps to "${target}", which package.json "files" does not ship`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "maps to an empty array";
    for (const member of value) {
      const problem = importsTargetProblem(member, capture, shipped, typeOnly);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === "object") {
    if (!Object.hasOwn(value, "default")) {
      return `has a conditions object without "default", so a resolver may match none of them`;
    }
    for (const [condition, member] of Object.entries(value)) {
      if (condition === "types" && !typeOnly) continue;
      const problem = importsTargetProblem(member, capture, shipped, typeOnly);
      if (problem) return problem;
    }
    return null;
  }
  return `maps to ${JSON.stringify(value)}`;
}

/** Why tsconfig `paths` targets may not resolve to shipped files, or null. Every fallback must ship. */
function pathsTargetProblem(targets, capture, baseUrl, shipped, typeOnly) {
  if (!Array.isArray(targets) || targets.length === 0) return "has no targets";
  for (const target of targets) {
    if (typeof target !== "string") return `maps to ${JSON.stringify(target)}`;
    const rel = posix.normalize(posix.join(baseUrl, target.replaceAll("*", capture)));
    if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) {
      return `maps to "${target}", which is outside the package`;
    }
    if (!shipsModule(rel, shipped, true, typeOnly))
      return `maps to "${target}", which package.json "files" does not ship`;
  }
  return null;
}

/**
 * Why the boundary plugin would fail to resolve this import from an npm install, or null.
 * `aliasProblem` returns undefined when no `#imports` or tsconfig alias matches the specifier,
 * null when the alias resolves to a shipped file, and the reason otherwise.
 */
export function importProblem({ specifier, typeOnly }, installed, aliasProblem = () => undefined) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (hostSdkSpecifiers.has(specifier) || hostModule.test(specifier) || isBuiltin(specifier)) return null;
  if (specifier === "@types/node") return null;
  if (typeOnly && specifier.startsWith("@getpaseo/protocol/")) return null;
  const alias = aliasProblem(specifier, typeOnly);
  if (specifier.startsWith("#")) {
    return alias === undefined ? `${specifier} is not defined in package.json "imports"` : alias;
  }
  if (alias === null) return null;
  // When a tsconfig `paths` target does not resolve, esbuild and TypeScript fall back to
  // node_modules, so a declared package still resolves through an alias that matches it.
  if (installed.has(packageName(specifier))) return null;
  const missing = `${packageName(specifier)} is not a dependency or peerDependency and the host does not provide it`;
  return alias ? `${alias}, and ${missing}` : missing;
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

/** `compilerOptions.paths` and `baseUrl` of a tsconfig.json, which allows comments and trailing commas. */
function tsconfigPaths(file) {
  const none = { baseUrl: ".", paths: [] };
  if (!existsSync(file)) return none;
  let config;
  try {
    config = JSON.parse(stripComments(readFileSync(file, "utf8")).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return none; // Unreadable here means no aliases are trusted, so their imports stay flagged.
  }
  const { baseUrl = ".", paths = {} } = config.compilerOptions ?? {};
  return { baseUrl: String(baseUrl).split("\\").join("/"), paths: Object.entries(paths) };
}

/** Imports in a plugin's shipped (package.json `files`) source that an npm install cannot resolve. */
export function checkPlugin(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const installed = new Set(
    [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((deps) => Object.keys(deps ?? {})),
  );
  const shipped = new Set(
    shippedFiles(pluginDir, pkg.files ?? ["."]).map((file) => relative(pluginDir, file).split("\\").join("/")),
  );
  const tsconfig = tsconfigPaths(join(pluginDir, "tsconfig.json"));
  // esbuild and TypeScript resolve `#name` through the package's own `imports` field, and aliases
  // through the tsconfig.json next to the plugin, but only to files that the install has.
  function aliasProblem(specifier, typeOnly) {
    if (specifier.startsWith("#")) {
      const match = bestMatch(Object.entries(pkg.imports ?? {}), specifier);
      if (!match) return undefined;
      const problem = importsTargetProblem(match.value, match.capture, shipped, typeOnly);
      return problem && `${specifier}: package.json "imports" ${problem}`;
    }
    const match = bestMatch(tsconfig.paths, specifier);
    if (!match) return undefined;
    if (!shipped.has("tsconfig.json")) {
      return `${specifier} is a tsconfig.json "paths" alias, but package.json "files" does not ship tsconfig.json`;
    }
    const problem = pathsTargetProblem(match.value, match.capture, tsconfig.baseUrl, shipped, typeOnly);
    return problem && `${specifier}: tsconfig.json "paths" ${problem}`;
  }
  const problems = [];
  for (const rel of shipped) {
    if (!sourceFile.test(rel) || testFile.test(rel)) continue;
    const source = readFileSync(join(pluginDir, rel), "utf8");
    for (const entry of readImports(source, { declaration: /\.d\.[cm]?ts$/.test(rel) })) {
      const problem = importProblem(entry, installed, aliasProblem);
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
