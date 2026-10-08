import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderEvent,
  ProviderInput,
  ProviderMcpServerConfig,
} from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withOmpSessionOpenEnv } from "../server/provider/host-tools";
import type { OmpMessage } from "../server/provider/omp-rpc-protocol";
import { createOmpProvider } from "../server/provider/registration";
import { OMP_SESSION_PURPOSE_ENV } from "../server/provider/session-purpose";
import {
  ALTERNATE_MODEL_PUBLIC_ID,
  EventLog,
  FakeOmpRuntime,
  type HostAgentManagerConstructor,
  type HostRegistryConstructor,
  ManualScheduler,
  MODEL,
  MODEL_PUBLIC_ID,
  NATIVE_SESSION_ID,
  pino,
  TEST_RUNTIME_ENV,
} from "./helpers/provider-harness";

type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;

const PLUGIN_PROVIDER_MODULE = new URL(
  "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js",
  import.meta.url,
).href;
const REMOVED_CWD = "/removed/workspace";
const TRANSCRIPT_FILE = "/sessions/removed-workspace.jsonl";
const AGENT_ID = "f570600a-8643-4a41-9cf0-c0536a62ff25";
const CAPABILITIES = [
  "prompt.message",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "session.subsession",
  "session.revert.conversation",
  "permission",
  "timeline.plugin",
];
const HISTORY_CAPABILITIES = ["session.persistence", "session.subsession", "timeline.plugin"];
const HISTORY_ENV = { PASEO_AGENT_ID: AGENT_ID, [OMP_SESSION_PURPOSE_ENV]: "history" };
const INTERACTIVE_ENV = { PASEO_AGENT_ID: AGENT_ID };
const CUSTOM_COMMAND = ["/custom/bin/omp", "--profile", "work"];
const CUSTOM_COMMAND_OPTIONS = { command: CUSTOM_COMMAND };
const TRANSCRIPT: OmpMessage[] = [
  { role: "user", entryId: "user-1", content: "original question" },
  { role: "assistant", entryId: "assistant-1", content: "original answer" },
];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function seedTranscript(runtime: FakeOmpRuntime, messages: OmpMessage[] = TRANSCRIPT): void {
  runtime.descriptors.push({
    id: NATIVE_SESSION_ID,
    cwd: REMOVED_CWD,
    transcriptFile: TRANSCRIPT_FILE,
  });
  runtime.persistedSessionMessages = {
    sessionFile: TRANSCRIPT_FILE,
    nativeSessionId: NATIVE_SESSION_ID,
    byteLength: 256,
    messages,
  };
}

async function createHistoryHarness(environment: NodeJS.ProcessEnv = TEST_RUNTIME_ENV) {
  const runtime = new FakeOmpRuntime();
  seedTranscript(runtime);
  const mcpConnections: string[] = [];
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: new ManualScheduler(),
    environment,
    mcpConnector: async (name) => {
      mcpConnections.push(name);
      throw new Error("a history session must not connect MCP servers");
    },
  }).connect({ versions: [1], capabilities: CAPABILITIES });
  const events = new EventLog();
  connection.onEvent((event) => events.push(event));
  return { connection, events, runtime, mcpConnections };
}

function sessionOpen(
  requestId: string,
  sessionId: string,
  options: {
    env?: Record<string, string>;
    cwd?: string;
    persist?: boolean;
    persisted?: boolean;
    history?: "replay" | "skip";
    providerOptions?: Record<string, unknown>;
    mcpServers?: Record<string, ProviderMcpServerConfig>;
  } = {},
): SessionOpenInput {
  return {
    type: "session.open",
    requestId,
    sessionId,
    config: {
      cwd: options.cwd ?? REMOVED_CWD,
      env: options.env ?? INTERACTIVE_ENV,
      systemPrompt: "must not be reapplied",
      mcpServers: options.mcpServers ?? {},
      model: MODEL_PUBLIC_ID,
      mode: "full",
      thinkingOption: "medium",
      settings: {},
      persist: options.persist ?? true,
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
    },
    ...(options.persisted === false
      ? {}
      : { persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } } }),
    history: options.history ?? "replay",
  };
}

function settled(events: EventLog, requestId: string): Promise<ProviderEvent> {
  return events.waitFor(
    (event) =>
      (event.type === "session.ready" && event.requestId === requestId) ||
      (event.type === "request.failed" && event.requestId === requestId),
  );
}

