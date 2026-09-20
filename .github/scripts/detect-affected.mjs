import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const specializedPlugins = new Map([
  ["paseo-omp", "omp"],
  ["paseo-shared-browser", "shared-browser"],
]);
const ciPaths = [".github/workflows/ci.yml", ".github/scripts/"];
const workflowPaths = [".github/workflows/", ".github/actions/"];

export function discoverPlugins(root = process.cwd()) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const plugin = entry.name;
      if (!existsSync(join(root, plugin, "paseo-plugin.json"))) {
        return [];
      }

      const packagePath = join(root, plugin, "package.json");
      if (!existsSync(packagePath)) {
        throw new Error(`${plugin} has paseo-plugin.json but no package.json`);
      }

      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      const scripts = packageJson.scripts ?? {};
      const invalidScripts = [
        typeof scripts.check === "string" && scripts.check.length > 0
          ? undefined
          : "script:check",
        scripts.build === "node ../.github/scripts/build-plugin.mjs"
          ? undefined
          : "script:build",
        typeof scripts.typecheck === "string" ? undefined : "script:typecheck",
        scripts.test === "run-s test:ci:*" ? undefined : "script:test",
        Object.keys(scripts).some((script) => script.startsWith("test:ci:"))
          ? undefined
          : "script:test:ci:*",
      ].filter(Boolean);
      const devDependencies = packageJson.devDependencies ?? {};
      const requiredTools = {
        "@biomejs/biome": null,
        "@getpaseo/server": "0.9.0-beta.1",
        "npm-run-all2": null,
      };
      const missingTools = Object.entries(requiredTools)
        .filter(([tool, version]) =>
          version === null
            ? typeof devDependencies[tool] !== "string"
            : devDependencies[tool] !== version,
        )
        .map(([tool]) => tool);

      if (invalidScripts.length > 0 || missingTools.length > 0) {
        const missing = [
          ...invalidScripts,
          ...missingTools.map((tool) => `devDependency:${tool}`),
        ];
        throw new Error(
          `${plugin} is missing required CI entries: ${missing.join(", ")}`,
        );
      }

      return [
        {
          plugin,
          kind: specializedPlugins.get(plugin) ?? "npm",
        },
      ];
    })
    .sort(({ plugin: left }, { plugin: right }) => left.localeCompare(right));
}

export function detectAffected(files, plugins = discoverPlugins()) {
  const runAll = files.some((file) =>
    ciPaths.some((ciPath) =>
      ciPath.endsWith("/") ? file.startsWith(ciPath) : file === ciPath,
    ),
  );
  const workflowAffected = files.some((file) =>
    workflowPaths.some((workflowPath) => file.startsWith(workflowPath)),
  );
  const changedPluginNames = new Set(files.map((file) => file.split("/", 1)[0]));
  const changedPlugins = plugins.filter(({ plugin }) =>
    changedPluginNames.has(plugin),
  );
  const isAffected = ({ plugin }) => runAll || changedPluginNames.has(plugin);
  const affectedPlugins = plugins.filter(isAffected);
  const pluginMatrix = affectedPlugins.map(({ plugin }) => plugin);

  return {
    pluginMatrix,
    pluginsAffected: pluginMatrix.length > 0,
    ompAffected: affectedPlugins.some(({ kind }) => kind === "omp"),
    sharedBrowserAffected: affectedPlugins.some(
      ({ kind }) => kind === "shared-browser",
    ),
    workflowAffected,
    affected: affectedPlugins.map(({ plugin }) => plugin),
    changed: changedPlugins.map(({ plugin }) => plugin),
  };
}

function changedFiles(baseSha, headSha, diffMode) {
  if (!baseSha || !headSha) {
    throw new Error("BASE_SHA and HEAD_SHA are required");
  }

  if (/^0+$/.test(baseSha)) {
    return [".github/workflows/ci.yml"];
  }

  const separator = diffMode === "merge-base" ? "..." : "..";
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${baseSha}${separator}${headSha}`],
    { encoding: "utf8" },
  );

  return output.split("\0").filter(Boolean);
}

function writeOutputs(result, outputPath) {
  const outputs = {
    plugin_matrix: JSON.stringify(result.pluginMatrix),
    plugins_affected: String(result.pluginsAffected),
    omp_affected: String(result.ompAffected),
    shared_browser_affected: String(result.sharedBrowserAffected),
    workflow_affected: String(result.workflowAffected),
    changed_plugins: JSON.stringify(result.changed),
  };

  appendFileSync(
    outputPath,
    `${Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
  console.log(
    result.affected.length > 0
      ? `Affected plugins: ${result.affected.join(", ")}`
      : "No plugins affected",
  );
}

function main() {
  const files = changedFiles(
    process.env.BASE_SHA,
    process.env.HEAD_SHA,
    process.env.DIFF_MODE,
  );
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }

  writeOutputs(detectAffected(files), outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
