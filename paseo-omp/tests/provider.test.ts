import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type {
  OmpModel,
  OmpRpcEvent,
  OmpRuntime,
  OmpRuntimeSession,
  OmpStartOptions,
} from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import type { OmpTimelineScheduler } from "../server/provider/timeline-projector";

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

class ManualScheduler implements OmpTimelineScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void | Promise<void>>();
  readonly delays: number[] = [];

  set(callback: () => void | Promise<void>, delayMs: number): number {
    const id = this.nextId;
    this.delays.push(delayMs);
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
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
  availableCommandsObserved: (() => void) | null = null;
  readonly modelChanges: Array<{ provider: string; modelId: string }> = [];
  readonly thinkingChanges: string[] = [];
  branchMessages: Array<{ entryId: string; text: string }> = [];
  currentModel = MODEL;
  nativeSessionId = "native-session";
  stateGate: Promise<void> | null = null;
  stateError: Error | null = null;
  isStreaming = false;
  isCompacting = false;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = "medium";
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
    if (this.stateGate) await this.stateGate;
    if (this.stateError) throw this.stateError;
    return {
      model: this.currentModel,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      sessionId: this.nativeSessionId,
    };
  }

  getAvailableModels() {
    return Promise.resolve([MODEL, ALTERNATE_MODEL]);
  }

  async getAvailableCommands() {
    this.availableCommandLookups += 1;
    this.availableCommandsObserved?.();
    if (this.availableCommandsGate) await this.availableCommandsGate;
    if (this.availableCommandsError) throw this.availableCommandsError;
    return this.availableCommands;
  }
  async prompt(message: string) {
    this.prompts.push(message);
    this.promptCount += 1;
    this.promptObserved?.();
    if (this.promptGate) await this.promptGate;
    for (const event of this.promptEvents) this.emit(event);
    return {
      requestId: `rpc-prompt-${this.promptCount}`,
      agentInvoked: this.promptAgentInvoked,
    };
  }

  setModel(provider: string, modelId: string) {
    this.modelChanges.push({ provider, modelId });
    const model = [MODEL, ALTERNATE_MODEL].find(
      (candidate) => candidate.provider === provider && candidate.id === modelId,
    );
    if (!model) return Promise.reject(new Error("unknown model"));
    this.currentModel = model;
    return Promise.resolve(model);
  }

  setThinkingLevel(level: string) {
    this.thinkingChanges.push(level);
    if (!isThinkingLevel(level)) return Promise.reject(new Error("invalid thinking level"));
    this.thinkingLevel = level;
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
  nextCloseError: Error | null = null;
  startGate: Promise<void> | null = null;
  startObserved: (() => void) | null = null;
  commandDiscoveryError: Error | null = null;
  availableCommands: Array<{ name: string; aliases?: string[] }> = [{ name: "help" }];
  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    this.starts.push(options);
    this.startObserved?.();
    if (this.startGate) await this.startGate;
    const session = new FakeOmpSession();
    session.availableCommandsError = this.commandDiscoveryError;
    session.availableCommands = this.availableCommands.map((command) => ({
      ...command,
      ...(command.aliases ? { aliases: [...command.aliases] } : {}),
    }));
    session.nativeSessionId = this.sessionIds.shift() ?? session.nativeSessionId;
    if (this.nextModel) {
      session.currentModel = this.nextModel;
      this.nextModel = null;
    }
    if (this.nextThinkingLevel) {
      session.thinkingLevel = this.nextThinkingLevel;
      this.nextThinkingLevel = null;
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
  const connection = await createOmpProvider({ runtime, timelineScheduler: scheduler }).connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.steer", "session.configure"],
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
      model: "anthropic/claude-sonnet-4-5",
      mode: "full",
      thinkingOption: "medium",
      settings: {},
      persist: false,
    },
    history: "skip",
  });
  await events.waitFor((event) => event.type === "session.ready" && event.requestId === requestId);
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
        defaultModel: "anthropic/claude-sonnet-4-5",
        defaultMode: "full",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "anthropic/claude-sonnet-4-5" }),
          expect.objectContaining({ id: "openai/gpt-5.4" }),
        ]),
        modes: [expect.objectContaining({ id: "full" })],
      }),
    });
    expect(runtime.starts[0]).toEqual(expect.objectContaining({ cwd: "/repo", noSession: true }));
    expect(sessionAt(runtime).closes).toBe(1);
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
          model: "anthropic/claude-sonnet-4-5",
          mode: "full",
          modes: [expect.objectContaining({ id: "full" })],
          thinkingOption: "medium",
        }),
      }),
    );
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        model: "anthropic/claude-sonnet-4-5",
        mode: "full",
        thinkingOption: "medium",
        systemPrompt: "Be precise",
      }),
    );
    expect(connection.capabilities).toEqual([
      "prompt.message",
      "prompt.steer",
      "session.configure",
    ]);
    await connection.close();
  });

  test("rejects malformed capabilities and filters unsupported capability names", async () => {
    const provider = createOmpProvider({ runtime: new FakeOmpRuntime() });
    await expect(
      provider.connect({ versions: [1], capabilities: ["prompt.message", 42] } as never),
    ).rejects.toThrow("valid provider protocol version 1 request");

    const connection = await provider.connect({
      versions: [1],
      capabilities: ["prompt.message", "provider.admin"],
    });
    expect(connection.capabilities).toEqual(["prompt.message"]);
    await connection.close();
  });
  test("rejects malformed and unsupported permission responses", async () => {
    const runtime = new FakeOmpRuntime();
    const connection = await createOmpProvider({ runtime }).connect({
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
    const connection = await createOmpProvider({ runtime }).connect({
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
      changes: { model: "openai/gpt-5.4", thinkingOption: "high" },
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
        config: expect.objectContaining({ model: "openai/gpt-5.4", thinkingOption: "high" }),
      }),
      { type: "request.completed", requestId: "configure-1" },
    ]);
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
    const firstReasoning = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "reasoning",
    );
    expect(firstAssistant).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ text: "Hello" }) }),
    );
    expect(firstReasoning).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ text: "Thinking" }) }),
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

    const assistantItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
    );
    expect(assistantItems).toEqual([
      expect.objectContaining({
        id: "omp:assistant:1:FptmLPBZggWJ:content:0:text",
        messageId: "omp:assistant:1:FptmLPBZggWJ",
        text: "First",
      }),
      expect.objectContaining({
        id: "omp:assistant:2:bcYQ7w4CEWWL:content:0:text",
        messageId: "omp:assistant:2:bcYQ7w4CEWWL",
        text: "Second",
      }),
    ]);
    expect(assistantItems.some((item) => item.id.includes("generic-id"))).toBe(false);
    await finishTurn(events, session, turnId);
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
    expect(assistantItems).toEqual([
      {
        type: "assistant_message",
        id: "omp:assistant:1:LXEWQrcmsEQB:content:0:text",
        messageId: "omp:assistant:1:LXEWQrcmsEQB",
        text: "First",
      },
      {
        type: "assistant_message",
        id: "omp:assistant:2:f4WLYWiaVvzc:content:0:text",
        messageId: "omp:assistant:2:f4WLYWiaVvzc",
        text: "Adversarial",
      },
      {
        type: "assistant_message",
        id: "omp:assistant:3:LXEWQrcmsEQB:content:0:text",
        messageId: "omp:assistant:3:LXEWQrcmsEQB",
        text: "Third draft",
      },
      {
        type: "assistant_message",
        id: "omp:assistant:3:LXEWQrcmsEQB:content:0:text",
        messageId: "omp:assistant:3:LXEWQrcmsEQB",
        text: "Third final",
      },
    ]);
    expect(new Set(assistantItems.map((item) => item.messageId)).size).toBe(3);
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

    expect(
      events.flatMap((event) =>
        event.type === "timeline.item" &&
        (event.item.type === "assistant_message" || event.item.type === "reasoning")
          ? [event.item]
          : [],
      ),
    ).toEqual([
      {
        type: "reasoning",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:0:reasoning",
        text: "Reason A",
      },
      {
        type: "assistant_message",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:1:text",
        messageId: "omp:assistant:1:_rtzMvYnX4Ti",
        text: "Answer A",
      },
      {
        type: "reasoning",
        id: "omp:assistant:1:_rtzMvYnX4Ti:content:0:reasoning",
        text: "Reason A revised",
      },
    ]);
    await finishTurn(events, session, turnId);
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
      partialResult: { content: "still running" },
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
          output: { content: "still running" },
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
    const registration = createOmpProvider({ runtime, timelineScheduler: new ManualScheduler() });
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
      systemPrompt: "Be precise",
      mcpServers: {},
      modeId: "full",
      model: "anthropic/claude-sonnet-4-5",
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

    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    const turnId = turnIdFrom(await startPrompt(connection, events, "observed-config", "continue"));
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        model: "openai/gpt-5.4",
        thinkingOption: "high",
        resumeSessionId: "native-session",
      }),
    );
    await finishTurn(events, sessionAt(runtime, 1), turnId);
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
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({ resumeSessionId: "native-session" }),
    );
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
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({ resumeSessionId: "native-session" }),
    );
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
    await connection.close();
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

  test("redacts provider-owned timeline payloads and native identifiers", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
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
    session.emit({
      type: "tool_execution_start",
      toolCallId: "credential-value-1234",
      toolName: "write",
      args: { value: "safe" },
    });
    session.emit({
      type: "notice",
      level: "warning",
      message: "Authorization: Bearer token-not-from-env",
    });
    session.emit({ type: "command_output", text: "credential-value-" });
    session.emit({ type: "command_output", text: "1234" });
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
    expect(visible).not.toContain("provider-internal-tool-id");
    expect(visible).not.toContain("provider-internal-response-id");
    expect(visible).not.toContain("token-not-from-env");
    const toolIds = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item.callId] : [],
    );
    expect(new Set(toolIds).size).toBe(2);
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
    await connection.close();
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
});
