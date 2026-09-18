import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildNpmReleaseMatrix(releaseOutputs, releaseConfig, readPackage) {
  const include = [];

  for (const [directory, packageConfig] of Object.entries(releaseConfig.packages ?? {})) {
    const packageJson = readPackage(directory);
    if (packageJson.private || releaseOutputs[`${directory}--release_created`] !== "true") {
      continue;
    }

    const tag = releaseOutputs[`${directory}--tag_name`];
    const sha = releaseOutputs[`${directory}--sha`];
    if (!tag || !sha) {
      throw new Error(`Release Please omitted tag or SHA outputs for ${directory}`);
    }
    if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
      throw new Error(`${directory}/package.json must declare a package name`);
    }

    const component = packageConfig.component ?? packageConfig["package-name"] ?? basename(directory);
    const item = { directory, name: packageJson.name, tag, sha };
    if (component !== directory) item.component = component;
    include.push(item);
  }

  return { include };
}

function main() {
  const releaseOutputs = JSON.parse(process.env.RELEASE_OUTPUTS ?? "{}");
  const releaseConfig = readJson("release-please-config.json");
  const matrix = buildNpmReleaseMatrix(releaseOutputs, releaseConfig, (directory) =>
    readJson(join(directory, "package.json")),
  );
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");

  appendFileSync(outputPath, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(outputPath, `released=${matrix.include.length > 0}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