async function openSettled(
  connection: { send(input: ProviderInput): Promise<void> },
  events: EventLog,
  input: SessionOpenInput,
): Promise<ProviderEvent> {
  await connection.send(input);
  return await settled(events, input.requestId);
}

async function closeSession(
  connection: { send(input: ProviderInput): Promise<void> },
  events: EventLog,
  sessionId: string,
): Promise<void> {
  const requestId = `close-${sessionId}`;
  await connection.send({ type: "session.close", requestId, sessionId });
  await events.waitFor(
    (event) => event.type === "request.completed" && event.requestId === requestId,
  );
}

function replayedText(events: readonly ProviderEvent[], sessionId: string): string[] {
  return events.flatMap((event) =>
    event.type === "timeline.item" &&
    event.sessionId === sessionId &&
    (event.item.type === "user_message" || event.item.type === "assistant_message")
      ? [event.item.text]
      : [],
  );
}

function openedEvent(events: readonly ProviderEvent[], sessionId: string) {
  const opened = events.find(
    (event) => event.type === "session.opened" && event.sessionId === sessionId,
  );
  if (opened?.type !== "session.opened") throw new Error(`Missing opened event for ${sessionId}`);
  return opened;
}

function failureMessage(event: ProviderEvent): string {
  if (event.type !== "request.failed") throw new Error(`Expected a failure, got ${event.type}`);
  return event.error.message;
}

