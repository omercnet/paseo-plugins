import { createInterface } from "node:readline";

const MODEL = {
  provider: "canary-mock",
  id: "deterministic",
  name: "Deterministic Canary",
  reasoning: false,
  input: ["text"],
  contextWindow: 32_000,
};
const SECRET = "CANARY_PROTOCOL_SECRET_DO_NOT_LOG";
const MALFORMED_FRAME_BYTES = 777;
const malformedFrame = {
  type: "notice",
  level: 42,
  message: SECRET,
  arguments: { credential: SECRET },
  result: SECRET,
  path: `/private/${SECRET}`,
  environment: { TOKEN: SECRET },
  padding: "",
};
malformedFrame.padding = "x".repeat(
  MALFORMED_FRAME_BYTES - Buffer.byteLength(JSON.stringify(malformedFrame)),
);
if (Buffer.byteLength(JSON.stringify(malformedFrame)) !== MALFORMED_FRAME_BYTES) {
  throw new Error("Could not construct the bounded malformed canary frame");
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, data = {}) {
  send({ type: "response", id: command.id, command: command.type, success: true, data });
}

send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
});

const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
reader.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  switch (command.type) {
    case "negotiate_protocol":
      respond(command, { protocolVersion: 2 });
      break;
    case "get_available_models":
      respond(command, { models: [MODEL] });
      break;
    case "get_available_commands":
      respond(command, { commands: [] });
      break;
    case "get_state":
      respond(command, {
        model: MODEL,
        isStreaming: false,
        isCompacting: false,
        sessionId: "protocol-violation-canary",
      });
      break;
    case "get_messages":
      respond(command, { messages: [] });
      break;
    case "prompt": {
      const message = String(command.message ?? "");
      respond(command, { agentInvoked: true });
      send({ type: "prompt_result", id: command.id, agentInvoked: true });
      send({ type: "turn_start" });
      send({ type: "agent_start" });
      send({
        type: "message_end",
        message: { role: "user", content: message, entryId: "protocol-user" },
      });
      for (let occurrence = 0; occurrence < 100; occurrence += 1) send(malformedFrame);
      const assistant = {
        role: "assistant",
        responseId: "protocol-assistant",
        content: "PROTOCOL_RECOVERED",
      };
      send({ type: "message_end", message: assistant });
      send({ type: "turn_end" });
      send({
        type: "agent_end",
        requestId: command.id,
        messages: [assistant],
        messageCount: 1,
        isTerminal: true,
      });
      break;
    }
    default:
      if (typeof command.id === "string") respond(command);
  }
});
