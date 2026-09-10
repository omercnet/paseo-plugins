import { describe, expect, test } from "bun:test";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import type {
  OmpModel,
  OmpRpcEvent,
  OmpRuntime,
  OmpRuntimeSession,
  OmpStartOptions,
} from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";
import type { OmpTimelineScheduler } from "../server/provider/timeline-projector";

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
  private readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];

  set(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.delays.push(delayMs);
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }

  async flush(): Promise<void> {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
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
  availableCommands: Array<{ name: string; aliases?: string[] }> = [{ name: "help" }];
  availableCommandsError: Error | null = null;
  readonly modelChanges: Array<{ provider: string; modelId: string }> = [];
  readonly thinkingChanges: string[] = [];
  branchMessages: Array<{ entryId: string; text: string }> = [];
  currentModel = MODEL;
  nativeSessionId = "native-session";
  stateGate: Promise<void> | null = null;
  stateError: Error | null = null;
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
      isStreaming: false,
      isCompacting: false,
      sessionId: this.nativeSessionId,
    };
  }

  getAvailableModels() {
    return Promise.resolve([MODEL, ALTERNATE_MODEL]);
  }

  getAvailableCommands() {
    if (this.availableCommandsError) return Promise.reject(this.availableCommandsError);
    return Promise.resolve(this.availableCommands);
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
  startGate: Promise<void> | null = null;
  startObserved: (() => void) | null = null;
  commandDiscoveryError: Error | null = null;

  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    this.starts.push(options);
    this.startObserved?.();
    if (this.startGate) await this.startGate;
    const session = new FakeOmpSession();
    session.availableCommandsError = this.commandDiscoveryError;
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
) {
  await connection.send({
    type: "session.open",
    requestId,
    sessionId,
    config: {
      cwd: "/repo",
      env: { TEST_ENV: "1" },
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
      "response-main:content:1:text",
      "response-main:content:1:text",
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === firstTurnId &&
          event.state !== "started",
      ),
    ).toHaveLength(1);
    const toolSnapshots = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "tool_call",
    );
    expect(toolSnapshots).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          id: "tool-1",
          status: "running",
          detail: { type: "unknown", input: { path: "file.ts" }, output: null },
        }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          id: "tool-1",
          status: "running",
          detail: {
            type: "unknown",
            input: { path: "file.ts" },
            output: { content: "partial" },
          },
        }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          id: "tool-1",
          status: "completed",
          detail: {
            type: "unknown",
            input: { path: "file.ts" },
            output: { content: "complete" },
          },
        }),
      }),
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
        id: "response-1:content:0:text",
        messageId: "response-1",
        text: "First",
      }),
      expect.objectContaining({
        id: "response-2:content:0:text",
        messageId: "response-2",
        text: "Second",
      }),
    ]);
    expect(assistantItems.some((item) => item.id.includes("generic-id"))).toBe(false);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("keeps interleaved indexed reasoning and text blocks stable", async () => {
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
      {
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "Reason B" },
        content: [
          { type: "thinking", thinking: "Reason A" },
          { type: "text", text: "Answer A" },
          { type: "thinking", thinking: "Reason B" },
        ],
      },
      {
        assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "Answer B" },
        content: [
          { type: "thinking", thinking: "Reason A" },
          { type: "text", text: "Answer A" },
          { type: "thinking", thinking: "Reason B" },
          { type: "text", text: "Answer B" },
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

    const projected = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
        ? [event.item]
        : [],
    );
    expect(projected.map((item) => [item.id, item.text])).toEqual([
      ["response-interleaved:content:0:reasoning", "Reason A"],
      ["response-interleaved:content:1:text", "Answer A"],
      ["response-interleaved:content:0:reasoning", "Reason A revised"],
      ["response-interleaved:content:2:reasoning", "Reason B"],
      ["response-interleaved:content:3:text", "Answer B"],
    ]);
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
          id: "response-image:content:1:text",
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
          id: "response-late:content:0:text",
          messageId: "response-late",
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
        id: "entry-repeat-1",
        messageId: "entry-repeat-1",
        clientMessageId: "same-1",
      }),
      expect.objectContaining({
        id: "entry-repeat-2",
        messageId: "entry-repeat-2",
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
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: "Mounted development tools",
        customType: "xdev-mount-notice",
        display: false,
      },
    });
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
        id: "entry-user-1",
        messageId: "entry-user-1",
        clientMessageId: "client-1",
      }),
      expect.objectContaining({
        id: "entry-steer-1",
        messageId: "entry-steer-1",
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
      event.item.id === "active-tool"
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

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "child-finish-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: childNotice }] },
      },
    });
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "child-finish-steer",
    );

    expect(result).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));
    expect(session.steers).toEqual([childNotice]);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "started",
      ),
    ).toHaveLength(1);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("keeps an accepted steer visible across the original agent end", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "hello", entryId: "entry-before-steer" },
    });
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
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);

    steerGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "accepted-after-end",
    );
    expect(result).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));
    session.emit({ type: "agent_start" });
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

    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "accepted-after-end",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("buffers an early steer echo and disables local-only completion on acceptance", async () => {
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
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    session.emit({
      type: "message_end",
      message: { role: "user", content: "focus", entryId: "entry-early-steer" },
    });
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "early-steer",
      ),
    ).toBe(false);

    steerGate.resolve();
    await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "early-steer",
    );
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: false });
    await scheduler.flush();
    session.emit({ type: "agent_start" });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "delayed-tool",
      toolName: "read",
      args: { path: "late.ts" },
    });

    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "early-steer",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "started",
      ),
    ).toHaveLength(1);
    expect(session.promptCount).toBe(1);
    expect(session.aborts).toBe(0);
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

    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
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
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
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
    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    expect(session.steers).toEqual([]);

    branchGate.resolve();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("retains all unseen branch entries for queued entry-less echoes", async () => {
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
    branchGate.resolve();
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "repeat-2",
    );

    const users = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(users).toEqual([
      expect.objectContaining({ id: "entry-repeat-1", clientMessageId: "repeat-1" }),
      expect.objectContaining({ id: "entry-repeat-2", clientMessageId: "repeat-2" }),
    ]);
    expect(session.branchMessageLookups).toBe(1);
    await finishTurn(events, session, turnId);
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
      expect.objectContaining({ id: "entry-queued-1", clientMessageId: "queued-1" }),
      expect.objectContaining({ id: "entry-queued-2", clientMessageId: "queued-2" }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toHaveLength(1);
    await connection.close();
  });

  test("fails closed slash steering and refreshes the native command catalog", async () => {
    const runtime = new FakeOmpRuntime();
    runtime.commandDiscoveryError = new Error("commands unavailable");
    const { connection, events } = await createHarness(runtime);
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "slash-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/help" }] },
      },
    });
    const result = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "slash-steer",
    );
    expect(result).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    expect(session.steers).toEqual([]);

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "path-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/usr is full" }] },
      },
    });
    const pathResult = await events.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "path-steer",
    );
    expect(pathResult).toEqual(expect.objectContaining({ result: { type: "steer", turnId } }));

    session.emit({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "refreshed-command",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "/fresh now" }] },
      },
    });
    const refreshedResult = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "refreshed-command",
    );
    expect(refreshedResult).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: "failed" }) }),
    );
    expect(session.steers).toEqual(["/usr is full"]);
    await finishTurn(events, session, turnId);
    await connection.close();
  });

  test("does not reuse an entry discovered after an earlier lookup failure", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.branchMessagesError = new Error("lookup unavailable");
    const firstTurnId = turnIdFrom(await startPrompt(connection, events, "lookup-1", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    await finishTurn(events, session, firstTurnId);

    session.branchMessagesError = null;
    session.branchMessages = [
      { entryId: "entry-old", text: "repeat" },
      { entryId: "entry-new", text: "repeat" },
    ];
    const secondTurnId = turnIdFrom(await startPrompt(connection, events, "lookup-2", "repeat"));
    session.emit({ type: "message_end", message: { role: "user", content: "repeat" } });
    await Promise.resolve();
    await Promise.resolve();
    await finishTurn(events, session, secondTurnId);

    const secondUser = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "lookup-2",
    );
    expect(secondUser).toEqual(
      expect.objectContaining({ item: expect.objectContaining({ id: "user:lookup-2" }) }),
    );
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "lookup-2" &&
          event.item.id === "entry-old",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("drops a delayed entry lookup after session close", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const branchGate = Promise.withResolvers<void>();
    session.branchMessagesGate = branchGate.promise;
    session.branchMessages = [{ entryId: "entry-after-close", text: "hello" }];
    await startPrompt(connection, events, "closing-lookup", "hello");
    session.emit({ type: "message_end", message: { role: "user", content: "hello" } });
    await connection.send({
      type: "session.close",
      requestId: "close-delayed-lookup",
      sessionId: "session-1",
    });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-delayed-lookup",
    );
    const timelineCount = events.filter((event) => event.type === "timeline.item").length;

    branchGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.filter((event) => event.type === "timeline.item")).toHaveLength(timelineCount);
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
        item: expect.objectContaining({ id: `command:${turnId}`, text: "first second" }),
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

  test("fails an active turn exactly once when the runtime exits", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const result = await startPrompt(connection, events, "failed-1", "work");
    const turnId = turnIdFrom(result);
    const session = sessionAt(runtime);

    session.emit({ type: "process_exit", error: "OMP exited with code 7" });
    const runtimeFailure = await events.waitFor((event) => event.type === "session.runtime_failed");

    expect(runtimeFailure).toEqual({
      type: "session.runtime_failed",
      sessionId: "session-1",
      error: { message: "OMP exited with code 7" },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    await connection.close();
  });
  test("recovers a dead idle runtime by resuming the same native session", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);

    first.emit({ type: "process_exit", error: "OMP exited between turns" });
    await events.waitFor((event) => event.type === "session.runtime_failed");

    const result = await startPrompt(connection, events, "recovered-1", "continue");
    const turnId = turnIdFrom(result);
    const recovered = sessionAt(runtime, 1);
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        env: { TEST_ENV: "1" },
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

  test("ignores stale terminal events from a dead runtime generation", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const first = sessionAt(runtime);
    const staleListener = [...first.listeners][0];
    if (!staleListener) throw new Error("expected native event listener");

    first.emit({ type: "process_exit", error: "OMP killed by SIGKILL" });
    await events.waitFor((event) => event.type === "session.runtime_failed");
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

  test("fails an EPIPE turn once and records the runtime failure", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events, "epipe-1", "work"));

    sessionAt(runtime).emit({ type: "process_exit", error: "OMP RPC stdin write failed: EPIPE" });
    await events.waitFor((event) => event.type === "session.runtime_failed");
    expect(
      events.filter(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toEqual([expect.objectContaining({ state: "failed" })]);
    await connection.close();
  });

  test("fails agent_end when the completion state stays unavailable", async () => {
    const { connection, events, runtime, scheduler } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    const state = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    const turnId = turnIdFrom(await startPrompt(connection, events, "stuck-state", "work"));

    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    await Promise.resolve();
    await scheduler.flush();
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(
      expect.objectContaining({
        state: "failed",
        error: { message: "OMP agent_end could not be confirmed before the state check timed out" },
      }),
    );
    state.resolve();
    await connection.close();
  });
  test("fails agent_end when get_state is unavailable", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const session = sessionAt(runtime);
    session.stateError = new Error("runtime state unavailable");
    const turnId = turnIdFrom(await startPrompt(connection, events, "unavailable-state", "work"));

    session.emit({ type: "agent_end", messages: [], isTerminal: true });
    const terminal = await events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
    expect(terminal).toEqual(expect.objectContaining({ state: "failed" }));
    await connection.close();
  });

  test("rejects recovery without an original native session handle", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    sessionAt(runtime).nativeSessionId = "";
    sessionAt(runtime).emit({ type: "process_exit", error: "OMP exited between turns" });
    await events.waitFor((event) => event.type === "session.runtime_failed");

    const result = await startPrompt(connection, events, "missing-handle", "continue");
    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({ message: expect.stringContaining("native session handle") }),
        }),
      }),
    );
    expect(runtime.starts).toHaveLength(1);
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
        id: "notice-idle",
        level: "warning",
        message: "Background task delayed",
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          type: "todo",
          id: "omp:todos",
          items: [
            expect.objectContaining({
              id: "todo-idle",
              completed: false,
              status: "pending",
            }),
          ],
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "notification",
          id: "omp:ui:notify-idle",
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
      expect.objectContaining({ error: { message: "OMP session close failed: close failed" } }),
    );
    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "close-1"),
    ).toBe(false);
    await connection.close().catch(() => undefined);
  });
});
