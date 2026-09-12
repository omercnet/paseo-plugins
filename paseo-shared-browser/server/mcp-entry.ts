import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "./runtime-protocol";
import { AgentSupervisorClient } from "./supervisor-client";
import { resolveSupervisorPaths } from "./supervisor";

const TICKET_ENV = "PASEO_SHARED_BROWSER_TICKET";
const MIN_VIEWPORT = { width: 320, height: 480 } as const;
const MAX_VIEWPORT = { width: 1600, height: 1200 } as const;

const pointSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(16_384),
  height: z.number().finite().positive().max(16_384),
});

const inputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    point: pointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({ kind: z.literal("move"), point: pointSchema }),
  z.object({
    kind: z.literal("drag"),
    start: pointSchema,
    end: pointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    kind: z.literal("scroll"),
    point: pointSchema,
    deltaX: z.number().finite().min(-4_000).max(4_000),
    deltaY: z.number().finite().min(-4_000).max(4_000),
  }),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(4_000) }),
  z.object({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]),
  }),
]);

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Shared Browser supervisor returned an invalid response");
  return value;
}

function textResult(value: JsonValue) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function main(): Promise<void> {
  const ticket = process.env[TICKET_ENV];
  if (!ticket) throw new Error(`${TICKET_ENV} is required`);
  const client = new AgentSupervisorClient({
    ticket,
    paths: resolveSupervisorPaths(paseoHome()),
  });
  await client.open();

  const server = new McpServer({ name: "paseo-shared-browser", version: "0.2.2" });

  server.registerTool(
    "shared_browser_status",
    {
      description: "Read the current shared browser state for this agent's workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(await client.request("status", {})),
  );

  server.registerTool(
    "shared_browser_capture",
    {
      description:
        "Capture the current shared browser frame and state. Capture before sending input.",
      inputSchema: z.object({ quality: z.enum(["low", "medium", "high"]).default("medium") }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ quality }) => {
      const result = await client.request("capture", { quality });
      const data = asObject(result);
      const frame = data.frame;
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: JSON.stringify(data.state, null, 2) }];
      if (frame && typeof frame === "object" && !Array.isArray(frame)) {
        const image = frame as Record<string, JsonValue>;
        if (typeof image.dataBase64 === "string" && typeof image.mimeType === "string")
          content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
      }
      return { content };
    },
  );

  server.registerTool(
    "shared_browser_acquire_control",
    {
      description:
        "Acquire browser control if no human or other viewer currently holds it. Forced takeover is unavailable.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async () => textResult(await client.request("acquire-control", {})),
  );

  server.registerTool(
    "shared_browser_release_control",
    {
      description: "Release this agent's browser control lease.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async () => textResult(await client.request("release-control", {})),
  );
  server.registerTool(
    "shared_browser_navigate",
    {
      description: "Navigate the shared browser using the agent's current observed state.",
      inputSchema: z.object({
        action: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("goto"), url: z.string().trim().min(1).max(8_192) }),
          z.object({ kind: z.literal("back") }),
          z.object({ kind: z.literal("forward") }),
          z.object({ kind: z.literal("reload") }),
        ]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ action }) =>
      textResult(await client.request("navigate", { action: action as unknown as JsonValue })),
  );

  server.registerTool(
    "shared_browser_input",
    {
      description:
        "Send one input event using the exact frame returned by the latest capture. Stale frames are rejected.",
      inputSchema: z.object({ event: inputEventSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ event }) =>
      textResult(await client.request("input", { event: event as unknown as JsonValue })),
  );

  server.registerTool(
    "shared_browser_viewport",
    {
      description: "Resize the shared browser viewport using the agent's current observed state.",
      inputSchema: z.object({
        width: z.number().int().min(MIN_VIEWPORT.width).max(MAX_VIEWPORT.width),
        height: z.number().int().min(MIN_VIEWPORT.height).max(MAX_VIEWPORT.height),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (viewport) =>
      textResult(await client.request("viewport", { viewport: viewport as unknown as JsonValue })),
  );

  const transport = new StdioServerTransport();
  process.once("exit", () => client.disconnect());
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
