import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PRIMARY_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
const BRANCHED_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfcc";
const MODELS = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
    contextWindow: 200_000,
    input: ["text", "image"],
  },
  {
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT 5.4",
    reasoning: true,
    thinking: { efforts: ["low", "high"], defaultLevel: "high" },
    contextWindow: 128_000,
    input: ["text"],
  },
] as const;

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("omp/18.1.15\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write(
    "--mode=<value>  Output mode: text, json, rpc, or rpc-ui\nlsp  Language server\n",
  );
  process.exit(0);
}

const resumeIndex = args.indexOf("--resume");
const resumeTarget = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
// Like OMP, a .jsonl target is opened as a file and identified by its header.
let sessionId = resumeTarget?.endsWith(".jsonl")
  ? (JSON.parse(readFileSync(resumeTarget, "utf8").split("\n", 1)[0] ?? "{}").id as string)
  : (resumeTarget ?? PRIMARY_SESSION_ID);
const sessionDirIndex = args.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] : undefined;
const modelIndex = args.indexOf("--model");
const configuredModel = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
let currentModel =
  MODELS.find((model) => `${model.provider}/${model.id}` === configuredModel) ?? MODELS[0];
const thinkingIndex = args.indexOf("--thinking");
let thinkingLevel = thinkingIndex >= 0 ? (args[thinkingIndex + 1] ?? "medium") : "medium";
let autoCompactionEnabled = true;
let activeScenario:
  | "hold"
  | "native-hold"
  | "typed-permission"
  | "fallback-permission"
  | "typed-cancel"
  | "fallback-cancel"
  | null = null;
let promptSequence = 0;
let activeApprovalId: string | null = null;
let activeApprovalToolCallId: string | null = null;
let activeFallbackId: string | null = null;
let lateTerminalMessage: Record<string, unknown> | null = null;
let history = [
  { role: "user", content: "replayed question", entryId: "user-root" },
  { role: "assistant", content: "replayed answer", entryId: "assistant-root" },
];
const HELD_TASK_CALL_ID = "task-held";
const HELD_SUBAGENTS = [
  { id: "held-child", agent: "worker", description: "held child" },
  {
    id: "parser-review",
    agent: "reviewer",
    description: "Review the parser changes for regressions",
  },
  {
    id: "caller-scan",
    agent: "explore",
    description: "Find every caller of parseConfig in the repository",
  },
].map((subagent, index) => ({
  ...subagent,
  index,
  sessionFile: `/tmp/fake-${subagent.id}.jsonl`,
  parentToolCallId: HELD_TASK_CALL_ID,
}));
type HeldSubagent = (typeof HELD_SUBAGENTS)[number];
const heldSubagents = new Map<string, HeldSubagent>();
const typedApprovals = process.env.PASEO_OMP_FAKE_TYPED_APPROVALS !== "0";
const logPath = process.env.PASEO_OMP_FAKE_LOG;
const secret = process.env.PASEO_OMP_FAKE_SECRET ?? "fake-secret-not-configured";
// Delays the final usage sample a turn takes before it publishes its terminal state.
const statsDelayMs = Number(process.env.PASEO_OMP_FAKE_STATS_DELAY_MS ?? "0");

function record(value: unknown): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

let descendantPid: number | undefined;
if (process.env.PASEO_OMP_FAKE_STUBBORN_DESCENDANT === "1") {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { detached: false, stdio: "ignore" },
  );
  descendantPid = descendant.pid;
  descendant.unref();
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendChunked(value: unknown, chunkId: string): void {
  const payload = Buffer.from(JSON.stringify(value));
  const chunkBytes = 128 * 1024;
  const count = Math.ceil(payload.byteLength / chunkBytes);
  for (let index = 0; index < count; index += 1) {
    const data = payload.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    send({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: payload.byteLength,
      data: data.toString("base64"),
    });
  }
}

function respond(command: Record<string, unknown>, data: unknown = {}): void {
  send({ type: "response", id: command.id, command: command.type, success: true, data });
}

function assistant(
  text: string,
  responseId = `assistant-${promptSequence}`,
): Record<string, unknown> {
  return { role: "assistant", responseId, content: text };
}

