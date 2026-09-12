export {};

const port = Number(Bun.env.PORT ?? "8080");
const model = "deterministic";
let lastPayload: Record<string, unknown> | null = null;

function stream(frames: readonly object[]): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function toolName(tool: unknown): string | undefined {
  if (
    !tool ||
    typeof tool !== "object" ||
    !("function" in tool) ||
    !tool.function ||
    typeof tool.function !== "object" ||
    !("name" in tool.function) ||
    typeof tool.function.name !== "string"
  ) {
    return;
  }
  return tool.function.name;
}

function hasTool(tools: readonly unknown[], name: string): boolean {
  return tools.some((tool) => toolName(tool) === name);
}

function toolCallResponse(
  base: { id: string; object: string; created: number; model: string },
  id: string,
  name: string,
  args: object,
): Response {
  return stream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
}

async function chatResponse(payload: Record<string, unknown>): Promise<Response> {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && "role" in message && message.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : undefined;
  const hasToolResult = messages
    .slice(latestUserIndex + 1)
    .some(
      (message) =>
        message && typeof message === "object" && "role" in message && message.role === "tool",
    );
  const prompt =
    latestUser && typeof latestUser === "object" && "content" in latestUser
      ? textFromContent(latestUser.content)
      : "";
  if (prompt.includes("CANARY_DELAY")) await Bun.sleep(30_000);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const base = {
    id: `chatcmpl-canary-${Date.now()}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
  };

  if (!hasToolResult && hasTool(tools, "write") && prompt.includes("CANARY_MCP")) {
    return toolCallResponse(base, "call_canary_mcp", "write", {
      i: "Calling canary MCP echo",
      path: "xd://mcp__canary_echo_marker",
      content: JSON.stringify({ value: "CANARY_MCP_OK" }),
    });
  }

  if (!hasToolResult && hasTool(tools, "hub") && prompt.includes("CANARY_HUB_START")) {
    return toolCallResponse(base, "call_canary_hub", "hub", {
      i: "Starting canary sleeper",
      op: "start",
      name: `canary-sleeper-${Date.now()}`,
      application: "sleep",
      args: ["3600"],
      cwd: "/workspace/paseo-plugins",
      pty: false,
    });
  }

  if (!hasToolResult && hasTool(tools, "task") && prompt.includes("CANARY_SUBAGENT")) {
    return toolCallResponse(base, "call_canary_task", "task", {
      context:
        "# Goal\nExercise the Docker canary subagent path.\n# Constraints\nDo not edit files.\n# Contract\nReturn a short result.",
      tasks: [
        {
          name: "CanaryChild",
          task: "# Target\nNo files.\n# Change\nReturn CANARY_CHILD_OK.\n# Acceptance\nThe response contains CANARY_CHILD_OK.",
        },
      ],
    });
  }

  if (!hasToolResult && hasTool(tools, "bash") && prompt.includes("CANARY_TOOL")) {
    return toolCallResponse(base, "call_canary_bash", "bash", {
      command: "printf CANARY_TOOL_OK",
    });
  }

  const content = hasToolResult
    ? prompt.includes("CANARY_SUBAGENT")
      ? "CANARY_SUBAGENT_OK"
      : prompt.includes("CANARY_HUB_START")
        ? "CANARY_HUB_OK"
        : prompt.includes("CANARY_MCP")
          ? "CANARY_MCP_OK"
          : "CANARY_TOOL_OK"
    : "CANARY_MOCK_OK";
  return stream([
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ]);
}

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (request.method === "GET" && url.pathname === "/last-request") {
      return Response.json(lastPayload ?? {});
    }
    if (request.method === "GET" && url.pathname === "/tools") {
      const tools =
        lastPayload && Array.isArray(lastPayload.tools)
          ? lastPayload.tools.flatMap((tool) => {
              const name = toolName(tool);
              return name ? [name] : [];
            })
          : [];
      return Response.json({ tools });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: model, object: "model" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      lastPayload = (await request.json()) as Record<string, unknown>;
      return await chatResponse(lastPayload);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

process.stdout.write(`mock LLM listening on 0.0.0.0:${port}\n`);
