/**
 * Opt-in mounted client regression using an existing workspace's React/JSDOM
 * tooling. No dependency installs, runtime assets or browser processes are used.
 * Bundle only the production hooks into a private temporary directory, resolve
 * React and Query once for the fixture, and always remove the generated files.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: { "tooling-root": { type: "string" }, fixture: { type: "string", default: "image" } },
});
const fixture = values.fixture;
if (fixture !== "image" && fixture !== "density")
  throw new Error("--fixture must be image or density");
const expectedCases = 6;
const toolingRoot = resolve(values["tooling-root"] ?? root);
const dependency = createRequire(join(toolingRoot, "package.json"));
let tooling;
try {
  // This fixture deliberately does not add DOM-only dependencies to the plugin.
  const packages = ["react", "react-dom/client", "jsdom", "@tanstack/react-query", "esbuild"];
  for (const name of packages) dependency.resolve(name);
  tooling = {
    build: dependency("esbuild").build,
    react: dependency.resolve("react"),
    jsx: dependency.resolve("react/jsx-runtime"),
    query: dependency.resolve("@tanstack/react-query"),
  };
} catch {
  throw new Error(
    "Mounted hook tests require existing React, react-dom, jsdom, React Query and esbuild. Pass --tooling-root <workspace> with those dependencies; this command never installs them.",
  );
}

const output = await mkdtemp(join(tmpdir(), "shared-browser-image-hooks-"));
try {
  const entries =
    fixture === "image"
      ? [
          ["capture", "use-browser-image-capture.ts"],
          ["recovery", "use-browser-viewer-recovery.ts"],
        ]
      : [
          ["density", "use-browser-capture-density.ts"],
          ["density-ui", "browser-capture-density-controls.tsx"],
        ];
  for (const [name, file] of entries) {
    await tooling.build({
      entryPoints: [join(root, "client", file)],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "es2022",
      outfile: join(output, `${name}.cjs`),
      external: [tooling.react, tooling.jsx, tooling.query],
      ...(fixture === "density"
        ? {
            plugins: [
              {
                name: "fixture-native-leaves",
                setup(builder) {
                  builder.onResolve({ filter: /^react-native$/ }, () => ({
                    path: join(root, "tests", "fixtures", "capture-density-native.fixture.cjs"),
                  }));
                },
              },
            ],
          }
        : {}),
      alias: {
        react: tooling.react,
        "react/jsx-runtime": tooling.jsx,
        "@tanstack/react-query": tooling.query,
      },
    });
  }
  const result = await promisify(execFile)(
    process.execPath,
    [
      join(
        root,
        "tests",
        "fixtures",
        `${fixture === "image" ? "image-capture" : "capture-density"}-mounted.fixture.cjs`,
      ),
    ],
    {
      env: {
        ...process.env,
        SHARED_BROWSER_MOUNTED_TOOLING_ROOT: toolingRoot,
        SHARED_BROWSER_MOUNTED_OUTPUT: output,
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    },
  );
  // Some restricted process runners return a synthetic zero exit without
  // executing the child. Require the fixture's completion receipt, not silence.
  const receipt = JSON.parse(await readFile(join(output, "completed.json"), "utf8"));
  if (receipt.completed !== expectedCases)
    throw new Error(`Mounted fixture did not execute all ${expectedCases} cases`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  if (typeof error.stdout === "string") process.stdout.write(error.stdout);
  if (typeof error.stderr === "string") process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(output, { recursive: true, force: true });
}