function finish(text: string, queueLateDuplicate = false): void {
  const message = assistant(text);
  send({ type: "message_end", message });
  send({ type: "turn_end" });
  send({ type: "agent_end", messages: [message], isTerminal: true });
  activeScenario = null;
  if (queueLateDuplicate) lateTerminalMessage = message;
}

function emitBasicPrompt(message: string): void {
  send({ type: "turn_start" });
  send({ type: "agent_start" });
  const entryId = message.includes("CONTRACT_REWIND") ? "user-root" : `user-${promptSequence}`;
  send({
    type: "message_end",
    message: { role: "user", content: message, entryId },
  });
  finish("FAKE_OK", message.startsWith("SOAK_"));
}

/**
 * A run OMP starts without a client prompt, as autoresearch resume, goal continuation, and
 * async job or IRC wakes do: a hidden custom message, then the agent's reply.
 */
function startNativeRun(customType: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "message_end",
    message: {
      role: "custom",
      id: `${customType}-${promptSequence}`,
      customType,
      display: false,
      content: "continue",
    },
  });
}

function finishNativeRun(text: string): void {
  const message = assistant(text, `native-${text}`);
  send({ type: "message_end", message });
  send({ type: "turn_end" });
  send({ type: "agent_end", messages: [message], isTerminal: true });
  send({ type: "session_settled" });
  activeScenario = null;
}

function emitNativeRun(customType: string, text: string): void {
  startNativeRun(customType);
  finishNativeRun(text);
}

