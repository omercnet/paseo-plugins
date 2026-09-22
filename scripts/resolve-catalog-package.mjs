import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function resolveCatalogPackageJson(packageJson, root) {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const catalog = rootPackage.catalog ?? {};
  const resolved = structuredClone(packageJson);

  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(resolved[section] ?? {})) {
      if (spec === "catalog:") resolved[section][name] = catalog[name];
    }
  }
  return resolved;
}
