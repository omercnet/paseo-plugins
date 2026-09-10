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

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
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
  closeGate: Promise<void> | null = null;
  closeObserved: (() => void) | null = null;
  readonly modelChanges: Array<{ provider: string; modelId: string }> = [];
  readonly thinkingChanges: string[] = [];
  branchMessages: Array<{ entryId: string; text: string }> = [];
  currentModel = MODEL;
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

  getState() {
    return Promise.resolve({
      model: this.currentModel,
      thinkingLevel: this.thinkingLevel,
      isStreaming: false,
      isCompacting: false,
      sessionId: "native-session",
    });
  }

  getAvailableModels() {
    return Promise.resolve([MODEL, ALTERNATE_MODEL]);
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

  getBranchMessages() {
    return Promise.resolve(this.branchMessages);
  }

  abort() {
    this.aborts += 1;
    return Promise.resolve();
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

  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    this.starts.push(options);
    this.startObserved?.();
    if (this.startGate) await this.startGate;
    const session = new FakeOmpSession();
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

    session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Think" },
          { type: "text", text: "Hel" },
        ],
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
      },
    });
    expect(
      events.some(
        (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
      ),
    ).toBe(false);
    scheduler.flush();
    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking more" },
          { type: "text", text: "Hello world" },
        ],
      },
    });
    scheduler.flush();

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
    session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "After tool" }] },
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
      `assistant:${firstTurnId}:1:content:1:text`,
      `assistant:${firstTurnId}:1:content:1:text`,
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
    session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Again" }] },
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
    scheduler.flush();
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
    scheduler.flush();

    const assistantItems = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? [event.item]
        : [],
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
      scheduler.flush();
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
      ["response-interleaved:content:2:reasoning", "Reason B"],
      ["response-interleaved:content:3:text", "Answer B"],
    ]);
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

  test("fails a steer whose expected turn ends before native acceptance", async () => {
    const { connection, events, runtime } = await createHarness();
    await openSession(connection, events);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    const session = sessionAt(runtime);
    const steerGate = Promise.withResolvers<void>();
    const steerObserved = Promise.withResolvers<void>();
    session.steerGate = steerGate.promise;
    session.steerObserved = steerObserved.resolve;

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "stale-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "late" }] },
      },
    });
    await steerObserved.promise;
    const terminal = finishTurn(events, session, turnId);
    await terminal;
    steerGate.resolve();
    const result = await events.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === "stale-steer",
    );

    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          type: "failed",
          error: { message: "The active OMP turn ended before the steer was accepted" },
        }),
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "stale-steer",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === "stale-steer",
      ),
    ).toBe(false);
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
    scheduler.flush();
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

    scheduler.flush();
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
    scheduler.flush();
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
      todos: [{ id: "todo-idle", content: "Wait for background task", status: "pending" }],
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
        type: "timeline.item",
        item: expect.objectContaining({ type: "todo", id: "omp:todos" }),
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