function emitFullContract(message: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_end", message: { role: "user", content: message, entryId: "user-root" } });
  send({
    type: "message_start",
    message: {
      role: "assistant",
      responseId: "stream-1",
      content: [
        { type: "text", text: "Hel" },
        { type: "thinking", thinking: "Reason" },
      ],
    },
  });
  send({
    type: "message_update",
    message: {
      role: "assistant",
      responseId: "stream-1",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Reasoning" },
      ],
    },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
  send({
    type: "tool_execution_start",
    toolCallId: "shell-1",
    toolName: "bash",
    args: { command: "printf contract" },
  });
  send({
    type: "tool_execution_update",
    toolCallId: "shell-1",
    toolName: "bash",
    partialResult: { output: "contract" },
  });
  send({
    type: "tool_execution_end",
    toolCallId: "shell-1",
    toolName: "bash",
    result: { output: "contract", exitCode: 0 },
    isError: false,
  });
  send({
    type: "todo_reminder",
    todos: [
      { id: "todo-1", content: "Verify contract", status: "in_progress" },
      { id: "todo-2", content: "Finish turn", status: "pending" },
    ],
  });
  send({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
  send({
    type: "auto_compaction_end",
    action: "context-full",
    result: { tokensBefore: 1_234 },
    aborted: false,
    willRetry: false,
  });
  send({
    type: "message_end",
    message: {
      role: "assistant",
      responseId: "stream-1",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "Reasoning" },
      ],
    },
  });
  send({
    type: "message_end",
    message: {
      role: "custom",
      id: "secret-event",
      customType: "notice",
      display: true,
      content: { text: `credential=${secret}` },
    },
  });
  send({ type: "turn_end" });
  send({ type: "agent_end", messages: [assistant("Hello", "stream-1")], isTerminal: true });
}

function emitChildContract(message: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_end", message: { role: "user", content: message, entryId: "user-child" } });
  send({
    type: "tool_execution_start",
    toolCallId: "task-root",
    toolName: "task",
    args: { agent: "worker", task: "delegate" },
  });
  send({
    type: "subagent_lifecycle",
    payload: {
      id: "child-1",
      agent: "worker",
      status: "started",
      description: "first child",
      parentToolCallId: "task-root",
      index: 0,
    },
  });
  send({
    type: "subagent_event",
    payload: {
      id: "child-1",
      event: {
        type: "tool_execution_start",
        toolCallId: "task-child",
        toolName: "task",
        args: { agent: "nested", task: "nested delegate" },
      },
    },
  });
  send({
    type: "subagent_lifecycle",
    payload: {
      id: "grandchild-1",
      agent: "nested",
      status: "started",
      description: "nested child",
      parentToolCallId: "task-child",
      index: 0,
    },
  });
  send({
    type: "subagent_event",
    payload: {
      id: "grandchild-1",
      event: {
        type: "message_end",
        message: { role: "assistant", responseId: "grandchild-answer", content: "GRANDCHILD_OK" },
      },
    },
  });
  send({
    type: "subagent_lifecycle",
    payload: {
      id: "grandchild-1",
      agent: "nested",
      status: "completed",
      parentToolCallId: "task-child",
      index: 0,
    },
  });
  send({
    type: "subagent_event",
    payload: {
      id: "child-1",
      event: {
        type: "tool_execution_end",
        toolCallId: "task-child",
        toolName: "task",
        result: { details: { results: [{ id: "grandchild-1", agent: "nested", exitCode: 0 }] } },
        isError: false,
      },
    },
  });
  send({
    type: "subagent_event",
    payload: {
      id: "child-1",
      event: {
        type: "message_end",
        message: { role: "assistant", responseId: "child-answer", content: "CHILD_OK" },
      },
    },
  });
  send({
    type: "subagent_lifecycle",
    payload: {
      id: "child-1",
      agent: "worker",
      status: "completed",
      parentToolCallId: "task-root",
      index: 0,
    },
  });
  send({
    type: "tool_execution_end",
    toolCallId: "task-root",
    toolName: "task",
    result: { details: { results: [{ id: "child-1", agent: "worker", exitCode: 0 }] } },
    isError: false,
  });
  finish("ROOT_OK");
}

/**
 * Running children that only `cancel_subagent` ends, so the root turn stays active meanwhile.
 * `CONTRACT_SUBAGENT_HOLD` starts one; `CONTRACT_SUBAGENT_HOLD_TEAM` starts the two others.
 */
function emitHeldSubagents(message: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_end", message: { role: "user", content: message, entryId: "user-held" } });
  send({
    type: "tool_execution_start",
    toolCallId: HELD_TASK_CALL_ID,
    toolName: "task",
    args: { agent: "worker", task: "hold" },
  });
  const team = message.includes("CONTRACT_SUBAGENT_HOLD_TEAM");
  for (const subagent of team ? HELD_SUBAGENTS.slice(1) : HELD_SUBAGENTS.slice(0, 1)) {
    heldSubagents.set(subagent.id, subagent);
    send({ type: "subagent_lifecycle", payload: { ...subagent, status: "started" } });
  }
}

function cancelHeldSubagent(command: Record<string, unknown>): void {
  const subagent = heldSubagents.get(String(command.subagentId));
  respond(command, { cancelled: subagent !== undefined });
  if (!subagent) return;
  heldSubagents.delete(subagent.id);
  send({ type: "subagent_lifecycle", payload: { ...subagent, status: "aborted" } });
  if (heldSubagents.size > 0) return;
  send({
    type: "tool_execution_end",
    toolCallId: HELD_TASK_CALL_ID,
    toolName: "task",
    result: { details: { results: [{ id: subagent.id, aborted: true }] } },
    isError: true,
  });
  // Like OMP, stopping a child only settles its task call; the parent turn carries on.
  send({ type: "message_end", message: assistant("ROOT_CONTINUES", "held-follow-up") });
  finish("ROOT_AFTER_CANCEL");
}

function steerHeldSubagent(command: Record<string, unknown>): void {
  const subagent = heldSubagents.get(String(command.subagentId));
  if (!subagent) {
    send({
      type: "response",
      id: command.id,
      command: command.type,
      success: false,
      error: `Subagent not running: ${String(command.subagentId)}`,
    });
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: true });
  send({
    type: "subagent_event",
    payload: {
      id: subagent.id,
      event: {
        type: "message_end",
        message: { role: "user", content: command.message, entryId: `${subagent.id}-steer` },
      },
    },
  });
}

function emitLargeContract(message: string): void {
  send({ type: "turn_start" });
  send({ type: "agent_start" });
  send({ type: "message_end", message: { role: "user", content: message, entryId: "user-large" } });
  const text = `LARGE:${"x".repeat(600_000)}`;
  const finalMessage = assistant(text, "large-answer");
  sendChunked({ type: "message_end", message: finalMessage }, "large-live-frame");
  send({ type: "turn_end" });
  send({ type: "agent_end", messages: [finalMessage], isTerminal: true });
}

