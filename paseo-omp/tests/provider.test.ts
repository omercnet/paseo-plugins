import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { mapOmpModels, ompModelId } from "../server/provider/catalog";
import { OmpNativeSessionReservations } from "../server/provider/connection";
import {
  type OmpMessage,
  type OmpModel,
  type OmpRpcEvent,
  OmpRpcRuntime,
  type OmpRuntime,
  type OmpRuntimeSession,
  type OmpStartOptions,
  type OmpSubagentMessagesResult,
  type OmpSubagentSnapshot,
} from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import { OmpCleanupFailure, OmpPublicDataFilter } from "../server/provider/security";
import {
  OmpTimelineProjector,
  type OmpTimelineScheduler,
} from "../server/provider/timeline-projector";

type HostLogger = object;
type PinoFactory = (options: { enabled: boolean }) => HostLogger;
type HostTerminalEvent = {
  type: "turn_failed" | "turn_completed" | "turn_canceled";
  turnId: string | undefined;
};
type HostStreamEvent = { type: string; turnId?: string };
type HostSession = {
  readonly id: string | null;
  startTurn(prompt: string, options?: { clientMessageId?: string }): Promise<{ turnId: string }>;
  subscribe(callback: (event: HostStreamEvent) => void): () => void;
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
const NATIVE_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
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
  canReplayHistory = true;
  readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  redactionValues: readonly string[] = [];
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
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
  availableCommands: Array<{ name: string; aliases?: string[] }> = [{ name: "help" }];
  availableCommandsError: Error | null = null;
  availableCommandLookups = 0;
  availableCommandsGate: Promise<void> | null = null;
  subagentSubscriptionError: Error | null = null;
  readonly subagentSubscriptions: string[] = [];
  subagents: OmpSubagentSnapshot[] = [];
  readonly subagentMessages = new Map<string, OmpSubagentMessagesResult>();
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
  historyMessages: OmpMessage[] = [];
  historyRequests = 0;
  historyGate: Promise<void> | null = null;
  historyError: Error | null = null;
  historyObserved: (() => void) | null = null;
  currentModel = MODEL;
  nativeSessionFile: string | undefined = "/sessions/root.jsonl";
  availableModels: OmpModel[] = [MODEL, ALTERNATE_MODEL];
  nativeSessionId = NATIVE_SESSION_ID;
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
      sessionFile: this.nativeSessionFile,
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
  async setSubagentSubscription(level: "events") {
    if (this.subagentSubscriptionError) throw this.subagentSubscriptionError;
    this.subagentSubscriptions.push(level);
  }

  getSubagents() {
    return Promise.resolve(this.subagents);
  }

  getSubagentMessages(selector: { subagentId?: string; sessionFile?: string }) {
    const key = selector.subagentId ?? selector.sessionFile;
    const result = key ? this.subagentMessages.get(key) : undefined;
    if (!result) return Promise.reject(new Error("missing fake subagent transcript"));
    return Promise.resolve(result);
  }
  async prompt(message: string, onAccepted?: () => void) {
    this.prompts.push(message);
    this.promptCount += 1;
    this.promptObserved?.();
    if (this.promptGate) await this.promptGate;
    for (const event of this.promptEvents) this.emit(event);
    onAccepted?.();
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

  async steer(message: string) {
    this.steerObserved?.();
    if (this.steerGate) await this.steerGate;
    if (this.steerError) throw this.steerError;
    this.steers.push(message);
  }

  async getBranchMessages() {
    if (this.branchMessagesError) throw this.branchMessagesError;
    this.branchMessageLookups += 1;
    if (this.branchMessagesGate) await this.branchMessagesGate;
    return this.branchMessages;
  }
  async getMessages() {
    this.historyRequests += 1;
    this.historyObserved?.();
    if (this.historyGate) await this.historyGate;
    if (this.historyError) throw this.historyError;
    return this.historyMessages;
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
  supportsPersistence = true;
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
  availableCommands: Array<{ name: string; aliases?: string[] }> = [{ name: "help" }];
  availableModels: OmpModel[] = [MODEL, ALTERNATE_MODEL];
  redactionValues: readonly string[] = [];
  readonly descriptors: Array<{ id: string; cwd: string; title?: string; updatedAt?: string }> = [];
  resolveSessions = true;
  nextCanReplayHistory = true;
  nextHistoryGate: Promise<void> | null = null;
  nextHistoryObserved: (() => void) | null = null;
  nextHistoryError: Error | null = null;
  nextHistoryMessages: OmpMessage[] = [];
  nextSubagents: OmpSubagentSnapshot[] = [];
  readonly nextSubagentMessages = new Map<string, OmpSubagentMessagesResult>();
  nextSubagentSubscriptionError: Error | null = null;
  readonly sessionListRequests: Array<{
    cwd: string;
    query?: string;
    limit?: number;
    sessionId?: string;
  }> = [];
  listSessions(options: { cwd: string; query?: string; limit?: number; sessionId?: string }) {
    this.sessionListRequests.push(options);
    const source =
      this.descriptors.length > 0
        ? this.descriptors
        : this.resolveSessions && options.sessionId
          ? [{ id: options.sessionId, cwd: options.cwd }]
          : [];
    return Promise.resolve(
      source.filter(
        (descriptor) =>
          (!options.sessionId || descriptor.id === options.sessionId) &&
          descriptor.cwd === options.cwd,
      ),
    );
  }
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
    session.nativeSessionId =
      this.sessionIds.shift() ?? options.resumeSessionId ?? session.nativeSessionId;
    session.canReplayHistory = this.nextCanReplayHistory;
    session.availableModels = this.availableModels.map((model) => ({ ...model }));
    session.historyGate = this.nextHistoryGate;
    session.historyObserved = this.nextHistoryObserved;
    session.historyError = this.nextHistoryError;
    session.historyMessages = this.nextHistoryMessages;
    session.subagents = this.nextSubagents;
    session.subagentSubscriptionError = this.nextSubagentSubscriptionError;
    for (const [key, history] of this.nextSubagentMessages) {
      session.subagentMessages.set(key, history);
    }
    this.nextCanReplayHistory = true;
    this.nextHistoryGate = null;
    this.nextHistoryObserved = null;
    this.nextHistoryError = null;
    this.nextHistoryMessages = [];
    this.nextSubagents = [];
    this.nextSubagentMessages.clear();
    this.nextSubagentSubscriptionError = null;
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

async function createHarness(
  runtime = new FakeOmpRuntime(),
  scheduler = new ManualScheduler(),
  capabilities: readonly string[] = ["prompt.message", "prompt.steer", "session.configure"],
) {
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: scheduler,
    environment: TEST_RUNTIME_ENV,
  }).connect({ versions: [1], capabilities });
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

function finishTurn(events: EventLog, session: FakeOmpSession, turnId: string) {
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
      "prompt.steer",
      "session.configure",
    ]);
    await connection.close();
  });
  test("persists, lists, and resumes the same native session with bounded replay before ready", async () => {
    const runtime = new FakeOmpRuntime();
    const capabilities = [
      "prompt.message",
      "prompt.steer",
      "session.configure",
      "session.list",
      "session.persistence",
    ];
    const { connection, events } = await createHarness(
      runtime,
      new ManualScheduler(),
      capabilities,
    );
    runtime.sessionIds.push(NATIVE_SESSION_ID);
    await connection.send({
      type: "session.open",
      requestId: "new-persisted",
      sessionId: "fresh-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        model: MODEL_PUBLIC_ID,
        mode: "full",
        thinkingOption: "medium",
        settings: {},
        persist: true,
      },
      history: "skip",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "new-persisted",
    );
    const opened = events.find(
      (event) => event.type === "session.opened" && event.sessionId === "fresh-session",
    );
    expect(opened).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      }),
    );
    await connection.send({
      type: "session.close",
      requestId: "close-fresh",
      sessionId: "fresh-session",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-fresh",
    );

    runtime.descriptors.push({
      id: NATIVE_SESSION_ID,
      cwd: "/repo",
      title: "Persisted session",
      updatedAt: "2026-09-11T00:00:00.000Z",
    });
    await connection.send({ type: "sessions", requestId: "list", cwd: "/repo", limit: 10 });
    await events.waitFor((event) => event.type === "sessions" && event.requestId === "list");
    expect(events.at(-1)).toEqual({
      type: "sessions",
      requestId: "list",
      sessions: [
        {
          persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
          cwd: "/repo",
          title: "Persisted session",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    });

    runtime.nextHistoryMessages = Array.from(
      { length: 260 },
      (_, index): OmpMessage =>
        index % 2 === 0
          ? { role: "user", id: `history-${index}`, content: `message ${index}` }
          : {
              role: "assistant",
              responseId: index === 1 ? "replayed-response" : `history-${index}`,
              content: `message ${index}`,
            },
    );
    runtime.nextHistoryMessages.push(
      {
        role: "toolResult",
        toolCallId: "history-tool",
        toolName: "read",
        content: { content: [{ type: "text", text: "tool output" }] },
      },
      { role: "bashExecution", command: "pwd", output: "/repo\n", exitCode: 0 },
    );
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    const replayStart = events.length;
    await connection.send({
      type: "session.open",
      requestId: "resume-persisted",
      sessionId: "resumed-session",
      config: {
        cwd: "/repo",
        env: {},
        systemPrompt: "must not be reapplied",
        mcpServers: {},
        model: ALTERNATE_MODEL_PUBLIC_ID,
        mode: "full",
        thinkingOption: "high",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "resume-persisted",
    );
    const replayEvents = events.slice(replayStart);
    const readyIndex = replayEvents.findIndex((event) => event.type === "session.ready");
    const timelineIndexes = replayEvents.flatMap((event, index) =>
      event.type === "timeline.item" ? [index] : [],
    );
    expect(Math.max(...timelineIndexes)).toBeLessThan(readyIndex);
    const timelineItems = replayEvents.flatMap((event) =>
      event.type === "timeline.item" ? [event.item] : [],
    );
    expect(
      timelineItems
        .slice(0, 4)
        .map((item) =>
          item.type === "user_message" || item.type === "assistant_message" ? item.text : null,
        ),
    ).toEqual(["message 0", "message 1", "message 2", "message 3"]);
    expect(timelineItems).toHaveLength(263);
    expect(new Set(timelineItems.map((item) => item.id)).size).toBe(262);
    expect(timelineItems).toContainEqual(
      expect.objectContaining({ type: "tool_call", name: "read", status: "completed" }),
    );
    expect(timelineItems).toContainEqual(
      expect.objectContaining({
        type: "assistant_message",
        id: expect.stringMatching(/^omp:command:/u),
        text: expect.stringContaining("$ pwd"),
      }),
    );
    const liveTurn = turnIdFrom(
      await startPrompt(connection, events, "live-after-replay", "next", "resumed-session"),
    );
    const liveBaseline = events.length;
    sessionAt(runtime, 1).emit({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "replayed-response",
        content: "message 1",
      },
    });
    expect(events.slice(liveBaseline)).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "message 1" }),
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), liveTurn);
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        resumeSessionId: NATIVE_SESSION_ID,
      }),
    );
    expect(runtime.starts[1]?.model).toBeUndefined();
    expect(runtime.starts[1]?.thinkingOption).toBeUndefined();
    expect(runtime.starts[1]?.systemPrompt).toBeUndefined();
    expect(sessionAt(runtime, 1).historyRequests).toBe(1);
    expect(replayEvents).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: MODEL_PUBLIC_ID,
          thinkingOption: "medium",
        }),
      }),
    );
    sessionAt(runtime, 1).emit({ type: "process_exit", error: "restart persisted session" });
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    const recoveryTurn = turnIdFrom(
      await startPrompt(connection, events, "persisted-recovery", "continue", "resumed-session"),
    );
    expect(runtime.starts[2]).toEqual(
      expect.objectContaining({ resumeSessionId: NATIVE_SESSION_ID }),
    );
    expect(runtime.starts[2]?.systemPrompt).toBeUndefined();
    await finishTurn(events, sessionAt(runtime, 2), recoveryTurn);
    await connection.close();
  });
  test("keeps replay-boundary counts beyond 1,024 occurrences", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryMessages = Array.from({ length: 1_025 }, (_, index): OmpMessage[] => [
      { role: "user", id: `large-user-${index}`, content: `prompt ${index}` },
      { role: "assistant", id: "shared-replay-id", content: "same answer" },
    ]).flat();
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "large-dedup-open",
      sessionId: "large-dedup-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "large-dedup-open",
    );
    const replayedAssistants = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );

    expect(replayedAssistants).toHaveLength(1_025);
    expect(new Set(replayedAssistants.map((item) => item.id)).size).toBe(1_025);
    const session = sessionAt(runtime);
    session.promptEvents = [
      {
        type: "message_start",
        message: { role: "assistant", id: "shared-replay-id", content: [] },
      },
      {
        type: "message_update",
        message: { role: "assistant", id: "shared-replay-id", content: "same" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "same" },
      },
      {
        type: "message_end",
        message: { role: "assistant", id: "shared-replay-id", content: "same answer" },
      },
    ];
    const boundaryBaseline = events.length;
    const liveTurn = turnIdFrom(
      await startPrompt(connection, events, "large-dedup-live", "continue", "large-dedup-session"),
    );
    expect(events.slice(boundaryBaseline).some((event) => event.type === "timeline.item")).toBe(
      false,
    );

    const liveBaseline = events.length;
    session.emit({
      type: "message_end",
      message: { role: "assistant", id: "shared-replay-id", content: "same answer" },
    });
    expect(events.slice(liveBaseline)).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "same answer" }),
      }),
    );
    await finishTurn(events, session, liveTurn);
    await connection.close();
  });
  test("scopes identical replay occurrences to the replay boundary", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const duplicate = {
      role: "assistant" as const,
      entryId: "shared-assistant-entry",
      responseId: "shared-response",
      content: "same answer",
    };
    runtime.nextHistoryMessages = [
      { role: "user", entryId: "replay-user-1", content: "first" },
      duplicate,
      { role: "user", entryId: "replay-user-2", content: "second" },
      duplicate,
    ];
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "occurrence-open",
      sessionId: "occurrence-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "occurrence-open",
    );
    const replayedAssistants = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(replayedAssistants.map((item) => item.text)).toEqual(["same answer", "same answer"]);
    expect(new Set(replayedAssistants.map((item) => item.id)).size).toBe(2);

    const session = sessionAt(runtime);
    session.promptEvents = [{ type: "message_end", message: duplicate }];
    const boundaryBaseline = events.length;
    const turnId = turnIdFrom(
      await startPrompt(connection, events, "occurrence-live", "continue", "occurrence-session"),
    );
    expect(
      events
        .slice(boundaryBaseline)
        .filter(
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        ),
    ).toHaveLength(0);

    const liveBaseline = events.length;
    session.emit({ type: "message_end", message: duplicate });
    expect(
      events
        .slice(liveBaseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        ),
    ).toEqual(["same answer"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("suppresses a replay duplicate after buffering 512 stream events", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector("event-limit-session", (event) =>
      events.push(event),
    );
    const duplicate = {
      role: "assistant" as const,
      entryId: "event-limit-entry",
      content: "same answer",
    };
    projector.projectReplayMessage(duplicate);
    projector.finishReplay();
    const baseline = events.length;
    projector.project({ type: "message_start", message: duplicate }, "replay-boundary");
    for (let index = 0; index < 511; index += 1) {
      projector.project(
        {
          type: "message_update",
          message: duplicate,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
        },
        "replay-boundary",
      );
    }
    projector.project({ type: "message_end", message: duplicate }, "replay-boundary");
    expect(events.slice(baseline)).toHaveLength(0);
    projector.close();
  });

  test("suppresses a replay duplicate after buffering four MiB", () => {
    const events: ProviderEvent[] = [];
    const projector = new OmpTimelineProjector("byte-limit-session", (event) => events.push(event));
    const content = "x".repeat(1024 * 1024);
    const duplicate = { role: "assistant" as const, entryId: "byte-limit-entry", content };
    projector.projectReplayMessage(duplicate);
    projector.finishReplay();
    const baseline = events.length;
    projector.project(
      { type: "message_start", message: { ...duplicate, content: [] } },
      "replay-boundary",
    );
    for (let index = 0; index < 4; index += 1) {
      projector.project(
        {
          type: "message_update",
          message: duplicate,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
        },
        "replay-boundary",
      );
    }
    projector.project({ type: "message_end", message: duplicate }, "replay-boundary");
    expect(events.slice(baseline)).toHaveLength(0);
    projector.close();
  });

  test("ignores stale resume thinking and rejects unsupported restored thinking", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextThinkingLevel = "max";
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "unsupported-restored-thinking",
      sessionId: "unsupported-restored-thinking-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        thinkingOption: "low",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    const failure = await events.waitFor(
      (event) =>
        event.type === "request.failed" && event.requestId === "unsupported-restored-thinking",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP runtime selected an unsupported thinking level" },
      }),
    );
    expect(runtime.starts[0]?.thinkingOption).toBeUndefined();
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    await connection.close();
  });

  test("rejects path-shaped or unresolved persistence without starting OMP", async () => {
    const runtime = new FakeOmpRuntime();

    runtime.resolveSessions = false;
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    for (const [requestId, sessionId] of [
      ["path-resume", "../../secret/session.jsonl"],
      ["missing-resume", NATIVE_SESSION_ID],
    ] as const) {
      await connection.send({
        type: "session.open",
        requestId,
        sessionId: `provider-${requestId}`,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId } },
        history: "replay",
      });
      await events.waitFor(
        (event) => event.type === "request.failed" && event.requestId === requestId,
      );
    }
    expect(runtime.starts).toHaveLength(0);
    expect(runtime.sessionListRequests).toEqual([
      { sessionId: NATIVE_SESSION_ID, cwd: "/repo", limit: 2 },
    ]);
    await connection.close();
  });
  test("rejects a persistence descriptor when persist is false", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await connection.send({
      type: "session.open",
      requestId: "nonpersistent-resume",
      sessionId: "nonpersistent-resume-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: false,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    const failure = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "nonpersistent-resume",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: { message: "OMP persisted sessions require persist: true" },
      }),
    );
    expect(runtime.sessionListRequests).toEqual([]);
    expect(runtime.starts).toEqual([]);
    await connection.close();
  });
  test("reserves one native transcript across concurrent public opens", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const sendResume = (requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
    await sendResume("first-native-open", "public-one");
    await started.promise;
    await sendResume("second-native-open", "public-two");
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "second-native-open",
    );
    expect(rejected).toEqual(
      expect.objectContaining({ error: { message: "OMP native session is already open" } }),
    );
    expect(runtime.starts).toHaveLength(1);
    runtime.startGate = null;
    gate.resolve();
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "first-native-open",
    );
    await connection.send({
      type: "session.close",
      requestId: "close-first",
      sessionId: "public-one",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-first",
    );
    await sendResume("third-native-open", "public-three");
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "third-native-open",
    );
    expect(runtime.starts).toHaveLength(2);
    await connection.close();
  });
  test("reserves native transcripts across provider connections until disposal", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
    const provider = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.persistence"],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    const openResume = (connection: ProviderConnection, requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
    await openResume(first.connection, "cross-connection-first", "cross-connection-owner");
    await started.promise;
    runtime.startGate = null;
    await openResume(second.connection, "cross-connection-second", "cross-connection-contender");
    const rejected = await second.events.waitFor(
      (event) =>
        (event.type === "request.failed" || event.type === "session.ready") &&
        event.requestId === "cross-connection-second",
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        type: "request.failed",
        error: { message: "OMP native session is already open" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    gate.resolve();
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "cross-connection-first",
    );
    await first.connection.close();
    await openResume(second.connection, "cross-connection-third", "cross-connection-successor");
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "cross-connection-third",
    );
    expect(runtime.starts).toHaveLength(2);
    await second.connection.close();
  });
  test("blocks list and resume while a new persistent session acquires its native ID", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionIds.push(NATIVE_SESSION_ID);
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
    const provider = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.list", "session.persistence"],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    await first.connection.send({
      type: "session.open",
      requestId: "new-persistent-open",
      sessionId: "new-persistent-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      history: "skip",
    });
    await started.promise;

    const rejectionStartedAt = performance.now();
    await second.connection.send({
      type: "sessions",
      requestId: "list-during-persistent-open",
      cwd: "/repo",
    });
    await second.connection.send({
      type: "session.open",
      requestId: "resume-during-persistent-open",
      sessionId: "resume-contender",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    const [listFailure, resumeFailure] = await Promise.all([
      second.events.waitFor(
        (event) =>
          event.type === "request.failed" && event.requestId === "list-during-persistent-open",
      ),
      second.events.waitFor(
        (event) =>
          event.type === "request.failed" && event.requestId === "resume-during-persistent-open",
      ),
    ]);
    expect(performance.now() - rejectionStartedAt).toBeLessThan(1_000);
    expect(listFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP persistent session registration is in progress" },
      }),
    );
    expect(resumeFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP persistent session registration is in progress" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.sessionListRequests).toEqual([]);

    runtime.startGate = null;
    gate.resolve();
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "new-persistent-open",
    );
    await second.connection.send({
      type: "sessions",
      requestId: "list-after-persistent-open",
      cwd: "/repo",
    });
    await second.events.waitFor(
      (event) => event.type === "sessions" && event.requestId === "list-after-persistent-open",
    );
    await first.connection.close();
    await second.connection.close();
  });

  test("keeps the native transcript reserved while its session recovers", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const openResume = (requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
    await openResume("recovery-owner-open", "recovery-owner");
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "recovery-owner-open",
    );
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    runtime.startGate = gate.promise;
    runtime.startObserved = started.resolve;
    sessionAt(runtime).emit({ type: "process_exit", error: "recover" });
    const recovering = startPrompt(
      connection,
      events,
      "recovery-owner-prompt",
      "continue",
      "recovery-owner",
    );
    await started.promise;
    await openResume("recovery-contender-open", "recovery-contender");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "recovery-contender-open",
    );
    expect(runtime.starts).toHaveLength(2);
    runtime.startGate = null;
    gate.resolve();
    const turnId = turnIdFrom(await recovering);
    await finishTurn(events, sessionAt(runtime, 1), turnId);
    await connection.close();
  });

  test("keeps a native transcript reserved after unverified open cleanup", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryError = new Error("history failed");
    runtime.nextCloseError = new Error("cleanup failed");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const openResume = (requestId: string, sessionId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
    await openResume("tombstone-owner-open", "tombstone-owner");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "tombstone-owner-open",
    );
    await openResume("tombstone-contender-open", "tombstone-contender");
    const rejected = await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "tombstone-contender-open",
    );
    expect(rejected).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });
  test("blocks persistent and nonpersistent opens until cleanup is verified", async () => {
    const otherNativeSessionId = "01a08f6b-8da9-72cb-9080-fc50139bdfcb";
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push(
      { id: NATIVE_SESSION_ID, cwd: "/repo" },
      { id: otherNativeSessionId, cwd: "/repo" },
    );
    const cleanup = Promise.withResolvers<void>();
    runtime.nextHistoryError = new Error("history failed");
    runtime.nextCloseError = new OmpCleanupFailure("cleanup unresolved", cleanup.promise);
    const provider = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.list", "session.persistence"],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    const openResume = (
      connection: ProviderConnection,
      requestId: string,
      sessionId: string,
      nativeSessionId: string,
    ) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: nativeSessionId } },
        history: "replay",
      });
    await openResume(
      first.connection,
      "failed-cleanup-first",
      "failed-cleanup-owner",
      NATIVE_SESSION_ID,
    );
    await first.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "failed-cleanup-first",
    );
    await first.connection.close();

    await second.connection.send({
      type: "sessions",
      requestId: "quarantined-list",
      cwd: "/repo",
    });
    const listFailure = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "quarantined-list",
    );
    expect(listFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    await openResume(
      second.connection,
      "different-resume-blocked",
      "different-resume-contender",
      otherNativeSessionId,
    );
    const resumeFailure = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "different-resume-blocked",
    );
    expect(resumeFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );
    expect(runtime.starts).toHaveLength(1);
    await second.connection.send({
      type: "session.open",
      requestId: "nonpersistent-blocked",
      sessionId: "nonpersistent-during-quarantine",
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
    const nonpersistentFailure = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "nonpersistent-blocked",
    );
    expect(nonpersistentFailure).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );

    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();
    await second.connection.send({
      type: "sessions",
      requestId: "released-list",
      cwd: "/repo",
    });
    await second.events.waitFor(
      (event) => event.type === "sessions" && event.requestId === "released-list",
    );
    await second.connection.send({
      type: "session.open",
      requestId: "nonpersistent-released",
      sessionId: "nonpersistent-during-quarantine",
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
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "nonpersistent-released",
    );
    await openResume(
      second.connection,
      "different-resume-released",
      "different-resume-session",
      otherNativeSessionId,
    );
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "different-resume-released",
    );
    expect(runtime.starts).toHaveLength(3);
    await second.connection.close();
  });

  test("caps provider-global cleanup quarantine growth", () => {
    const reservations = new OmpNativeSessionReservations();
    const entries = Array.from({ length: 256 }, (_, index) => ({
      owner: Symbol(`quarantine-${index}`),
      nativeSessionId: `quarantined-native-${index}`,
    }));
    for (const { nativeSessionId, owner } of entries) {
      reservations.reserve(nativeSessionId, owner);
    }
    expect(() => reservations.reserve("quarantine-overflow", Symbol("overflow"))).toThrow(
      "OMP persistent session registry limit reached",
    );
    for (const { nativeSessionId, owner } of entries) {
      reservations.quarantine(nativeSessionId, owner);
    }
    expect(() => reservations.assertListable()).toThrow(
      "OMP native session cleanup quarantine is active",
    );
  });

  test("publishes selected branch history from chunked OMP RPC before ready", async () => {
    const largeText = "x".repeat(600_000);
    let child: ProviderRpcChild;
    child = new ProviderRpcChild((command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_state") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            model: MODEL,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            sessionId: NATIVE_SESSION_ID,
          },
        });
      } else if (command.type === "get_available_models") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { models: [MODEL] },
        });
      } else if (command.type === "get_available_commands") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { commands: [] },
        });
      } else if (command.type === "get_messages") {
        child.writeChunked(
          {
            type: "response",
            id: command.id,
            success: true,
            data: {
              messages: [
                { role: "user", id: "selected-user", content: "selected branch" },
                {
                  role: "assistant",
                  responseId: "selected-assistant-1",
                  content: [
                    { type: "text", text: largeText },
                    {
                      type: "toolCall",
                      id: "selected-tool",
                      name: "read",
                      arguments: { path: "selected.ts" },
                    },
                  ],
                },
                {
                  role: "toolResult",
                  toolCallId: "selected-tool",
                  toolName: "read",
                  content: [{ type: "text", text: "selected result" }],
                },
                { role: "bashExecution", command: "pwd", output: "/repo\n", exitCode: 0 },
                {
                  role: "assistant",
                  responseId: "selected-assistant-2",
                  content: largeText,
                },
              ],
            },
          },
          "selected-history",
        );
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
      listSessions: () => [{ id: NATIVE_SESSION_ID, cwd: "/repo" }],
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    queueMicrotask(() =>
      child.write({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "selected-branch-open",
      sessionId: "selected-branch-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "selected-branch-open",
    );
    const readyIndex = events.findIndex((event) => event.type === "session.ready");
    const timeline = events.flatMap((event, index) =>
      event.type === "timeline.item" ? [{ index, item: event.item }] : [],
    );
    expect(timeline.every((entry) => entry.index < readyIndex)).toBe(true);
    expect(timeline.map((entry) => entry.item.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_call",
      "assistant_message",
      "assistant_message",
    ]);
    expect(timeline.filter((entry) => entry.item.type === "assistant_message")[0]?.item).toEqual(
      expect.objectContaining({ text: largeText }),
    );
    expect(
      timeline.find((entry) => entry.item.type === "tool_call" && entry.item.status === "completed")
        ?.item,
    ).toEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ input: { path: "selected.ts" } }),
      }),
    );
    await connection.close();
  });
  test("advances replay suppression at an in-chunk prompt acknowledgement", async () => {
    const duplicate = {
      role: "assistant" as const,
      entryId: "transport-shared-entry",
      responseId: "transport-shared-response",
      content: "same answer",
    };
    const preAckDuplicate = {
      ...duplicate,
      content: [
        { type: "thinking" as const, thinking: "pre-ack replay duplicate" },
        { type: "text" as const, text: "same answer" },
      ],
    };
    let child: ProviderRpcChild;
    child = new ProviderRpcChild((command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_state") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            model: MODEL,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            sessionId: NATIVE_SESSION_ID,
          },
        });
      } else if (command.type === "get_available_models") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { models: [MODEL] },
        });
      } else if (command.type === "get_available_commands") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { commands: [] },
        });
      } else if (command.type === "get_messages") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            messages: [
              { role: "user", entryId: "transport-user-1", content: "first" },
              preAckDuplicate,
              { role: "user", entryId: "transport-user-2", content: "second" },
              duplicate,
            ],
          },
        });
      } else if (command.type === "prompt") {
        child.stdout.write(
          `${[
            { type: "message_end", message: preAckDuplicate },
            {
              type: "response",
              id: command.id,
              success: true,
              data: { agentInvoked: true },
            },
            { type: "message_end", message: duplicate },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n")}\n`,
        );
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
      listSessions: () => [{ id: NATIVE_SESSION_ID, cwd: "/repo" }],
    });
    const connection = await createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events = new EventLog();
    connection.onEvent((event) => events.push(event));
    queueMicrotask(() =>
      child.write({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
      }),
    );
    await connection.send({
      type: "session.open",
      requestId: "transport-boundary-open",
      sessionId: "transport-boundary-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "transport-boundary-open",
    );
    const replayedAssistants = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(replayedAssistants.map((item) => item.text)).toEqual(["same answer", "same answer"]);

    const baseline = events.length;
    const turnId = turnIdFrom(
      await startPrompt(
        connection,
        events,
        "transport-boundary-prompt",
        "continue",
        "transport-boundary-session",
      ),
    );
    expect(
      events
        .slice(baseline)
        .flatMap((event) =>
          event.type === "timeline.item" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        ),
    ).toEqual(["same answer"]);
    expect(
      events
        .slice(baseline)
        .some((event) => event.type === "timeline.item" && event.item.type === "reasoning"),
    ).toBe(false);
    child.write({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    await connection.close();
  });
  test("rejects cwd relocation and unscoped listing before touching OMP", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/other" });
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.list",
      "session.persistence",
    ]);
    await connection.send({ type: "sessions", requestId: "unscoped-list" });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "unscoped-list",
    );
    await connection.send({
      type: "session.open",
      requestId: "wrong-cwd",
      sessionId: "wrong-cwd-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "wrong-cwd",
    );
    expect(runtime.starts).toHaveLength(0);
    expect(runtime.sessionListRequests).toEqual([
      { sessionId: NATIVE_SESSION_ID, cwd: "/repo", limit: 2 },
    ]);
    await connection.close();
  });

  test("makes replaying sessions closable and routes a ready-callback prompt", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const historyStarted = Promise.withResolvers<void>();
    runtime.nextHistoryObserved = historyStarted.resolve;
    runtime.nextHistoryGate = Promise.withResolvers<void>().promise;
    const stalled = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    await stalled.connection.send({
      type: "session.open",
      requestId: "stalled-replay",
      sessionId: "stalled-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await historyStarted.promise;
    await expect(stalled.connection.close()).resolves.toBeUndefined();
    expect(stalled.events.some((event) => event.type === "session.ready")).toBe(false);

    const readyRuntime = new FakeOmpRuntime();
    readyRuntime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const ready = await createHarness(readyRuntime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    ready.connection.onEvent((event) => {
      if (event.type !== "session.ready") return;
      void ready.connection.send({
        type: "session.prompt",
        sessionId: "ready-race-session",
        prompt: {
          clientMessageId: "ready-race-prompt",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "continue" }] },
        },
      });
    });
    await ready.connection.send({
      type: "session.open",
      requestId: "ready-race",
      sessionId: "ready-race-session",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    const result = await ready.events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "ready-race-prompt",
    );
    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "turn" }) }),
    );
    await ready.connection.close();
  });

  test("does not negotiate persistence when history replay is unavailable", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.supportsPersistence = false;
    const { connection } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    expect(connection.capabilities).toEqual(["prompt.message"]);
    await connection.close();
  });
  test("tombstones an unreaped session after history replay fails", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    runtime.nextHistoryError = new Error("invalid chunked history");
    runtime.nextCloseError = new Error("process tree not reaped");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
    ]);
    const open = (requestId: string) =>
      connection.send({
        type: "session.open",
        requestId,
        sessionId: "replay-failure-session",
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
    await open("replay-failure");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "replay-failure",
    );
    await open("replay-reopen");
    await events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "replay-reopen",
    );
    expect(runtime.starts).toHaveLength(1);
    expect(events.some((event) => event.type === "session.ready")).toBe(false);
    await expect(connection.close()).resolves.toBeUndefined();
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
  test("rejects malformed and unsupported permission responses", async () => {
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
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: "permission-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow();
    expect(connection.capabilities).not.toContain("permission");
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

    session.currentModel = ALTERNATE_MODEL;
    session.thinkingLevel = "high";
    const fallback = events.waitFor(
      (event) =>
        event.type === "session.config" &&
        event.config.model === ALTERNATE_MODEL_PUBLIC_ID &&
        event.config.thinkingOption === "high",
    );
    session.emit({
      type: "retry_fallback_succeeded",
      model: "openai/gpt-5.4:high",
      role: "default",
    });
    const fallbackConfig = await fallback;
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
        noSession: true,
      }),
    );
    expect(runtime.starts[1]?.resumeSessionId).toBeUndefined();
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
        noSession: true,
      }),
    );
    expect(runtime.starts[1]?.resumeSessionId).toBeUndefined();
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
        noSession: true,
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
        detail: { type: "unknown", input: { path: "file.ts" }, output: null },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: {
          type: "unknown",
          input: { path: "file.ts" },
          output: { content: "partial" },
        },
        status: "running",
        error: null,
      },
      {
        type: "tool_call",
        id: "omp:tool:1",
        callId: "omp:tool:1",
        name: "read",
        detail: {
          type: "unknown",
          input: { path: "file.ts" },
          output: { content: "complete" },
        },
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
    const { connection, events, runtime, scheduler } = await createHarness();
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
        content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
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
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });
    await scheduler.flush();

    expect(
      events.filter(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          id: "omp:assistant:1:-588CG_nYBzM:content:1:text",
          text: "after image",
        }),
      }),
    ]);
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
        role: "custom" as const,
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
        detail: { type: "unknown", input: { path: "active.ts" }, output: null },
      }),
      expect.objectContaining({
        status: "running",
        detail: {
          type: "unknown",
          input: { path: "active.ts" },
          output: { content: "still active." },
        },
      }),
      expect.objectContaining({
        status: "completed",
        detail: {
          type: "unknown",
          input: { path: "active.ts" },
          output: { content: "done" },
        },
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
          detail: { type: "unknown", input: { path: "after.ts" }, output: null },
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
          detail: {
            type: "unknown",
            input: { path: "after.ts" },
            output: { content: "partial" },
          },
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
          detail: {
            type: "unknown",
            input: { path: "after.ts" },
            output: { content: "done" },
          },
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

  test("does not complete after a suspended local timer loses to steering", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.promptAgentInvoked = false;
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-suspended-local", text: "work" }];
    const turnId = turnIdFrom(await startPrompt(connection, events, "suspended-local", "work"));
    session.emit({ type: "message_end", message: { role: "user", content: "work" } });

    const [localCompletion] = scheduler.runPending();
    if (!localCompletion) throw new Error("Expected the local completion timer to start");
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "steer-after-timer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "continue" }] },
      },
    });
    await steerObserved.promise;
    session.emit({
      type: "message_end",
      message: { role: "user", content: "continue", entryId: "entry-after-timer" },
    });

    branchGate.resolve();
    await localCompletion;
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);

    steerGate.resolve();
    const steerResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "steer-after-timer",
    );
    expect(steerResult).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "steer-after-timer",
      result: { type: "steer", turnId },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([]);

    session.emit({ type: "agent_end", messages: [], isTerminal: true });
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
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([terminal]);
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
      result: {
        type: "failed",
        error: { message: "OMP slash commands are unavailable while steering" },
      },
    });
    expect(session.availableCommandLookups).toBe(4);
    expect(session.steers).toEqual([pathProse]);
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

  test("bounds a dataless prompt acknowledgement with local completion", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).promptAgentInvoked = undefined;
    const result = await startPrompt(connection, events, "dataless-1", "local command");
    const turnId = turnIdFrom(result);

    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );

    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
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
      expect(runtime.starts[1]).toEqual(expect.objectContaining({ noSession: true }));
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
        noSession: true,
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
        noSession: true,
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

  test("retires timed-out state confirmation after completing the authoritative agent_end", async () => {
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
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

  test("retires unavailable state confirmation after completing agent_end", async () => {
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
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(session.closes).toBe(1);
    const recoveredTurn = turnIdFrom(
      await startPrompt(connection, events, "after-unavailable", "continue"),
    );
    expect(runtime.starts[1]).toEqual(expect.objectContaining({ noSession: true }));
    await finishTurn(events, sessionAt(runtime, 1), recoveredTurn);
    await connection.close();
  });

  test("fails and retires a still-active completion state", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branch = Promise.withResolvers<void>();
    session.branchMessagesGate = branch.promise;
    session.isStreaming = true;
    const turnId = turnIdFrom(await startPrompt(connection, events, "active-state", "work"));

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
        error: { message: "OMP agent_end arrived while the native runtime remained active" },
      }),
    );
    expect(
      events.some((event) => event.type === "timeline.item" && event.item.type === "user_message"),
    ).toBe(true);
    expect(session.closes).toBe(1);
    await startPrompt(connection, events, "after-active", "continue");
    expect(runtime.starts[1]).toEqual(expect.objectContaining({ noSession: true }));
    await connection.close();
  });

  test("recovers an ephemeral session without a native transcript handle", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.sessionIds.push("");
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });

    const result = await startPrompt(connection, events, "missing-handle", "continue");
    const turnId = turnIdFrom(result);
    expect(runtime.starts).toHaveLength(2);
    expect(runtime.starts[1]).toEqual(expect.objectContaining({ noSession: true }));
    expect(runtime.starts[1]?.resumeSessionId).toBeUndefined();
    await finishTurn(events, sessionAt(runtime, 1), turnId);
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
  test("retains failed fresh replacement cleanup until explicit close reports it", async () => {
    const runtime = new FakeOmpRuntime();
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    runtime.nextModel = ALTERNATE_MODEL;
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

  test("releases recovery cleanup quarantine after verification", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const cleanup = Promise.withResolvers<void>();
    const provider = createOmpProvider({ runtime, environment: TEST_RUNTIME_ENV });
    const connect = async () => {
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "session.persistence"],
      });
      const events = new EventLog();
      connection.onEvent((event) => events.push(event));
      return { connection, events };
    };
    const first = await connect();
    const second = await connect();
    await first.connection.send({
      type: "session.open",
      requestId: "recovery-cleanup-open",
      sessionId: "recovery-cleanup-owner",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        mode: "full",
        settings: {},
        persist: true,
      },
      persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      history: "replay",
    });
    await first.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "recovery-cleanup-open",
    );

    runtime.nextStartError = new OmpCleanupFailure(
      "recovery startup cleanup failed",
      cleanup.promise,
    );
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    for (const clientMessageId of ["failed-recovery-start", "blocked-recovery-retry"]) {
      const result = await startPrompt(
        first.connection,
        first.events,
        clientMessageId,
        "continue",
        "recovery-cleanup-owner",
      );
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
    await first.connection.send({
      type: "session.close",
      requestId: "recovery-cleanup-close",
      sessionId: "recovery-cleanup-owner",
    });
    await first.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "recovery-cleanup-close",
    );
    await first.connection.close();

    await second.connection.send({
      type: "session.open",
      requestId: "recovery-cleanup-blocked",
      sessionId: "recovery-cleanup-successor",
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
    const blocked = await second.events.waitFor(
      (event) => event.type === "request.failed" && event.requestId === "recovery-cleanup-blocked",
    );
    expect(blocked).toEqual(
      expect.objectContaining({
        error: { message: "OMP native session cleanup quarantine is active" },
      }),
    );

    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();
    await second.connection.send({
      type: "session.open",
      requestId: "recovery-cleanup-released",
      sessionId: "recovery-cleanup-successor",
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
    await second.events.waitFor(
      (event) => event.type === "session.ready" && event.requestId === "recovery-cleanup-released",
    );
    expect(runtime.starts).toHaveLength(3);
    await second.connection.close();
  });

  test("fails a degraded terminal frame with no outcome messages", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "degraded-1", "work");
    const turnId = turnIdFrom(result);
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
    });

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
              id: "omp:todo:0",
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
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "permission-turn", "work"));
    sessionAt(runtime).emit({
      type: "extension_ui_request",
      id: "permission-request",
      method: "confirm",
      title: "Approve API_KEY=secret-value from /home/private/file",
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
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === firstTurn && event.state === "canceled",
    );
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
    session.emit({
      type: "agent_end",
      messages: [
        ...Array.from({ length: 128 }, () => ({ role: "assistant" as const, content: "ok" })),
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
      type: "agent_end",
      messages: [
        ...Array.from({ length: 128 }, () => ({ role: "assistant" as const, content: "ok" })),
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
      expect(launchArgs[index + 2]).toContain("--no-session");
      expect(launchArgs[index + 2]).not.toContain("--resume");
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
    expect(launchArgs[5]).toContain("--no-session");
    expect(launchArgs[5]).not.toContain("--resume");
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

  test("publishes one task child once and keeps its parent active", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-single",
      toolName: "task",
      args: { tasks: [{ task: "inspect" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-single",
      toolName: "task",
      result: { details: { results: [{ id: "native-child-single", agent: "scout" }] } },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-child-single",
        agent: "scout",
        description: "Inspect the implementation",
        status: "started",
        sessionFile: "/sessions/root/native-child-single.jsonl",
        parentToolCallId: "task-single",
        index: 0,
      },
    });
    const opened = events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (opened?.type !== "session.opened") throw new Error("Missing child session");
    expect(opened).toEqual(
      expect.objectContaining({
        capabilities: [],
        restoration: "parent",
        title: "scout",
      }),
    );
    session.emit({
      type: "subagent_event",
      payload: {
        id: "native-child-single",
        event: {
          type: "message_end",
          message: { role: "assistant", responseId: "child-answer", content: "child output" },
        },
      },
    });
    session.emit({
      type: "subagent_event",
      payload: {
        id: "native-child-single",
        event: {
          type: "message_end",
          message: { role: "assistant", responseId: "child-answer", content: "child output" },
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === opened.sessionId &&
          event.item.type === "assistant_message" &&
          event.item.text === "child output",
      ),
    ).toHaveLength(1);
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === "session-1" &&
          event.state !== "started",
      ),
    ).toBe(false);
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-child-single",
        agent: "scout",
        status: "completed",
        sessionFile: "/sessions/root/native-child-single.jsonl",
        parentToolCallId: "task-single",
        index: 0,
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.filter(
        (event) => event.type === "session.opened" && event.sessionId === opened.sessionId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === opened.sessionId &&
          event.state === "completed",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("keeps a batch dispatch active across gaps between child starts", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-batch",
      toolName: "task",
      args: { tasks: [{ task: "one" }, { task: "two" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-batch",
      toolName: "task",
      result: { message: "Spawned 2 background agents" },
    });
    for (const status of ["started", "completed"] as const) {
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-batch-one",
          agent: "first",
          status,
          sessionFile: "/sessions/root/native-batch-one.jsonl",
          parentToolCallId: "task-batch",
          index: 0,
        },
      });
    }
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
      ),
    ).toBe(false);
    for (const status of ["started", "completed"] as const) {
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-batch-two",
          agent: "second",
          status,
          sessionFile: "/sessions/root/native-batch-two.jsonl",
          parentToolCallId: "task-batch",
          index: 1,
        },
      });
    }
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.filter(
        (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
      ),
    ).toHaveLength(2);
    await connection.close();
  });

  test("publishes nested task children beneath their native parent", async () => {
    const { connection, events, runtime } = await createHarness(
      new FakeOmpRuntime(),
      new ManualScheduler(),
      ["prompt.message", "session.subsession"],
    );
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    session.emit({
      type: "tool_execution_start",
      toolCallId: "root-task",
      toolName: "task",
      args: { tasks: [{ task: "parent" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "root-task",
      toolName: "task",
      result: { message: "spawned" },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-parent-child",
        agent: "parent-child",
        status: "started",
        sessionFile: "/sessions/root/native-parent-child.jsonl",
        parentToolCallId: "root-task",
        index: 0,
      },
    });
    const parentChild = events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (parentChild?.type !== "session.opened") throw new Error("Missing parent child session");
    for (const event of [
      {
        type: "tool_execution_start" as const,
        toolCallId: "nested-task",
        toolName: "task",
        args: { tasks: [{ task: "grandchild" }] },
      },
      {
        type: "tool_execution_end" as const,
        toolCallId: "nested-task",
        toolName: "task",
        result: { message: "spawned" },
      },
    ]) {
      session.emit({ type: "subagent_event", payload: { id: "native-parent-child", event } });
    }
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-grandchild",
        agent: "grandchild",
        status: "started",
        sessionFile: "/sessions/root/native-parent-child/native-grandchild.jsonl",
        parentToolCallId: "nested-task",
        index: 0,
      },
    });
    const grandchild = events.findLast(
      (event) => event.type === "session.opened" && event.parentSessionId === parentChild.sessionId,
    );
    expect(grandchild).toEqual(expect.objectContaining({ type: "session.opened" }));
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-parent-child",
        agent: "parent-child",
        status: "completed",
        sessionFile: "/sessions/root/native-parent-child.jsonl",
        parentToolCallId: "root-task",
        index: 0,
      },
    });
    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === parentChild.sessionId &&
          event.state === "completed",
      ),
    ).toBe(false);
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "native-grandchild",
        agent: "grandchild",
        status: "completed",
        sessionFile: "/sessions/root/native-parent-child/native-grandchild.jsonl",
        parentToolCallId: "nested-task",
        index: 0,
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === parentChild.sessionId &&
          event.state === "completed",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("replays resumed child timelines once with stable native identity", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: "/repo" });
    const configureReplay = () => {
      runtime.nextHistoryMessages = [
        {
          role: "assistant",
          responseId: "root-task-message",
          content: [
            {
              type: "toolCall",
              id: "replayed-task",
              name: "task",
              arguments: { agent: "scout", task: "inspect" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "replayed-task",
          toolName: "task",
          content: [{ type: "text", text: "done" }],
          details: { results: [{ id: "native-replayed-child", agent: "scout", exitCode: 0 }] },
        },
      ];
      runtime.nextSubagents = [
        {
          id: "native-replayed-child",
          index: 0,
          agent: "scout",
          status: "completed",
          sessionFile: "/sessions/root/native-replayed-child.jsonl",
          lastUpdate: 42,
          parentToolCallId: "replayed-task",
        },
      ];
      runtime.nextSubagentMessages.set("native-replayed-child", {
        sessionFile: "/sessions/root/native-replayed-child.jsonl",
        fromByte: 0,
        nextByte: 42,
        reset: false,
        messages: [
          { role: "user", entryId: "child-user", content: "inspect" },
          { role: "assistant", responseId: "child-response", content: "replayed child output" },
        ],
      });
    };
    configureReplay();
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "session.persistence",
      "session.subsession",
    ]);
    const openReplay = async (requestId: string, sessionId: string) => {
      const baseline = events.length;
      await connection.send({
        type: "session.open",
        requestId,
        sessionId,
        config: {
          cwd: "/repo",
          env: {},
          mcpServers: {},
          mode: "full",
          settings: {},
          persist: true,
        },
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
        history: "replay",
      });
      await events.waitFor(
        (event) => event.type === "session.ready" && event.requestId === requestId,
      );
      const replay = events.slice(baseline);
      const childOpened = replay.find(
        (event) => event.type === "session.opened" && event.parentSessionId === sessionId,
      );
      if (childOpened?.type !== "session.opened") throw new Error("Missing replayed child");
      expect(
        replay.filter(
          (event) =>
            event.type === "timeline.item" &&
            event.sessionId === childOpened.sessionId &&
            event.item.type === "assistant_message",
        ),
      ).toHaveLength(1);
      expect(
        replay.filter(
          (event) => event.type === "session.opened" && event.sessionId === childOpened.sessionId,
        ),
      ).toHaveLength(1);
      return childOpened.sessionId;
    };
    const firstChildId = await openReplay("replay-one", "resumed-one");
    await connection.send({
      type: "session.close",
      requestId: "close-replay-one",
      sessionId: "resumed-one",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-replay-one",
    );
    configureReplay();
    const secondChildId = await openReplay("replay-two", "resumed-two");
    expect(secondChildId).toBe(firstChildId);
    await connection.close();
  });

  test("publishes failed and canceled child terminal states exactly once", async () => {
    for (const terminal of ["failed", "aborted"] as const) {
      const { connection, events, runtime } = await createHarness(
        new FakeOmpRuntime(),
        new ManualScheduler(),
        ["prompt.message", "session.subsession"],
      );
      await openSession(connection, events);
      const session = sessionAt(runtime);
      const turnId = turnIdFrom(await startPrompt(connection, events));
      session.emit({
        type: "tool_execution_start",
        toolCallId: `task-${terminal}`,
        toolName: "task",
        args: { tasks: [{ task: terminal }] },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: `task-${terminal}`,
        toolName: "task",
        result: { message: "spawned" },
      });
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: `native-${terminal}`,
          agent: terminal,
          status: "started",
          parentToolCallId: `task-${terminal}`,
          index: 0,
        },
      });
      session.emit({ type: "agent_end", messages: [], isTerminal: true });
      if (terminal === "aborted") {
        await connection.send({
          type: "session.interrupt",
          requestId: "cancel-parent",
          sessionId: "session-1",
        });
      }
      session.emit({
        type: "subagent_lifecycle",
        payload: {
          id: `native-${terminal}`,
          agent: terminal,
          status: terminal,
          parentToolCallId: `task-${terminal}`,
          index: 0,
        },
      });
      const expected = terminal === "failed" ? "failed" : "canceled";
      await events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      );
      const childOpened = events.find(
        (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
      );
      if (childOpened?.type !== "session.opened") throw new Error("Missing terminal child");
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.sessionId === childOpened.sessionId &&
            event.state === expected,
        ),
      ).toHaveLength(1);
      await connection.close();
    }
  });

  test("omits subsession capabilities when OMP cannot subscribe", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.nextSubagentSubscriptionError = new Error("unsupported command");
    const { connection, events } = await createHarness(runtime, new ManualScheduler(), [
      "prompt.message",
      "prompt.steer",
      "session.subsession",
    ]);
    await openSession(connection, events);
    expect(
      events.find((event) => event.type === "session.opened" && event.sessionId === "session-1"),
    ).toEqual(expect.objectContaining({ capabilities: ["prompt.message", "prompt.steer"] }));
    expect(connection.capabilities).toContain("session.subsession");
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
});