describe("OMP history-only sessions", () => {
  test("replays a removed workspace from its authorized transcript without a process, MCP connection, or reservation", async () => {
    const { connection, events, runtime, mcpConnections } = await createHistoryHarness();

    const outcome = await openSettled(
      connection,
      events,
      sessionOpen("history-open", "history-session", {
        env: HISTORY_ENV,
        mcpServers: { repo: { type: "stdio", command: "repo" } },
      }),
    );

    expect(outcome.type).toBe("session.ready");
    expect(runtime.starts).toEqual([]);
    expect(mcpConnections).toEqual([]);
    // The recorded workspace is compared, never opened, and the original native identity is the
    // only one authorized.
    expect(runtime.sessionListRequests).toEqual([
      { sessionId: NATIVE_SESSION_ID, cwd: REMOVED_CWD, limit: 2, sessionDir: undefined },
    ]);
    expect(runtime.persistedSessionRequests).toEqual([
      { sessionFile: TRANSCRIPT_FILE, sessionId: NATIVE_SESSION_ID, cwd: REMOVED_CWD },
    ]);
    expect(openedEvent(events, "history-session")).toEqual(
      expect.objectContaining({
        cwd: REMOVED_CWD,
        restoration: "core",
        capabilities: HISTORY_CAPABILITIES,
        persistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        sessionId: "history-session",
        config: expect.objectContaining({ model: MODEL_PUBLIC_ID, mode: "full" }),
      }),
    );
    expect(replayedText(events, "history-session")).toEqual([
      "original question",
      "original answer",
    ]);
    const lastTimeline = events.findLastIndex((event) => event.type === "timeline.item");
    const ready = events.findIndex((event) => event.type === "session.ready");
    expect(lastTimeline).toBeGreaterThanOrEqual(0);
    expect(lastTimeline).toBeLessThan(ready);

    // Connection shutdown retires an open history session without any process cleanup.
    await expect(connection.close()).resolves.toBeUndefined();
  });

  test("keeps a history session read-only and closes it without side effects", async () => {
    const { connection, events, runtime } = await createHistoryHarness();
    await openSettled(
      connection,
      events,
      sessionOpen("history-open", "history-session", { env: HISTORY_ENV }),
    );

    await connection.send({
      type: "session.prompt",
      sessionId: "history-session",
      prompt: {
        clientMessageId: "history-prompt",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "continue" }] },
      },
    });
    await connection.send({
      type: "session.configure",
      requestId: "history-configure",
      sessionId: "history-session",
      changes: { model: ALTERNATE_MODEL_PUBLIC_ID },
    });
    await connection.send({
      type: "session.revert",
      requestId: "history-revert",
      sessionId: "history-session",
      token: "token",
      scope: "conversation",
    });
    await connection.send({
      type: "session.interrupt",
      requestId: "history-interrupt",
      sessionId: "history-session",
    });
    await expect(
      connection.send({
        type: "session.permission",
        sessionId: "history-session",
        permissionId: "permission-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("no pending permissions");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        sessionId: "history-session",
        clientMessageId: "history-prompt",
        result: { type: "failed", error: { message: "OMP history sessions are read-only" } },
      }),
    );
    for (const requestId of ["history-configure", "history-revert"]) {
      expect(events).toContainEqual({
        type: "request.failed",
        requestId,
        error: { message: "OMP history sessions are read-only" },
      });
    }
    expect(events).toContainEqual({ type: "request.completed", requestId: "history-interrupt" });

    await closeSession(connection, events, "history-session");
    expect(events).toContainEqual({ type: "session.closed", sessionId: "history-session" });
    expect(runtime.starts).toEqual([]);
    await connection.close();
  });

  test("leaves interactive resume bound to the recorded workspace and persisted identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connection, events, runtime } = await createHistoryHarness();
    await openSettled(
      connection,
      events,
      sessionOpen("history-open", "history-session", {
        env: HISTORY_ENV,
        providerOptions: CUSTOM_COMMAND_OPTIONS,
      }),
    );
    await closeSession(connection, events, "history-session");
    const historyOpened = openedEvent(events, "history-session");

    // Without the host-derived marker the same persisted handle is an ordinary resume: the runtime
    // is asked to start in the recorded directory, and its failure is reported rather than
    // answered from the transcript or retried somewhere else.
    runtime.nextStartError = Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" });
    const missing = await openSettled(
      connection,
      events,
      sessionOpen("interactive-missing", "interactive-missing", {
        providerOptions: CUSTOM_COMMAND_OPTIONS,
      }),
    );
    expect(failureMessage(missing)).toContain("OMP session failed to open");
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]).toEqual(
      expect.objectContaining({
        cwd: REMOVED_CWD,
        resumeSessionId: NATIVE_SESSION_ID,
        resumeSessionFile: TRANSCRIPT_FILE,
      }),
    );
    expect(replayedText(events, "interactive-missing")).toEqual([]);

    // After the directory is restored, the very same persistence resumes interactively without a
    // re-applied system prompt and with the original identity.
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    const restored = await openSettled(
      connection,
      events,
      sessionOpen("interactive-restored", "interactive-restored", {
        providerOptions: CUSTOM_COMMAND_OPTIONS,
      }),
    );
    expect(restored.type).toBe("session.ready");
    expect(runtime.starts).toHaveLength(2);
    expect(runtime.starts[1]).toEqual(
      expect.objectContaining({
        cwd: REMOVED_CWD,
        resumeSessionId: NATIVE_SESSION_ID,
        resumeSessionFile: TRANSCRIPT_FILE,
      }),
    );
    expect(runtime.starts[1]?.systemPrompt).toBeUndefined();
    expect(runtime.starts[1]?.env?.[OMP_SESSION_PURPOSE_ENV]).toBeUndefined();
    // The configured custom OMP command is honored by interactive resumes only; history never
    // needed (or ran) it.
    expect(runtime.starts.map((start) => start.command)).toEqual([CUSTOM_COMMAND, CUSTOM_COMMAND]);
    const interactiveOpened = openedEvent(events, "interactive-restored");
    expect(interactiveOpened.persistence).toEqual(historyOpened.persistence);
    expect(interactiveOpened.cwd).toBe(historyOpened.cwd);
    expect(interactiveOpened.capabilities).toContain("prompt.message");
    expect(historyOpened.capabilities).not.toContain("prompt.message");
    expect(replayedText(events, "interactive-restored")).toEqual([
      "original question",
      "original answer",
    ]);
    await connection.close();
  });

  test("lets a history session coexist with an interactive session on the same native session", async () => {
    const { connection, events, runtime } = await createHistoryHarness();
    await openSettled(
      connection,
      events,
      sessionOpen("history-one", "history-one", { env: HISTORY_ENV }),
    );
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    expect((await openSettled(connection, events, sessionOpen("live", "live"))).type).toBe(
      "session.ready",
    );
    // History holds no process and no reservation, so it neither blocks nor is blocked by the
    // live owner, while a second live owner of the same native session is still refused.
    expect(
      (
        await openSettled(
          connection,
          events,
          sessionOpen("history-two", "history-two", { env: HISTORY_ENV }),
        )
      ).type,
    ).toBe("session.ready");
    expect(
      failureMessage(await openSettled(connection, events, sessionOpen("live-2", "live-2"))),
    ).toBe("OMP native session is already open");
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test.each([
    ["a create", { persisted: false, persist: false, history: "skip" as const }],
    ["a skipped replay", { history: "skip" as const }],
    ["a replay without persistence", { persisted: false }],
    ["a non-persisted config", { persist: false }],
  ])("refuses the history marker on %s", async (_name, options) => {
    const { connection, events, runtime } = await createHistoryHarness();

    const outcome = await openSettled(
      connection,
      events,
      sessionOpen("misused-marker", "misused-marker", { ...options, env: HISTORY_ENV }),
    );

    expect(failureMessage(outcome)).toBe("OMP history purpose requires a persisted session replay");
    expect(runtime.starts).toEqual([]);
    expect(runtime.sessionListRequests).toEqual([]);
    await connection.close();
  });

  test.each([["interactive"], [""], ["History"]])(
    "refuses unknown purpose marker %j",
    async (purpose) => {
      const { connection, events, runtime } = await createHistoryHarness();

      const outcome = await openSettled(
        connection,
        events,
        sessionOpen("unknown-purpose", "unknown-purpose", {
          env: { PASEO_AGENT_ID: AGENT_ID, [OMP_SESSION_PURPOSE_ENV]: purpose },
        }),
      );

      expect(failureMessage(outcome)).toBe("Invalid OMP session purpose");
      expect(runtime.starts).toEqual([]);
      await connection.close();
    },
  );

  test("keeps workspace and transcript authorization for history opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connection, events, runtime } = await createHistoryHarness();

    // A different recorded workspace never resolves the native session.
    const elsewhere = await openSettled(
      connection,
      events,
      sessionOpen("other-workspace", "other-workspace", {
        env: HISTORY_ENV,
        cwd: "/other/workspace",
      }),
    );
    expect(failureMessage(elsewhere)).toBe("OMP session could not be resolved in this workspace");
    expect(runtime.persistedSessionRequests).toEqual([]);

    // A descriptor without an authorized transcript is not replayable.
    runtime.descriptors.length = 0;
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd: REMOVED_CWD });
    const unresolved = await openSettled(
      connection,
      events,
      sessionOpen("no-transcript", "no-transcript", { env: HISTORY_ENV }),
    );
    expect(failureMessage(unresolved)).toBe(
      "OMP session transcript could not be resolved in this workspace",
    );
    expect(runtime.persistedSessionRequests).toEqual([]);

    // A transcript that fails ownership validation fails the open instead of serving a partial
    // history, and the connection stays usable once it is healthy again.
    runtime.descriptors.length = 0;
    seedTranscript(runtime);
    runtime.persistedSessionError = new Error("OMP session transcript failed ownership validation");
    const rejected = await openSettled(
      connection,
      events,
      sessionOpen("bad-transcript", "bad-transcript", { env: HISTORY_ENV }),
    );
    expect(failureMessage(rejected)).toContain("OMP session failed to open");
    expect(replayedText(events, "bad-transcript")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.closed", sessionId: "bad-transcript" }),
    );
    runtime.persistedSessionError = null;
    expect(
      (
        await openSettled(
          connection,
          events,
          sessionOpen("healthy", "healthy", { env: HISTORY_ENV }),
        )
      ).type,
    ).toBe("session.ready");
    expect(runtime.starts).toEqual([]);
    await connection.close();
  });

  test("redacts configured and inherited values when replaying history", async () => {
    const { connection, events, runtime } = await createHistoryHarness({
      ...TEST_RUNTIME_ENV,
      INHERITED_SECRET_FOR_TEST: "inherited-secret-5678",
    });
    runtime.persistedSessionMessages = {
      sessionFile: TRANSCRIPT_FILE,
      nativeSessionId: NATIVE_SESSION_ID,
      byteLength: 256,
      messages: [
        { role: "user", entryId: "user-1", content: "question" },
        {
          role: "assistant",
          entryId: "assistant-1",
          content: "leaks configured-secret-1234 and inherited-secret-5678",
        },
      ],
    };

    const outcome = await openSettled(
      connection,
      events,
      sessionOpen("redacted-history", "redacted-history", {
        env: { ...HISTORY_ENV, EXAMPLE_API_KEY: "configured-secret-1234" },
        providerOptions: {
          outputRedaction: "configured-values",
          inheritEnv: ["INHERITED_SECRET_FOR_TEST"],
        },
      }),
    );

    expect(outcome.type).toBe("session.ready");
    const text = replayedText(events, "redacted-history").join("\n");
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("configured-secret-1234");
    expect(text).not.toContain("inherited-secret-5678");
    expect(runtime.starts).toEqual([]);
    await connection.close();
  });

  test("gives history replay the same stable child identities as a live resume", async () => {
    const { connection, events, runtime } = await createHistoryHarness();
    runtime.persistedSessionMessages = {
      sessionFile: TRANSCRIPT_FILE,
      nativeSessionId: NATIVE_SESSION_ID,
      byteLength: 256,
      messages: [
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
          details: {
            results: [],
            progress: [
              { index: 0, id: "native-replayed-child", agent: "scout", status: "pending" },
            ],
          },
        },
      ],
    };
    runtime.persistedSubagentMessages.set(`${TRANSCRIPT_FILE}\0native-replayed-child`, {
      sessionFile: "/sessions/root/native-replayed-child.jsonl",
      nativeSessionId: "01a0915d-e337-7009-af23-7382348f59b5",
      byteLength: 42,
      messages: [
        { role: "user", entryId: "child-user", content: "inspect" },
        { role: "assistant", responseId: "child-response", content: "replayed child output" },
      ],
    });
    const childSessionId = (parentSessionId: string): string => {
      const child = events.find(
        (event) => event.type === "session.opened" && event.parentSessionId === parentSessionId,
      );
      if (child?.type !== "session.opened") throw new Error("Missing replayed child session");
      expect(child.toolCallId).toBe("replayed-task");
      return child.sessionId;
    };

    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";
    await openSettled(connection, events, sessionOpen("live", "live"));
    const liveChild = childSessionId("live");
    await closeSession(connection, events, "live");
    await openSettled(connection, events, sessionOpen("history", "history", { env: HISTORY_ENV }));
    const historyChild = childSessionId("history");

    expect(historyChild).toBe(liveChild);
    expect(
      events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === historyChild &&
          event.item.type === "assistant_message" &&
          event.item.text === "replayed child output",
      ),
    ).toHaveLength(2);
    // Only the live open started a process; both opens read the cold child transcript.
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.persistedSubagentRequests).toEqual([
      { parentSessionFile: TRANSCRIPT_FILE, childTranscriptId: "native-replayed-child" },
      { parentSessionFile: TRANSCRIPT_FILE, childTranscriptId: "native-replayed-child" },
    ]);
    await connection.close();
  });

  test("never lets per-agent provider options select or leak the history purpose", async () => {
    const { connection, events, runtime } = await createHistoryHarness();
    runtime.nextModel = MODEL;
    runtime.nextThinkingLevel = "medium";

    // providerOptions.env is user configuration, not host launch context: it cannot request history
    // mode, and the reserved name never reaches a real OMP process.
    const outcome = await openSettled(
      connection,
      events,
      sessionOpen("forged-options", "forged-options", {
        providerOptions: { env: { [OMP_SESSION_PURPOSE_ENV]: "history", KEEP_ME: "1" } },
      }),
    );

    expect(outcome.type).toBe("session.ready");
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.env).toEqual({ PASEO_AGENT_ID: AGENT_ID, KEEP_ME: "1" });
    expect(openedEvent(events, "forged-options").capabilities).toContain("prompt.message");
    await connection.close();
  });
});