function handlePrompt(command: Record<string, unknown>): void {
  const message = String(command.message ?? "");
  promptSequence += 1;
  respond(command, { agentInvoked: true });
  setImmediate(() => {
    send({ type: "prompt_result", id: command.id, agentInvoked: true });
    setImmediate(() => {
      if (message.includes("CONTRACT_FULL")) {
        emitFullContract(message);
      } else if (message.includes("CONTRACT_TYPED_PERMISSION")) {
        const cancel = message.includes("_CANCEL");
        activeScenario = cancel ? "typed-cancel" : "typed-permission";
        send({ type: "turn_start" });
        send({ type: "agent_start" });
        send({
          type: "message_end",
          message: { role: "user", content: message, entryId: `user-permission-${promptSequence}` },
        });
        const id = `approval-${promptSequence}`;
        const toolCallId = `approval-tool-${promptSequence}`;
        activeApprovalId = id;
        activeApprovalToolCallId = toolCallId;
        send({
          type: "tool_approval_request",
          id,
          toolCallId,
          toolKind: "shell",
          toolName: "bash",
          tier: "exec",
          identity: { kind: "shell", command: "printf approved" },
          input: { command: "printf approved", token: secret },
          detail: {
            lines: ["Command: printf approved"],
            truncated: false,
            truncatedFields: [],
            redacted: true,
            redactedFields: ["input.token"],
          },
        });
        if (cancel) {
          setTimeout(() => {
            send({ type: "tool_approval_cancel", id: `cancel-${id}`, targetId: id, toolCallId });
            finish("TYPED_CANCELED");
          }, 25);
        }
      } else if (message.includes("CONTRACT_FALLBACK_PERMISSION")) {
        const cancel = message.includes("_CANCEL");
        activeScenario = cancel ? "fallback-cancel" : "fallback-permission";
        send({ type: "turn_start" });
        send({ type: "agent_start" });
        send({
          type: "message_end",
          message: { role: "user", content: message, entryId: `user-fallback-${promptSequence}` },
        });
        const id = `fallback-${promptSequence}`;
        activeFallbackId = id;
        send({
          type: "extension_ui_request",
          id,
          method: "confirm",
          title: "Run command",
          message: "Approve fallback operation?",
        });
        if (cancel) {
          setTimeout(() => {
            send({
              type: "extension_ui_request",
              id: `cancel-${id}`,
              method: "cancel",
              targetId: id,
            });
            finish("FALLBACK_CANCELED");
          }, 25);
        }
      } else if (message.includes("CONTRACT_HOLD")) {
        activeScenario = "hold";
        send({ type: "turn_start" });
        send({ type: "agent_start" });
        send({
          type: "message_end",
          message: { role: "user", content: message, entryId: `user-hold-${promptSequence}` },
        });
      } else if (message.includes("CONTRACT_AUTO_RESUME")) {
        emitBasicPrompt(message);
        setTimeout(() => emitNativeRun("autoresearch-resume", "AUTO_RESUMED"), 50);
      } else if (message.includes("CONTRACT_LATE_WAKE")) {
        emitBasicPrompt(message);
        send({ type: "session_settled" });
        setTimeout(() => emitNativeRun("async-result", "LATE_WAKE_OK"), 1_000);
      } else if (message.includes("CONTRACT_NATIVE_HOLD")) {
        emitBasicPrompt(message);
        setTimeout(() => {
          activeScenario = "native-hold";
          startNativeRun("goal-continuation");
        }, 50);
      } else if (message.includes("CONTRACT_SETTLE_HOLD")) {
        send({ type: "agent_start" });
        send({ type: "turn_start" });
        send({
          type: "message_end",
          message: { role: "user", content: message, entryId: `user-settle-${promptSequence}` },
        });
        const held = assistant("HELD_OK");
        send({ type: "message_end", message: held });
        send({ type: "turn_end" });
        // The run waits on a background job whose delivery is then cancelled: no run follows.
        send({ type: "agent_end", messages: [held], isTerminal: false, awaitingAsyncWork: true });
        setTimeout(() => send({ type: "session_settled" }), 25);
      } else if (message.includes("CONTRACT_SUBAGENT_HOLD")) {
        emitHeldSubagents(message);
      } else if (message.includes("CONTRACT_CHILD")) {
        emitChildContract(message);
      } else if (message.includes("CONTRACT_LARGE")) {
        emitLargeContract(message);
      } else if (message.includes("CONTRACT_SIDE_CHANNELS")) {
        send({
          type: "extension_error",
          extensionPath: "/repo/.omp/extensions/lint.ts",
          event: "tool_call",
          error: "lint hook threw",
        });
        send({ type: "session_info_update", title: "Renamed", sessionId });
        send({ type: "config_update", model: currentModel, thinkingLevel });
        emitBasicPrompt(message);
      } else if (message.includes("CONTRACT_DIE")) {
        send({ type: "turn_start" });
        send({ type: "agent_start" });
        process.exit(17);
      } else {
        emitBasicPrompt(message);
      }
    });
  });
}

