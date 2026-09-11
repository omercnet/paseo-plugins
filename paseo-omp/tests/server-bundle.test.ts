import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { build } from "esbuild";
import { unzipSync } from "fflate";

const pluginRoot = join(import.meta.dirname, "..");
const nodeRequire = createRequire(join(pluginRoot, "index.server.ts"));
const sdkStub = {
  defineRpc: (definition: unknown) => definition,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
};

function runtimeRequire(name: string): unknown {
  return name.startsWith("@getpaseo/plugin") ? sdkStub : nodeRequire(name);
}

async function compileServerBundle(entryPath: string) {
  const result = await build({
    stdin: {
      contents: await Bun.file(entryPath).text(),
      loader: "tsx",
      resolveDir: dirname(entryPath),
      sourcefile: entryPath,
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/client", "zod"],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  return { code: result.outputFiles[0]?.text ?? "", warnings: result.warnings };
}

describe("plugin server bundle", () => {
  test("loads and registers the canary provider in the daemon CJS sandbox", async () => {
    const { code, warnings } = await compileServerBundle(join(pluginRoot, "index.server.ts"));
    expect(warnings.map((warning) => warning.text)).toEqual([]);
    // biome-ignore lint/security/noGlobalEval: mirrors the daemon's plugin loader
    const factory = globalThis.eval(
      `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`,
    ) as (require: (name: string) => unknown) => { default?: unknown };
    const originalCwd = process.cwd();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-bundle-"));
    process.chdir(temporaryDirectory);
    try {
      const module = factory(runtimeRequire);
      if (typeof module.default !== "function") throw new Error("Missing server contribution");
      const providers: ProviderRegistration[] = [];
      const handlers: unknown[] = [];
      const beforeHooks: unknown[] = [];
      const cleanup = module.default({
        before: (...args: unknown[]) => {
          beforeHooks.push(args);
          return () => {};
        },
        handle: (...args: unknown[]) => handlers.push(args),
        registerProvider: (provider: ProviderRegistration) => providers.push(provider),
      });
      expect(handlers).toHaveLength(7);
      expect(beforeHooks).toHaveLength(1);
      expect(providers).toEqual([
        expect.objectContaining({ id: "omp-plugin", label: "OMP (Plugin Preview)" }),
      ]);
      const provider = providers[0];
      if (!provider) throw new Error("Registered provider is missing");
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "prompt.steer", "session.configure"],
      });
      expect(connection.capabilities).toEqual([
        "prompt.message",
        "prompt.steer",
        "session.configure",
      ]);
      await connection.close();
      expect(typeof cleanup).toBe("function");
    } finally {
      process.chdir(originalCwd);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("loads the server entrypoint from the extracted release archive", async () => {
    await mkdir(join(pluginRoot, "dist"), { recursive: true });
    const temporaryDirectory = await mkdtemp(join(pluginRoot, "dist", "release-load-"));
    const archivePath = join(temporaryDirectory, "paseo-omp.zip");
    const extractionRoot = join(temporaryDirectory, "extracted");
    try {
      const packaging = Bun.spawn([process.execPath, "scripts/package-release.ts", archivePath], {
        cwd: pluginRoot,
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        packaging.exited,
        new Response(packaging.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      const files = unzipSync(await Bun.file(archivePath).bytes());
      expect(files["paseo-omp/server/provider/security.ts"]).toBeDefined();
      for (const [path, content] of Object.entries(files)) {
        const outputPath = join(extractionRoot, path);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content);
      }

      // Dynamic import intentionally exercises the extracted plugin's runtime module boundary.
      const entrypoint = await import(
        pathToFileURL(join(extractionRoot, "paseo-omp", "index.server.ts")).href
      );
      expect(typeof entrypoint.default).toBe("function");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
