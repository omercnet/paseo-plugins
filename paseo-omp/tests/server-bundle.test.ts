import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    external: ["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/client", "yaml", "zod"],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  return { code: result.outputFiles[0]?.text ?? "", warnings: result.warnings };
}

async function compileClientBundle(entryPath: string) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["@getpaseo/*", "@tanstack/react-query", "react", "react-native", "zod"],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  return result.warnings;
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
      const cleanup = module.default({
        handle: (...args: unknown[]) => handlers.push(args),
        registerProvider: (provider: ProviderRegistration) => providers.push(provider),
      });
      expect(handlers).toHaveLength(7);
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

  test("packages import-complete client and server entries", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-package-"));
    const archivePath = join(temporaryDirectory, "paseo-omp.zip");
    try {
      const packaging = Bun.spawn({
        cmd: ["bun", "scripts/package-release.ts", archivePath],
        cwd: pluginRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await packaging.exited).toBe(0);
      const archive = unzipSync(await Bun.file(archivePath).bytes());
      for (const [path, bytes] of Object.entries(archive)) {
        const destination = join(temporaryDirectory, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }
      for (const path of [
        "paseo-omp/client/provider-image.tsx",
        "paseo-omp/shared/provider-image.ts",
        "paseo-omp/server/provider/image.ts",
      ]) {
        expect(archive[path]).toBeDefined();
      }
      const extractedRoot = join(temporaryDirectory, "paseo-omp");
      const clientWarnings = await compileClientBundle(join(extractedRoot, "index.client.tsx"));
      const serverBundle = await compileServerBundle(join(extractedRoot, "index.server.ts"));
      expect(clientWarnings.map((warning) => warning.text)).toEqual([]);
      expect(serverBundle.warnings.map((warning) => warning.text)).toEqual([]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