describe("OMP session_open hook purpose marker", () => {
  const request = {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "omp-plugin",
    cwd: REMOVED_CWD,
    reason: "resume",
    purpose: "history",
    env: { [OMP_SESSION_PURPOSE_ENV]: "spoofed", KEEP_ME: "1" },
  };

  test("derives the marker only from a host resume with history purpose", () => {
    const history = withOmpSessionOpenEnv(request);
    expect(history.env).toEqual({
      [OMP_SESSION_PURPOSE_ENV]: "history",
      KEEP_ME: "1",
      PASEO_AGENT_ID: "agent-1",
      PASEO_WORKSPACE_ID: "workspace-1",
    });
    // Hooks may change nothing but env: every other field must survive untouched.
    expect(history).toMatchObject({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      provider: "omp-plugin",
      cwd: REMOVED_CWD,
      reason: "resume",
      purpose: "history",
    });
  });

  test.each([
    ["an interactive resume", { purpose: "interactive", reason: "resume" }],
    ["a history create", { purpose: "history", reason: "create" }],
    ["a history import", { purpose: "history", reason: "import" }],
    ["a history refresh", { purpose: "history", reason: "refresh" }],
    ["a host that reports no purpose", { purpose: undefined, reason: "resume" }],
  ])("discards a caller-supplied marker for %s", (_name, overrides) => {
    const result = withOmpSessionOpenEnv({ ...request, ...overrides });

    expect(result.env).toEqual({
      KEEP_ME: "1",
      PASEO_AGENT_ID: "agent-1",
      PASEO_WORKSPACE_ID: "workspace-1",
    });
  });

  test("does not mutate the host request", () => {
    withOmpSessionOpenEnv(request);

    expect(request.env).toEqual({ [OMP_SESSION_PURPOSE_ENV]: "spoofed", KEEP_ME: "1" });
  });
});

