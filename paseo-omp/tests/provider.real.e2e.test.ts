import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type {
  AgentClient,
  AgentSession,
} from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-sdk-types.js";
import { createOmpProvider } from "../server/provider/registration";

const executeFile = promisify(execFile);
const pluginProviderModulePath =
  "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
const hostRequire = createRequire(new URL(pluginProviderModulePath, import.meta.url));
const pino = hostRequire("pino") as (options: { enabled: boolean }) => object;
const testReal = process.env.PASEO_OMP_REAL_E2E === "1" ? test : test.skip;
const roots: string[] = [];

type HostRegistry = {
  replace(registrations: readonly ProviderRegistration[]): void;
  clients(): Record<string, AgentClient>;
  shutdown(): Promise<void>;
};
type HostRegistryConstructor = new (logger: object) => HostRegistry;

async function createHarness(): Promise<{
  cwd: string;
  registry: HostRegistry;
  client: AgentClient;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-real-e2e-"));
  roots.push(cwd);
  const registration = createOmpProvider();
  // Static importing the host fails on its incompatible Node/Zod declaration graph.
  const adapter = (await import(pluginProviderModulePath)) as unknown as {
    PluginAgentClientRegistry: HostRegistryConstructor;
  };
  const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
  registry.replace([registration]);
  const client = registry.clients()[registration.id];
  if (!client) throw new Error("registered OMP client is missing");
  return { cwd, registry, client };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP 18.1.15 real provider", () => {
  testReal(
    "discovers the installed 18.1.15 runtime through the core host boundary",
    async () => {
      const { stdout } = await executeFile("omp", ["--version"], { encoding: "utf8" });
      expect(stdout.trim()).toBe("omp/18.1.15");

      const harness = await createHarness();
      try {
        await expect(harness.client.isAvailable()).resolves.toBe(true);
        const catalog = await harness.client.fetchCatalog({
          scope: "workspace",
          cwd: harness.cwd,
          force: true,
        });
        expect(catalog.models.length).toBeGreaterThan(0);
        expect(catalog.models.some((model) => model.isDefault)).toBe(true);
        expect(catalog.defaultModeId).toBe("full");
        expect(catalog.modes.map((mode) => mode.id)).toEqual(
          expect.arrayContaining(["full", "write", "ask"]),
        );
      } finally {
        await harness.registry.shutdown();
      }
    },
    60_000,
  );

  testReal(
    "runs a text and tool turn without duplicate or hanging completion",
    async () => {
      const harness = await createHarness();
      let session: AgentSession | undefined;
      try {
        const catalog = await harness.client.fetchCatalog({
          scope: "workspace",
          cwd: harness.cwd,
          force: true,
        });
        const model = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
        if (!model) throw new Error("OMP returned no usable model");
        session = await harness.client.createSession(
          {
            provider: "omp-plugin",
            cwd: harness.cwd,
            model: model.id,
            modeId: "full",
            thinkingOptionId: model.defaultThinkingOptionId,
            featureValues: {},
          },
          undefined,
          { persistSession: false },
        );
        const events: Array<{ type: string; turnId?: string }> = [];
        const unsubscribe = session.subscribe((event) => events.push(event));
        try {
          const result = await session.run(
            "Use the bash tool exactly once to run `printf REAL_OMP_TOOL_OK`, then reply with exactly REAL_OMP_DONE.",
            { clientMessageId: "real-omp-tool" },
          );
          expect(result.finalText).toContain("REAL_OMP_DONE");
          expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
          expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
          expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
          expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
          expect(
            result.timeline.some(
              (item) =>
                item.type === "tool_call" &&
                item.status === "completed" &&
                item.name.toLowerCase() === "bash",
            ),
          ).toBe(true);
        } finally {
          unsubscribe();
        }
      } finally {
        await session?.close();
        await harness.registry.shutdown();
      }
    },
    180_000,
  );
});
