import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
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
let sessionId =
  resumeIndex >= 0 ? (args[resumeIndex + 1] ?? PRIMARY_SESSION_ID) : PRIMARY_SESSION_ID;
const modelIndex = args.indexOf("--model");
const configuredModel = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
let currentModel =
  MODELS.find((model) => `${model.provider}/${model.id}` === configuredModel) ?? MODELS[0];
const thinkingIndex = args.indexOf("--thinking");
let thinkingLevel = thinkingIndex >= 0 ? (args[thinkingIndex + 1] ?? "medium") : "medium";
let autoCompactionEnabled = true;
let activeScenario:
  | "hold"
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
const typedApprovals = process.env.PASEO_OMP_FAKE_TYPED_APPROVALS !== "0";
const logPath = process.env.PASEO_OMP_FAKE_LOG;
const secret = process.env.PASEO_OMP_FAKE_SECRET ?? "fake-secret-not-configured";

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
      } else if (message.includes("CONTRACT_CHILD")) {
        emitChildContract(message);
      } else if (message.includes("CONTRACT_LARGE")) {
        emitLargeContract(message);
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
    case "get_session_stats":
      respond(command, {
        tokens: { input: 900, output: 120, cacheRead: 200 },
        cost: 0.42,
        contextUsage: { tokens: 1_234, contextWindow: currentModel.contextWindow, percent: 1 },
      });
      break;
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
      respond(command, { text: "replayed question", cancelled: false });
      break;
    case "get_subagents":
      respond(command, { subagents: [] });
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
      send({
        type: "message_end",
        message: { role: "user", content: command.message, entryId: "user-steer" },
      });
      send({ type: "message_end", message: assistant("STEERED") });
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
