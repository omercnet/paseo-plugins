import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = {
	"@modelcontextprotocol/sdk": "1.30.0",
	esbuild: "0.28.2",
	zod: "4.4.3",
};

function withNpmCompatibleManifest(root, install) {
	const manifestPath = join(root, "package.json");
	const source = readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(source);

	for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
		if (spec === "catalog:") manifest.dependencies[name] = catalog[name];
	}
  manifest.dependencies["@getpaseo/plugin"] = "0.9.0";
	delete manifest.devDependencies;

	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	try {
		return install();
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
	withNpmCompatibleManifest(root, () => {
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
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	prepareDependencies();
}
