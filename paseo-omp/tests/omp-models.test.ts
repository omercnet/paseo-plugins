import { homedir } from "node:os";
import { describe, expect, test } from "vitest";
import { resolveListOmpModels } from "../server/omp-models";
import { withOmpStore } from "../server/paths";
import type { OmpRuntime, OmpRuntimeSession } from "../server/provider/omp-rpc";
import type { OmpStartOptions } from "../server/provider/omp-rpc-environment";
import type { OmpModel } from "../server/provider/omp-rpc-protocol";
import { OmpCleanupFailure } from "../server/provider/security";
import {
  listOmpModels,
  type OmpModelCandidate,
  OmpModelListResultSchema,
} from "../shared/omp-models";

const MODEL: OmpModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  thinking: { efforts: ["low", "high"], defaultLevel: "high" },
  input: ["text", "image"],
  contextWindow: 200_000,
};

interface RuntimeHarness {
  runtime: OmpRuntime;
  starts: OmpStartOptions[];
  getAvailableModelsCalls: number;
  closeCalls: number;
}

function createRuntimeHarness(
  options: { models?: OmpModel[]; modelError?: Error; closeError?: Error } = {},
): RuntimeHarness {
  const starts: OmpStartOptions[] = [];
  const harness: RuntimeHarness = {
    runtime: undefined as unknown as OmpRuntime,
    starts,
    getAvailableModelsCalls: 0,
    closeCalls: 0,
  };
  const session = {
    async getAvailableModels() {
      harness.getAvailableModelsCalls += 1;
      if (options.modelError) throw options.modelError;
      return options.models ?? [MODEL];
    },
    async close() {
      harness.closeCalls += 1;
      if (options.closeError) throw options.closeError;
    },
  } as unknown as OmpRuntimeSession;
  harness.runtime = {
    supportsPersistence: true,
    async startSession(startOptions: OmpStartOptions) {
      starts.push(startOptions);
      return session;
    },
  } as unknown as OmpRuntime;
  return harness;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("OMP model catalog contract", () => {
  test("rejects unknown input fields and bounds every candidate collection", () => {
    expect(listOmpModels.input.safeParse({ unexpected: true }).success).toBe(false);

    const candidate: OmpModelCandidate = {
      selector: "provider/model",
      provider: "provider",
      id: "model",
      reasoning: false,
      input: [],
      thinkingLevels: [],
    };
    expect(OmpModelListResultSchema.safeParse({ models: Array(257).fill(candidate) }).success).toBe(
      false,
    );
    expect(
      OmpModelListResultSchema.safeParse({
        models: [{ ...candidate, provider: "p".repeat(257) }],
      }).success,
    ).toBe(false);
    expect(
      OmpModelListResultSchema.safeParse({
        models: [{ ...candidate, input: Array(17).fill("text") }],
      }).success,
    ).toBe(false);
    expect(
      OmpModelListResultSchema.safeParse({
        models: [{ ...candidate, thinkingLevels: Array(17).fill("high") }],
      }).success,
    ).toBe(false);
    expect(
      OmpModelListResultSchema.safeParse({
        models: [{ ...candidate, contextWindow: 100_000_001 }],
      }).success,
    ).toBe(false);
  });
});

describe("resolveListOmpModels", () => {
  test("starts a no-session runtime in the default store and daemon home", async () => {
    const harness = createRuntimeHarness();

    await resolveListOmpModels({}, harness.runtime);

    expect(harness.starts).toHaveLength(1);
    expect(harness.starts[0]).toMatchObject({ cwd: homedir(), noSession: true });
    expect(harness.starts[0]?.environment).toBe(process.env);
    expect(harness.closeCalls).toBe(1);
  });

  test("passes a named profile through request-local environment without mutating process.env", async () => {
    const harness = createRuntimeHarness();
    const ambientProfile = process.env.OMP_PROFILE;

    await withOmpStore({ profile: "team-models" }, () => resolveListOmpModels({}, harness.runtime));

    expect(harness.starts[0]?.environment).not.toBe(process.env);
    expect(harness.starts[0]?.environment?.OMP_PROFILE).toBe("team-models");
    expect(process.env.OMP_PROFILE).toBe(ambientProfile);
  });

  test("passes the selected cwd to OMP", async () => {
    const harness = createRuntimeHarness();

    await resolveListOmpModels({ cwd: "/workspace/project" }, harness.runtime);

    expect(harness.starts[0]?.cwd).toBe("/workspace/project");
  });

  test("rejects a relative cwd without starting OMP", async () => {
    const harness = createRuntimeHarness();

    await expect(
      resolveListOmpModels({ cwd: "relative/project" }, harness.runtime),
    ).rejects.toThrow("The workspace path is invalid.");

    expect(harness.starts).toEqual([]);
    expect(harness.closeCalls).toBe(0);
  });

  test("rejects a NUL-containing cwd without starting OMP", async () => {
    const harness = createRuntimeHarness();

    await expect(
      resolveListOmpModels({ cwd: "/workspace/\0project" }, harness.runtime),
    ).rejects.toThrow("The workspace path is invalid.");

    expect(harness.starts).toEqual([]);
    expect(harness.closeCalls).toBe(0);
  });

  test("maps concrete OMP metadata to bounded picker candidates", async () => {
    const harness = createRuntimeHarness({
      models: [MODEL, { provider: "openai", id: "gpt-5", contextWindow: null }],
    });

    const result = await resolveListOmpModels({}, harness.runtime);

    expect(result).toEqual({
      models: [
        {
          selector: "anthropic/claude-sonnet-4-5",
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
          thinkingLevels: ["low", "high"],
        },
        {
          selector: "openai/gpt-5",
          provider: "openai",
          id: "gpt-5",
          reasoning: false,
          input: [],
          contextWindow: null,
          thinkingLevels: [],
        },
      ],
    });
    expect(OmpModelListResultSchema.parse(result)).toEqual(result);
  });

  test("sanitizes native model strings to public byte bounds", async () => {
    const harness = createRuntimeHarness({
      models: [
        {
          provider: "p".repeat(400),
          id: "m".repeat(400),
          name: "n".repeat(400),
          input: ["i".repeat(400)],
          thinking: { efforts: ["t".repeat(100)] },
        },
      ],
    });

    const result = await resolveListOmpModels({}, harness.runtime);
    const [model] = result.models;

    expect(model).toBeDefined();
    expect(bytes(model?.provider ?? "")).toBeLessThanOrEqual(256);
    expect(bytes(model?.id ?? "")).toBeLessThanOrEqual(256);
    expect(bytes(model?.name ?? "")).toBeLessThanOrEqual(256);
    expect(bytes(model?.input[0] ?? "")).toBeLessThanOrEqual(256);
    expect(bytes(model?.thinkingLevels[0] ?? "")).toBeLessThanOrEqual(32);
    expect(OmpModelListResultSchema.parse(result)).toEqual(result);
  });

  test("propagates runtime errors after closing the no-session process", async () => {
    const harness = createRuntimeHarness({ modelError: new Error("catalog unavailable") });

    await expect(resolveListOmpModels({}, harness.runtime)).rejects.toThrow("catalog unavailable");
    expect(harness.closeCalls).toBe(1);
  });

  test("reports cleanup failures deterministically", async () => {
    const harness = createRuntimeHarness({ closeError: new Error("native close failed") });

    const failure = await resolveListOmpModels({}, harness.runtime).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(OmpCleanupFailure);
    expect(failure).toMatchObject({ message: "OMP model catalog cleanup failed" });
    await expect((failure as OmpCleanupFailure).cleanup).rejects.toThrow("native close failed");
    expect(harness.closeCalls).toBe(1);
  });
});
