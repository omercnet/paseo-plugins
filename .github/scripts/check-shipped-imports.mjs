// Fails when a plugin's shipped code imports a package the installed plugin cannot resolve.
//
// The daemon compiles each plugin with a runtime-boundary esbuild plugin
// (@getpaseo/server dist/server/server/plugins/compiler-build.js). It resolves every import,
// `import type` included, from the plugin's install directory unless the host provides it.
// A package that is only a devDependency resolves in this monorepo but not in an npm install,
// so the install fails with `Could not resolve type dependency "<pkg>"` (#396, #581).
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

/** Module specifiers in a source file, with whether the whole statement is type-only. */
export function readImports(source) {
  const imports = [];
  for (const match of source.matchAll(/^\s*\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/gm)) {
    imports.push({ specifier: `@types/${match[1].replace(/^@/, "").replace("/", "__")}`, typeOnly: true });
  }
  const code = stripComments(source);
  const statement = /(?:^|[;\s}])(?:import|export)\s+(type\s+)?(?:[^;"'`]*?\sfrom\s*)?["']([^"']+)["']/g;
  for (const match of code.matchAll(statement)) {
    imports.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
  }
  for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push({ specifier: match[1], typeOnly: false });
  }
  return imports;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Why the boundary plugin would fail to resolve this import from an npm install, or null. */
export function importProblem({ specifier, typeOnly }, installed) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (hostSdkSpecifiers.has(specifier) || hostModule.test(specifier) || isBuiltin(specifier)) return null;
  if (specifier === "@types/node") return null;
  if (typeOnly && specifier.startsWith("@getpaseo/protocol/")) return null;
  if (installed.has(packageName(specifier))) return null;
  return `${packageName(specifier)} is not a dependency or peerDependency and the host does not provide it`;
}

function walk(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules")
    .flatMap((entry) => walk(join(path, entry.name)));
}

/** Imports in a plugin's shipped (package.json `files`) source that an npm install cannot resolve. */
export function checkPlugin(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const installed = new Set(
    [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((deps) => Object.keys(deps ?? {})),
  );
  const shipped = (pkg.files ?? ["."]).flatMap((entry) => walk(join(pluginDir, entry)));
  const problems = [];
  for (const file of shipped) {
    const rel = relative(pluginDir, file).split("\\").join("/");
    if (!sourceFile.test(rel) || testFile.test(rel)) continue;
    for (const entry of readImports(readFileSync(file, "utf8"))) {
      const problem = importProblem(entry, installed);
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
    for (const { file, specifier, problem } of checkPlugin(dir)) {
      failed = true;
      console.error(`${join(relative(process.cwd(), dir), file)}: imports "${specifier}": ${problem}`);
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
