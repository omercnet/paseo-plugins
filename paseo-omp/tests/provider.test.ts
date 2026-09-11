import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderRegistration,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { AgentPermissionRequestPayloadSchema } from "@getpaseo/protocol/messages";
import { mapOmpModels, ompModelId } from "../server/provider/catalog";
import {
  type OmpAvailableCommand,
  type OmpExtensionUiResponse,
  type OmpImage,
  type OmpModel,
  type OmpRpcEvent,
  OmpRpcRuntime,
  type OmpRuntime,
  type OmpRuntimeSession,
  type OmpStartOptions,
} from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import { OmpCleanupFailure, OmpPublicDataFilter } from "../server/provider/security";
import type { OmpTimelineScheduler } from "../server/provider/timeline-projector";
import { ompImageTimelineSchema, transformOmpImageToolItem } from "../shared/provider-image";

type HostLogger = object;
type PinoFactory = (options: { enabled: boolean }) => HostLogger;
type HostTerminalEvent = {
  type: "turn_failed" | "turn_completed" | "turn_canceled";
  turnId: string | undefined;
};
type HostTimelineItem = {
  type: string;
  status?: string;
  trigger?: string;
  message?: string;
  [key: string]: unknown;
};
type HostStreamEvent = { type: string; turnId?: string; item?: HostTimelineItem };
type HostSession = {
  readonly id: string | null;
  startTurn(prompt: string, options?: { clientMessageId?: string }): Promise<{ turnId: string }>;
  subscribe(callback: (event: HostStreamEvent) => void): () => void;
  getPendingPermissions(): Array<{ id: string }>;
  respondToPermission(
    requestId: string,
    response: { behavior: "allow" | "deny"; selectedActionId?: string; updatedInput?: object },
  ): Promise<void>;
  close(): Promise<void>;
};
type HostSessionConfig = {
  provider: string;
  cwd: string;
  systemPrompt?: string;
  mcpServers?: Record<string, unknown>;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
};
type HostLaunchContext = { env?: Record<string, string> };
type HostClient = {
  createSession(
    config: HostSessionConfig,
    launchContext?: HostLaunchContext,
    options?: { persistSession?: boolean },
  ): Promise<HostSession>;
};
type HostRegistry = {
  replace(registrations: readonly ProviderRegistration[]): void;
  clients(): Record<string, HostClient>;
  shutdown(): Promise<void>;
};
type HostRegistryConstructor = new (logger: HostLogger) => HostRegistry;

const pluginProviderModulePath: string =
  "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
const timelineContentModulePath: string =
  "../node_modules/@getpaseo/server/dist/server/server/agent/agent-timeline-content.js";
const hostRequire = createRequire(new URL(pluginProviderModulePath, import.meta.url));
const pino = hostRequire("pino") as PinoFactory;

const MODEL: OmpModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
  contextWindow: 200_000,
};
const ALTERNATE_MODEL: OmpModel = {
  provider: "openai",
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  thinking: { efforts: ["low", "high"], defaultLevel: "high" },
  contextWindow: null,
};
const MODEL_PUBLIC_ID = ompModelId(MODEL);
const ALTERNATE_MODEL_PUBLIC_ID = ompModelId(ALTERNATE_MODEL);
const TEST_RUNTIME_ENV: NodeJS.ProcessEnv = {
  HOME: "/__paseo_omp_test_no_home__",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
  PI_CONFIG_DIR: ".omp-no-config",
};
const THINKING_LEVELS: Readonly<Record<string, true>> = {
  high: true,
  low: true,
  max: true,
  medium: true,
  minimal: true,
  off: true,
  xhigh: true,
};

class EventLog extends Array<ProviderEvent> {
  private readonly waiters: Array<{
    predicate: (event: ProviderEvent) => boolean;
    resolve: (event: ProviderEvent) => void;
  }> = [];

  override push(...items: ProviderEvent[]): number {
    const length = super.push(...items);
    for (const event of items) {
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index];
        if (!waiter?.predicate(event)) continue;
        this.waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
    return length;
  }

  waitFor(predicate: (event: ProviderEvent) => boolean): Promise<ProviderEvent> {
    const existing = this.find(predicate);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<ProviderEvent>();
    this.waiters.push({ predicate, resolve });
    return promise;
  }
}
class ProviderRpcChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 515_151;
  private didClose = false;

  constructor(handler: (command: Record<string, unknown>) => void) {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer | string) => {
      buffered += String(chunk);
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handler(JSON.parse(line) as Record<string, unknown>);
      }
    });
    this.stdin.once("finish", () => this.close());
  }

  write(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  writeChunked(frame: Record<string, unknown>, chunkId: string): void {
    const payload = Buffer.from(JSON.stringify(frame));
    const count = Math.ceil(payload.byteLength / (256 * 1024));
    for (let index = 0; index < count; index += 1) {
      const part = payload.subarray(index * 256 * 1024, (index + 1) * 256 * 1024);
      this.write({
        type: "rpc_chunk",
        chunkId,
        index,
        count,
        byteLength: payload.byteLength,
        data: part.toString("base64"),
      });
    }
  }

  close(): void {
    if (this.didClose) return;
    this.didClose = true;
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }

  kill(): boolean {
    this.close();
    return true;
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

class ManualScheduler implements OmpTimelineScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void | Promise<void>>();
  readonly delays: number[] = [];
  clearError: Error | null = null;
  get pendingCount(): number {
    return this.callbacks.size;
  }

  set(callback: () => void | Promise<void>, delayMs: number): number {
    const id = this.nextId;
    this.delays.push(delayMs);
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
    if (this.clearError) {
      const error = this.clearError;
      this.clearError = null;
      throw error;
    }
  }

  runPending(): Promise<void>[] {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    return callbacks.map((callback) => {
      try {
        return Promise.resolve(callback());
      } catch (error) {
        return Promise.reject(error);
      }
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.runPending());
    await Promise.resolve();
    await Promise.resolve();
  }
}

class FakeOmpSession implements OmpRuntimeSession {
  readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  redactionValues: readonly string[] = [];
  readonly prompts: string[] = [];
  readonly promptImages: OmpImage[][] = [];
  readonly steers: string[] = [];
  readonly steerImages: OmpImage[][] = [];
  readonly extensionUiResponses: OmpExtensionUiResponse[] = [];
  extensionUiResponseGate: Promise<void> | null = null;
  extensionUiResponseObserved: (() => void) | null = null;
  extensionUiResponseError: Error | null = null;
  promptGate: Promise<void> | null = null;
  promptObserved: (() => void) | null = null;
  steerGate: Promise<void> | null = null;
  steerObserved: (() => void) | null = null;
  branchMessagesGate: Promise<void> | null = null;
  branchMessagesError: Error | null = null;
  branchMessageLookups = 0;
  closeGate: Promise<void> | null = null;
  closeObserved: (() => void) | null = null;
  abortGate: Promise<void> | null = null;
  abortObserved: (() => void) | null = null;
  abortError: Error | null = null;
  availableCommands: OmpAvailableCommand[] = [
    { name: "help", description: "Show help", source: "builtin" },
  ];
  availableCommandsError: Error | null = null;
  availableCommandLookups = 0;
  availableCommandsGate: Promise<void> | null = null;
  availableCommandsObserved: (() => void) | null = null;
  readonly modelChanges: Array<{ provider: string; modelId: string }> = [];
  modelResponseGate: Promise<void> | null = null;
  modelResponseObserved: (() => void) | null = null;
  readonly thinkingChanges: string[] = [];
  applyModelChanges = true;
  applyThinkingChanges = true;
  modelChangeGate: Promise<void> | null = null;
  modelChangeObserved: (() => void) | null = null;
  modelChangeError: Error | null = null;
  branchMessages: Array<{ entryId: string; text: string }> = [];
  currentModel = MODEL;
  availableModels: OmpModel[] = [MODEL, ALTERNATE_MODEL];
  nativeSessionId = "native-session";
  stateGate: Promise<void> | null = null;
  stateModelOverride: OmpModel | null | undefined;
  stateLookups = 0;
  stateObserved: (() => void) | null = null;
  stateError: Error | null = null;
  isStreaming = false;
  isCompacting = false;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined =
    "medium";
  promptAgentInvoked: boolean | undefined = true;
  promptEvents: OmpRpcEvent[] = [];
  promptError: Error | null = null;
  steerError: Error | null = null;
  closeError: Error | null = null;
  aborts = 0;
  promptCount = 0;
  closes = 0;
  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: OmpRpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async getState() {
    this.stateLookups += 1;
    this.stateObserved?.();
    const state = {
      model: this.stateModelOverride !== undefined ? this.stateModelOverride : this.currentModel,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      sessionId: this.nativeSessionId,
    };
    if (this.stateGate) await this.stateGate;
    if (this.stateError) throw this.stateError;
    return state;
  }

  getAvailableModels() {
    return Promise.resolve(this.availableModels);
  }

  async getAvailableCommands() {
    this.availableCommandLookups += 1;
    this.availableCommandsObserved?.();
    if (this.availableCommandsGate) await this.availableCommandsGate;
    if (this.availableCommandsError) throw this.availableCommandsError;
    return this.availableCommands;
  }
  async prompt(message: string, images: readonly OmpImage[] = []) {
    this.prompts.push(message);
    this.promptImages.push([...images]);
    this.promptCount += 1;
    this.promptObserved?.();
    if (this.promptGate) await this.promptGate;
    for (const event of this.promptEvents) this.emit(event);
    if (this.promptError) throw this.promptError;
    return {
      requestId: `rpc-prompt-${this.promptCount}`,
      agentInvoked: this.promptAgentInvoked,
    };
  }

  async setModel(provider: string, modelId: string) {
    this.modelChanges.push({ provider, modelId });
    const model = this.availableModels.find(
      (candidate) => candidate.provider === provider && candidate.id === modelId,
    );
    if (!model) throw new Error("unknown model");
    this.modelChangeObserved?.();
    if (this.modelChangeGate) await this.modelChangeGate;
    if (this.modelChangeError) throw this.modelChangeError;
    if (this.applyModelChanges) {
      this.currentModel = model;
      const efforts = model.thinking?.efforts ?? [];
      if (!this.thinkingLevel || !efforts.includes(this.thinkingLevel)) {
        const defaultLevel = model.thinking?.defaultLevel ?? "";
        this.thinkingLevel = isThinkingLevel(defaultLevel) ? defaultLevel : undefined;
      }
    }
    this.modelResponseObserved?.();
    if (this.modelResponseGate) await this.modelResponseGate;
    return model;
  }

  setThinkingLevel(level: string) {
    this.thinkingChanges.push(level);
    if (!isThinkingLevel(level)) return Promise.reject(new Error("invalid thinking level"));
    if (this.applyThinkingChanges) this.thinkingLevel = level;
    return Promise.resolve();
  }

  async steer(message: string, images: readonly OmpImage[] = []) {
    this.steerObserved?.();
    if (this.steerGate) await this.steerGate;
    if (this.steerError) throw this.steerError;
    this.steers.push(message);
    this.steerImages.push([...images]);
  }

  async respondToExtensionUi(response: OmpExtensionUiResponse) {
    this.extensionUiResponseObserved?.();
    if (this.extensionUiResponseGate) await this.extensionUiResponseGate;
    if (this.extensionUiResponseError) throw this.extensionUiResponseError;
    this.extensionUiResponses.push(response);
  }

  async getBranchMessages() {
    if (this.branchMessagesError) throw this.branchMessagesError;
    this.branchMessageLookups += 1;
    if (this.branchMessagesGate) await this.branchMessagesGate;
    return this.branchMessages;
  }

  async abort() {
    this.aborts += 1;
    this.abortObserved?.();
    if (this.abortGate) await this.abortGate;
    if (this.abortError) throw this.abortError;
  }

  async close() {
    this.closes += 1;
    this.closeObserved?.();
    if (this.closeGate) await this.closeGate;
    if (this.closeError) throw this.closeError;
  }
}

class FakeOmpRuntime implements OmpRuntime {
  readonly sessions: FakeOmpSession[] = [];
  readonly starts: OmpStartOptions[] = [];
  readonly sessionIds: string[] = [];
  nextModel: OmpModel | null = null;
  nextThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null = null;
  omitNextThinkingLevel = false;
  nextCloseError: Error | null = null;
  nextStartError: Error | null = null;
  startGate: Promise<void> | null = null;
  startObserved: (() => void) | null = null;
  commandDiscoveryError: Error | null = null;
  availableCommands: OmpAvailableCommand[] = [
    { name: "help", description: "Show help", source: "builtin" },
  ];
  availableModels: OmpModel[] = [MODEL, ALTERNATE_MODEL];
  redactionValues: readonly string[] = [];
  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    this.starts.push(options);
    this.startObserved?.();
    if (this.startGate) await this.startGate;
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = null;
      throw error;
    }
    const session = new FakeOmpSession();
    session.availableCommandsError = this.commandDiscoveryError;
    session.availableCommands = this.availableCommands.map((command) => ({
      ...command,
      ...(command.aliases ? { aliases: [...command.aliases] } : {}),
    }));
    session.redactionValues = this.redactionValues;
    session.availableModels = this.availableModels.map((model) => ({ ...model }));
    session.nativeSessionId = this.sessionIds.shift() ?? session.nativeSessionId;
    if (this.nextModel) {
      session.currentModel = this.nextModel;
      this.nextModel = null;
    }
    if (this.nextThinkingLevel) {
      session.thinkingLevel = this.nextThinkingLevel;
      this.nextThinkingLevel = null;
    }
    if (this.omitNextThinkingLevel) {
      session.thinkingLevel = undefined;
      this.omitNextThinkingLevel = false;
    }
    if (this.nextCloseError) {
      session.closeError = this.nextCloseError;
      this.nextCloseError = null;
    }
    this.sessions.push(session);
    return session;
  }
}

function isThinkingLevel(
  level: string,
): level is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return THINKING_LEVELS[level] === true;
}

function sessionAt(runtime: FakeOmpRuntime, index = 0): FakeOmpSession {
  const session = runtime.sessions[index];
  if (!session) throw new Error(`Missing fake OMP session ${index}`);
  return session;
}

async function createHarness(runtime = new FakeOmpRuntime(), scheduler = new ManualScheduler()) {
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: scheduler,
    environment: TEST_RUNTIME_ENV,
  }).connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "prompt.steer",
      "session.configure",
      "permission",
    ],
  });
  const events = new EventLog();
  connection.onEvent((event) => events.push(event));
  return { connection, events, runtime, scheduler };
}

async function openSession(
  connection: ProviderConnection,
  events: EventLog,
  requestId = "open-1",
  sessionId = "session-1",
  env: Record<string, string> = { TEST_ENV: "test-value" },
  model = MODEL_PUBLIC_ID,
  thinkingOption: string | null = "medium",
) {
  await connection.send({
    type: "session.open",
    requestId,
    sessionId,
    config: {
      cwd: "/repo",
      env,
      systemPrompt: "Be precise",
      mcpServers: {},
      model,
      mode: "full",
      ...(thinkingOption ? { thinkingOption } : {}),
      settings: {},
      persist: false,
    },
    history: "skip",
  });
  const outcome = await events.waitFor(
    (event) =>
      (event.type === "session.ready" && event.requestId === requestId) ||
      (event.type === "request.failed" && event.requestId === requestId),
  );
  if (outcome.type === "request.failed") throw new Error(outcome.error.message);
}

async function startPrompt(
  connection: ProviderConnection,
  events: EventLog,
  clientMessageId = "client-1",
  text = "hello",
  sessionId = "session-1",
) {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  });
  return events.waitFor(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
  );
}

function turnIdFrom(result: ProviderEvent): string {
  if (result.type !== "session.prompt_result" || result.result.type !== "turn") {
    throw new Error("Expected turn prompt result");
  }
  return result.result.turnId;
}

function establishTerminalOwnership(session: FakeOmpSession): void {
  session.emit({
    type: "prompt_result",
    id: `rpc-prompt-${session.promptCount}`,
    agentInvoked: true,
  });
}

function finishTurn(events: EventLog, session: FakeOmpSession, turnId: string) {
  establishTerminalOwnership(session);
  session.emit({ type: "agent_end", messages: [], isTerminal: true });
  return events.waitFor(
    (event) =>
      event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
  );
}

