import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

	for (const [name, spec] of Object.entries(manifest.dependencies)) {
		if (spec !== "catalog:") continue;
		if (typeof catalog[name] !== "string")
			throw new Error(`Missing catalog entry for ${name}`);
		manifest.dependencies[name] = catalog[name];
	}
	delete manifest.devDependencies;

	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	try {
		install();
	} finally {
		writeFileSync(manifestPath, source);
	}
}

export function resolveDependencyRoot(packageName, from = import.meta.url) {
	return dirname(createRequire(from).resolve(`${packageName}/package.json`));
}

export function prepareDependencies(
	root = projectRoot,
	execute = execFileSync,
) {
	const catalog = loadRootCatalog(root);
	if (!catalog) return false;
	stageManifest(root, catalog, () => {
		execute(
			process.platform === "win32" ? "npm.cmd" : "npm",
			[
				"install",
				"--omit=dev",
				"--ignore-scripts",
				"--no-package-lock",
				"--workspaces=false",
			],
			{
				cwd: root,
				stdio: "inherit",
			},
		);
	});
	return true;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	prepareDependencies();
}
