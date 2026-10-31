import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Run through the shell so Windows resolves npm.cmd: Node refuses to spawn .cmd files without one.
const INSTALL_COMMAND = "npm ci --omit=dev --ignore-scripts --workspaces=false";

function loadRootCatalog(root) {
  for (let directory = root; ; directory = dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const catalog = JSON.parse(readFileSync(manifestPath, "utf8")).catalog;
      if (catalog) return catalog;
    }
    if (directory === dirname(directory)) return null;
  }
}

function stageManifest(root, catalog, install) {
  const manifestPath = join(root, "package.json");
  const source = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(source);

  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (spec !== "catalog:") continue;
    if (typeof catalog[name] !== "string") throw new Error(`Missing catalog entry for ${name}`);
    manifest.dependencies[name] = catalog[name];
  }
  delete manifest.devDependencies;
  // npm-shrinkwrap.json is generated without overrides, so npm ci rejects a manifest that keeps them.
  delete manifest.overrides;

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    install();
  } finally {
    writeFileSync(manifestPath, source);
  }
}

export function prepareDependencies(root = projectRoot, execute = execSync) {
  const catalog = loadRootCatalog(root);
  if (!catalog) return false;
  stageManifest(root, catalog, () => {
    execute(INSTALL_COMMAND, { cwd: root, stdio: "inherit" });
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDependencies();
}