describe("OMP direct provider", () => {
  test("discovers real models and exposes Full Access only", async () => {
    const { connection, events, runtime } = await createHarness();
    await connection.send({ type: "catalog", requestId: "catalog-1", cwd: "/repo" });
    const event = await events.waitFor((candidate) => candidate.type === "catalog");

    expect(event).toEqual({
      type: "catalog",
      requestId: "catalog-1",
      catalog: expect.objectContaining({
        defaultModel: MODEL_PUBLIC_ID,
        defaultMode: "full",
        models: expect.arrayContaining([
          expect.objectContaining({ id: MODEL_PUBLIC_ID }),
          expect.objectContaining({ id: ALTERNATE_MODEL_PUBLIC_ID }),
        ]),
        modes: [expect.objectContaining({ id: "full" })],
      }),
    });
    if (event.type !== "catalog") throw new Error("Expected catalog event");
    const alternate = event.catalog.models.find((model) => model.id === ALTERNATE_MODEL_PUBLIC_ID);
    expect(alternate?.contextWindowMaxTokens).toBeUndefined();
    expect(alternate?.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high"]);
    expect(event.catalog.modes.map((mode) => mode.id)).toEqual(["full"]);
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({ cwd: "/repo", noSession: true, environment: TEST_RUNTIME_ENV }),
    );
    expect(sessionAt(runtime).closes).toBe(1);
    await connection.close();
  });
  test("omits thinking options without recognized effort metadata", () => {
    const variants: OmpModel[] = [
      { provider: "test", id: "absent", reasoning: true },
      { provider: "test", id: "empty", reasoning: true, thinking: { efforts: [] } },
      {
        provider: "test",
        id: "unknown",
        reasoning: true,
        thinking: { efforts: ["ultra", "extreme"] },
      },
    ];

    for (const model of mapOmpModels(variants)) {
      expect(model.thinkingOptions).toBeUndefined();
      expect(model.defaultThinkingOptionId).toBeUndefined();
    }
  });

  test("accepts catalog state without a thinking level", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.omitNextThinkingLevel = true;
    const { connection, events } = await createHarness(runtime);

    await connection.send({ type: "catalog", requestId: "catalog-no-thinking", cwd: "/repo" });
    const event = await events.waitFor(
      (candidate) => candidate.type === "catalog" && candidate.requestId === "catalog-no-thinking",
    );

    expect(event).toEqual(
      expect.objectContaining({
        catalog: expect.not.objectContaining({ defaultThinkingOption: expect.anything() }),
      }),
    );
    await connection.close();
  });

  test("omits an unsupported active thinking level from catalog defaults", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "medium";
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "catalog",
      requestId: "catalog-unsupported-default",
      cwd: "/repo",
    });
    const event = await events.waitFor(
      (candidate) =>
        candidate.type === "catalog" && candidate.requestId === "catalog-unsupported-default",
    );
    if (event.type !== "catalog") throw new Error("Expected catalog event");

    expect(event.catalog.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high"]);
    expect("defaultThinkingOption" in event.catalog).toBe(false);
    await connection.close();
  });

  test("blocks repeated catalog discovery after unverified cleanup", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextCloseError = new Error("catalog cleanup failed");
    const { connection, events } = await createHarness(runtime);
    for (const requestId of ["catalog-cleanup-failure", "catalog-cleanup-retry"]) {
      await connection.send({ type: "catalog", requestId, cwd: "/repo" });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  test("rejects unadvertised catalog and session state models", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [MODEL];
    runtime.nextModel = ALTERNATE_MODEL;
    const { connection, events } = await createHarness(runtime);
    await connection.send({ type: "catalog", requestId: "unadvertised-catalog", cwd: "/repo" });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unadvertised-catalog",
    );
    runtime.nextModel = ALTERNATE_MODEL;
    await connection.send({
      type: "session.open",
      requestId: "unadvertised-open",
      sessionId: "unadvertised-session",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unadvertised-open",
    );
    await connection.close();
  });

  test("sanitizes malicious model fields while preserving native runtime identity", async () => {
    const maliciousModel: OmpModel = {
      provider: "API_KEY=provider-secret",
      id: "/home/private/model",
      name: "Authorization: Basic model-secret",
      reasoning: false,
    };
    const slashIdModel: OmpModel = { provider: "a", id: "b/c", name: "B\u0007name" };
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [maliciousModel, slashIdModel];
    runtime.nextModel = maliciousModel;
    const { connection, events } = await createHarness(runtime);
    await connection.send({ type: "catalog", requestId: "malicious-catalog", cwd: "/repo" });
    const catalog = await events.waitFor(
      (event) => event.type === "catalog" && event.requestId === "malicious-catalog",
    );
    if (catalog.type !== "catalog") throw new Error("Expected catalog event");
    const publicModelId = catalog.catalog.models[0]?.id;
    if (!publicModelId) throw new Error("Expected projected model");
    runtime.nextModel = maliciousModel;
    runtime.omitNextThinkingLevel = true;
    await openSession(
      connection,
      events,
      "malicious-open",
      "session-1",
      { TEST_ENV: "test-value" },
      publicModelId,
      null,
    );
    const config = events.find(
      (event) => event.type === "session.config" && event.sessionId === "session-1",
    );
    const visible = JSON.stringify([catalog, config]);
    await connection.send({
      type: "session.configure",
      requestId: "malicious-model-select",
      sessionId: "session-1",
      changes: { model: publicModelId },
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "malicious-model-select",
    );
    expect(visible).not.toContain("provider-secret");
    expect(visible).not.toContain("/home/private/model");
    expect(visible).not.toContain("model-secret");
    expect(visible).toContain("omp:model:");
    if (catalog.type !== "catalog") throw new Error("Expected catalog event");
    expect(new Set(catalog.catalog.models.map((model) => model.id)).size).toBe(2);
    expect(catalog.catalog.models.every((model) => model.id.startsWith("omp:model:"))).toBe(true);
    expect(visible).not.toContain("\u0000");
    expect(visible).not.toContain("\u0007");
    expect(runtime.starts[1]?.model).toBeUndefined();
    expect(sessionAt(runtime, 1).modelChanges).toContainEqual({
      provider: maliciousModel.provider,
      modelId: maliciousModel.id,
    });
    await connection.close();
  });
  test("rejects slash-containing native model providers", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [{ provider: "ambiguous/provider", id: "model/id" }];
    runtime.nextModel = runtime.availableModels[0] ?? null;
    const { connection, events } = await createHarness(runtime);

    await connection.send({ type: "catalog", requestId: "slash-provider", cwd: "/repo" });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "slash-provider",
    );
    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP reported an invalid model provider" } }),
    );
    await connection.close();
  });

  test("publishes opened, committed config, then ready", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);

    expect(events.map((event) => event.type)).toEqual([
      "session.opened",
      "session.config",
      "session.commands",
      "session.ready",
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: MODEL_PUBLIC_ID,
          mode: "full",
          modes: [expect.objectContaining({ id: "full" })],
          thinkingOption: "medium",
        }),
      }),
    );
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        mode: "full",
        thinkingOption: "medium",
        systemPrompt: "Be precise",
      }),
    );
    expect(runtime.starts[0]?.model).toBeUndefined();
    expect(connection.capabilities).toEqual([
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "prompt.steer",
      "session.configure",
      "permission",
    ]);
    await connection.close();
  });
  test("rejects unadvertised raw model identifiers", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "raw-model-open",
      sessionId: "raw-model-session",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: "anthropic/claude-sonnet-4-5",
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "raw-model-open",
    );
    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP model selection is unavailable" } }),
    );
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    expect(sessionAt(runtime).modelChanges).toHaveLength(0);
    await connection.close();
  });

  test("rejects unsupported thinking after resolving the committed open model", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "unsupported-thinking-open",
      sessionId: "unsupported-thinking-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: ALTERNATE_MODEL_PUBLIC_ID,
        mode: "full",
        thinkingOption: "medium",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unsupported-thinking-open",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP thinking level is unavailable for the selected model" },
      }),
    );
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    expect(sessionAt(runtime).closes).toBe(1);
    await connection.close();
  });

  test("rejects malformed capabilities and filters unsupported capability names", async () => {
    const provider = createOmpProvider({
      runtime: new FakeOmpRuntime(),
      environment: TEST_RUNTIME_ENV,
    });
    await expect(
      provider.connect({ versions: [1], capabilities: ["prompt.message", 42] } as never),
    ).rejects.toThrow("valid provider protocol version 1 request");
    await expect(
      provider.connect({
        versions: Array.from({ length: 33 }, () => 1),
        capabilities: ["prompt.message"],
      }),
    ).rejects.toThrow("oversized connection request");

    const connection = await provider.connect({
      versions: [1],
      capabilities: ["prompt.message", "provider.admin"],
    });
    expect(connection.capabilities).toEqual(["prompt.message"]);
    await connection.close();
  });
  test("rejects malformed permission responses and advertises permission support", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "permission"],
    });

    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: "permission-1",
        response: { behavior: "allow", updatedPermissions: Array.from({ length: 65 }, () => ({})) },
      } as never),
    ).rejects.toThrow("Invalid permission response");
    expect(connection.capabilities).toContain("permission");
    expect(runtime.starts).toHaveLength(0);
    await connection.close();
  });

  test("rejects unsupported MCP configuration and dangerous environment before spawn", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "unsupported-mcp",
      sessionId: "session-mcp",
      config: {
        cwd: "/repo",
        env: { API_TOKEN: "credential-value" },
        mcpServers: { filesystem: { type: "stdio", command: "cat", args: ["/etc/passwd"] } },
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unsupported-mcp",
    );
    await connection.send({
      type: "session.open",
      requestId: "dangerous-env",
      sessionId: "session-env",
      config: {
        cwd: "/repo",
        env: { LD_PRELOAD: "/tmp/injected.so" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "dangerous-env",
    );

    expect(runtime.starts).toHaveLength(0);
    const visible = JSON.stringify(events);
    expect(visible).not.toContain("credential-value");
    expect(visible).not.toContain("/etc/passwd");
    expect(visible).not.toContain("/tmp/injected.so");
    await connection.close();
  });

  test("rejects uploaded prompt content before invoking OMP", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "uploaded-file",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            {
              type: "uploaded_file",
              id: "upload-1",
              fileName: "secret.txt",
              mimeType: "text/plain",
              size: 12,
              path: "/etc/passwd",
            },
          ],
        },
      },
    });
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "uploaded-file",
    );

    expect(result).toEqual(
      expect.objectContaining({
        result: { type: "failed", error: { message: "OMP supports text messages only" } },
      }),
    );
    expect(session.promptCount).toBe(0);
    expect(JSON.stringify(events)).not.toContain("/etc/passwd");
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "too-many-parts",
        delivery: "auto",
        input: {
          type: "message",
          content: Array.from({ length: 65 }, () => ({ type: "text" as const, text: "x" })),
        },
      },
    });
    const oversized = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "too-many-parts",
    );
    expect(oversized).toEqual(
      expect.objectContaining({
        result: { type: "failed", error: { message: "OMP prompt has too many content parts" } },
      }),
    );
    expect(session.promptCount).toBe(0);
    await connection.close();
  });

  test("commits an actual model and thinking change", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const baseline = events.length;

    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID, thinkingOption: "high" },
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "configure-1",
    );

    const session = sessionAt(runtime);
    expect(session.modelChanges).toEqual([{ provider: "openai", modelId: "gpt-5.4" }]);
    expect(session.thinkingChanges).toEqual(["high"]);
    expect(events.slice(baseline)).toEqual([
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
      { type: "request.completed", requestId: "configure-1" },
    ]);
    await connection.close();
  });
  test("publishes native fallback and revert state", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const fallbackTimelineBaseline = events.length;

    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    const fallback = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === ALTERNATE_MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "high",
    );
    session.emit({
      type: "retry_fallback_applied",
      from: "anthropic/claude-sonnet-4-5:medium",
      to: "openai/gpt-5.4:high",
      role: "default",
    });
    session.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    const fallbackConfig = await fallback;
    const fallbackItems = events
      .slice(fallbackTimelineBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "omp_retry_fallback"
          ? [event.item]
          : [],
      );
    expect(fallbackItems.map((item) => item.status)).toEqual(["running", "completed"]);
    expect(new Set(fallbackItems.map((item) => item.callId)).size).toBe(1);
    expect(fallbackItems.map((item) => item.detail)).toEqual([
      expect.objectContaining({
        type: "plain_text",
        label: "OMP fallback applied for default",
        text: "anthropic/claude-sonnet-4-5:medium -> openai/gpt-5.4:high",
      }),
      expect.objectContaining({
        type: "plain_text",
        label: "OMP fallback succeeded for default",
        text: "Using openai/gpt-5.4:high",
      }),
    ]);
    if (fallbackConfig.type !== "session.config") throw new Error("Expected config event");
    expect(fallbackConfig.config.thinkingOptions.map((option) => option.id)).toEqual([
      "low",
      "high",
    ]);

    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    const reverted = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    session.emit({ type: "model_changed" });
    const revertedConfig = await reverted;
    if (revertedConfig.type !== "session.config") throw new Error("Expected config event");
    expect(revertedConfig.config.thinkingOptions.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    session.thinkingLevel = "high";
    const thinkingChanged = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "high",
    );
    session.emit({ type: "thinking_level_changed", thinkingLevel: "future-thinking" });
    await thinkingChanged;

    const latest = events.findLast((event) => event.type === "session.config");
    expect(latest).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: MODEL_PUBLIC_ID,
          thinkingOption: "high",
          thinkingOptions: expect.arrayContaining([expect.objectContaining({ id: "low" })]),
        }),
      }),
    );
    await connection.close();
  });
  test("renders goal and retry events and routes subagent events", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;

    session.emit({
      type: "goal_updated",
      goal: { id: "goal-1", objective: "Ship", status: "active", tokenBudget: 10_000 },
      state: { enabled: true, mode: "focused" },
    });
    session.emit({
      type: "goal_updated",
      goal: {
        id: "goal-1",
        objective: "Ship",
        status: "completed",
        tokenBudget: 10_000,
        tokensUsed: 8_000,
      },
      state: { enabled: true, mode: "focused" },
    });
    session.emit({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 4,
      delayMs: 1_500,
      errorMessage: "rate limited",
      errorId: 429,
    });
    session.emit({
      type: "auto_retry_end",
      success: false,
      attempt: 2,
      finalError: "still rate limited",
      recoveredErrors: [{ id: 429 }],
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "scout", status: "started", index: 0 },
    });
    session.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "scout",
        task: "Inspect protocol",
        progress: { id: "child-1", status: "running" },
      },
    });
    session.emit({
      type: "subagent_event",
      payload: { id: "child-1", event: { type: "agent_start" } },
    });
    session.emit({ type: "notice", level: "info", message: "subagent events routed" });

    const statusItems = events
      .slice(baseline)
      .flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
      );
    const goalItems = statusItems.filter((item) => item.name === "omp_goal_updated");
    expect(goalItems).toHaveLength(2);
    expect(new Set(goalItems.map((item) => item.callId)).size).toBe(1);
    expect(goalItems.at(-1)).toEqual(
      expect.objectContaining({
        status: "completed",
        detail: expect.objectContaining({
          label: "OMP goal completed",
          text: "Ship\nStatus: completed\nTokens used: 8000\nToken budget: 10000\nMode: focused",
        }),
      }),
    );
    const retryItems = statusItems.filter((item) => item.name === "omp_auto_retry");
    expect(retryItems.map((item) => item.status)).toEqual(["running", "failed"]);
    expect(new Set(retryItems.map((item) => item.callId)).size).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          message: "subagent events routed",
        }),
      }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.close();
  });

  test("coalesces a runtime config event flood and publishes only changed state", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineLookups = session.stateLookups;
    const baselineConfigs = events.filter((event) => event.type === "session.config").length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    session.emit({ type: "model_changed" });
    await observed.promise;
    for (let index = 0; index < 100; index += 1) {
      session.emit({ type: "model_changed" });
    }
    expect(session.stateLookups).toBe(baselineLookups + 1);

    const committed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.stateGate = null;
    gate.resolve();
    await committed;
    await Promise.resolve();
    await Promise.resolve();

    expect(session.stateLookups).toBe(baselineLookups + 2);
    expect(events.filter((event) => event.type === "session.config").length - baselineConfigs).toBe(
      1,
    );
    await connection.close();
  });
  test("clears a detached refresh after scheduler cleanup throws", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineLookups = session.stateLookups;
    scheduler.clearError = new Error("timer cleanup failed");
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    const fallback = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.pendingCount).toBe(1);
    await scheduler.flush();
    await fallback;
    expect(session.stateLookups).toBe(baselineLookups + 2);

    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    const reverted = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    session.emit({ type: "model_changed" });
    await reverted;
    await connection.close();
  });
  test("preserves a deferred native refresh across rejected configure validation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    session.emit({ type: "model_changed" });
    await observed.promise;
    await connection.send({
      type: "session.configure",
      requestId: "invalid-during-refresh",
      sessionId: "session-1",
      changes: { mode: "write" },
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "invalid-during-refresh",
    );

    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    session.stateGate = null;
    gate.resolve();
    await refreshed;
    await Promise.resolve();
    await Promise.resolve();

    session.emit({ type: "process_exit", error: "restart after native change" });
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "refresh-recovery", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({ model: "openai/gpt-5.4", thinkingOption: "high" }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("recovers from native state after fallback immediately precedes process exit", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";

    session.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    await observed.promise;
    session.emit({ type: "process_exit", error: "fallback runtime exited" });
    session.stateGate = null;
    gate.resolve();
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";

    const turnId = turnIdFrom(await startPrompt(connection, events, "fallback-exit", "continue"));
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: undefined,
        thinkingOption: undefined,
        resumeSessionId: "native-session",
      }),
    );
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("recovers native state when setModel commits immediately before process exit", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const responseGate = Promise.withResolvers<void>();
    const responseObserved = Promise.withResolvers<void>();
    session.modelResponseGate = responseGate.promise;
    session.modelResponseObserved = responseObserved.resolve;

    await connection.send({
      type: "session.configure",
      requestId: "configure-exit-after-model-commit",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await responseObserved.promise;
    const failed = events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-exit-after-model-commit",
    );
    session.emit({ type: "process_exit", error: "exit before set_model response" });
    session.modelResponseGate = null;
    responseGate.resolve();
    await failed;

    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "configure-exit-recovery", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: undefined,
        thinkingOption: undefined,
        resumeSessionId: "native-session",
      }),
    );
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("invalidates runtime state with a thinking level outside the model catalog", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineConfigs = events.filter((event) => event.type === "session.config").length;
    const closed = Promise.withResolvers<void>();
    session.closeObserved = closed.resolve;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "medium";

    session.emit({ type: "model_changed" });
    await closed.promise;

    expect(session.closes).toBe(1);
    expect(events.filter((event) => event.type === "session.config")).toHaveLength(baselineConfigs);
    await connection.close();
  });

  test("retries failed and timed-out config refreshes without killing an active turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "refresh-timeout", "work"));

    session.stateError = new Error("transient state failure");
    session.emit({ type: "model_changed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.closes).toBe(0);

    session.stateError = null;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.delays.at(-1)).toBe(250);
    const afterRejection = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    await scheduler.flush();
    await afterRejection;

    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;
    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    session.emit({ type: "model_changed" });
    await observed.promise;
    await scheduler.flush();
    const timedOutLookups = session.stateLookups;
    for (let index = 0; index < 100; index += 1) {
      session.emit({ type: "model_changed" });
    }
    expect(session.stateLookups).toBe(timedOutLookups);

    expect(session.closes).toBe(0);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);

    const afterTimeout = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    session.stateGate = null;
    gate.resolve();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.delays.at(-1)).toBe(250);
    await scheduler.flush();
    await afterTimeout;
    expect(scheduler.delays.filter((delay) => delay < 2_000)).toEqual([250, 250]);

    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("retries after a never-settling refresh request times out", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const neverSettles = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = neverSettles.promise;
    session.stateObserved = observed.resolve;

    session.emit({ type: "model_changed" });
    await observed.promise;
    await scheduler.flush();
    expect(scheduler.pendingCount).toBe(1);

    session.stateGate = null;
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" && event.config.model === ALTERNATE_MODEL_PUBLIC_ID,
    );
    await scheduler.flush();
    await refreshed;

    expect(session.stateLookups).toBe(3);
    await connection.close();
  });

  test("ignores a late timed-out state result after a newer refresh commits", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineConfigs = events.filter((event) => event.type === "session.config").length;
    const late = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    session.stateGate = late.promise;
    session.stateObserved = observed.resolve;

    session.emit({ type: "model_changed" });
    await observed.promise;
    await scheduler.flush();

    session.stateGate = null;
    session.currentModel = MODEL;
    session.thinkingLevel = "low";
    const refreshed = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "low",
    );
    await scheduler.flush();
    await refreshed;
    const committedConfigs = events.filter((event) => event.type === "session.config").length;

    late.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.filter((event) => event.type === "session.config")).toHaveLength(
      committedConfigs,
    );
    expect(committedConfigs).toBe(baselineConfigs + 1);
    await connection.close();
  });

  test("invalidates after bounded persistent config refresh failures", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baselineLookups = session.stateLookups;
    const closed = Promise.withResolvers<void>();
    session.closeObserved = closed.resolve;
    session.stateError = new Error("persistent state failure");

    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.delays.filter((delay) => delay < 2_000)).toEqual([250]);
    await scheduler.flush();
    expect(scheduler.delays.filter((delay) => delay < 2_000)).toEqual([250, 500]);
    await scheduler.flush();
    await closed.promise;

    expect(session.stateLookups).toBe(baselineLookups + 3);
    expect(session.closes).toBe(1);
    await connection.close();
  });

  test("cancels and drains a config refresh backoff on close", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateError = new Error("state unavailable before close");
    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.pendingCount).toBe(1);
    const stateLookups = session.stateLookups;

    await connection.close();

    expect(scheduler.pendingCount).toBe(0);
    await scheduler.flush();
    expect(session.stateLookups).toBe(stateLookups);
  });

  test("cancels and drains a config refresh backoff on runtime invalidation", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateError = new Error("state unavailable before invalidation");
    session.emit({ type: "model_changed" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduler.pendingCount).toBe(1);
    const stateLookups = session.stateLookups;

    session.emit({ type: "process_exit", error: "runtime exited during refresh backoff" });
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.pendingCount).toBe(0);
    await scheduler.flush();
    expect(session.stateLookups).toBe(stateLookups);
    expect(session.closes).toBe(1);
    await connection.close();
  });

  test("fails configure when OMP does not commit the requested selection", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.applyModelChanges = false;

    await connection.send({
      type: "session.configure",
      requestId: "configure-uncommitted",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-uncommitted",
    );

    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP did not commit the requested model" } }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-uncommitted",
      ),
    ).toBe(false);
    expect(events.findLast((event) => event.type === "session.config")).toEqual(
      expect.objectContaining({ config: expect.objectContaining({ model: MODEL_PUBLIC_ID }) }),
    );
    session.applyModelChanges = true;
    session.applyThinkingChanges = false;
    await connection.send({
      type: "session.configure",
      requestId: "configure-uncommitted-thinking",
      sessionId: "session-1",
      changes: { thinkingOption: "low" },
    });
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-uncommitted-thinking",
    );
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" &&
          event.requestId === "configure-uncommitted-thinking",
      ),
    ).toBe(false);
    await connection.close();
  });
  test("bounds state reconciliation after a configure mutation failure", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const stateGate = Promise.withResolvers<void>();
    const stateObserved = Promise.withResolvers<void>();
    session.modelChangeError = new Error("model mutation failed");
    session.stateGate = stateGate.promise;
    session.stateObserved = stateObserved.resolve;

    await connection.send({
      type: "session.configure",
      requestId: "configure-reconcile-timeout",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await stateObserved.promise;
    await Promise.resolve();
    const failure = events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-reconcile-timeout",
    );
    expect(scheduler.delays.at(-1)).toBe(2_000);
    await scheduler.flush();

    await failure;
    expect(scheduler.delays).toContain(2_000);
    expect(session.closes).toBe(0);
    stateGate.resolve();
    await connection.close();
  });

  test("rejects unsupported thinking before changing the target model", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.configure",
      requestId: "configure-unsupported-thinking",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID, thinkingOption: "medium" },
    });
    const failure = await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "configure-unsupported-thinking",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP thinking level is unavailable for the selected model" },
      }),
    );
    expect(session.modelChanges).toEqual([]);
    expect(session.thinkingChanges).toEqual([]);
    await connection.close();
  });

  test("invalidates the runtime when configure observes a catalog escape", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateModelOverride = {
      provider: "escaped",
      id: "unadvertised",
      reasoning: false,
    };

    await connection.send({
      type: "session.configure",
      requestId: "configure-catalog-escape",
      sessionId: "session-1",
      changes: { mode: "full" },
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-catalog-escape",
    );

    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP runtime selected an unadvertised model" } }),
    );
    expect(session.closes).toBe(1);
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-catalog-escape",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("does not publish deferred configure success after runtime invalidation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;

    const configuring = connection.send({
      type: "session.configure",
      requestId: "configure-invalidated",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await observed.promise;
    session.emit({ type: "process_exit", error: "runtime exited" });
    const failure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-invalidated",
    );
    session.stateGate = null;
    gate.resolve();
    await failure;
    await configuring;

    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-invalidated",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("fails a deferred getState configure request after close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.stateGate = gate.promise;
    session.stateObserved = observed.resolve;

    const configuring = connection.send({
      type: "session.configure",
      requestId: "configure-closed",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await observed.promise;
    const failure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-closed",
    );
    const closing = connection.close();
    session.stateGate = null;
    gate.resolve();
    await failure;
    await Promise.all([configuring, closing]);

    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "request.completed" && event.requestId === "configure-closed",
      ),
    ).toHaveLength(0);
  });

  test("fails a deferred setModel configure request after close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.modelChangeGate = gate.promise;
    session.modelChangeObserved = observed.resolve;

    const configuring = connection.send({
      type: "session.configure",
      requestId: "configure-model-closed",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await observed.promise;
    const failure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-model-closed",
    );
    const closing = connection.close();
    session.modelChangeGate = null;
    gate.resolve();
    await failure;
    await Promise.all([configuring, closing]);

    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "request.completed" && event.requestId === "configure-model-closed",
      ),
    ).toHaveLength(0);
  });

  test("rejects approval mode changes without claiming success", async () => {
    const { connection, events } = await createHarness();
    await openSession(connection, events);

    await connection.send({
      type: "session.configure",
      requestId: "configure-mode",
      sessionId: "session-1",
      changes: { mode: "write" },
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "configure-mode",
    );

    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP approval mode cannot change live; create a new session instead" },
      }),
    );
    expect(
      events.some(
        (event) => event.type === "request.completed" && event.requestId === "configure-mode",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("preserves isolated environment after configure and recovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    await connection.send({
      type: "session.configure",
      requestId: "configure-before-recovery",
      sessionId: "session-1",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await events.waitFor(
      (event) =>
        event.type === "request.completed" && event.requestId === "configure-before-recovery",
    );
    const recoveryBaseline = events.length;
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "low";
    sessionAt(runtime).emit({ type: "process_exit", error: "closed" });
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "configured-recovery", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        environment: TEST_RUNTIME_ENV,
        model: "openai/gpt-5.4",
        resumeSessionId: "native-session",
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    expect(events.slice(recoveryBaseline)).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "low",
        }),
      }),
    );
    await connection.close();
  });

  test("coalesces streams, preserves tool snapshots, and resets IDs between turns", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const firstResult = await startPrompt(connection, events, "client-1", "hello");
    const firstTurnId = turnIdFrom(firstResult);
    const session = sessionAt(runtime);
    session.branchMessages = [{ entryId: "entry-user-1", text: "hello" }];
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "client-1",
    );

    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-main" },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Think" },
          { type: "text", text: "Hel" },
        ],
        responseId: "response-main",
      },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking" },
          { type: "text", text: "Hello" },
        ],
        responseId: "response-main",
      },
    });
    expect(
      events.some(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toBe(false);
    await scheduler.flush();
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking more" },
          { type: "text", text: "Hello world" },
        ],
        responseId: "response-main",
      },
    });
    await scheduler.flush();

    session.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "file.ts" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      partialResult: { content: "partial" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: "complete" },
    });
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-after-tool" },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "After tool" }],
        responseId: "response-after-tool",
      },
    });
    const firstTerminal = await finishTurn(events, session, firstTurnId);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    const firstAssistant = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    const firstReasoning = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "reasoning",
    );
    expect(firstAssistant).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ text: "Hello" }) }),
    );
    expect(firstReasoning).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ text: "Thinking more" }) }),
    );
    expect(firstTerminal).toEqual(expect.objectContaining({ state: "completed" }));
    const assistantSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(assistantSnapshots.map((item) => item.text)).toEqual([
      "Hello",
      "Hello world",
      "After tool",
    ]);
    const firstStreamSnapshots = assistantSnapshots.filter(
      (item) => item.text === "Hello" || item.text === "Hello world",
    );
    expect(firstStreamSnapshots.map((item) => item.id)).toEqual([
      "omp:assistant:1:W-GOZ8cyzNX6:content:1:text",
      "omp:assistant:1:W-GOZ8cyzNX6:content:1:text",
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === firstTurnId &&
          event.state !== "started",
      ),
    ).toHaveLength(1);
    const toolSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
    );
    expect(toolSnapshots).toEqual([
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: { type: "read", filePath: "file.ts" },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: { type: "read", filePath: "file.ts", content: "partial" },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: { type: "read", filePath: "file.ts", content: "complete" },
        status: "completed",
        error: null,
      },
    ]);

    const secondResult = await startPrompt(connection, events, "client-2", "again");
    const secondTurnId = turnIdFrom(secondResult);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-again" },
    });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Again" }],
        responseId: "response-again",
      },
    });
    await finishTurn(events, session, secondTurnId);
    const assistantIds = events
      .filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")
      .map((event) => (event.type === "timeline.item" ? event.item.id : ""));
    expect(new Set(assistantIds).size).toBe(3);
    await connection.close();
  });

  test("keeps multiple native assistant messages distinct within one turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);

    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-1", id: "generic-id" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First" },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        responseId: "response-1",
        id: "generic-id",
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        responseId: "response-1",
        id: "generic-id",
      },
    });
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-2", id: "generic-id" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second" },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
        responseId: "response-2",
        id: "generic-id",
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
        responseId: "response-2",
        id: "generic-id",
      },
    });
    await finishTurn(events, session, turnId);

    const assistantItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    const firstFinal = assistantItems.findLast((item) => item.text === "First");
    const secondFinal = assistantItems.findLast((item) => item.text === "Second");
    if (!firstFinal || !secondFinal) throw new Error("Expected final assistant snapshots");
    expect(new Set(assistantItems.map((item) => item.messageId))).toEqual(
      new Set([firstFinal.messageId, secondFinal.messageId]),
    );
    expect(
      assistantItems
        .filter((item) => item.messageId === firstFinal.messageId)
        .every((item) => item.id === firstFinal.id),
    ).toBe(true);
    expect(
      assistantItems
        .filter((item) => item.messageId === secondFinal.messageId)
        .every((item) => item.id === secondFinal.id),
    ).toBe(true);
    expect(firstFinal.text).toBe("First");
    expect(secondFinal.text).toBe("Second");
    expect(assistantItems.some((item) => item.id.includes("generic-id"))).toBe(false);
    await connection.close();
  });

  test("keeps repeated and adversarial native assistant identities collision free", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    const emitAssistant = async (responseId: string, text: string) => {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
        message: {
          role: "assistant",
          responseId,
          content: [{ type: "text", text }],
        },
      });
      await scheduler.flush();
    };

    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "identity-1", "first"));
    await emitAssistant("x", "First");
    await finishTurn(events, session, firstTurnId);

    const adversarialTurnId = turnIdFrom(
      await startPrompt(connection, events, "identity-2", "adversarial"),
    );
    await emitAssistant("x:occurrence:2", "Adversarial");
    await finishTurn(events, session, adversarialTurnId);

    const repeatedTurnId = turnIdFrom(
      await startPrompt(connection, events, "identity-3", "repeated"),
    );
    await emitAssistant("x", "Third draft");
    await emitAssistant("x", "Third final");
    await finishTurn(events, session, repeatedTurnId);

    const assistantItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    const firstFinal = assistantItems.findLast((item) => item.text === "First");
    const adversarialFinal = assistantItems.findLast((item) => item.text === "Adversarial");
    const repeatedFinal = assistantItems.findLast((item) => item.text === "Third final");
    if (!firstFinal || !adversarialFinal || !repeatedFinal) {
      throw new Error("Expected final assistant snapshots");
    }
    const finalItems = [firstFinal, adversarialFinal, repeatedFinal];
    expect(new Set(assistantItems.map((item) => item.messageId))).toEqual(
      new Set(finalItems.map((item) => item.messageId)),
    );
    for (const finalItem of finalItems) {
      expect(
        assistantItems
          .filter((item) => item.messageId === finalItem.messageId)
          .every((item) => item.id === finalItem.id),
      ).toBe(true);
    }
    expect(finalItems.map((item) => item.text)).toEqual(["First", "Adversarial", "Third final"]);
    expect(JSON.stringify(finalItems.map((item) => item.messageId))).not.toContain("x:occurrence");
    expect(JSON.stringify(finalItems.map((item) => item.messageId))).not.toContain(
      "repeated-native-response",
    );
    await connection.close();
  });

  test("keeps timeline IDs unique after bounded native identity eviction", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    for (let index = 0; index < 1_030; index += 1) {
      const turnId = turnIdFrom(
        await startPrompt(connection, events, `bounded-identity-${index}`, `prompt-${index}`),
      );
      session.emit({
        type: "message_end",
        message: {
          role: "user",
          content: `prompt-${index}`,
          entryId: index === 1_029 ? "entry-0" : `entry-${index}`,
        },
      });
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `answer-${index}` },
        message: {
          role: "assistant",
          responseId: "repeated-native-response",
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
      await scheduler.flush();
      await finishTurn(events, session, turnId);
    }

    const userIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item.id] : [],
    );
    const assistantIds = events.flatMap((event) => {
      if (event.type !== "timeline.item" || event.item.type !== "assistant_message") return [];
      return event.item.messageId ? [event.item.messageId] : [];
    });
    expect(new Set(userIds).size).toBe(1_030);
    expect(new Set(assistantIds).size).toBe(1_030);
    expect(userIds.some((id) => id.includes("entry-0"))).toBe(false);
    expect(assistantIds.some((id) => id.includes("repeated-native-response"))).toBe(false);
    await connection.close();
  });

  test("does not let delayed tool completion resolve a reused later-turn ID", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "tool-owner-a", "first"));
    first.emit({
      type: "tool_execution_start",
      toolCallId: "reused-tool",
      toolName: "read",
      args: { path: "first.ts" },
    });
    await finishTurn(events, first, firstTurnId);

    const secondTurnId = turnIdFrom(
      await startPrompt(connection, events, "tool-owner-b", "second"),
    );
    const secondBaseline = events.length;
    first.emit({
      type: "tool_execution_start",
      toolCallId: "reused-tool",
      toolName: "read",
      args: { path: "second.ts" },
    });
    first.emit({
      type: "tool_execution_end",
      toolCallId: "reused-tool",
      toolName: "read",
      result: { content: "late first result" },
    });
    expect(events.slice(secondBaseline).filter((event) => event.type === "timeline.item")).toEqual(
      [],
    );
    await finishTurn(events, first, secondTurnId);

    first.emit({ type: "process_exit", error: "restart generation" });
    const thirdTurnId = turnIdFrom(await startPrompt(connection, events, "tool-owner-c", "third"));
    const recovered = sessionAt(runtime, 1);
    const thirdBaseline = events.length;
    recovered.emit({
      type: "tool_execution_start",
      toolCallId: "reused-tool",
      toolName: "read",
      args: { path: "third.ts" },
    });
    recovered.emit({
      type: "tool_execution_end",
      toolCallId: "reused-tool",
      toolName: "read",
      result: { content: "third result" },
    });
    expect(
      events
        .slice(thirdBaseline)
        .filter(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "tool_call" &&
            event.item.name === "read",
        ),
    ).toHaveLength(2);
    await finishTurn(events, recovered, thirdTurnId);
    await connection.close();
  });

  test("keeps contentIndex 0 to 1 to 0 snapshots stable", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-interleaved" },
    });
    const snapshots = [
      {
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reason A" },
        content: [{ type: "thinking", thinking: "Reason A" }],
      },
      {
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer A" },
        content: [
          { type: "thinking", thinking: "Reason A" },
          { type: "text", text: "Answer A" },
        ],
      },
      {
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " revised" },
        content: [
          { type: "thinking", thinking: "Reason A revised" },
          { type: "text", text: "Answer A" },
        ],
      },
    ] as const;
    for (const snapshot of snapshots) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: snapshot.assistantMessageEvent,
        message: {
          role: "assistant",
          content: [...snapshot.content],
          responseId: "response-interleaved",
        },
      });
      await scheduler.flush();
    }

    await finishTurn(events, session, turnId);
    const timelineUpdates = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
        ? [event.item]
        : [],
    );
    const finalById = new Map(timelineUpdates.map((item) => [item.id, item]));
    expect([...finalById.values()]).toEqual([
      {
        type: "reasoning",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:0:reasoning",
        text: "Reason A revised",
      },
      {
        type: "assistant_message",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:1:text",
        messageId: "omp:assistant:1:_rtzMvYnX4Ti",
        text: "Answer A",
      },
    ]);
    await connection.close();
  });

  test("bounds huge and excessive content indices without sparse state", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-bounded" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1_000_000, delta: "huge" },
      message: { role: "assistant", content: [], responseId: "response-bounded" },
    });
    for (let contentIndex = 0; contentIndex <= 64; contentIndex += 1) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex,
          delta: `block-${contentIndex}`,
        },
        message: { role: "assistant", content: [], responseId: "response-bounded" },
      });
    }
    await scheduler.flush();

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "assistant_message"
          ? [event.item]
          : [],
      ),
    ).toEqual(
      Array.from({ length: 64 }, (_, contentIndex) => ({
        type: "assistant_message",
        id: `omp:assistant:1:B7lAkpW__Trl:content:${contentIndex}:text`,
        messageId: "omp:assistant:1:B7lAkpW__Trl",
        text: `block-${contentIndex}`,
      })),
    );
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("accepts image blocks and projects later indexed text", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.redactionValues = ["iVBORw0KGgo="];
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-image" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "after image" },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });
    await scheduler.flush();

    const imageCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "Assistant image images",
    );
    if (imageCarrier?.type !== "timeline.item" || imageCarrier.item.type !== "tool_call") {
      throw new Error("Expected assistant image carrier");
    }
    expect(transformOmpImageToolItem(imageCarrier.item)?.items[0]).toEqual({
      type: "plugin",
      id: imageCarrier.item.callId,
      kind: "omp-images",
      version: 1,
      data: {
        label: "Assistant image",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
      },
    });
    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "assistant_message"
          ? [event.item.text]
          : [],
      ),
    ).toEqual(["after image"]);
    expect(JSON.stringify(events)).not.toContain("data:image");
    const webpData = Buffer.from("RIFF\0\0\0\0WEBP", "binary").toString("base64");
    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 2,
        content: { type: "image", data: webpData, mimeType: "image/webp" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "after image" },
          { type: "image", data: webpData, mimeType: "image/webp" },
        ],
      },
    });
    await scheduler.flush();
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "error",
        id: "omp:assistant:1:-588CG_nYBzM:content:2:image:error",
        message: "OMP image uses WebP, which is not supported on every Paseo client",
      },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("waits for a native identity before publishing an assistant stream", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Draft" },
      message: { role: "assistant", content: [{ type: "text", text: "Draft" }] },
    });
    await scheduler.flush();
    expect(
      events.some(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toBe(false);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " final" },
      message: {
        role: "assistant",
        responseId: "response-late",
        content: [{ type: "text", text: "Draft final" }],
      },
    });
    await scheduler.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          id: "omp:assistant:2:DP-A_9m7gBMN:content:0:text",
          messageId: "omp:assistant:2:DP-A_9m7gBMN",
          text: "Draft final",
        }),
      }),
    );
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("correlates equal user text to distinct native entry IDs", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "same-1", "repeat"));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "entry-repeat-1" },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "same-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "repeat" }] },
      },
    });
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "same-2",
    );
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "entry-repeat-2" },
    });

    const userItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(userItems).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "same-1",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "same-2",
      }),
    ]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("keeps one user bubble through hidden notices and mid-turn steering", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const promptResult = await startPrompt(connection, events);
    const turnId = turnIdFrom(promptResult);
    const session = sessionAt(runtime);
    session.branchMessages = [{ entryId: "entry-user-1", text: "hello" }];
    const hiddenNotice = {
      type: "message_end" as const,
      message: {
        role: "custom",
        content: "Mounted development tools",
        customType: "xdev-mount-notice",
        display: false,
      },
    };
    session.emit(hiddenNotice);
    session.emit({
      type: "notice",
      id: "notice-before-echo",
      level: "info",
      message: "Background setup finished",
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "normalized echo", id: "generic-message-id" },
    });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "client-1",
    );
    session.emit({
      type: "tool_execution_start",
      toolCallId: "active-tool",
      toolName: "read",
      args: { path: "active.ts" },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-1",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    const steerResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-1",
    );
    session.emit({
      type: "tool_execution_update",
      toolCallId: "active-tool",
      toolName: "read",
      partialResult: { content: "still active." },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "active-tool",
      toolName: "read",
      result: { content: "done" },
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "duplicate", entryId: "entry-user-1" },
    });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "focus", entryId: "entry-steer-1" },
    });
    const terminal = await finishTurn(events, session, turnId);
    const correlatedUsers = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(correlatedUsers).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "client-1",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "steer-1",
      }),
    ]);
    expect(correlatedUsers.some((item) => item.id === "generic-message-id")).toBe(false);

    expect(steerResult).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));
    expect(
      events.filter(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-1",
      ),
    ).toHaveLength(1);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "started",
      ),
    ).toHaveLength(1);
    const activeToolSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.id === "omp:tool:1"
        ? [event.item]
        : [],
    );
    expect(activeToolSnapshots).toEqual([
      expect.objectContaining({
        status: "running",
        detail: { type: "read", filePath: "active.ts" },
      }),
      expect.objectContaining({
        status: "running",
        detail: { type: "read", filePath: "active.ts", content: "still active." },
      }),
      expect.objectContaining({
        status: "completed",
        detail: { type: "read", filePath: "active.ts", content: "done" },
      }),
    ]);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    for (const clientMessageId of ["client-1", "steer-1"]) {
      expect(
        events.filter(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "user_message" &&
            event.item.clientMessageId === clientMessageId,
        ),
      ).toHaveLength(1);
    }

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "too late" }] },
      },
    });
    const rejected = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-2",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    expect(session.steers).toEqual(["focus"]);
    await connection.close();
  });

  test("delivers child-finish-style steering without aborting or replacing the turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const childNotice = "Child agent finished: review complete";
    const baseline = events.length;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "child-finish-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: childNotice }] },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "child-finish-steer",
    );

    expect(events.slice(baseline)).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "child-finish-steer",
        result: { type: "steer", turnId },
      },
    ]);
    expect(session.steers).toEqual([childNotice]);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "started",
      ),
    ).toEqual([{ type: "session.turn", sessionId: "session-1", turnId, state: "started" }]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("keeps accepted steer work after an earlier agent_end", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "hello", entryId: "entry-before-steer" },
    });
    const baseline = events.length;
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "accepted-after-end",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "continue" }] },
      },
    });
    await steerObserved.promise;
    session.emit({
      type: "message_end",
      message: { role: "user", content: "continue", entryId: "entry-accepted-steer" },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(events.slice(baseline)).toEqual([]);

    steerGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "accepted-after-end",
    );
    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "accepted-after-end",
      result: { type: "steer", turnId },
    });
    session.emit({ type: "agent_start" });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "post-steer-tool",
      toolName: "read",
      args: { path: "after.ts" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "post-steer-tool",
      toolName: "read",
      partialResult: { content: "partial" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "post-steer-tool",
      toolName: "read",
      result: { content: "done" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "continued" },
      message: {
        role: "assistant",
        responseId: "response-after-steer",
        content: [{ type: "text", text: "continued" }],
      },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(events.slice(baseline).filter((event) => event.type === "timeline.item")).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "user_message",
          id: expect.stringMatching(/^omp:user:\d+:/u),
          messageId: expect.stringMatching(/^omp:user:\d+:/u),
          clientMessageId: "accepted-after-end",
          text: "continue",
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "tool_call",
          id: "omp:tool:1",
          callId: "omp:tool:1",
          name: "read",
          detail: { type: "read", filePath: "after.ts" },
          status: "running",
          error: null,
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "tool_call",
          id: "omp:tool:1",
          callId: "omp:tool:1",
          name: "read",
          detail: { type: "read", filePath: "after.ts", content: "partial" },
          status: "running",
          error: null,
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "tool_call",
          id: "omp:tool:1",
          callId: "omp:tool:1",
          name: "read",
          detail: { type: "read", filePath: "after.ts", content: "done" },
          status: "completed",
          error: null,
        },
      },
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "assistant_message",
          id: "omp:assistant:1:fu4akAEZQMwl:content:0:text",
          messageId: "omp:assistant:1:fu4akAEZQMwl",
          text: "continued",
        },
      },
    ]);
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    await connection.close();
  });

  test("ignores the local-only timer while native steering is pending", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(await startPrompt(connection, events, "local-race", "work"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "work", entryId: "entry-local-race" },
    });
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;
    const baseline = events.length;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "early-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    await steerObserved.promise;
    await scheduler.flush();
    expect(events.slice(baseline)).toEqual([]);

    session.emit({
      type: "message_end",
      message: { role: "user", content: "focus", entryId: "entry-early-steer" },
    });
    expect(events.slice(baseline)).toEqual([]);
    steerGate.resolve();
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "early-steer",
    );

    expect(events.slice(baseline)).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "user_message",
          id: expect.stringMatching(/^omp:user:\d+:/u),
          messageId: expect.stringMatching(/^omp:user:\d+:/u),
          clientMessageId: "early-steer",
          text: "focus",
        },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "early-steer",
        result: { type: "steer", turnId },
      },
    ]);
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false });
    await scheduler.flush();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    session.emit({ type: "agent_start" });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("cancels local-only completion when the current-turn user echo arrives", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    session.branchMessages = [{ entryId: "entry-local-evidence", text: "work" }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "local-evidence", "work"));
    session.emit({
      type: "message_end",
      message: { role: "user", content: "work", entryId: "entry-local-evidence" },
    });
    await scheduler.flush();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("discards an early steer echo when native steering rejects", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "hello", entryId: "entry-before-reject" },
    });
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;
    session.steerError = new Error("rejected");
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "rejected-early",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "do not show" }] },
      },
    });
    await steerObserved.promise;
    session.emit({
      type: "message_end",
      message: { role: "user", content: "do not show", entryId: "entry-rejected" },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    steerGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "rejected-early",
    );

    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "rejected-early",
      result: { type: "failed", error: { message: "OMP steer failed" } },
    });
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "rejected-early",
      ),
    ).toBe(false);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    await connection.close();
  });

  test("rejects steering while a terminal agent event waits for user correlation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-delayed", text: "hello" }];
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "terminalizing-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "too late" }] },
      },
    });
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "terminalizing-steer",
    );
    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "terminalizing-steer",
      result: {
        type: "failed",
        error: { message: "There is no active OMP turn to steer" },
      },
    });
    expect(session.steers).toEqual([]);

    branchGate.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    await connection.close();
  });

  test("preserves both queued branch IDs when terminal arrives before lookup", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "repeat-1", "repeat"));
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [
      { entryId: "entry-repeat-1", text: "repeat" },
      { entryId: "entry-repeat-2", text: "repeat" },
    ];
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "repeat-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "repeat" }] },
      },
    });
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "repeat-2",
    );
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);

    branchGate.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "repeat-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "repeat-2",
        text: "repeat",
      },
    ]);
    expect(terminal).toEqual({
      type: "session.turn",
      sessionId: "session-1",
      turnId,
      state: "completed",
    });
    expect(session.branchMessageLookups).toBe(1);
    await connection.close();
  });

  test("drains duplicate entry-less echoes before terminal fallback", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "queued-1", "repeat"));
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-queued-1", text: "repeat" }];
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "queued-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "repeat" }] },
      },
    });
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "queued-2",
    );
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    session.emit({
      type: "message_end",
      message: { role: "user", content: "repeat", entryId: "entry-queued-2" },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    branchGate.resolve();
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "queued-2",
    );
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    const users = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(users).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "queued-1",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "queued-2",
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("does not let a surplus branch entry cross turn ownership", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.branchMessages = [
      { entryId: "entry-owned-1", text: "repeat" },
      { entryId: "entry-surplus", text: "repeat" },
    ];
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "owner-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "owner-1",
    );
    await finishTurn(events, session, firstTurnId);

    session.branchMessages = [
      { entryId: "entry-owned-1", text: "repeat" },
      { entryId: "entry-surplus", text: "repeat" },
      { entryId: "entry-owned-2", text: "repeat" },
    ];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "owner-2", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "owner-2",
    );
    await finishTurn(events, session, secondTurnId);

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "owner-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: expect.stringMatching(/^omp:user:\d+:/u),
        messageId: expect.stringMatching(/^omp:user:\d+:/u),
        clientMessageId: "owner-2",
        text: "repeat",
      },
    ]);
    expect(session.branchMessageLookups).toBe(2);
    await connection.close();
  });

  test("fails closed until a fresh catalog permits nonexistent path prose", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.commandDiscoveryError = new Error("commands unavailable");
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const pathProse = "/definitely/not/a/real/path is missing";

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "slash-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/help" }] },
      },
    });
    const unavailableCommand = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "slash-steer",
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "unavailable-path",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: pathProse }] },
      },
    });
    const unavailablePath = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "unavailable-path",
    );
    expect([unavailableCommand, unavailablePath]).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "slash-steer",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "unavailable-path",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
    ]);
    expect(session.steers).toEqual([]);

    session.availableCommandsError = null;
    session.availableCommands = [{ name: "fresh-command", aliases: ["fresh"] }];
    session.emit({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "path-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: pathProse }] },
      },
    });
    const pathResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "path-steer",
    );
    expect(pathResult).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "path-steer",
      result: { type: "steer", turnId },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "refreshed-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/fresh:now" }] },
      },
    });
    const refreshedResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "refreshed-command",
    );
    expect(refreshedResult).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "refreshed-command",
      result: { type: "steer", turnId },
    });
    expect(session.availableCommandLookups).toBe(5);
    expect(session.steers).toEqual([pathProse, "/fresh:now"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("refreshes stale catalogs before allowing unknown slash prose", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [{ name: "old-command" }];
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.availableCommands = [{ name: "new-command" }];

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "stale-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/new-command now" }] },
      },
    });
    const refreshed = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "stale-command",
    );

    session.availableCommands = [];
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "unknown-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/unknown now" }] },
      },
    });
    const unknown = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "unknown-command",
    );

    expect([refreshed, unknown]).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "stale-command",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "unknown-command",
        result: { type: "steer", turnId },
      },
    ]);
    expect(session.availableCommandLookups).toBe(3);
    expect(session.steers).toEqual(["/unknown now"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("does not retarget a steer after deferred command discovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "turn-a", "first"));
    const discoveryGate = Promise.withResolvers<void>();
    const discoveryObserved = Promise.withResolvers<void>();
    session.availableCommands = [];
    session.availableCommandsGate = discoveryGate.promise;
    session.availableCommandsObserved = discoveryObserved.resolve;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "delayed-path-steer",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "/not-a-command continue" }],
        },
      },
    });
    await discoveryObserved.promise;
    await finishTurn(events, session, firstTurnId);
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "turn-b", "second"));

    discoveryGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "delayed-path-steer",
    );
    expect(result).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "delayed-path-steer",
      result: {
        type: "failed",
        error: { message: "There is no active OMP turn to steer" },
      },
    });
    expect(session.steers).toEqual([]);
    await finishTurn(events, session, secondTurnId);
    await connection.close();
  });

  test("replaces the discovered slash catalog authoritatively", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [{ name: "retired-command" }];
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.availableCommands = [{ name: "fresh-command" }];
    session.emit({
      type: "available_commands_update",
      commands: [{ name: "fresh-command" }],
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "former-command-prose",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "/retired-command continue" }],
        },
      },
    });
    const former = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "former-command-prose",
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "replacement-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/fresh-command now" }] },
      },
    });
    const replacement = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "replacement-command",
    );

    expect([former, replacement]).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "former-command-prose",
        result: { type: "steer", turnId },
      },
      {
        type: "session.prompt_result",
        sessionId: "session-1",
        clientMessageId: "replacement-command",
        result: {
          type: "failed",
          error: { message: "OMP slash commands are unavailable while steering" },
        },
      },
    ]);
    expect(session.availableCommandLookups).toBe(2);
    expect(session.steers).toEqual(["/retired-command continue"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("quarantines branch entries after lookup failure before the same text", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.branchMessagesError = new Error("lookup unavailable");
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "lookup-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    const firstTerminal = await finishTurn(events, session, firstTurnId);

    session.branchMessagesError = null;
    session.branchMessages = [
      { entryId: "entry-old", text: "repeat" },
      { entryId: "entry-new", text: "repeat" },
    ];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "lookup-2", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    const secondTerminal = await finishTurn(events, session, secondTurnId);

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: "omp:user:1:local",
        messageId: "omp:user:1:local",
        clientMessageId: "lookup-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: "omp:user:2:local",
        messageId: "omp:user:2:local",
        clientMessageId: "lookup-2",
        text: "repeat",
      },
    ]);
    expect([firstTerminal, secondTerminal]).toEqual([
      {
        type: "session.turn",
        sessionId: "session-1",
        turnId: firstTurnId,
        state: "completed",
      },
      {
        type: "session.turn",
        sessionId: "session-1",
        turnId: secondTurnId,
        state: "completed",
      },
    ]);
    await connection.close();
  });

  test("quarantines late branch entries after fallback publication", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "fallback-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    await finishTurn(events, session, firstTurnId);

    session.branchMessages = [{ entryId: "entry-late", text: "repeat" }];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "fallback-2", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    await finishTurn(events, session, secondTurnId);

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
      ),
    ).toEqual([
      {
        type: "user_message",
        id: "omp:user:1:local",
        messageId: "omp:user:1:local",
        clientMessageId: "fallback-1",
        text: "repeat",
      },
      {
        type: "user_message",
        id: "omp:user:2:local",
        messageId: "omp:user:2:local",
        clientMessageId: "fallback-2",
        text: "repeat",
      },
    ]);
    await connection.close();
  });

  test("emits nothing from a delayed entry lookup after session-only close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-after-close", text: "hello" }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "closing-lookup", "hello"));
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    const closeBaseline = events.length;
    await connection.send({
      type: "session.close",
      requestId: "close-delayed-lookup",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-delayed-lookup",
    );
    expect(events.slice(closeBaseline)).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "user_message",
          id: "omp:user:1:local",
          messageId: "omp:user:1:local",
          clientMessageId: "closing-lookup",
          text: "hello",
        },
      },
      {
        type: "session.turn",
        sessionId: "session-1",
        turnId,
        state: "canceled",
      },
      { type: "session.closed", sessionId: "session-1" },
      { type: "request.completed", requestId: "close-delayed-lookup" },
    ]);

    const closedBaseline = events.length;
    branchGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.slice(closedBaseline)).toEqual([]);
    await connection.close();
  });

  test("completes a correlated local-only prompt exactly once", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;
    session.promptEvents = [
      { type: "command_output", text: "first" },
      { type: "command_output", text: " second" },
      { type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false },
    ];

    const result = await startPrompt(connection, events, "local-1", "/help");
    const turnId = turnIdFrom(result);
    expect(scheduler.delays).toContain(5_000);
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ id: `omp:command:${turnId}`, text: "first second" }),
      }),
    );
    await connection.close();
  });

  test("keeps a missing prompt acknowledgement unknown and preserves buffered true result", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true }];
    const result = await startPrompt(connection, events, "dataless-1", "local command");
    const turnId = turnIdFrom(result);

    expect(scheduler.delays).not.toContain(5_000);
    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    await finishTurn(events, session, turnId);

    await connection.close();
  });
  test("keeps buffered positive acknowledgement authoritative over a false prompt result", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = true;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "buffered-positive", "work"));

    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("cancels local-only completion when a turn-scoped permission appears", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-evidence", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "permission-evidence",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected permission");
    expect(permission.request.input).toEqual({
      questions: [
        {
          header: "Continue",
          question: "Proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    });
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...permission.request, provider: "omp" }),
    ).not.toThrow();

    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: { answers: { Continue: "Yes" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === permission.request.id,
    );
    session.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "permission-evidence", content: "Continuing" },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });
  test("reconciles complete buffered turns before true false and missing acknowledgements", async () => {
    for (const acknowledgement of [true, false, undefined]) {
      const { connection, events, runtime } = await createHarness();
      await openSession(connection, events);
      const session = sessionAt(runtime);
      session.promptAgentInvoked = acknowledgement;
      session.promptEvents = [
        {
          type: "message_end",
          message: {
            role: "user",
            content: "work",
            entryId: `buffered-user-${String(acknowledgement)}`,
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            responseId: `buffered-${String(acknowledgement)}`,
            content: "Buffered response",
          },
        },
        {
          type: "agent_end",
          messages: [{ role: "assistant", content: "Buffered response" }],
          isTerminal: true,
        },
      ];
      const result = await startPrompt(
        connection,
        events,
        `buffered-${String(acknowledgement)}`,
        "work",
      );
      const turnId = turnIdFrom(result);
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
        ),
      ).toHaveLength(1);
      await connection.close();
    }
  });

  test("cleans pending and in-flight permissions when prompt acknowledgement rejects", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptGate = Promise.withResolvers<void>();
    const promptObserved = Promise.withResolvers<void>();
    session.promptGate = promptGate.promise;
    session.promptObserved = promptObserved.resolve;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "reject-with-permission",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "work" }] },
      },
    });
    await promptObserved.promise;
    session.emit({
      type: "extension_ui_request",
      id: "prompt-reject-ui",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected permission");
    const responseGate = Promise.withResolvers<void>();
    const responseObserved = Promise.withResolvers<void>();
    session.extensionUiResponseGate = responseGate.promise;
    session.extensionUiResponseObserved = responseObserved.resolve;
    const permissionResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await responseObserved.promise;
    promptGate.reject(new Error("prompt rejected"));
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "reject-with-permission" &&
        event.result.type === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    responseGate.resolve();
    await permissionResponse;
    await Promise.resolve();
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    await connection.close();
  });

  test("fails an acknowledged turn on a late correlated scheduling error", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptEvents = [
      { type: "prompt_error", id: "rpc-prompt-1", error: "OMP prompt scheduling failed" },
    ];
    const result = await startPrompt(connection, events, "late-error", "work");
    const turnId = turnIdFrom(result);
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(
      expect.objectContaining({ error: { message: "OMP prompt scheduling failed" } }),
    );
    await connection.close();
  });
  test("quarantines timed-out prompt ownership before accepting another turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const stale = sessionAt(runtime);
    stale.promptError = new Error("OMP RPC request timed out");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "timed-out-prompt",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "first" }] },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "timed-out-prompt" &&
        event.result.type === "failed",
    );
    expect(stale.closes).toBe(1);

    const nextTurn = turnIdFrom(await startPrompt(connection, events, "after-timeout", "second"));
    const staleBaseline = events.length;
    stale.emit({
      type: "extension_ui_request",
      id: "stale-question",
      method: "confirm",
      title: "Stale",
      message: "Wrong turn",
    });
    stale.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "stale", content: "late first response" },
    });
    stale.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "late first response" }],
      isTerminal: true,
    });
    await Promise.resolve();
    expect(events.slice(staleBaseline)).toEqual([]);

    const current = sessionAt(runtime, 1);
    current.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "current", content: "second response" },
    });
    await finishTurn(events, current, nextTurn);
    await connection.close();
  });
  test("cancels local-only completion when native activity starts", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = undefined;

    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false }];
    const result = await startPrompt(connection, events, "activity-1", "work");
    const turnId = turnIdFrom(result);

    session.emit({ type: "agent_start" });
    await scheduler.flush();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    const terminal = await finishTurn(events, session, turnId);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("fails an active turn without terminalizing the host session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "failed-1", "work");
    const turnId = turnIdFrom(result);
    const session = sessionAt(runtime);

    session.emit({ type: "process_exit", error: "OMP exited with code 7" });
    expect(events.filter((event) => event.type === "session.runtime_failed")).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    await connection.close();
  });
  test("real Paseo provider host keeps a recovered session reachable", async () => {
    const runtime = new FakeOmpRuntime();
    const registration = createOmpProvider({
      runtime,
      timelineScheduler: new ManualScheduler(),
      environment: TEST_RUNTIME_ENV,
    });
    // Static imports resolve the host's incompatible Node/Zod declaration graph in this package.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const client = registry.clients()[registration.id];
    if (!client) throw new Error("registered OMP client is missing");
    const config: HostSessionConfig = {
      provider: registration.id,
      cwd: "/repo",
      model: MODEL_PUBLIC_ID,
      mcpServers: {},
      modeId: "full",
      thinkingOptionId: "medium",
      featureValues: {},
    };
    const launchContext: HostLaunchContext = { env: { TEST_ENV: "test-value" } };
    let session: HostSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      session = await client.createSession(config, launchContext, { persistSession: false });
      const sessionId = session.id;
      const terminals: HostTerminalEvent[] = [];
      const firstTerminal = Promise.withResolvers<HostTerminalEvent>();
      const secondTerminal = Promise.withResolvers<HostTerminalEvent>();
      let firstTurnId: string | undefined;
      let secondTurnId: string | undefined;
      unsubscribe = session.subscribe((event) => {
        if (
          event.type !== "turn_failed" &&
          event.type !== "turn_completed" &&
          event.type !== "turn_canceled"
        ) {
          return;
        }
        const terminal = event as HostTerminalEvent;
        terminals.push(terminal);
        if (terminal.turnId === firstTurnId) firstTerminal.resolve(terminal);
        if (terminal.turnId === secondTurnId) secondTerminal.resolve(terminal);
      });

      const first = await session.startTurn("work", { clientMessageId: "host-first" });
      firstTurnId = first.turnId;
      sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited" });
      await expect(firstTerminal.promise).resolves.toEqual(
        expect.objectContaining({ type: "turn_failed", turnId: first.turnId }),
      );

      const second = await session.startTurn("continue", { clientMessageId: "host-recovered" });
      secondTurnId = second.turnId;
      expect(session.id).toBe(sessionId);
      expect(runtime.starts[1]).toEqual(
        expect.objectContaining({ resumeSessionId: "native-session" }),
      );
      establishTerminalOwnership(sessionAt(runtime, 1));
      sessionAt(runtime, 1).emit({ type: "agent_end", messages: [], isTerminal: true });
      await expect(secondTerminal.promise).resolves.toEqual(
        expect.objectContaining({ type: "turn_completed", turnId: second.turnId }),
      );
      for (const turnId of [first.turnId, second.turnId]) {
        expect(terminals.filter((event) => event.turnId === turnId)).toHaveLength(1);
      }
      expect(terminals.some((event) => event.turnId === undefined)).toBe(false);
    } finally {
      unsubscribe?.();
      await session?.close();
      await registry.shutdown();
    }
  });
  test("serializes anonymous compactions through the Paseo provider reducer", async () => {
    const runtime = new FakeOmpRuntime();
    const registration = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    // Static imports resolve the host's incompatible Node/Zod declaration graph in this package.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const client = registry.clients()[registration.id];
    if (!client) throw new Error("registered OMP client is missing");
    let session: HostSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      session = await client.createSession(
        {
          provider: registration.id,
          cwd: "/repo",
          model: MODEL_PUBLIC_ID,
          mcpServers: {},
          modeId: "full",
          thinkingOptionId: "medium",
          featureValues: {},
        },
        { env: { TEST_ENV: "test-value" } },
        { persistSession: false },
      );
      const timeline: HostTimelineItem[] = [];
      unsubscribe = session.subscribe((event) => {
        if (event.type === "timeline" && event.item) timeline.push(event.item);
      });
      const native = sessionAt(runtime);
      native.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
      native.emit({
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      });
      native.emit({
        type: "auto_compaction_end",
        action: "context-full",
        aborted: false,
        willRetry: false,
      });
      native.emit({
        type: "auto_compaction_end",
        action: "remote",
        aborted: false,
        willRetry: false,
      });
      native.emit({ type: "compaction_start" });
      native.emit({ type: "compaction_end", aborted: false, willRetry: false });
      await Promise.resolve();

      expect(timeline.filter((item) => item.type === "compaction")).toEqual([
        { type: "compaction", status: "loading", trigger: "auto" },
        { type: "compaction", status: "completed", trigger: "auto" },
        { type: "compaction", status: "loading", trigger: "manual" },
        { type: "compaction", status: "completed", trigger: "manual" },
      ]);
      expect(timeline).toContainEqual({
        type: "error",
        message: "OMP emitted overlapping compactions",
      });
    } finally {
      unsubscribe?.();
      await session?.close();
      await registry.shutdown();
    }
  });
  test("keeps host permission pending when native dispatch fails", async () => {
    const runtime = new FakeOmpRuntime();
    const registration = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    // Static imports resolve the host's incompatible Node/Zod declaration graph in this package.
    const adapter = (await import(pluginProviderModulePath)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const client = registry.clients()[registration.id];
    if (!client) throw new Error("registered OMP client is missing");
    let session: HostSession | undefined;
    try {
      session = await client.createSession(
        {
          provider: registration.id,
          cwd: "/repo",
          model: MODEL_PUBLIC_ID,
          mcpServers: {},
          modeId: "full",
          thinkingOptionId: "medium",
          featureValues: {},
        },
        { env: { TEST_ENV: "test-value" } },
        { persistSession: false },
      );
      const native = sessionAt(runtime);
      native.emit({
        type: "extension_ui_request",
        id: "host-retry",
        method: "input",
        title: "Branch",
      });
      const permission = session.getPendingPermissions()[0];
      if (!permission) throw new Error("Expected host permission");
      native.extensionUiResponseError = new Error("write failed");
      await expect(
        session.respondToPermission(permission.id, {
          behavior: "allow",
          selectedActionId: "submit",
          updatedInput: { answers: { Branch: "feature/retry" } },
        }),
      ).rejects.toThrow("write failed");
      expect(session.getPendingPermissions().map((request) => request.id)).toEqual([permission.id]);

      native.extensionUiResponseError = null;
      await session.respondToPermission(permission.id, {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: { answers: { Branch: "feature/retry" } },
      });
      expect(session.getPendingPermissions()).toEqual([]);
      expect(native.extensionUiResponses).toContainEqual({
        type: "extension_ui_response",
        id: "host-retry",
        value: "feature/retry",
      });
    } finally {
      await session?.close();
      await registry.shutdown();
    }
  });

  test("recovers a dead idle runtime by resuming the same native session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);

    first.emit({ type: "process_exit", error: "OMP exited between turns" });
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    const result = await startPrompt(connection, events, "recovered-1", "continue");
    const turnId = turnIdFrom(result);
    const recovered = sessionAt(runtime, 1);
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        model: "anthropic/claude-sonnet-4-5",
        mode: "full",
        thinkingOption: "medium",
        systemPrompt: "Be precise",
        resumeSessionId: "native-session",
      }),
    );
    expect(await finishTurn(events, recovered, turnId)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    await connection.close();
  });
  test("recovers with the native model and thinking selected at open", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "open-default-config",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "open-default-config",
    );
    const baseline = events.length;
    runtime.nextModel = ALTERNATE_MODEL;
    runtime.nextThinkingLevel = "high";
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    const turnId = turnIdFrom(await startPrompt(connection, events, "observed-config", "continue"));
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: "openai/gpt-5.4",
        thinkingOption: "high",
        resumeSessionId: "native-session",
      }),
    );
    expect(events.slice(baseline)).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: ALTERNATE_MODEL_PUBLIC_ID,
          thinkingOption: "high",
        }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("rejects recovery when runtime falls back to another advertised model", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const baseline = events.length;
    runtime.nextModel = ALTERNATE_MODEL;
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "fallback-recovery", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: { message: "OMP session recovery failed" },
        }),
      }),
    );
    expect(sessionAt(runtime, 1).closes).toBe(1);
    expect(events.slice(baseline).some((event) => event.type === "session.config")).toBe(false);
    await connection.close();
  });

  test("ignores stale terminal events from a dead runtime generation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    const staleListener = [...first.listeners][0];
    if (!staleListener) throw new Error("expected native event listener");

    first.emit({ type: "process_exit", error: "OMP killed by SIGKILL" });
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    const result = await startPrompt(connection, events, "generation-2", "continue");
    const turnId = turnIdFrom(result);

    staleListener({ type: "agent_end", messages: [], isTerminal: true });
    staleListener({ type: "turn_end" });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(0);

    await finishTurn(events, sessionAt(runtime, 1), turnId);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("rejects delayed prior-turn activity after true and false B acknowledgements", async () => {
    for (const acknowledgement of [true, false]) {
      const { connection, events, runtime } = await createHarness();
      await openSession(connection, events);
      const session = sessionAt(runtime);
      const firstTurn = turnIdFrom(
        await startPrompt(connection, events, "terminal-owner-a", "first"),
      );
      await finishTurn(events, session, firstTurn);

      session.promptAgentInvoked = acknowledgement;
      const secondTurn = turnIdFrom(
        await startPrompt(connection, events, "terminal-owner-b", "second"),
      );
      const stateLookups = session.stateLookups;
      session.emit({ type: "turn_end" });
      session.emit({
        type: "message_end",
        message: { role: "assistant", responseId: "stale-a", content: "late first output" },
      });
      session.emit({ type: "agent_end", messages: [], isTerminal: true });
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === secondTurn &&
            event.state !== "started",
        ),
      ).toHaveLength(0);
      expect(session.stateLookups).toBe(stateLookups + 1);

      session.emit({ type: "prompt_result", id: "rpc-prompt-2", agentInvoked: true });
      session.emit({
        type: "agent_end",
        messages: [{ role: "assistant", content: "second complete" }],
        isTerminal: true,
      });
      const terminal = await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      );
      expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
      await connection.close();
    }
  });

  test("does not grant terminal ownership to a buffered positive prompt result", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(
      await startPrompt(connection, events, "buffered-owner-a", "first"),
    );
    await finishTurn(events, session, firstTurn);

    session.promptAgentInvoked = true;
    session.promptEvents = [{ type: "prompt_result", id: "rpc-prompt-2", agentInvoked: true }];
    const secondTurn = turnIdFrom(
      await startPrompt(connection, events, "buffered-owner-b", "second"),
    );
    session.promptEvents = [];
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      ),
    ).toHaveLength(0);

    session.emit({ type: "prompt_result", id: "rpc-prompt-2", agentInvoked: true });
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "second complete" }],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("does not derive terminal ownership from a busy stale agent_end", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "busy-owner-a", "first"));
    await finishTurn(events, session, firstTurn);

    const secondTurn = turnIdFrom(await startPrompt(connection, events, "busy-owner-b", "second"));
    session.isStreaming = true;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    session.isStreaming = false;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
      ),
    ).toHaveLength(0);

    establishTerminalOwnership(session);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === secondTurn && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("fails an EPIPE turn once without terminalizing the host session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "epipe-1", "work"));

    sessionAt(runtime).emit({ type: "process_exit", error: "OMP RPC stdin write failed: EPIPE" });
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    await connection.close();
  });

  test("fails a turn when terminal state confirmation times out", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const staleListener = [...session.listeners][0];
    if (!staleListener) throw new Error("expected native event listener");
    const branch = Promise.withResolvers<void>();
    const state = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.stateGate = state.promise;
    const turnId = turnIdFrom(await startPrompt(connection, events, "stuck-state", "work"));

    session.emit({ type: "message_end", message: { role: "user", content: "work" } });
    await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    branch.resolve();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP agent_end state could not be confirmed" },
      }),
    );
    expect(session.closes).toBe(1);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-stuck", "continue"),
    );
    staleListener({ type: "agent_end", messages: [], isTerminal: true });
    staleListener({ type: "turn_end" });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoveredTurn &&
          event.state !== "started",
      ),
    ).toHaveLength(0);
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    state.resolve();
    await connection.close();
  });

  test("fails a turn when terminal state confirmation is unavailable", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branch = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.stateError = new Error("runtime state unavailable");
    const turnId = turnIdFrom(await startPrompt(connection, events, "unavailable-state", "work"));

    session.emit({ type: "message_end", message: { role: "user", content: "work" } });
    await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    branch.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP agent_end state could not be confirmed" },
      }),
    );
    expect(session.closes).toBe(1);
    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-unavailable", "continue"),
    );
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({ resumeSessionId: "native-session" }),
    );
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    await connection.close();
  });

  test("discards an agent_end while the native runtime remains active", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branch = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.isStreaming = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "active-state", "work"));

    session.emit({
      type: "message_end",
      message: { role: "user", content: "work", entryId: "active-user" },
    });
    await Promise.resolve();
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    branch.resolve();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(0);

    session.isStreaming = false;
    establishTerminalOwnership(session);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.some((event) => event.type === "timeline.item" && event.item.type === "user_message"),
    ).toBe(true);
    expect(session.closes).toBe(0);
    await connection.close();
  });

  test("rejects recovery when the initial native session handle is absent", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionIds.push("");
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "missing-handle", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test("fails closed when disposing the old runtime fails", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("native close failed");
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "cleanup-failure", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close().catch(() => undefined);
  });
  test("retains failed replacement cleanup until explicit close reports it", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionIds.push("native-session", "wrong-session");
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    runtime.nextCloseError = new Error("candidate close failed");
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const replacement = await startPrompt(connection, events, "wrong-candidate", "continue");
    expect(replacement).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(2);
    const blocked = await startPrompt(connection, events, "blocked-candidate", "continue");
    expect(blocked).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            message: "OMP session recovery failed",
          }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(2);

    await connection.send({
      type: "session.close",
      requestId: "candidate-close",
      sessionId: "session-1",
    });
    const closeFailure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "candidate-close",
    );
    expect(closeFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    const closed = await events.waitFor((event) => event.type === "session.closed");
    expect(closed).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "candidate-reopen",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "candidate-reopen",
    );
    expect(runtime.starts).toHaveLength(2);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  test("retains failed recovery startup cleanup until explicit close", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    runtime.nextStartError = new OmpCleanupFailure(
      "recovery startup cleanup failed",
      Promise.resolve(),
    );
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    for (const clientMessageId of ["failed-recovery-start", "blocked-recovery-retry"]) {
      const result = await startPrompt(connection, events, clientMessageId, "continue");
      expect(result).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            type: "failed",
            error: expect.objectContaining({ message: "OMP session recovery failed" }),
          }),
        }),
      );
    }
    expect(runtime.starts).toHaveLength(2);

    await connection.send({
      type: "session.close",
      requestId: "failed-recovery-close",
      sessionId: "session-1",
    });
    const closeFailure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "failed-recovery-close",
    );
    expect(closeFailure).toEqual(
      expect.objectContaining({ error: { message: "OMP session close failed" } }),
    );
    expect(runtime.starts).toHaveLength(2);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  test("fails a degraded terminal frame with no outcome messages", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "degraded-1", "work");
    const turnId = turnIdFrom(result);
    establishTerminalOwnership(sessionAt(runtime));
    sessionAt(runtime).emit({ type: "agent_end", messageCount: 1, isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP agent_end omitted terminal messages; outcome is unknown" },
      }),
    );
    await connection.close();
  });

  test("projects safe passive updates outside a turn without wedging the session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);

    session.emit({
      type: "notice",
      id: "notice-idle",
      level: "warning",
      message: "Background task delayed",
    });
    session.emit({
      type: "todo_reminder",
      todos: [{ id: "todo-idle", content: "Wait for background task", status: "blocked" }],
    });
    session.emit({
      type: "extension_ui_request",
      id: "notify-idle",
      method: "notify",
      notifyType: "info",
      message: "Background task resumed",
    });
    session.emit({
      type: "extension_ui_request",
      id: "widget-idle",
      method: "setWidget",
      widgetKey: "status",
    });
    const urlBaseline = events.length;
    session.emit({
      type: "extension_ui_request",
      id: "oauth-url",
      method: "open_url",
      url: "https://auth.example.com/callback?token=secret-token&code=secret-code&state=query-state#secret-fragment",
      instructions: "Authenticate",
    });
    session.emit({
      type: "extension_ui_request",
      id: "safe-url",
      method: "open_url",
      url: "https://docs.example.com/guide",
      instructions: "Documentation",
    });
    session.emit({
      type: "extension_ui_request",
      id: "malformed-url",
      method: "open_url",
      url: "not a URL",
    });
    session.emit({
      type: "extension_ui_request",
      id: "credential-url",
      method: "open_url",
      url: "https://user:password@example.com/private",
    });
    const urlItems = events
      .slice(urlBaseline)
      .flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "notification" ? [event.item] : [],
      );
    expect(urlItems).toEqual([
      {
        type: "notification",
        id: "omp:ui:3",
        level: "info",
        message: "Authenticate\nhttps://auth.example.com/callback",
      },
      {
        type: "notification",
        id: "omp:ui:4",
        level: "info",
        message: "Documentation\nhttps://docs.example.com/guide",
      },
    ]);
    expect(JSON.stringify(urlItems)).not.toMatch(
      /secret-token|secret-code|query-state|secret-fragment|password/u,
    );

    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "notification",
        id: "omp:notice:1",
        level: "warning",
        message: "Background task delayed",
      },
    });
    expect(
      events.filter((event) => event.type === "timeline.item" && event.item.type === "todo"),
    ).toEqual([
      {
        type: "timeline.item",
        sessionId: "session-1",
        item: {
          type: "todo",
          id: "omp:todos",
          items: [
            {
              id: expect.stringMatching(/^omp:todo:/u),
              text: "Wait for background task",
              completed: false,
              status: "pending",
            },
          ],
        },
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          id: "omp:ui:2",
          message: "Background task resumed",
        }),
      }),
    );
    const unsafeLaunchBaseline = events.length;
    session.emit({
      type: "extension_ui_request",
      id: "script-launch-url",
      method: "open_url",
      url: "https://safe.example.com/callback",
      launchUrl: "javascript:alert(1)",
    });
    session.emit({
      type: "extension_ui_request",
      id: "file-launch-url",
      method: "open_url",
      url: "https://safe.example.com/callback",
      launchUrl: "file:///private/oauth-token",
    });
    expect(events).toHaveLength(unsafeLaunchBaseline);
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    const turnId = turnIdFrom(await startPrompt(connection, events, "after-passive", "continue"));
    const terminal = await finishTurn(events, session, turnId);
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("preserves normal output with benign short environment values", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events, "short-env-open", "session-1", {
      DEBUG: "1",
      NODE_ENV: "dev",
    });
    sessionAt(runtime).emit({ type: "notice", level: "info", message: "value 1 in dev" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "notification", message: "value 1 in dev" }),
      }),
    );
    await connection.close();
  });

  test("holds credential markers split within their first three characters", () => {
    const filter = new OmpPublicDataFilter();
    const cases = [
      ["Authorization: Basic header-secret", "Authorization: <redacted>"],
      ["Bearer bearer-secret", "Bearer <redacted>"],
      ["API_KEY=api-secret", "API_KEY=<redacted>"],
      ["password=password-secret", "password=<redacted>"],
      ["private-key=private-secret", "private-key=<redacted>"],
      ["session token=session-secret", "session token=<redacted>"],
      ["ghp_abcdefgh", "<redacted>"],
    ] as const;

    for (const [value, expected] of cases) {
      for (const split of [1, 2, 3]) {
        expect(filter.streamText(value.slice(0, split))).toEqual({ text: "", pending: true });
        expect(filter.streamText(value).text).toBe(expected);
      }
    }
    expect(filter.streamText("normal output").text).toBe("normal output");
    expect(filter.streamText("Aut", true)).toEqual({ text: "Aut", pending: false });
  });

  test("redacts POSIX paths after common delimiters", () => {
    const filter = new OmpPublicDataFilter();
    for (const delimiter of [",", "]", ">", "-"]) {
      expect(filter.text(`prefix${delimiter}/home/private/file`)).toBe(
        `prefix${delimiter}<absolute path>`,
      );
    }
  });

  test("redacts provider-owned timeline payloads and native identifiers", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.redactionValues = ["license-secret", "custom-secret"];
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events, "redacted-open", "session-1", {
      MY_RUNTIME_SECRET: "credential-value-1234",
    });
    const turnId = turnIdFrom(await startPrompt(connection, events, "redacted-prompt", "work"));
    const session = sessionAt(runtime);
    session.emit({
      type: "notice",
      id: "provider-internal-notice-id",
      level: "warning",
      message: "credential-value-1234 at /home/private/config",
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "provider-internal-tool-id",
      toolName: "read",
      args: JSON.parse(
        '{"__proto__":{"polluted":"yes"},"apiKey":"another-secret","/home/private":"first","<absolute path>":"second"}',
      ),
    });
    for (const message of [
      "Authorization=Basic basic-equals-secret",
      "Authorization: Token token-scheme-secret",
      "Authorization: Digest username=user, nonce=digest-nonce; response=digest-response\r\n\tqop=auth\nFollowing line",
      "Authorization=AWS4-HMAC-SHA256 Credential=aws-credential, SignedHeaders=host, Signature=aws-signature\nNext line",
    ]) {
      session.emit({ type: "notice", level: "warning", message });
    }
    session.emit({
      type: "tool_execution_start",
      toolCallId: "credential-value-1234",
      toolName: "write",
      args: { value: "safe" },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      args: { value: "safe" },
    });
    const splitToolBaseline = events.length;
    session.emit({
      type: "tool_execution_update",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      partialResult: { content: "Au" },
    });
    expect(events).toHaveLength(splitToolBaseline);
    session.emit({
      type: "tool_execution_update",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      partialResult: { content: "thorization: Basic tool-secret" },
    });
    expect(events).toHaveLength(splitToolBaseline);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "split-authorization-tool",
      toolName: "auth-write",
      result: { content: "Authorization: Basic tool-secret" },
    });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "credential-value-1234",
      toolName: "write",
      partialResult: { content: "credential-value-" },
    });
    expect(JSON.stringify(events)).not.toContain("credential-value-");
    session.emit({
      type: "tool_execution_update",
      toolCallId: "credential-value-1234",
      toolName: "write",
      partialResult: { content: "1234" },
    });
    expect(JSON.stringify(events)).not.toContain("credential-value-");
    session.emit({
      type: "tool_execution_end",
      toolCallId: "credential-value-1234",
      toolName: "write",
      result: { content: "credential-value-1234" },
    });
    session.emit({
      type: "notice",
      level: "warning",
      message: "Authorization: Bearer token-not-from-env",
    });
    session.emit({
      type: "notice",
      level: "warning",
      message: "Authorization: Basic basic-token-not-from-env",
    });
    session.emit({ type: "notice", level: "warning", message: "license-secret" });
    session.emit({ type: "notice", level: "warning", message: "custom-secret" });
    session.emit({ type: "command_output", text: "credential-value-" });
    expect(JSON.stringify(events)).not.toContain("credential-value-");
    session.emit({ type: "command_output", text: "1234" });
    session.emit({ type: "command_output", text: " g" });
    expect(
      JSON.stringify(events.findLast((event) => event.type === "timeline.item")),
    ).not.toContain(" g");
    session.emit({ type: "command_output", text: "hp_abcdefgh" });
    for (const [type, contentIndex, first, second] of [
      ["text_delta", 1, "Bearer alpha", "beta"],
      ["thinking_delta", 2, "Bearer alpha", "beta"],
      ["text_delta", 3, "credential-value-", "1234"],
      ["thinking_delta", 4, "credential-value-", "1234"],
      ["text_delta", 5, "ghp_abc", "defgh"],
      ["thinking_delta", 6, "Authoriz", "ation: Basic header-secret"],
      ["text_delta", 7, "A", "uthorization: Basic assistant-one"],
      ["thinking_delta", 8, "Au", "thorization: Basic reasoning-two"],
      ["text_delta", 9, "Aut", "horization: Basic assistant-three"],
      ["thinking_delta", 10, "B", "earer bearer-one"],
      ["text_delta", 11, "Be", "arer bearer-two"],
      ["thinking_delta", 12, "Bea", "rer bearer-three"],
      ["text_delta", 13, "g", "hp_abcdefgh"],
      ["thinking_delta", 14, "gh", "p_abcdefgh"],
      ["text_delta", 15, "ghp", "_abcdefgh"],
    ] as const) {
      const splitBaseline = events.length;
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex, delta: first },
        message: { role: "assistant", responseId: "split-stream", content: [] },
      });
      await scheduler.flush();
      expect(JSON.stringify(events.slice(splitBaseline))).not.toContain(first);
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex, delta: second },
        message: { role: "assistant", responseId: "split-stream", content: [] },
      });
      await scheduler.flush();
    }
    const formattedText = "```ts\n\tconst value = 1;\r\n```";
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "whitespace-stream",
        content: [{ type: "text", text: formattedText }],
      },
    });
    await scheduler.flush();
    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "credential-value-1234",
      },
      message: {
        role: "assistant",
        responseId: "provider-internal-response-id",
        content: [{ type: "text", text: "credential-value-1234 from /home/private/file" }],
      },
    });
    await scheduler.flush();

    const visible = JSON.stringify(events);
    expect(visible).not.toContain("credential-value-1234");
    expect(visible).not.toContain("another-secret");
    expect(visible).not.toContain("/home/private");
    expect(visible).not.toContain("provider-internal-notice-id");
    expect(visible).not.toContain("alpha");
    expect(visible).not.toContain("beta");
    expect(visible).not.toContain("alphabeta");
    expect(visible).not.toContain("credential-value-");
    expect(visible).not.toContain("provider-internal-tool-id");
    expect(visible).not.toContain("provider-internal-response-id");
    expect(visible).not.toContain("token-not-from-env");
    expect(visible).not.toContain("basic-token-not-from-env");
    expect(visible).not.toContain("license-secret");
    expect(visible).not.toContain("custom-secret");
    expect(visible).not.toContain("basic-equals-secret");
    expect(visible).not.toContain("token-scheme-secret");
    expect(visible).not.toContain("digest-nonce");
    expect(visible).not.toContain("digest-response");
    expect(visible).not.toContain("aws-credential");
    expect(visible).not.toContain("aws-signature");
    expect(visible).toContain("Following line");
    expect(visible).toContain("Next line");
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === formattedText,
      ),
    ).toBe(true);
    const splitAssistant = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.endsWith(":content:1:text"),
    );
    const splitReasoning = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.id.endsWith(":content:2:reasoning"),
    );
    expect(
      splitAssistant?.type === "timeline.item" && splitAssistant.item.type === "assistant_message"
        ? splitAssistant.item.text
        : null,
    ).toBe("Bearer <redacted>");
    expect(
      splitReasoning?.type === "timeline.item" && splitReasoning.item.type === "reasoning"
        ? splitReasoning.item.text
        : null,
    ).toBe("Bearer <redacted>");
    const literalSplitAssistant = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.endsWith(":content:3:text"),
    );
    const literalSplitReasoning = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.id.endsWith(":content:4:reasoning"),
    );
    expect(
      literalSplitAssistant?.type === "timeline.item" &&
        literalSplitAssistant.item.type === "assistant_message"
        ? literalSplitAssistant.item.text
        : null,
    ).toBe("<redacted>");
    expect(
      literalSplitReasoning?.type === "timeline.item" &&
        literalSplitReasoning.item.type === "reasoning"
        ? literalSplitReasoning.item.text
        : null,
    ).toBe("<redacted>");
    const command = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.startsWith("omp:command:"),
    );
    expect(
      command?.type === "timeline.item" && command.item.type === "assistant_message"
        ? command.item.text
        : null,
    ).toBe("<redacted> <redacted>");
    const streamedTool = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "write" &&
      event.item.detail.type === "unknown"
        ? [event.item.detail.output]
        : [],
    );
    expect(streamedTool).toEqual([null, "<redacted>"]);
    const deferredTool = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.name === "auth-write" &&
      event.item.detail.type === "unknown"
        ? [event.item.detail.output]
        : [],
    );
    expect(deferredTool).toEqual([null, "<redacted>"]);
    const splitToken = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.id.endsWith(":content:5:text"),
    );
    const splitAuthorization = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "reasoning" &&
        event.item.id.endsWith(":content:6:reasoning"),
    );
    expect(
      splitToken?.type === "timeline.item" && splitToken.item.type === "assistant_message"
        ? splitToken.item.text
        : null,
    ).toBe("<redacted>");
    expect(
      splitAuthorization?.type === "timeline.item" && splitAuthorization.item.type === "reasoning"
        ? splitAuthorization.item.text
        : null,
    ).toBe("Authorization: <redacted>");
    const earlySplitSnapshots = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
        ? [event.item]
        : [],
    );
    for (const [contentIndex, itemType, expected] of [
      [7, "assistant_message", "Authorization: <redacted>"],
      [8, "reasoning", "Authorization: <redacted>"],
      [9, "assistant_message", "Authorization: <redacted>"],
      [10, "reasoning", "Bearer <redacted>"],
      [11, "assistant_message", "Bearer <redacted>"],
      [12, "reasoning", "Bearer <redacted>"],
      [13, "assistant_message", "<redacted>"],
      [14, "reasoning", "<redacted>"],
      [15, "assistant_message", "<redacted>"],
    ] as const) {
      const suffix = itemType === "reasoning" ? "reasoning" : "text";
      const snapshot = earlySplitSnapshots.findLast(
        (item) => item.type === itemType && item.id.endsWith(`:content:${contentIndex}:${suffix}`),
      );
      expect(snapshot?.text).toBe(expected);
    }
    const toolIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item.callId] : [],
    );
    expect(new Set(toolIds).size).toBe(3);
    const firstTool = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    if (
      firstTool?.type !== "timeline.item" ||
      firstTool.item.type !== "tool_call" ||
      firstTool.item.detail.type !== "unknown"
    ) {
      throw new Error("Expected sanitized tool item");
    }
    const detailInput = firstTool.item.detail.input;
    if (!detailInput || typeof detailInput !== "object" || Array.isArray(detailInput)) {
      throw new Error("Expected sanitized tool input object");
    }
    expect(Object.getPrototypeOf(detailInput)).toBeNull();
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(Object.keys(detailInput)).toEqual(["apiKey", "<absolute path>"]);
    expect(visible).toContain("<redacted>");
    expect(visible).toContain("<absolute path>");
    await finishTurn(events, session, turnId);
    await connection.close();
  });
  test("bounds aggregate retained bytes across many active tools", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "tool-budget", "work"));
    const session = sessionAt(runtime);
    for (let index = 0; index < 64; index += 1) {
      session.emit({
        type: "tool_execution_start",
        toolCallId: `large-tool-${index}`,
        toolName: "read",
        args: { content: "x".repeat(100 * 1024) },
      });
    }
    const publicTools = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    expect(publicTools.length).toBeGreaterThan(0);
    expect(publicTools.length).toBeLessThan(64);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("preserves a one-MiB UTF-8 snapshot and marks an over-limit display", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "byte-limit", "work"));
    const session = sessionAt(runtime);
    const nearLimit = "é".repeat((1024 * 1024) / 2);
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "near-limit",
        content: [{ type: "text", text: nearLimit }],
      },
    });
    await scheduler.flush();
    const nearEvent = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.text === nearLimit,
    );
    expect(nearEvent).toBeDefined();
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "near-limit",
        content: [{ type: "text", text: `${nearLimit}é` }],
      },
    });
    await scheduler.flush();
    const latest = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(
      latest?.type === "timeline.item" && latest.item.type === "assistant_message"
        ? latest.item.text.endsWith("<truncated>")
        : false,
    ).toBe(true);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("fails unsupported interactive permission UI without reflecting its payload", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-turn", "work"));
    sessionAt(runtime).emit({
      type: "extension_ui_request",
      id: "permission-request",
      method: "confirm",
      title: "Approve API_KEY=secret-value from /home/private/file",
      message: "Continue?",
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP runtime failed" } }),
    );
    const visible = JSON.stringify(events);
    expect(visible).not.toContain("secret-value");
    expect(visible).not.toContain("/home/private/file");
    expect(visible).not.toContain("permission-request");
    await connection.close();
  });

  test("interrupts and emits one terminal turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const promptResult = await startPrompt(connection, events);
    const turnId = turnIdFrom(promptResult);
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-1",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "interrupt-1",
    );
    const terminal = await finishTurn(events, session, turnId);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });

    expect(session.aborts).toBe(1);
    expect(terminal).toEqual(expect.objectContaining({ state: "canceled" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });
  test("does not start a later turn while an earlier abort is unsettled", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortObserved = observed.resolve;
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "abort-first", "first"));

    await connection.send({
      type: "session.interrupt",
      requestId: "abort-first",
      sessionId: "session-1",
    });
    await observed.promise;
    await finishTurn(events, session, firstTurn);
    const blocked = await startPrompt(connection, events, "abort-blocked", "second");
    expect(blocked).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: { message: "OMP interrupt is still settling" },
        }),
      }),
    );
    expect(session.prompts).toEqual(["first"]);

    abort.resolve();
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "abort-first",
    );
    const secondTurn = turnIdFrom(await startPrompt(connection, events, "abort-second", "second"));
    await connection.send({
      type: "session.interrupt",
      requestId: "abort-second",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "abort-second",
    );
    await finishTurn(events, session, secondTurn);
    expect(session.aborts).toBe(2);
    await connection.close();
  });
  test("reports the same abort failure to concurrent interrupts", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortObserved = observed.resolve;
    session.abortError = new Error("abort rejected");
    await startPrompt(connection, events, "abort-error-turn", "work");

    await connection.send({
      type: "session.interrupt",
      requestId: "abort-error-one",
      sessionId: "session-1",
    });
    await observed.promise;
    await connection.send({
      type: "session.interrupt",
      requestId: "abort-error-two",
      sessionId: "session-1",
    });
    const firstFailure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "abort-error-one",
    );
    const secondFailure = events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "abort-error-two",
    );
    abort.resolve();
    const [first, second] = await Promise.all([firstFailure, secondFailure]);
    expect(first).toEqual(expect.objectContaining({ error: { message: "OMP interrupt failed" } }));
    expect(second).toEqual(expect.objectContaining({ error: { message: "OMP interrupt failed" } }));
    await connection.close();
  });
  test("serializes interrupt and close while awaiting runtime disposal", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const abort = Promise.withResolvers<void>();
    const abortObserved = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    session.abortGate = abort.promise;
    session.abortObserved = abortObserved.resolve;
    session.closeGate = close.promise;
    const turnId = turnIdFrom(await startPrompt(connection, events, "interrupt-close", "work"));

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-race",
      sessionId: "session-1",
    });
    await abortObserved.promise;
    const closing = connection.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    abort.resolve();
    close.resolve();
    await closing;
    expect(session.aborts).toBe(1);
    expect(session.closes).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "canceled" })]);
  });
  test("reports native close rejection to an explicit close request", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("native close failed");

    await connection.send({
      type: "session.close",
      requestId: "close-failure",
      sessionId: "session-1",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "close-failure",
    );
    const closed = await events.waitFor((event) => event.type === "session.closed");
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    expect(closed).toEqual(
      expect.objectContaining({
        error: { message: "OMP session close failed" },
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "reopen-after-close-failure",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "reopen-after-close-failure",
    );
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).resolves.toBeUndefined();
  });
  test("retains failed initialization cleanup ownership and blocks same-ID reopen", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableModels = [];
    runtime.nextCloseError = new Error("initial cleanup failed");
    const { connection, events } = await createHarness(runtime);
    await connection.send({
      type: "session.open",
      requestId: "failed-initial-open",
      sessionId: "failed-initial-session",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "failed-initial-open",
    );
    await connection.send({
      type: "session.open",
      requestId: "blocked-reopen",
      sessionId: "failed-initial-session",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "blocked-reopen",
    );
    expect(runtime.starts).toHaveLength(1);
    await expect(connection.close()).resolves.toBeUndefined();
  });
  test("tombstones OmpRpcRuntime startup cleanup failures", async () => {
    let starts = 0;
    const runtime = new OmpRpcRuntime({
      spawnProcess() {
        starts += 1;
        const child = new ProviderRpcChild(() => {});
        queueMicrotask(() => child.write({ type: "ready", protocolVersion: 1 }));
        return child.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(false),
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    for (const requestId of ["startup-failure", "blocked-startup-reopen"]) {
      await connection.send({
        type: "session.open",
        requestId,
        sessionId: "startup-failure-session",
        config: {
          cwd: "/repo",
          env: { TEST_ENV: "test-value" },
          mcpServers: {},
          model: MODEL_PUBLIC_ID,
          mode: "full",
          settings: {},
          persist: false,
        },
        history: "skip",
      });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    expect(starts).toBe(1);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  test("close during open waits for the created runtime session cleanup", async () => {
    const runtime = new FakeOmpRuntime();
    const start = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    runtime.startGate = start.promise;
    runtime.startObserved = observed.resolve;
    const { connection, events } = await createHarness(runtime);

    await connection.send({
      type: "session.open",
      requestId: "open-race",
      sessionId: "session-race",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await observed.promise;
    const closing = connection.close();
    start.resolve();
    await closing;

    expect(sessionAt(runtime).closes).toBe(1);
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
  });

  test("close during an active prompt waits and cancels exactly one turn", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptResult = await startPrompt(connection, events, "closing-prompt", "wait");
    const turnId = turnIdFrom(promptResult);

    await connection.close();

    const turns = events.filter(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(turns).toEqual([expect.objectContaining({ state: "canceled" })]);
    expect(session.closes).toBe(1);
  });

  test("close waits for a deferred prompt acceptance", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const promptGate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.promptGate = promptGate.promise;
    session.promptObserved = observed.resolve;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "pending-close",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "wait" }] },
      },
    });
    await observed.promise;
    const closing = connection.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    promptGate.resolve();
    await closing;

    expect(
      events.filter(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "pending-close",
      ),
    ).toEqual([expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) })]);
  });

  test("concurrent connection closes await one deferred disposal", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const closeGate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.closeGate = closeGate.promise;
    session.closeObserved = observed.resolve;

    const first = connection.close();
    const second = connection.close();
    await observed.promise;
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    closeGate.resolve();
    await Promise.all([first, second]);

    expect(session.closes).toBe(1);
  });

  test("reports native steer failures while a turn remains active", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    await startPrompt(connection, events);
    const session = sessionAt(runtime);
    session.steerError = new Error("steer transport failed");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-failed",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "focus" }] },
      },
    });
    const result = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "steer-failed",
    );

    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    await connection.close();
  });

  test("bounds concurrent session opens before starting excess runtimes", async () => {
    const runtime = new FakeOmpRuntime();
    const gate = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    const { connection, events } = await createHarness(runtime);
    for (let index = 0; index < 33; index += 1) {
      await connection.send({
        type: "session.open",
        requestId: `bounded-open-${index}`,
        sessionId: `bounded-session-${index}`,
        config: {
          cwd: "/repo",
          env: { TEST_ENV: "test-value" },
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: false,
        },
        history: "skip",
      });
    }
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "bounded-open-32",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ error: { message: "OMP session limit reached" } }),
    );
    expect(runtime.starts).toHaveLength(32);
    gate.resolve();
    await connection.close();
  });
  test("bounds connection-wide active operations before dispatch", async () => {
    const runtime = new FakeOmpRuntime();
    const gate = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    const { connection } = await createHarness(runtime);
    for (let index = 0; index < 128; index += 1) {
      await connection.send({ type: "catalog", requestId: `catalog-${index}`, cwd: "/repo" });
    }
    await expect(
      connection.send({ type: "catalog", requestId: "catalog-overflow", cwd: "/repo" }),
    ).rejects.toThrow("busy");
    gate.resolve();
    await connection.close();
  });

  test("retains a closing session ID and fences its late events", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const oldSession = sessionAt(runtime);
    const staleListener = [...oldSession.listeners][0];
    if (!staleListener) throw new Error("Expected native event listener");
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    oldSession.closeGate = gate.promise;
    oldSession.closeObserved = observed.resolve;
    await connection.send({
      type: "session.close",
      requestId: "close-old",
      sessionId: "session-1",
    });
    await observed.promise;
    await connection.send({
      type: "session.open",
      requestId: "open-too-early",
      sessionId: "session-1",
      config: {
        cwd: "/repo",
        env: { TEST_ENV: "test-value" },
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "open-too-early",
    );
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-old",
    );
    await openSession(connection, events, "open-replacement", "session-1");
    const baseline = events.length;
    staleListener({ type: "notice", level: "error", message: "stale-secret" });
    expect(events).toHaveLength(baseline);
    expect(runtime.starts).toHaveLength(2);
    await connection.close();
  });

  test("preserves late terminal data and isolates secret native IDs", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = Array.from({ length: 129 }, (_, index) => ({
      name: `command-${index}`,
    }));
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events, "secret-open", "session-1", {
      FIRST_SECRET: "secret-native-a",
      SECOND_SECRET: "secret-native-b",
    });
    const turnId = turnIdFrom(await startPrompt(connection, events, "late-terminal", "work"));
    const session = sessionAt(runtime);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "late-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "late command" }] },
      },
    });
    const commandResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "late-command",
    );
    expect(commandResult).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));
    for (const [index, nativeId] of ["secret-native-a", "secret-native-b"].entries()) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `answer-${index}` },
        message: {
          role: "assistant",
          responseId: nativeId,
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
      await scheduler.flush();
    }
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    session.emit({
      type: "agent_end",
      messages: [
        ...Array.from({ length: 128 }, () => ({ role: "assistant", content: "ok" })),
        { role: "assistant", content: "failed", stopReason: "error", errorMessage: "private" },
      ],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    const assistantIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? [event.item.messageId]
        : [],
    );
    expect(new Set(assistantIds).size).toBe(2);
    expect(JSON.stringify(assistantIds)).not.toContain("secret-native");
    expect(terminal).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP assistant turn failed" } }),
    );
    await connection.close();
  });

  test("preserves structural protocol data through OmpRpcRuntime", async () => {
    const nativeSessionId = "native-session-secret";
    const proxyUrl = "https://proxy%2Duser:proxy%2Dpass@example.test?access_token=proxy%2Dtoken";
    const sessionProxyUrl =
      "https://session%2Duser:p%40ss@example.test/session%2Dpath?code=token%2Dvalue#secret%2Dfragment";
    const children: ProviderRpcChild[] = [];
    const launchArgs: string[][] = [];
    const promptRequestIds: string[] = [];
    const runtime = new OmpRpcRuntime({
      spawnProcess(request) {
        launchArgs.push([...request.args]);
        let child: ProviderRpcChild;
        child = new ProviderRpcChild((command) => {
          const type = command.type;
          if (type === "negotiate_protocol") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { protocolVersion: 2 },
            });
          } else if (type === "get_state") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: {
                model: MODEL,
                thinkingLevel: "medium",
                isStreaming: false,
                isCompacting: false,
                sessionId: nativeSessionId,
              },
            });
          } else if (type === "get_available_models") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { models: [MODEL] },
            });
          } else if (type === "get_available_commands") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: {
                commands: [
                  ...Array.from({ length: 129 }, (_, index) => ({ name: `command-${index}` })),
                ],
              },
            });
          } else if (type === "prompt" || type === "steer") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { agentInvoked: true },
            });
            if (type === "prompt") {
              if (typeof command.id === "string") promptRequestIds.push(command.id);
              child.write({ type: "prompt_result", id: command.id, agentInvoked: true });
              child.write({
                type: "tool_execution_start",
                toolCallId: "buffered-large-tool",
                toolName: "read",
                args: Array.from({ length: 513 }, (_, index) => ({
                  a: `buffered-a-${index}`,
                  b: `buffered-b-${index}`,
                  c: `buffered-c-${index}`,
                })),
              });
            }
          } else if (type === "get_branch_messages") {
            child.write({
              type: "response",
              id: command.id,
              success: true,
              data: { messages: [] },
            });
          }
        });
        children.push(child);
        queueMicrotask(() =>
          child.write({
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
        );
        return child.asChildProcess();
      },
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
    });
    const connection = await createOmpProvider({
      runtime,
      environment: { ...TEST_RUNTIME_ENV, HTTPS_PROXY: proxyUrl },
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer", "session.configure"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    await openSession(connection, events, "transport-open", "session-1", {
      NATIVE_SECRET: nativeSessionId,
      ALL_PROXY: sessionProxyUrl,
    });
    children[0]?.write({
      type: "notice",
      level: "warning",
      message: `${proxyUrl} proxy-user proxy-pass proxy-token session%2Duser session-user p%40ss p@ss session%2Dpath session-path token%2Dvalue token-value secret%2Dfragment secret-fragment`,
    });
    const proxyNotice = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "notification",
    );
    expect(proxyNotice).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ message: expect.stringContaining("<redacted>") }),
      }),
    );
    for (const secret of [
      "proxy-user",
      "proxy-pass",
      "proxy-token",
      "session%2Duser",
      "session-user",
      "p%40ss",
      "p@ss",
      "session%2Dpath",
      "session-path",
      "token%2Dvalue",
      "token-value",
      "secret%2Dfragment",
      "secret-fragment",
    ]) {
      expect(JSON.stringify(proxyNotice)).not.toContain(secret);
    }
    const turnId = turnIdFrom(await startPrompt(connection, events, "transport-prompt", "work"));
    const bufferedLargeTool = await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "read" &&
        event.item.status === "running",
    );
    expect(bufferedLargeTool).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ status: "running" }) }),
    );
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "missing-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/command-128" }] },
      },
    });
    const rejected = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "missing-command",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "transport-late-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/late-command" }] },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" &&
        event.clientMessageId === "transport-late-command",
    );
    children[0]?.write({
      type: "tool_execution_start",
      toolCallId: "large-tool",
      toolName: "read",
      args: Array.from({ length: 513 }, (_, index) => `input-${index}`),
    });
    children[0]?.write({
      type: "tool_execution_end",
      toolCallId: "large-tool",
      toolName: "read",
      result: Array.from({ length: 513 }, (_, index) => `output-${index}`),
    });
    const completedTool = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    if (
      completedTool?.type !== "timeline.item" ||
      completedTool.item.type !== "tool_call" ||
      completedTool.item.detail.type !== "unknown" ||
      !Array.isArray(completedTool.item.detail.output)
    ) {
      throw new Error("Expected completed bounded tool output");
    }
    expect(completedTool.item.detail.output).toHaveLength(128);
    children[0]?.write({
      type: "prompt_result",
      id: promptRequestIds[0],
      agentInvoked: true,
    });
    children[0]?.write({
      type: "agent_end",
      messages: [
        ...Array.from({ length: 128 }, () => ({ role: "assistant", content: "ok" })),
        { role: "assistant", content: "failed", stopReason: "error", errorMessage: "private" },
      ],
      isTerminal: true,
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(
      expect.objectContaining({ error: { message: "OMP assistant turn failed" } }),
    );
    children[0]?.write({
      type: "rpc_chunk",
      chunkId: "oversized-runtime-frame",
      index: 0,
      count: 1,
      byteLength: 12 * 1024 * 1024 + 1,
      data: "e30=",
    });
    const recovered = await startPrompt(connection, events, "transport-recovery", "continue");
    expect(recovered).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "turn" }) }),
    );
    const recoveredTurnId = turnIdFrom(recovered);
    children[1]?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children[1]?.write({ type: "agent_start" });
    children[1]?.writeChunked(
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: "é".repeat((1024 * 1024) / 2 + 1) }],
        isTerminal: true,
      },
      "oversized-terminal-text",
    );
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === recoveredTurnId &&
        event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoveredTurnId &&
          event.state !== "started",
      ),
    ).toHaveLength(1);
    const nestedTurn = turnIdFrom(
      await startPrompt(connection, events, "nested-terminal", "continue"),
    );
    children[1]?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children[1]?.write({ type: "agent_start" });
    children[1]?.write({
      type: "agent_end",
      messages: Array.from({ length: 400 }, () => ({
        role: "assistant",
        content: Array.from({ length: 10 }, () => ({ type: "text", text: "x" })),
      })),
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === nestedTurn && event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === nestedTurn && event.state !== "started",
      ),
    ).toHaveLength(1);
    const oversizedEnvelopeTurn = turnIdFrom(
      await startPrompt(connection, events, "oversized-terminal-envelope", "continue"),
    );
    children[1]?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children[1]?.write({ type: "agent_start" });
    children[1]?.write({
      type: "agent_end",
      metadata: Array.from({ length: 1_025 }, () => "x"),
      isTerminal: true,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === oversizedEnvelopeTurn &&
        event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === oversizedEnvelopeTurn &&
          event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    for (const [index, messages] of ["bad", null].entries()) {
      const malformedTurn = turnIdFrom(
        await startPrompt(connection, events, `malformed-terminal-${index}`, "continue"),
      );
      children[1]?.write({
        type: "prompt_result",
        id: promptRequestIds.at(-1),
        agentInvoked: true,
      });
      children[1]?.write({ type: "agent_start" });
      children[1]?.write({ type: "agent_end", messages, isTerminal: true });
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === malformedTurn &&
          event.state === "failed",
      );
      const terminalEvents = events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === malformedTurn &&
          event.state !== "started",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toEqual(expect.objectContaining({ state: "failed" }));
    }
    let recoverableTurn = turnIdFrom(
      await startPrompt(connection, events, "invalid-terminal-scalars-0", "continue"),
    );
    const invalidTerminalFrames = [
      { type: "agent_end", messages: [], isTerminal: 5 },
      { type: "agent_end", messages: [], messageCount: -1, isTerminal: true },
      { type: "agent_end", messages: [], messageCount: "1", isTerminal: true },
    ];
    for (const [index, frame] of invalidTerminalFrames.entries()) {
      children.at(-1)?.write(frame);
      await events.waitFor(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoverableTurn &&
          event.state === "failed",
      );
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === recoverableTurn &&
            event.state !== "started",
        ),
      ).toEqual([expect.objectContaining({ state: "failed" })]);

      const recovered = await startPrompt(
        connection,
        events,
        `after-invalid-terminal-scalars-${index}`,
        "continue",
      );
      recoverableTurn = turnIdFrom(recovered);
      expect(recovered).toEqual(
        expect.objectContaining({ result: expect.objectContaining({ type: "turn" }) }),
      );
      expect(launchArgs[index + 2]).toEqual(expect.arrayContaining(["--resume", nativeSessionId]));
    }

    children.at(-1)?.write({
      type: "agent_end",
      messages: "invalid-nonterminal-payload",
      isTerminal: false,
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === recoverableTurn &&
        event.state === "failed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === recoverableTurn &&
          event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);

    const finalTurn = turnIdFrom(
      await startPrompt(connection, events, "after-invalid-nonterminal", "continue"),
    );
    expect(launchArgs[5]).toEqual(expect.arrayContaining(["--resume", nativeSessionId]));
    children.at(-1)?.write({
      type: "prompt_result",
      id: promptRequestIds.at(-1),
      agentInvoked: true,
    });
    children.at(-1)?.write({ type: "agent_start" });
    children.at(-1)?.write({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === finalTurn && event.state === "completed",
    );
    expect(JSON.stringify(events)).not.toContain(nativeSessionId);
    expect(children).toHaveLength(6);
    await connection.close();
  });

  test("fails closed after one-turn native identity saturation and recovers next turn", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const firstTurn = turnIdFrom(await startPrompt(connection, events, "saturated-turn", "work"));
    for (let index = 0; index < 1_025; index += 1) {
      session.emit({
        type: "message_update",
        message: {
          role: "assistant",
          responseId: `native-${index}`,
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
      await scheduler.flush();
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          responseId: `native-${index}`,
          content: [{ type: "text", text: `answer-${index}` }],
        },
      });
    }
    expect(
      events.filter(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toHaveLength(1_024);
    await finishTurn(events, session, firstTurn);

    const nextTurn = turnIdFrom(
      await startPrompt(connection, events, "after-saturation", "continue"),
    );
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "native-after-saturation",
        content: [{ type: "text", text: "recovered" }],
      },
    });
    await scheduler.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "recovered" }),
      }),
    );
    await finishTurn(events, session, nextTurn);
    await connection.close();
  });

  test("reports an explicit session close failure without completing it", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).closeError = new Error("close failed");

    await connection.send({
      type: "session.close",
      requestId: "close-1",
      sessionId: "session-1",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "close-1",
    );

    expect(failure).toEqual(
      expect.objectContaining({ error: { message: "OMP session close failed" } }),
    );
    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "close-1"),
    ).toBe(false);
    await connection.close().catch(() => undefined);
  });

  test("publishes command metadata and dispatches structured commands and images", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.availableCommands = [
      {
        name: "review",
        aliases: ["rv"],
        description: "Review the current change",
        input: { hint: "[scope]" },
        source: "extension",
      },
      { name: "git:status", description: "Show repository status", source: "extension" },
      { name: "unsafe/name", description: "Unsafe command", source: "extension" },
    ];
    const { connection, events, scheduler } = await createHarness(runtime);
    await openSession(connection, events);
    expect(events).toContainEqual({
      type: "session.commands",
      sessionId: "session-1",
      commands: [
        {
          name: "review",
          description: "Review the current change",
          argumentHint: "[scope]",
        },
        {
          name: "git:status",
          description: "Show repository status",
        },
      ],
    });

    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "structured-command",
        delivery: "auto",
        input: { type: "command", name: "review", arguments: "src" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "structured-command",
    );
    await scheduler.flush();
    expect(session.prompts).toEqual(["/review src"]);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "namespaced-command",
        delivery: "auto",
        input: { type: "command", name: "git:status", arguments: "--short" },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "namespaced-command",
    );
    await scheduler.flush();
    expect(session.prompts).toEqual(["/review src", "/git:status --short"]);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "unsafe-command",
        delivery: "auto",
        input: { type: "command", name: "unsafe/name", arguments: "" },
      },
    });
    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "unsafe-command",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        result: { type: "failed", error: { message: "Invalid OMP command name" } },
      }),
    );

    session.promptAgentInvoked = true;
    const imageResult = connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "image-prompt",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
      },
    });
    await imageResult;
    const imageTurn = turnIdFrom(
      await events.waitFor(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "image-prompt",
      ),
    );
    expect(session.promptImages.at(-1)).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    await finishTurn(events, session, imageTurn);
    await connection.close();
  });

  test("continues extension questions through native permissions", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.redactionValues = ["Preview", "Production"];
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "ask-turn", "choose"));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "ask-tool",
      toolName: "ask_user",
      args: { question: "Deployment" },
    });
    session.emit({
      type: "extension_ui_request",
      id: "native-select",
      method: "select",
      title: "Deployment",
      options: ["Preview", "Production"],
      optionDetails: [{ description: "Safe sandbox" }, { description: "Live traffic" }],
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission event");
    const questions = permission.request.input?.questions;
    expect(questions).toEqual([
      {
        header: "Deployment",
        question: "Deployment",
        options: [
          {
            label: "<redacted>",
            value: expect.stringMatching(/:option:0$/u),
            description: "Safe sandbox",
          },
          {
            label: "<redacted> (2)",
            value: expect.stringMatching(/:option:1$/u),
            description: "Live traffic",
          },
        ],
        multiSelect: false,
      },
    ]);
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...permission.request, provider: "omp" }),
    ).not.toThrow();
    const optionActions =
      permission.request.actions?.filter((action) => action.id.includes(":option:")) ?? [];
    expect(new Set(optionActions.map((action) => action.id)).size).toBe(2);
    const productionAction = optionActions[1];
    if (!productionAction) throw new Error("Expected production action");
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "allow", selectedActionId: "submit" },
      }),
    ).rejects.toThrow("OMP permission action is invalid");
    expect(session.extensionUiResponses).toHaveLength(0);
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { Deployment: "<redacted> (2)" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === permission.request.id,
    );
    expect(session.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "native-select", value: "Production" },
    ]);
    const postResponseTerminalCount = events.filter(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    ).length;
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(postResponseTerminalCount);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "ask-tool",
      toolName: "ask_user",
      result: { answer: "Production" },
    });
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.name === "ask_user",
      ),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
      ),
    ).toBe(false);
    session.emit({
      type: "extension_ui_request",
      id: "native-input",
      method: "input",
      title: "Branch name",
      placeholder: "feature/...",
    });
    const inputPermission = await events.waitFor(
      (event) => event.type === "session.permission" && event.request.id !== permission.request.id,
    );
    if (inputPermission.type !== "session.permission") throw new Error("Expected input permission");
    expect(inputPermission.request.input).toEqual({
      questions: [
        {
          header: "Branch name",
          question: "Branch name",
          options: [],
          multiSelect: false,
          placeholder: "feature/...",
        },
      ],
    });
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...inputPermission.request, provider: "omp" }),
    ).not.toThrow();
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: inputPermission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Branch name": "feature/native" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === inputPermission.request.id,
    );
    expect(session.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "native-select", value: "Production" },
      { type: "extension_ui_response", id: "native-input", value: "feature/native" },
    ]);
    session.emit({
      type: "extension_ui_request",
      id: "native-editor",
      method: "editor",
      title: "Release notes",
      prefill: "Draft",
      promptStyle: true,
    });
    const editorPermission = await events.waitFor(
      (event) =>
        event.type === "session.permission" &&
        event.request.id !== permission.request.id &&
        event.request.id !== inputPermission.request.id,
    );
    if (editorPermission.type !== "session.permission")
      throw new Error("Expected editor permission");
    expect(editorPermission.request.input).toEqual({
      questions: [
        {
          header: "Release notes",
          question: "Release notes",
          options: [],
          multiSelect: false,
          prefill: "Draft",
        },
      ],
    });
    expect(() =>
      AgentPermissionRequestPayloadSchema.parse({ ...editorPermission.request, provider: "omp" }),
    ).not.toThrow();
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: editorPermission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Release notes": "Final notes" } },
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === editorPermission.request.id,
    );
    expect(session.extensionUiResponses.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "native-editor",
      value: "Final notes",
    });
    const permissionCount = events.filter((event) => event.type === "session.permission").length;
    const responseCount = session.extensionUiResponses.length;
    session.emit({
      type: "extension_ui_request",
      id: "open-url",
      method: "open_url",
      url: "https://example.com/oauth?token=public",
      launchUrl: "http://127.0.0.1:4321/launch",
      instructions: "Open this link",
    });
    expect(events.filter((event) => event.type === "session.permission")).toHaveLength(
      permissionCount,
    );
    expect(session.extensionUiResponses).toHaveLength(responseCount);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          message: "Open this link\nhttp://127.0.0.1:4321/launch",
        }),
      }),
    );
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "ask-answer",
        content: [{ type: "text", text: "Continuing" }],
      },
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("claims permission responses once and expires unanswered questions locally", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.emit({
      type: "extension_ui_request",
      id: "native-race",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission");
    const permissionCountBeforeUpdate = events.filter(
      (event) => event.type === "session.permission",
    ).length;
    const replacementRequest = {
      type: "extension_ui_request" as const,
      id: "native-race",
      method: "confirm" as const,
      title: "Continue updated",
      message: "Proceed now?",
    };
    session.emit(replacementRequest);
    const updatedPermissions = events.filter((event) => event.type === "session.permission");
    expect(updatedPermissions).toHaveLength(permissionCountBeforeUpdate + 1);
    const updatedPermission = updatedPermissions.at(-1);
    if (updatedPermission?.type !== "session.permission") {
      throw new Error("Expected updated permission");
    }
    expect(updatedPermission.request.id).not.toBe(permission.request.id);
    expect(events).toContainEqual({
      type: "session.permission_resolved",
      sessionId: "session-1",
      permissionId: permission.request.id,
    });
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");

    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.extensionUiResponseGate = gate.promise;
    session.extensionUiResponseObserved = observed.resolve;
    const inFlightResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: updatedPermission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await observed.promise;
    const permissionCountInFlight = events.filter(
      (event) => event.type === "session.permission",
    ).length;
    session.emit(replacementRequest);
    expect(events.filter((event) => event.type === "session.permission")).toHaveLength(
      permissionCountInFlight,
    );
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: updatedPermission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    gate.resolve();
    await inFlightResponse;
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" &&
        event.permissionId === updatedPermission.request.id,
    );
    expect(session.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "native-race", confirmed: true },
    ]);

    session.extensionUiResponseGate = null;
    session.extensionUiResponseObserved = null;
    session.extensionUiResponseError = new Error("write failed");
    session.emit({
      type: "extension_ui_request",
      id: "native-retry",
      method: "input",
      title: "Retry input",
      timeout: 1_000,
    });
    const retryPermission = await events.waitFor(
      (event) => event.type === "session.permission" && event.request.title === "Retry input",
    );
    if (retryPermission.type !== "session.permission") throw new Error("Expected retry permission");
    const retryResponse = {
      behavior: "allow" as const,
      updatedInput: { answers: { "Retry input": "value" } },
    };
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: retryPermission.request.id,
        response: retryResponse,
      }),
    ).rejects.toThrow("write failed");
    expect(scheduler.delays.at(-1)).toBeLessThanOrEqual(1_000);
    const retryObserved = Promise.withResolvers<void>();
    session.extensionUiResponseObserved = retryObserved.resolve;
    session.extensionUiResponseError = null;
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: retryPermission.request.id,
      response: retryResponse,
    });
    await retryObserved.promise;
    await Promise.resolve();
    expect(session.extensionUiResponses.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "native-retry",
      value: "value",
    });
    session.emit({
      type: "extension_ui_request",
      id: "native-timeout",
      method: "input",
      title: "Timed input",
      timeout: 250,
    });
    const timed = await events.waitFor(
      (event) => event.type === "session.permission" && event.request.title === "Timed input",
    );

    if (timed.type !== "session.permission") throw new Error("Expected timed permission");
    const responsesBeforeTimeout = session.extensionUiResponses.length;
    expect(scheduler.delays).toContain(250);
    await scheduler.flush();
    await events.waitFor(
      (event) =>
        event.type === "session.permission_resolved" && event.permissionId === timed.request.id,
    );
    expect(session.extensionUiResponses).toHaveLength(responsesBeforeTimeout + 1);
    expect(session.extensionUiResponses.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "native-timeout",
      cancelled: true,
      timedOut: true,
    });

    await connection.close();
  });
  test("fails closed when an in-flight native permission changes semantics", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "changed-in-flight", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "changing-native",
      method: "confirm",
      title: "Original",
      message: "Proceed?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected permission");
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.extensionUiResponseGate = gate.promise;
    session.extensionUiResponseObserved = observed.resolve;
    const inFlightResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await observed.promise;
    session.emit({
      type: "extension_ui_request",
      id: "changing-native",
      method: "confirm",
      title: "Replacement",
      message: "Different request",
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(
      events.filter(
        (event) => event.type === "session.permission" && event.request.title === "Replacement",
      ),
    ).toHaveLength(0);
    gate.resolve();
    await inFlightResponse;
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    await connection.close();
  });
  test("scopes permission evidence to its turn and never reuses public ids", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const firstSession = sessionAt(runtime);
    firstSession.emit({
      type: "extension_ui_request",
      id: "reused-native-id",
      method: "confirm",
      title: "Idle question",
      message: "Idle?",
    });
    const idlePermission = events.findLast((event) => event.type === "session.permission");
    if (idlePermission?.type !== "session.permission") throw new Error("Expected idle permission");

    const turnId = turnIdFrom(await startPrompt(connection, events, "scoped-turn", "work"));
    firstSession.emit({
      type: "extension_ui_request",
      id: "turn-question",
      method: "confirm",
      title: "Turn question",
      message: "Continue?",
    });
    const turnPermission = events.findLast((event) => event.type === "session.permission");
    if (turnPermission?.type !== "session.permission") throw new Error("Expected turn permission");
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: turnPermission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await Promise.resolve();
    firstSession.emit({
      type: "message_end",
      message: { role: "assistant", responseId: "permission-answer", content: "Continuing" },
    });
    firstSession.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    firstSession.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    await connection.send({
      type: "session.close",
      requestId: "close-first",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-first",
    );

    await openSession(connection, events, "open-second", "session-2");
    sessionAt(runtime, 1).emit({
      type: "extension_ui_request",
      id: "reused-native-id",
      method: "confirm",
      title: "Idle question",
      message: "Idle?",
    });
    const secondPermission = events.findLast(
      (event) => event.type === "session.permission" && event.sessionId === "session-2",
    );
    if (secondPermission?.type !== "session.permission")
      throw new Error("Expected second permission");
    expect(secondPermission.request.id).not.toBe(idlePermission.request.id);
    await connection.close();
  });

  test("cancels saturated permission queues and fails empty selects closed", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    for (let index = 0; index < 33; index += 1) {
      session.emit({
        type: "extension_ui_request",
        id: `native-${index}`,
        method: "confirm",
        title: `Question ${index}`,
        message: "Continue?",
      });
    }
    await events.waitFor(
      (event) => event.type === "session.notice" && event.notice.title === "OMP question canceled",
    );
    expect(session.extensionUiResponses).toContainEqual({
      type: "extension_ui_response",
      id: "native-32",
      cancelled: true,
    });
    const turnId = turnIdFrom(await startPrompt(connection, events, "empty-select", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "empty-select",
      method: "select",
      title: "Empty",
      options: [],
    });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    expect(terminal).toEqual(expect.objectContaining({ error: { message: "OMP runtime failed" } }));
    await connection.close();
  });

  test("bounds cumulative pending permission bytes", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const options = Array.from({ length: 128 }, (_, index) => `${index}:${"x".repeat(2_040)}`);
    for (let index = 0; index < 10; index += 1) {
      session.emit({
        type: "extension_ui_request",
        id: `large-${index}`,
        method: "select",
        title: `Large ${index}`,
        options,
      });
      if (
        events.some(
          (event) =>
            event.type === "session.notice" &&
            event.notice.description === "OMP question data exceeded the pending input budget",
        )
      ) {
        break;
      }
    }
    const permissions = events.filter((event) => event.type === "session.permission");
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.length).toBeLessThan(10);
    await Promise.resolve();
    expect(session.extensionUiResponses.at(-1)).toEqual(
      expect.objectContaining({ type: "extension_ui_response", cancelled: true }),
    );
    await connection.close();
  });
  test("accepts null command input and redacts published command and custom names", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.redactionValues = ["secret-command"];
    runtime.availableCommands = [
      { name: "help", description: "Help", input: null, source: "builtin" },
      { name: "secret-command", description: "Private", input: null, source: "extension" },
    ];
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events, "redacted-open", "session-1", {
      SECRET_NAME: "secret-command",
    });
    const commandEvent = events.find((event) => event.type === "session.commands");
    expect(JSON.stringify(commandEvent)).not.toContain("secret-command");
    expect(commandEvent).toEqual(
      expect.objectContaining({
        commands: expect.arrayContaining([
          { name: "help", description: "Help" },
          expect.objectContaining({ name: "<redacted>" }),
        ]),
      }),
    );
    const turnId = turnIdFrom(await startPrompt(connection, events, "custom-redaction", "work"));
    sessionAt(runtime).emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "stable-custom",
        customType: "secret-command",
        display: true,
        content: "visible",
      },
    });
    const custom = events.findLast(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    expect(JSON.stringify(custom)).not.toContain("secret-command");
    await finishTurn(events, sessionAt(runtime), turnId);
    await connection.close();
  });
  test("accepts future compaction actions and actionless completion", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const baseline = events.length;

    session.emit({ type: "auto_compaction_start", reason: "future", action: "future-action" });
    session.emit({ type: "auto_compaction_end", aborted: false, willRetry: false });

    expect(
      events
        .slice(baseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : [],
        ),
    ).toEqual([
      { type: "compaction", id: "omp:compaction:1", status: "loading", trigger: "auto" },
      { type: "compaction", id: "omp:compaction:1", status: "completed", trigger: "auto" },
    ]);
    await connection.close();
  });

  test("renders native tools custom messages hidden notices and compaction once", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "render-turn", "work"));
    for (const [toolCallId, toolName, args, result, detailType] of [
      [
        "bash",
        "bash",
        { command: "pwd", cwd: "/repo" },
        { content: [{ type: "text", text: "/repo" }], details: { exitCode: 0 } },
        "shell",
      ],
      [
        "edit",
        "edit",
        { path: "a.ts", oldString: "a", newString: "b" },
        { content: [{ type: "text", text: "updated" }], details: { diff: "-a\n+b" } },
        "edit",
      ],
      ["write", "write", { path: "b.ts", content: "b" }, { ok: true }, "write"],
      ["grep", "grep", { pattern: "needle" }, { content: "a.ts:1" }, "search"],
      ["fetch", "fetch", { url: "https://example.com" }, { content: "page" }, "fetch"],
      ["task", "task", { agent: "reviewer", description: "Review" }, { log: "done" }, "sub_agent"],
      ["advisor", "advisor", { prompt: "Check" }, { content: "Concern" }, "plain_text"],
      ["custom", "vendor_tool", { value: 1 }, { value: 2 }, "unknown"],
    ] as const) {
      session.emit({ type: "tool_execution_start", toolCallId, toolName, args });
      session.emit({ type: "tool_execution_end", toolCallId, toolName, result });
      const snapshots = events.flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === toolName
          ? [event.item]
          : [],
      );
      expect(snapshots).toHaveLength(2);
      expect(new Set(snapshots.map((item) => item.id)).size).toBe(1);
      expect(snapshots.at(-1)?.detail.type).toBe(detailType);
    }
    session.emit({
      type: "tool_execution_start",
      toolCallId: "sensitive-fetch",
      toolName: "web_fetch",
      args: { url: "https://example.com/page?token=model-secret#fragment" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "sensitive-fetch",
      toolName: "web_fetch",
      result: { content: "page" },
    });
    const sanitizedFetch = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "web_fetch" &&
        event.item.status === "completed",
    );
    expect(
      sanitizedFetch?.type === "timeline.item" && sanitizedFetch.item.type === "tool_call"
        ? sanitizedFetch.item.detail
        : undefined,
    ).toEqual({ type: "fetch", url: "https://example.com/page", result: "page" });
    expect(JSON.stringify(sanitizedFetch)).not.toContain("model-secret");

    session.emit({
      type: "tool_execution_start",
      toolCallId: "unsafe-fetch",
      toolName: "web_fetch",
      args: { url: "javascript:alert('secret')" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "unsafe-fetch",
      toolName: "web_fetch",
      result: { content: "ignored" },
    });
    const unsafeFetch = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "web_fetch" &&
        event.item.status === "completed",
    );
    expect(
      unsafeFetch?.type === "timeline.item" && unsafeFetch.item.type === "tool_call"
        ? unsafeFetch.item.detail
        : undefined,
    ).toEqual({ type: "plain_text", label: "web_fetch", text: "ignored" });
    expect(JSON.stringify(unsafeFetch)).not.toContain("javascript");
    session.emit({
      type: "tool_execution_start",
      toolCallId: "edit-default-input",
      toolName: "edit",
      args: { input: "apply prepared edit" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "edit-default-input",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "updated" }],
        details: {
          path: "src/derived.ts",
          perFileResults: [
            { path: "src/derived.ts", diff: "-old\n+new" },
            { path: "src/other.ts", diff: "-before\n+after" },
          ],
        },
      },
    });
    const derivedEdit = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed" &&
        event.item.detail.type === "edit" &&
        event.item.detail.filePath === "src/derived.ts",
    );
    expect(
      derivedEdit?.type === "timeline.item" && derivedEdit.item.type === "tool_call"
        ? derivedEdit.item.detail
        : undefined,
    ).toEqual({
      type: "edit",
      filePath: "src/derived.ts",
      unifiedDiff: "-old\n+new\n-before\n+after",
    });
    const screenshotBytes = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(225 * 1024),
    ]).toString("base64");
    session.emit({
      type: "tool_execution_start",
      toolCallId: "browser-shot",
      toolName: "browser_screenshot",
      args: { browserId: "browser-1" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "browser-shot",
      toolName: "browser_screenshot",
      result: {
        content: [
          { type: "text", text: "token test-value" },
          { type: "image", data: screenshotBytes, mimeType: "image/png" },
        ],
        details: { width: 1280, height: 720, authorization: "test-value" },
      },
    });
    const browserTool = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "browser_screenshot" &&
        event.item.status === "completed",
    );
    if (browserTool?.type !== "timeline.item" || browserTool.item.type !== "tool_call") {
      throw new Error("Expected terminal browser screenshot tool");
    }
    const browserCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.id === `${browserTool.item.id}:images`,
    );
    if (browserCarrier?.type !== "timeline.item" || browserCarrier.item.type !== "tool_call") {
      throw new Error("Expected browser screenshot image carrier");
    }
    // Static imports pull the host's incompatible Node/Zod declaration graph into this package.
    const timelineContent = (await import(timelineContentModulePath)) as unknown as {
      limitAgentTimelineItemContent(item: ProviderTimelineItem): ProviderTimelineItem;
    };
    const reducedCarrier = timelineContent.limitAgentTimelineItemContent(browserCarrier.item);
    if (reducedCarrier.type !== "tool_call") throw new Error("Expected reduced image carrier");
    const browserTransform = transformOmpImageToolItem(reducedCarrier);
    const browserImage = browserTransform?.items[0];
    expect(JSON.stringify(browserImage?.data).length).toBeGreaterThan(256 * 1024);
    expect(ompImageTimelineSchema.parse(browserImage?.data).images[0]?.data).toBe(screenshotBytes);
    expect(browserImage).toEqual({
      type: "plugin",
      id: browserCarrier.item.id,
      kind: "omp-images",
      version: 1,
      data: {
        label: "browser_screenshot",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: screenshotBytes,
            mimeType: "image/png",
          },
        ],
        text: "token <redacted>",
        details: { width: 1280, height: 720, authorization: "<redacted>" },
      },
    });
    const screenshotLifecycle = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.id === browserTool.item.id ? [event.item] : [],
    );
    expect(screenshotLifecycle[0]?.type).toBe("tool_call");
    expect(
      new Map(screenshotLifecycle.map((item) => [item.id, item])).get(browserTool.item.id),
    ).toEqual(expect.objectContaining({ type: "tool_call", status: "completed" }));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "read-image",
      toolName: "read",
      args: { path: "image.png" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "read-image",
      toolName: "read",
      result: {
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    const readCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "read images",
    );
    if (readCarrier?.type !== "timeline.item" || readCarrier.item.type !== "tool_call") {
      throw new Error("Expected read image carrier");
    }
    expect(transformOmpImageToolItem(readCarrier.item)?.items[0]).toEqual(
      expect.objectContaining({ type: "plugin", kind: "omp-images" }),
    );
    session.emit({
      type: "tool_execution_start",
      toolCallId: "image-with-large-text",
      toolName: "multi_image",
      args: {},
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "image-with-large-text",
      toolName: "multi_image",
      result: {
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "a".repeat(150 * 1024) },
          { type: "text", text: "b".repeat(150 * 1024) },
          { type: "text", text: "c".repeat(150 * 1024) },
        ],
      },
    });
    const boundedTextCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "multi_image images",
    );
    if (
      boundedTextCarrier?.type !== "timeline.item" ||
      boundedTextCarrier.item.type !== "tool_call"
    ) {
      throw new Error("Expected bounded image text carrier");
    }
    const boundedImage = transformOmpImageToolItem(boundedTextCarrier.item)?.items[0];
    const boundedImageData = ompImageTimelineSchema.parse(boundedImage?.data);
    expect(Buffer.byteLength(boundedImageData.text ?? "", "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(boundedImageData.images).toHaveLength(1);
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "custom-image",
        customType: "gallery",
        display: true,
        content: [
          { type: "text", text: "caption test-value" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        details: { token: "test-value" },
      },
    });
    const customCarrier = events.findLast(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === "gallery images",
    );
    if (customCarrier?.type !== "timeline.item" || customCarrier.item.type !== "tool_call") {
      throw new Error("Expected custom image carrier");
    }
    expect(transformOmpImageToolItem(customCarrier.item)?.items[0]).toEqual({
      type: "plugin",
      id: customCarrier.item.id,
      kind: "omp-images",
      version: 1,
      data: {
        label: "gallery",
        images: [
          {
            id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u),
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
        text: "caption <redacted>",
        details: { token: "<redacted>" },
      },
    });
    const completedMappedTools = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.status === "completed"
        ? [event.item]
        : [],
    );
    expect(completedMappedTools.find((item) => item.name === "bash")?.detail).toEqual({
      type: "shell",
      command: "pwd",
      cwd: "<absolute path>",
      output: "<absolute path>",
      exitCode: 0,
    });
    expect(completedMappedTools.find((item) => item.name === "edit")?.detail).toEqual({
      type: "edit",
      filePath: "a.ts",
      oldString: "a",
      newString: "b",
      unifiedDiff: "-a\n+b",
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "todo",
      toolName: "todo",
      args: { op: "view" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "todo",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "updated" }],
        details: {
          phases: [
            {
              id: "phase-1",
              name: "Build",
              tasks: [{ id: "task-1", content: "Map events", status: "in_progress" }],
            },
          ],
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.name === "todo",
      ),
    ).toHaveLength(0);
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "todo",
        id: "omp:todos",
        items: [
          {
            id: expect.stringMatching(/^omp:todo:/u),
            text: "Map events",
            completed: false,
            status: "in_progress",
            activeForm: "Build",
          },
        ],
      },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "failed-ask",
      toolName: "ask_user",
      args: { questions: [] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "failed-ask",
      toolName: "ask_user",
      result: { content: [{ type: "text", text: "question failed" }] },
      isError: true,
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "failed-todo",
      toolName: "todo",
      args: { op: "view" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "failed-todo",
      toolName: "todo",
      result: { content: [{ type: "text", text: "missing phases" }] },
    });
    for (const name of ["ask_user", "todo"]) {
      const fallback = events.flatMap((event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.name === name
          ? [event.item]
          : [],
      );
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.status).toBe("failed");
    }
    session.emit({
      type: "todo_reminder",
      todos: [{ id: "task-1", content: "Map events", status: "in_progress" }],
    });
    const todoRows = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "todo" ? [event.item] : [],
    );
    expect(todoRows.map((item) => item.items[0]?.id)).toEqual([
      expect.stringMatching(/^omp:todo:/u),
      expect.stringMatching(/^omp:todo:/u),
    ]);
    expect(todoRows[0]?.items[0]?.id).toBe(todoRows[1]?.items[0]?.id);
    expect(new Set(todoRows.map((item) => item.id))).toEqual(new Set(["omp:todos"]));

    const beforeCustom = events.length;
    session.emit({
      type: "message_end",
      message: { role: "custom", customType: "internal-notice", display: false, content: "hidden" },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "advisor-native-id",
        customType: "advisor-message",
        display: true,
        content: "",
        details: {
          severity: "warning",
          attribution: "reviewer",
          notes: ["Check the race"],
        },
      },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        id: "advisor-native-id",
        customType: "advisor-message",
        display: true,
        content: "",
        details: {
          severity: "error",
          attribution: "reviewer",
          notes: [{ note: "Race confirmed", severity: "blocker", advisor: "reviewer" }],
        },
      },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "bashExecution",
        id: "bash-native-id",
        command: "pwd",
        output: "/repo\n",
        exitCode: 0,
        images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    session.emit({ type: "compaction_start" });
    session.emit({
      type: "compaction_end",
      aborted: true,
      willRetry: false,
      errorMessage: "manual compaction aborted",
    });
    session.emit({ type: "compaction_start" });
    session.emit({ type: "compaction_end", skipped: true, aborted: false, willRetry: false });
    session.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
    session.emit({
      type: "auto_compaction_end",
      action: "remote",
      aborted: false,
      willRetry: true,
      errorMessage: "retrying",
    });
    session.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
    session.emit({
      type: "auto_compaction_end",
      action: "remote",
      result: { tokensBefore: 8_000 },
      aborted: false,
      willRetry: false,
    });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      result: { preTokens: 12_345 },
      aborted: false,
      willRetry: false,
    });
    const overlapBaseline = events.length;
    session.emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" });
    session.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
    session.emit({
      type: "auto_compaction_end",
      action: "context-full",
      aborted: false,
      willRetry: false,
    });
    session.emit({
      type: "auto_compaction_end",
      action: "remote",
      aborted: false,
      willRetry: false,
    });
    const overlapEvents = events
      .slice(overlapBaseline)
      .flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
    expect(overlapEvents).toEqual([
      {
        type: "compaction",
        id: "omp:compaction:5",
        status: "loading",
        trigger: "auto",
      },
      {
        type: "compaction",
        id: "omp:compaction:5",
        status: "completed",
        trigger: "auto",
      },
      {
        type: "error",
        id: "omp:compaction:5:error",
        message: "OMP emitted overlapping compactions",
      },
    ]);
    session.emit({ type: "advisor_yielded" });
    const rendered = events.slice(beforeCustom).filter((event) => event.type === "timeline.item");
    expect(JSON.stringify(rendered)).not.toContain("hidden");
    const customItems = rendered.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
    );
    expect(customItems).toHaveLength(4);
    expect(new Set(customItems.map((item) => item.id)).size).toBe(3);
    expect(JSON.stringify(customItems)).toContain("[blocker] [reviewer] Race confirmed");
    const bashImageCarrier = customItems.find((item) => item.name === "bashExecution images");
    expect(
      bashImageCarrier ? transformOmpImageToolItem(bashImageCarrier)?.items[0] : undefined,
    ).toEqual(expect.objectContaining({ type: "plugin", kind: "omp-images" }));
    expect(rendered).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "notification",
        id: expect.stringMatching(/^omp:advisor:/u),
        level: "info",
        message: "Advisor review completed",
      },
    });
    expect(customItems.find((item) => item.detail.type === "shell")?.detail).toEqual({
      type: "shell",
      command: "pwd",
      output: "<absolute path>\n",
      exitCode: 0,
    });
    const compactions = rendered.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : [],
    );
    expect(compactions).toContainEqual({
      type: "compaction",
      id: "omp:compaction:4",
      status: "loading",
      trigger: "auto",
    });
    expect(compactions).toContainEqual({
      type: "compaction",
      id: "omp:compaction:4",
      status: "completed",
      trigger: "auto",
      preTokens: 12_345,
    });
    const compactionResults = rendered.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "compaction" || event.item.type === "error")
        ? [event.item]
        : [],
    );
    expect(compactionResults).toContainEqual({
      type: "error",
      id: "omp:compaction:1:error",
      message: "manual compaction aborted",
    });
    const reducedTimeline = new Map(
      rendered.flatMap((event) =>
        event.type === "timeline.item" ? [[event.item.id, event.item] as const] : [],
      ),
    );
    expect(reducedTimeline.get("omp:compaction:1")).toEqual({
      type: "compaction",
      id: "omp:compaction:1",
      status: "completed",
      trigger: "manual",
    });
    expect(compactionResults).toContainEqual({
      type: "compaction",
      id: "omp:compaction:2",
      status: "completed",
      trigger: "manual",
    });
    expect(rendered).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "notification",
        id: "omp:compaction:2:skipped",
        level: "warning",
        message: "OMP compaction was skipped",
      },
    });
    expect(compactionResults).toContainEqual({
      type: "compaction",
      id: "omp:compaction:3",
      status: "completed",
      trigger: "auto",
      preTokens: 8_000,
    });
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("honors interrupts after questions and retires compactions across recovery", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const interruptedTurn = turnIdFrom(
      await startPrompt(connection, events, "interrupt-question", "work"),
    );
    session.emit({
      type: "extension_ui_request",

      id: "interrupt-ui",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    await events.waitFor((event) => event.type === "session.permission");
    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-question-request",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) =>
        event.type === "request.completed" && event.requestId === "interrupt-question-request",
    );
    await finishTurn(events, session, interruptedTurn);
    await Promise.resolve();
    expect(session.extensionUiResponses).toContainEqual({
      type: "extension_ui_response",
      id: "interrupt-ui",
      cancelled: true,
    });
    expect(events.filter((event) => event.type === "session.permission_resolved")).toHaveLength(1);

    const recoveryTurn = turnIdFrom(
      await startPrompt(connection, events, "compaction-death", "continue"),
    );
    const recoveredSource = sessionAt(runtime);
    recoveredSource.emit({ type: "compaction_start" });
    recoveredSource.emit({ type: "compaction_start" });
    recoveredSource.emit({ type: "compaction_end", aborted: false, willRetry: false });
    recoveredSource.emit({ type: "process_exit", error: "transport died" });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === recoveryTurn && event.state === "failed",
    );
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "error",
        id: "omp:compaction:1:error",
        message: "OMP emitted overlapping compactions",
      },
    });

    const finalTurn = turnIdFrom(
      await startPrompt(connection, events, "after-compaction-death", "again"),
    );
    const recovered = sessionAt(runtime, 1);
    recovered.emit({ type: "compaction_start" });
    recovered.emit({ type: "compaction_end", aborted: false, willRetry: false });
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "compaction",
        id: "omp:compaction:2",
        status: "completed",
        trigger: "manual",
      },
    });
    await finishTurn(events, recovered, finalTurn);
    await openSession(connection, events, "open-2", "session-2");
    sessionAt(runtime, 2).emit({ type: "compaction_start" });
    await connection.send({ type: "session.close", requestId: "close-2", sessionId: "session-2" });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-2",
    );
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-2",
      item: {
        type: "error",
        id: "omp:compaction:1:error",
        message: "OMP compaction ended when the session closed",
      },
    });
    await connection.close();
  });
  test("resolves turnless permissions on direct runtime invalidation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.emit({
      type: "extension_ui_request",
      id: "idle-before-invalidation",
      method: "confirm",
      title: "Idle",
      message: "Continue?",
    });
    const permission = events.findLast((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("Expected idle permission");
    const turnId = turnIdFrom(await startPrompt(connection, events, "invalidate-state", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "turn-before-invalidation",
      method: "confirm",
      title: "Turn",
      message: "Continue?",
    });
    session.extensionUiResponseError = new Error("cancel failed");
    await connection.send({
      type: "session.interrupt",
      requestId: "invalidate-interrupt",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "invalidate-interrupt",
    );
    await finishTurn(events, session, turnId);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    await connection.close();
  });
  test("keeps compaction active through local-only completion", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "local-compaction", "/compact"),
    );
    session.emit({ type: "compaction_start" });
    await scheduler.flush();
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "error" &&
          event.item.id === "omp:compaction:1",
      ),
    ).toBe(false);
    session.emit({
      type: "compaction_end",
      result: { preTokens: 4_000 },
      aborted: false,
      willRetry: false,
    });
    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "compaction",
        id: "omp:compaction:1",
        status: "completed",
        trigger: "manual",
        preTokens: 4_000,
      },
    });
    await connection.close();
  });

  test("does not restore claimed permissions after transport death", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-death", "work"));
    session.emit({
      type: "extension_ui_request",
      id: "dying-ui",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    });
    const permission = await events.waitFor((event) => event.type === "session.permission");
    if (permission.type !== "session.permission") throw new Error("Expected permission");
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    session.extensionUiResponseGate = gate.promise;
    session.extensionUiResponseObserved = observed.resolve;
    const inFlightResponse = connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: permission.request.id,
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    await observed.promise;
    session.extensionUiResponseError = new Error("transport died");
    session.emit({ type: "process_exit", error: "transport died" });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "failed",
    );
    gate.resolve();
    await inFlightResponse;
    await Promise.resolve();
    expect(
      events.filter(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === permission.request.id,
      ),
    ).toHaveLength(1);
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: permission.request.id,
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Unknown OMP permission request");
    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-permission-death", "continue"),
    );
    expect(runtime.sessions).toHaveLength(2);
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    await connection.close();
  });

  test("bounds aggregate text reasoning and image stream output", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "image-flood", "render"));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_start",
      message: { role: "assistant", responseId: "image-flood-response", content: [] },
    });
    for (let replacement = 0; replacement < 20; replacement += 1) {
      const imageData = Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        Buffer.alloc(2 * 1024 * 1024 - 8, replacement),
      ]).toString("base64");
      session.emit({
        type: "message_update",
        message: { role: "assistant", responseId: "image-flood-response", content: [] },
        assistantMessageEvent: {
          type: "image_end",
          contentIndex: 0,
          content: { type: "image", data: imageData, mimeType: "image/png" },
        },
      });
      await scheduler.flush();
    }
    const renderedImages = events.flatMap((event) => {
      if (event.type !== "timeline.item" || event.item.type !== "tool_call") return [];
      const transformed = transformOmpImageToolItem(event.item)?.items[0];
      if (!transformed) return [];
      return ompImageTimelineSchema.parse(transformed.data).images.map((image) => image.data);
    });
    expect(renderedImages.length).toBeGreaterThan(0);
    expect(renderedImages.length).toBeLessThan(20);
    expect(renderedImages.reduce((total, data) => total + Buffer.byteLength(data), 0)).toBeLessThan(
      16 * 1024 * 1024,
    );
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("data:image"),
      ),
    ).toBe(false);
    await finishTurn(events, sessionAt(runtime), turnId);
    await connection.close();
  });
});
