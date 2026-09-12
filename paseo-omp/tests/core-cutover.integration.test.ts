import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

const pluginRoot = resolve(import.meta.dirname, "..");
const coreRoot = process.env.PASEO_CORE_ROOT?.trim();
const coreTest = coreRoot ? test : test.skip;

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
  for (const [path, contents] of Object.entries(files)) {
    const outputPath = join(destination, "package", path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents);
  }
  const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
    cwd: packageDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [installExitCode, installStderr] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);
  expect(installExitCode, installStderr).toBe(0);
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
  "rejects old core, installs once on cutover core, and unregisters for rollback",
  async () => {
    if (!coreRoot) throw new Error("PASEO_CORE_ROOT is required");
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-core-cutover-"));
    const coreServer = join(coreRoot, "packages/server/dist/server/server");
    const [{ PluginService }, { DaemonConfigStore }] = (await Promise.all([
      import(pathToFileURL(join(coreServer, "plugins/index.js")).href),
      import(pathToFileURL(join(coreServer, "daemon-config-store.js")).href),
    ])) as [
      { PluginService: PluginServiceConstructor },
      { DaemonConfigStore: DaemonConfigStoreConstructor },
    ];
    const require = createRequire(join(coreRoot, "package.json"));
    const pino = require("pino") as (options: { level: string }) => unknown;
    const pluginDirectory = await packagePlugin(root);
    const oldConfigStore = new DaemonConfigStore(join(root, "old-home"), {
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
    const oldService = new PluginService(pino({ level: "silent" }), oldConfigStore, "0.8.0");
    bindSessionHost(oldService, "0.8.0");
    try {
      await oldService.start();
      await expect(oldService.installDirectory({ path: pluginDirectory })).rejects.toThrow(
        "requires Paseo ^0.8.1",
      );
      expect(oldService.getProviderRegistrations()).toEqual([]);
    } finally {
      await oldService.stopAllPlugins();
    }

    const configStore = new DaemonConfigStore(join(root, "home"), {
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
    const service = new PluginService(pino({ level: "silent" }), configStore, "0.8.1");
    bindSessionHost(service, "0.8.1");

    try {
      await service.start();
      await service.installDirectory({ path: pluginDirectory });
      expect(service.getProviderRegistrations()).toEqual([
        expect.objectContaining({ id: "omp", label: "OMP" }),
      ]);
      await service.disablePlugin("paseo-omp");
      expect(service.getProviderRegistrations()).toEqual([]);
    } finally {
      await service.stopAllPlugins();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
