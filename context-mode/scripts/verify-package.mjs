import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const topLevelFiles = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "index.client.tsx",
  "index.server.ts",
  "package.json",
  "paseo-plugin.json",
];
const runtimeDirectories = ["client", "server", "shared"];

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: packageRoot, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${label} failed with exit code ${error.code ?? "unknown"}:\n${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function walk(directory) {
  const entries = await readdir(join(packageRoot, directory), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.replaceAll("\\", "/"));
    }
  }

  return files;
}

async function expectedFiles() {
  const files = new Set(topLevelFiles);

  for (const directory of runtimeDirectories) {
    for (const file of await walk(directory)) {
      files.add(file);
    }
  }

  return files;
}

function packFiles(stdout) {
  let reports;

  try {
    reports = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${String(error)}`);
  }

  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error(
      `npm pack returned ${Array.isArray(reports) ? reports.length : "a non-array result"}; expected one package report`,
    );
  }

  const report = reports[0];
  if (!Array.isArray(report.files)) {
    throw new Error("npm pack report does not contain a files array");
  }

  return new Set(
    report.files.map(({ path }, index) => {
      if (typeof path !== "string") {
        throw new Error(`npm pack report file ${index + 1} has no string path`);
      }

      return path.replace(/^package\//, "").replaceAll("\\", "/");
    }),
  );
}

const packed = packFiles(
  await run("npm", ["pack", "--dry-run", "--json"], "npm package verification"),
);
const expected = await expectedFiles();

const missing = [...expected].filter((file) => !packed.has(file)).sort();
const extra = [...packed].filter((file) => !expected.has(file)).sort();

if (missing.length || extra.length) {
  throw new Error(
    [
      missing.length ? `Missing from tarball:\n- ${missing.join("\n- ")}` : null,
      extra.length ? `Unexpected in tarball:\n- ${extra.join("\n- ")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

console.log(`Verified npm tarball contents for ${packed.size} files.`);
