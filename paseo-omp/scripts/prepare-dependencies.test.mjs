import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareDependencies } from "./prepare-dependencies.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("installs the shrinkwrapped production tree from a staged manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-dependencies-"));
  temporaryRoots.push(root);
  const source = `${JSON.stringify({
    catalog: { zod: "4.4.3" },
    dependencies: { zod: "catalog:" },
    devDependencies: { typescript: "catalog:" },
    overrides: { qs: "6.16.1" },
  })}\n`;
  await writeFile(join(root, "package.json"), source);
  const calls = [];

  const installed = prepareDependencies(root, (command, options) => {
    calls.push({ command, options, manifest: readFileSync(join(root, "package.json"), "utf8") });
  });

  expect(installed).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe("npm ci --omit=dev --ignore-scripts --workspaces=false");
  expect(calls[0].options).toEqual({ cwd: root, stdio: "inherit" });
  expect(JSON.parse(calls[0].manifest)).toEqual({
    catalog: { zod: "4.4.3" },
    dependencies: { zod: "4.4.3" },
  });
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(source);
});
