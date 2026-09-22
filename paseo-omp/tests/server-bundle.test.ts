import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { synchronizeBuildVersion } from "../scripts/sync-build-version.mjs";

const pluginRoot = join(import.meta.dirname, "..");
const nodeRequire = createRequire(join(pluginRoot, "index.server.ts"));
const sdkStub = {
  defineRpc: (definition: unknown) => definition,
  defineSettings: (definition: unknown) => definition,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
};

function runtimeRequire(name: string): unknown {
  return name.startsWith("@getpaseo/plugin") ? sdkStub : nodeRequire(name);
}

async function compileServerBundle(entryPath: string) {
  const result = await build({
    stdin: {
      contents: await readFile(entryPath, "utf8"),
      loader: "tsx",
      resolveDir: dirname(entryPath),
      sourcefile: entryPath,
    },
    nodePaths: [join(pluginRoot, "node_modules")],
    bundle: true,
    format: "cjs",
    platform: "node",
    external: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/server",
      "@getpaseo/client",
      "@modelcontextprotocol/sdk/*",
      "yaml",
      "zod",
    ],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  return { code: result.outputFiles[0]?.text ?? "", warnings: result.warnings };
}

async function supportReportFromBundle(entryPath: string): Promise<string> {
  const { code, warnings } = await compileServerBundle(entryPath);
  if (warnings.length > 0) throw new Error(warnings.map((warning) => warning.text).join("; "));
  // biome-ignore lint/security/noGlobalEval: mirrors the daemon's plugin loader
  const factory = globalThis.eval(
    `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`,
  ) as (require: (name: string) => unknown) => { default?: unknown };
  const module = factory(runtimeRequire);
  if (typeof module.default !== "function") throw new Error("Missing server contribution");
  const handlers: Array<[{ name: string }, unknown]> = [];
  const cleanup = module.default({
    before: () => () => {},
    handle: (contract: { name: string }, handler: unknown) => handlers.push([contract, handler]),
    registerSettings: () => {},
    registerProvider: () => {},
  });
  try {
    const registration = handlers.find(
      ([contract]) => contract.name === "paseo-omp.get-support-report",
    ) as
      | [{ name: string }, (input: { force?: boolean }) => Promise<{ report: string }>]
      | undefined;
    if (!registration) throw new Error("Missing support report handler");
    return (await registration[1]({ force: true })).report;
  } finally {
    await Promise.resolve(cleanup());
  }
}

describe("plugin server bundle", () => {
  test("declares the supported Paseo 0.9 manifest contract", async () => {
    const manifest = JSON.parse(await readFile(join(pluginRoot, "paseo-plugin.json"), "utf8"));
    expect(manifest).toEqual({
      id: "paseo-omp",
      requirements: { paseo: ">=0.9.0-beta.1 <0.10.0" },
      build: [["node", "scripts/prepare-dependencies.mjs"]],
    });
    const packageManifest = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
    expect(packageManifest.description).toBe(
      "Paseo integration for OMP, including its direct provider and workspace tooling.",
    );
    expect(
      await readFile(join(pluginRoot, "server", "provider", "omp-rpc.ts"), "utf8"),
    ).not.toContain("@oh-my-pi/");
    expect(packageManifest.files).not.toContain("tests");
    expect(await readFile(join(pluginRoot, "README.md"), "utf8")).toContain(
      "Paseo `>=0.9.0-beta.1 <0.10.0`",
    );
    const releaseConfig = JSON.parse(
      await readFile(join(pluginRoot, "..", "release-please-config.json"), "utf8"),
    ) as { packages: Record<string, { "extra-files"?: unknown }> };
    expect(releaseConfig.packages["paseo-omp"]?.["extra-files"]).toEqual([
      { type: "generic", path: "server/package-version.ts" },
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "reports the workflow-mutated next version from a direct source bundle",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "paseo-omp-next-bundle-"));
      const nextVersion = "0.3.0-next.123.2";
      try {
        await Promise.all([
          cp(join(pluginRoot, "server"), join(root, "server"), { recursive: true }),
          cp(join(pluginRoot, "shared"), join(root, "shared"), { recursive: true }),
          cp(join(pluginRoot, "index.server.ts"), join(root, "index.server.ts")),
        ]);
        const packageManifest = JSON.parse(
          await readFile(join(pluginRoot, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        packageManifest.version = nextVersion;
        await writeFile(
          join(root, "package.json"),
          `${JSON.stringify(packageManifest, null, 2)}\n`,
        );
        await synchronizeBuildVersion(root);

        expect(await readFile(join(root, "server", "package-version.ts"), "utf8")).toContain(
          `PASEO_OMP_PACKAGE_VERSION = "${nextVersion}"`,
        );
        const report = await supportReportFromBundle(join(root, "index.server.ts"));
        expect(report).toContain(`paseo_omp.version: ${nextVersion}`);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "compiles source without preparation and reports the package version",
    async () => {
      await rm(join(pluginRoot, "server", "generated", "package-version.js"), { force: true });
      const { code, warnings } = await compileServerBundle(join(pluginRoot, "index.server.ts"));
      expect(warnings.map((warning) => warning.text)).toEqual([]);
      expect(code).not.toContain("@oh-my-pi/");
      // biome-ignore lint/security/noGlobalEval: mirrors the daemon's plugin loader
      const factory = globalThis.eval(
        `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`,
      ) as (require: (name: string) => unknown) => { default?: unknown };
      const originalCwd = process.cwd();
      const originalHome = process.env.HOME;
      const originalConfigDir = process.env.PI_CONFIG_DIR;
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-bundle-"));
      process.chdir(temporaryDirectory);
      process.env.HOME = temporaryDirectory;
      process.env.PI_CONFIG_DIR = ".omp";
      try {
        const module = factory(runtimeRequire);
        if (typeof module.default !== "function") throw new Error("Missing server contribution");
        const providers: ProviderRegistration[] = [];
        const handlers: Array<[{ name: string }, unknown]> = [];
        const settings: unknown[] = [];
        const beforeHooks: unknown[] = [];
        const cleanup = module.default({
          before: (...args: unknown[]) => {
            beforeHooks.push(args);
            return () => {};
          },
          handle: (contract: { name: string }, handler: unknown) =>
            handlers.push([contract, handler]),
          registerSettings: (definition: unknown) => settings.push(definition),
          registerProvider: (provider: ProviderRegistration) => providers.push(provider),
        });
        expect(handlers).toHaveLength(17);
        expect(handlers.map(([contract]) => contract.name)).toContain("paseo-omp.list-models");
        expect(settings).toEqual([
          expect.objectContaining({ id: "composer-pills", scope: "host", version: 1 }),
        ]);
        const supportRegistration = handlers.find(
          (entry) =>
            Array.isArray(entry) &&
            (entry[0] as { name?: string } | undefined)?.name === "paseo-omp.get-support-report",
        ) as
          | [{ name: string }, (input: { force?: boolean }) => Promise<{ report: string }>]
          | undefined;
        expect(supportRegistration).toBeDefined();
        const packageManifest = JSON.parse(
          await readFile(join(pluginRoot, "package.json"), "utf8"),
        ) as { version: string };
        const supportReport = await supportRegistration?.[1]({ force: true });
        expect(supportReport?.report).toContain(`paseo_omp.version: ${packageManifest.version}`);
        expect(beforeHooks).toHaveLength(1);
        const [hookName, hook] = beforeHooks[0] as [
          string,
          (event: {
            request: {
              agentId: string;
              workspaceId: string | null;
              provider: string;
              cwd: string;
              env: Record<string, string>;
            };
          }) => unknown,
        ];
        expect(hookName).toBe("agent.session_open");
        expect(
          hook({
            request: {
              agentId: "plugin-agent",
              workspaceId: "plugin-workspace",
              provider: "omp-plugin",
              cwd: "/workspace",
              env: { PASEO_AGENT_ID: "spoofed" },
            },
          }),
        ).toEqual(
          expect.objectContaining({
            env: {
              PASEO_AGENT_ID: "plugin-agent",
              PASEO_WORKSPACE_ID: "plugin-workspace",
            },
          }),
        );
        expect(
          hook({
            request: {
              agentId: "builtin-agent",
              workspaceId: "builtin-workspace",
              provider: "omp",
              cwd: "/workspace",
              env: {},
            },
          }),
        ).toBeUndefined();
        expect(providers).toEqual([
          expect.objectContaining({ id: "omp-plugin", label: "OMP Plugin" }),
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
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
        else process.env.PI_CONFIG_DIR = originalConfigDir;
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );
});