record({ kind: "start", pid: process.pid, argv: args });
if (descendantPid !== undefined) record({ kind: "descendant", pid: descendantPid });
process.on("SIGTERM", () => {
  record({ kind: "exit", pid: process.pid, signal: "SIGTERM" });
  process.exit(0);
});
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
  ...(typedApprovals ? { features: { typedToolApprovals: 1 } } : {}),
});

const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
reader.on("line", (line) => {
  let command: Record<string, unknown>;
  try {
    command = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  record({ kind: "command", command });
  switch (command.type) {
    case "negotiate_protocol":
      respond(command, {
        protocolVersion: 2,
        ...(typedApprovals ? { clientCapabilities: { typedToolApprovals: 1 } } : {}),
      });
      break;
    case "get_available_models":
      respond(command, { models: MODELS });
      break;
    case "get_available_commands":
      respond(command, {
        commands: [
          { name: "review", aliases: ["rv"], description: "Review changes", source: "extension" },
        ],
      });
      break;
    case "get_state":
      respond(command, {
        model: currentModel,
        thinkingLevel,
        isStreaming: activeScenario !== null,
        isCompacting: false,
        autoCompactionEnabled,
        sessionId,
        contextUsage: { tokens: 1_234, contextWindow: currentModel.contextWindow, percent: 1 },
      });
      break;
    case "get_session_stats": {
      const respondStats = () =>
        respond(command, {
          tokens: { input: 900, output: 120, cacheRead: 200 },
          cost: 0.42,
          contextUsage: { tokens: 1_234, contextWindow: currentModel.contextWindow, percent: 1 },
        });
      if (statsDelayMs > 0) setTimeout(respondStats, statsDelayMs);
      else respondStats();
      break;
    }
    case "get_messages_page": {
      const offset =
        typeof command.cursor === "string" && /^\d+$/u.test(command.cursor)
          ? Number(command.cursor)
          : 0;
      const limit =
        typeof command.limit === "number" && Number.isSafeInteger(command.limit)
          ? Math.max(1, Math.min(256, command.limit))
          : 100;
      const messages = history.slice(offset, offset + limit);
      const nextOffset = offset + messages.length;
      const data = {
        messages,
        ...(nextOffset < history.length ? { nextCursor: String(nextOffset) } : {}),
        totalMessages: history.length,
      };
      if (process.env.PASEO_OMP_FAKE_CHUNK_HISTORY === "1") {
        sendChunked(
          {
            type: "response",
            id: command.id,
            command: command.type,
            success: true,
            data,
          },
          `history-page-${offset}`,
        );
      } else {
        respond(command, data);
      }
      break;
    }
    case "get_messages":
      if (process.env.PASEO_OMP_FAKE_CHUNK_HISTORY === "1") {
        sendChunked(
          {
            type: "response",
            id: command.id,
            command: command.type,
            success: true,
            data: { messages: history },
          },
          "history-frame",
        );
      } else {
        respond(command, { messages: history });
      }
      break;
    case "get_branch_messages":
      respond(command, { messages: [{ entryId: "user-root", text: "replayed question" }] });
      break;
    case "branch":
      sessionId = BRANCHED_SESSION_ID;
      history = [{ role: "user", content: "replayed question", entryId: "user-root" }];
      // Like OMP, a branch is a new session journal that a later resume can resolve.
      if (sessionDir) {
        writeFileSync(
          join(sessionDir, `2026-09-12T00-00-01-000Z_${BRANCHED_SESSION_ID}.jsonl`),
          `${[
            { type: "session", version: 3, id: BRANCHED_SESSION_ID, cwd: process.cwd() },
            {
              type: "message",
              id: "user-root",
              parentId: null,
              message: { role: "user", content: "replayed question" },
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n")}\n`,
        );
      }
      respond(command, { text: "replayed question", cancelled: false });
      break;
    case "get_subagents":
      respond(command, {
        subagents: [...heldSubagents.values()].map((subagent) => ({
          ...subagent,
          status: "running",
          lastUpdate: Date.now(),
        })),
      });
      break;
    case "cancel_subagent":
      cancelHeldSubagent(command);
      break;
    case "steer_subagent":
      steerHeldSubagent(command);
      break;
    case "get_subagent_messages":
      respond(command, {
        sessionFile: "/tmp/fake-child.jsonl",
        fromByte: 0,
        nextByte: 1,
        messages: [],
      });
      break;
    case "set_subagent_subscription":
    case "set_host_tools":
      respond(command, command.type === "set_host_tools" ? { toolNames: [] } : {});
      break;
    case "set_model": {
      const selected = MODELS.find(
        (model) => model.provider === command.provider && model.id === command.modelId,
      );
      if (selected) {
        currentModel = selected;
        if (!(selected.thinking.efforts as readonly string[]).includes(thinkingLevel)) {
          thinkingLevel = selected.thinking.defaultLevel;
        }
      }
      respond(command, currentModel);
      break;
    }
    case "set_thinking_level":
      thinkingLevel = String(command.level);
      if (lateTerminalMessage) {
        send({ type: "message_end", message: lateTerminalMessage });
        send({ type: "agent_end", messages: [lateTerminalMessage], isTerminal: true });
        lateTerminalMessage = null;
      }
      respond(command);
      break;
    case "set_auto_compaction":
      autoCompactionEnabled = command.enabled === true;
      respond(command);
      break;
    case "compact":
      // OMP 18.13.3+ brackets every manual compaction with these events before answering.
      if (String(command.customInstructions ?? "").includes("CONTRACT_MANUAL_EVENTS")) {
        send({ type: "manual_compaction_start" });
        send({
          type: "manual_compaction_end",
          result: { summary: "kept", firstKeptEntryId: "user-1", tokensBefore: 1_234, details: {} },
          aborted: false,
        });
      }
      respond(command, { tokensBefore: 1_234 });
      break;
    case "handoff":
    case "follow_up":
      respond(command);
      setTimeout(() => finish(command.type === "handoff" ? "HANDOFF_OK" : "FOLLOW_UP_OK"), 0);
      break;
    case "prompt":
      handlePrompt(command);
      break;
    case "steer":
      respond(command);
      send({
        type: "message_end",
        message: { role: "user", content: command.message, entryId: "user-steer" },
      });
      send({ type: "message_end", message: assistant("STEERED") });
      if (activeScenario === "native-hold") setTimeout(() => finishNativeRun("NATIVE_STEERED"), 10);
      break;
    case "abort":
      respond(command);
      setTimeout(() => finish("INTERRUPTED", true), 0);
      break;
    case "tool_approval_response":
      if (
        activeScenario === "typed-permission" &&
        command.id === activeApprovalId &&
        command.toolCallId === activeApprovalToolCallId
      ) {
        send({
          type: "tool_execution_end",
          toolCallId: activeApprovalToolCallId,
          toolName: "bash",
          result: { output: command.approved === true ? "approved" : "denied", exitCode: 0 },
          isError: command.approved !== true,
        });
        finish(command.approved === true ? "APPROVED" : "DENIED");
      }
      break;
    case "extension_ui_response":
      if (activeScenario === "fallback-permission" && command.id === activeFallbackId) {
        finish(command.confirmed === true ? "FALLBACK_APPROVED" : "FALLBACK_DENIED");
      }
      break;
    default:
      if (typeof command.id === "string") respond(command);
  }
});

reader.on("close", () => {
  record({ kind: "eof-ignored", pid: process.pid });
});
