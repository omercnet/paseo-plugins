import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { extractArchiveFiles } from "../scripts/release-archive";

const pluginRoot = resolve(import.meta.dirname, "..");
const legacyCoreRoot = process.env.PASEO_LEGACY_CORE_ROOT?.trim();
const cutoverCoreRoot = process.env.PASEO_CUTOVER_CORE_ROOT?.trim();
const coreTest = legacyCoreRoot && cutoverCoreRoot ? test : test.skip;

interface PluginRegistration {
  id: string;
  label: string;
}

interface PluginSocket {
  once(event: "close", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  send(data: string): void;
}

interface PluginServiceLike {
  bindPaseoSessionHost(host: {
    attachPluginSocket(pluginId: string, socket: PluginSocket): Promise<{ closed: Promise<void> }>;
  }): void;
  start(): Promise<void>;
  installDirectory(input: { path: string }): Promise<unknown>;
  disablePlugin(pluginId: string): Promise<unknown>;
  getProviderRegistrations(): readonly PluginRegistration[];
  stopAllPlugins(): Promise<void>;
}

type PluginServiceConstructor = new (
  logger: unknown,
  configStore: unknown,
  daemonVersion: string,
) => PluginServiceLike;
type DaemonConfigStoreConstructor = new (
  home: string,
  config: {
    mcp: { injectIntoAgents: boolean };
    browserTools: { enabled: boolean };
    providers: Record<string, never>;
    metadataGeneration: { providers: never[] };
    autoArchiveAfterMerge: boolean;
    enableTerminalAgentHooks: boolean;
    appendSystemPrompt: string;
    pluginsEnabled: boolean;
    plugins: Record<string, never>;
  },
) => unknown;

interface LoadedCore {
  PluginService: PluginServiceConstructor;
  DaemonConfigStore: DaemonConfigStoreConstructor;
  buildProviderRegistry(logger: unknown): Record<string, unknown>;
  pino(options: { level: string }): unknown;
  version: string;
}

async function loadCore(coreRoot: string): Promise<LoadedCore> {
  const coreServer = join(coreRoot, "packages/server/dist/server/server");
  const [{ PluginService }, { DaemonConfigStore }, { buildProviderRegistry }] = (await Promise.all([
    import(pathToFileURL(join(coreServer, "plugins/index.js")).href),
    import(pathToFileURL(join(coreServer, "daemon-config-store.js")).href),
    import(pathToFileURL(join(coreServer, "agent/provider-registry.js")).href),
  ])) as [
    { PluginService: PluginServiceConstructor },
    { DaemonConfigStore: DaemonConfigStoreConstructor },
    { buildProviderRegistry: LoadedCore["buildProviderRegistry"] },
  ];
  const packageJson = (await Bun.file(join(coreRoot, "package.json")).json()) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") {
    throw new Error(`Paseo core at ${coreRoot} has no package version`);
  }
  const require = createRequire(join(coreRoot, "package.json"));
  return {
    PluginService,
    DaemonConfigStore,
    buildProviderRegistry,
    pino: require("pino") as LoadedCore["pino"],
    version: packageJson.version,
  };
}

async function packagePlugin(destination: string): Promise<string> {
  const archivePath = join(destination, "paseo-omp.zip");
  const child = Bun.spawn([process.execPath, "scripts/package-release.ts", archivePath], {
    cwd: pluginRoot,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
  const packageDirectory = join(destination, "package", "paseo-omp");
  const files = unzipSync(await Bun.file(archivePath).bytes());
  await extractArchiveFiles(files, join(destination, "package"));
  return packageDirectory;
}

function bindSessionHost(service: PluginServiceLike, version: string): void {
  service.bindPaseoSessionHost({
    async attachPluginSocket(_pluginId, socket) {
      const closed = new Promise<void>((done) => socket.once("close", done));
      socket.on("message", (data) => {
        if (typeof data !== "string") return;
        const message = JSON.parse(data) as { type?: string };
        if (message.type !== "hello") return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "paseo-omp-cutover-test",
                hostname: "paseo-omp-cutover-test",
                version,
                features: {},
              },
            },
          }),
        );
      });
      return { closed };
    },
  });
}

coreTest(
  "uses actual legacy and cutover cores for rejection, install, and rollback",
  async () => {
    if (!legacyCoreRoot || !cutoverCoreRoot) {
      throw new Error("PASEO_LEGACY_CORE_ROOT and PASEO_CUTOVER_CORE_ROOT are required");
    }
    if (resolve(legacyCoreRoot) === resolve(cutoverCoreRoot)) {
      throw new Error("Legacy and cutover core roots must be distinct checkouts");
    }
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-core-cutover-"));
    let legacyService: PluginServiceLike | undefined;
    let cutoverService: PluginServiceLike | undefined;
    try {
      const [legacy, cutover, pluginDirectory] = await Promise.all([
        loadCore(legacyCoreRoot),
        loadCore(cutoverCoreRoot),
        packagePlugin(root),
      ]);

      const legacyBuiltins = legacy.buildProviderRegistry(legacy.pino({ level: "silent" }));
      expect(legacyBuiltins).toHaveProperty("omp");
      const legacyConfigStore = new legacy.DaemonConfigStore(join(root, "legacy-home"), {
        mcp: { injectIntoAgents: true },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        pluginsEnabled: true,
        plugins: {},
      });
      legacyService = new legacy.PluginService(
        legacy.pino({ level: "silent" }),
        legacyConfigStore,
        legacy.version,
      );
      bindSessionHost(legacyService, legacy.version);
      await legacyService.start();
      await expect(legacyService.installDirectory({ path: pluginDirectory })).rejects.toThrow(
        /requirements|requires Paseo \^0\.8\.1/u,
      );
      expect(legacyService.getProviderRegistrations()).toEqual([]);

      const cutoverBuiltins = cutover.buildProviderRegistry(cutover.pino({ level: "silent" }));
      expect(cutoverBuiltins).not.toHaveProperty("omp");
      const cutoverConfigStore = new cutover.DaemonConfigStore(join(root, "cutover-home"), {
        mcp: { injectIntoAgents: true },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        pluginsEnabled: true,
        plugins: {},
      });
      cutoverService = new cutover.PluginService(
        cutover.pino({ level: "silent" }),
        cutoverConfigStore,
        cutover.version,
      );
      bindSessionHost(cutoverService, cutover.version);
      await cutoverService.start();
      await cutoverService.installDirectory({ path: pluginDirectory });
      expect(cutoverService.getProviderRegistrations()).toEqual([
        expect.objectContaining({ id: "omp", label: "OMP" }),
      ]);

      await cutoverService.disablePlugin("paseo-omp");
      expect(cutoverService.getProviderRegistrations()).toEqual([]);
      expect(legacy.buildProviderRegistry(legacy.pino({ level: "silent" }))).toHaveProperty("omp");
    } finally {
      await cutoverService?.stopAllPlugins();
      await legacyService?.stopAllPlugins();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