type HistoryHostManager = {
  createAgent(
    config: Record<string, unknown>,
    agentId: string | undefined,
    options: Record<string, unknown>,
  ): Promise<{ id: string }>;
  resumeAgentFromPersistence(
    handle: Record<string, unknown>,
    overrides: Record<string, unknown>,
    agentId: string,
    options: Record<string, unknown> | undefined,
    resumeOptions: { purpose: "history" | "interactive" } | undefined,
  ): Promise<{ id: string }>;
  hydrateTimelineFromProvider(
    agentId: string,
    options: { broadcast: () => boolean },
  ): Promise<void>;
  getTimeline(agentId: string): unknown[];
  closeAgent(agentId: string): Promise<void>;
};

describe("OMP history through the Paseo host", () => {
  async function createHostHarness() {
    const runtime = new FakeOmpRuntime();
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-history-host-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    runtime.descriptors.push({ id: NATIVE_SESSION_ID, cwd, transcriptFile: TRANSCRIPT_FILE });
    runtime.persistedSessionMessages = {
      sessionFile: TRANSCRIPT_FILE,
      nativeSessionId: NATIVE_SESSION_ID,
      byteLength: 256,
      messages: TRANSCRIPT,
    };
    const registration = createOmpProvider({
      runtime,
      timelineScheduler: new ManualScheduler(),
      environment: TEST_RUNTIME_ENV,
      availabilityProbe: async () => ({ status: "available" }),
    });
    const providerEvents: ProviderEvent[] = [];
    const connect = registration.connect.bind(registration);
    registration.connect = async (connectRequest) => {
      const connection = await connect(connectRequest);
      connection.onEvent((event) => providerEvents.push(event));
      return connection;
    };
    // Dynamic imports intentionally exercise the installed daemon's CJS/ESM plugin boundary.
    const adapter = (await import(PLUGIN_PROVIDER_MODULE)) as unknown as {
      PluginAgentClientRegistry: HostRegistryConstructor;
    };
    const agentManagerModule = (await import(
      "../node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js"
    )) as unknown as { AgentManager: HostAgentManagerConstructor };
    const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
    registry.replace([registration]);
    const hookRequests: Array<{ purpose?: string; reason?: string }> = [];
    const lifecycle = {
      // The exact env transform the plugin registers for agent.session_open.
      async before(name: string, hookRequest: unknown) {
        if (name !== "agent.session_open") return hookRequest;
        const typed = hookRequest as Parameters<typeof withOmpSessionOpenEnv>[0];
        hookRequests.push({ purpose: typed.purpose, reason: typed.reason });
        return withOmpSessionOpenEnv(typed);
      },
      emit() {},
    };
    const manager = new agentManagerModule.AgentManager({
      logger: pino({ enabled: false }),
      clients: registry.clients(),
      providerDefinitions: registry.definitions(),
      pluginLifecycle: lifecycle,
      paseoToolsEnabled: false,
      idFactory: () => AGENT_ID,
    }) as unknown as HistoryHostManager;
    const handle = {
      provider: registration.id,
      sessionId: `plugin:${JSON.stringify({ version: 1, data: { sessionId: NATIVE_SESSION_ID } })}`,
      metadata: {
        pluginProviderPersistence: { version: 1, data: { sessionId: NATIVE_SESSION_ID } },
      },
    };
    const overrides = {
      cwd,
      model: MODEL_PUBLIC_ID,
      modeId: "full",
      thinkingOptionId: "medium",
      featureValues: {},
    };
    return { runtime, registry, manager, handle, overrides, cwd, providerEvents, hookRequests };
  }

  test("loads archived history after the workspace is removed, then retires it for an interactive resume", async () => {
    const { runtime, registry, manager, handle, overrides, cwd, providerEvents, hookRequests } =
      await createHostHarness();
    try {
      await rm(cwd, { recursive: true });

      // The archived agent loads read-only through the real hook, adapter, and AgentManager.
      await manager.resumeAgentFromPersistence(handle, overrides, AGENT_ID, undefined, {
        purpose: "history",
      });
      await manager.hydrateTimelineFromProvider(AGENT_ID, { broadcast: () => false });
      const timeline = JSON.stringify(manager.getTimeline(AGENT_ID));
      expect(timeline).toContain("original question");
      expect(timeline).toContain("original answer");
      expect(hookRequests).toEqual([{ purpose: "history", reason: "resume" }]);
      expect(runtime.starts).toEqual([]);
      const firstOpened = providerEvents.find((event) => event.type === "session.opened");
      if (firstOpened?.type !== "session.opened") throw new Error("history session never opened");
      const historySessionId = firstOpened.sessionId;

      // Unarchiving closes the read-only runtime before anything interactive can use it.
      await manager.closeAgent(AGENT_ID);
      expect(providerEvents).toContainEqual({
        type: "session.closed",
        sessionId: historySessionId,
      });

      // An ordinary resume still requires the workspace: the host refuses it before any plugin
      // involvement, so nothing can fall back to another directory.
      await expect(
        manager.resumeAgentFromPersistence(handle, overrides, AGENT_ID, undefined, undefined),
      ).rejects.toThrow("Working directory does not exist");
      expect(runtime.starts).toEqual([]);

      await mkdir(cwd);
      runtime.nextModel = MODEL;
      runtime.nextThinkingLevel = "medium";
      await manager.resumeAgentFromPersistence(handle, overrides, AGENT_ID, undefined, undefined);

      expect(hookRequests.at(-1)).toEqual({ purpose: "interactive", reason: "resume" });
      expect(runtime.starts).toHaveLength(1);
      expect(runtime.starts[0]).toEqual(
        expect.objectContaining({
          cwd,
          resumeSessionId: NATIVE_SESSION_ID,
          resumeSessionFile: TRANSCRIPT_FILE,
        }),
      );
      expect(runtime.starts[0]?.env?.[OMP_SESSION_PURPOSE_ENV]).toBeUndefined();
      const opened = providerEvents.filter((event) => event.type === "session.opened");
      expect(opened).toHaveLength(2);
      const interactive = opened[1];
      if (interactive?.type !== "session.opened") throw new Error("interactive session missing");
      expect(interactive.sessionId).not.toBe(historySessionId);
      expect(interactive.capabilities).toContain("prompt.message");
      await manager.closeAgent(AGENT_ID);
    } finally {
      await registry.shutdown();
    }
  });

  test("strips a caller-supplied history marker from agent creation env", async () => {
    const { runtime, registry, manager, overrides } = await createHostHarness();
    try {
      await manager.createAgent({ provider: "omp-plugin", ...overrides }, AGENT_ID, {
        workspaceId: "workspace-1",
        persistSession: false,
        env: { [OMP_SESSION_PURPOSE_ENV]: "history" },
      });

      // A surviving marker would have been refused as a non-persisted create; instead the agent
      // started a real runtime with the marker removed.
      expect(runtime.starts).toHaveLength(1);
      expect(runtime.starts[0]?.env?.[OMP_SESSION_PURPOSE_ENV]).toBeUndefined();
      expect(runtime.starts[0]?.env?.PASEO_AGENT_ID).toBe(AGENT_ID);
      await manager.closeAgent(AGENT_ID);
    } finally {
      await registry.shutdown();
    }
  });
});
