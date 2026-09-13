import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "paseo-omp-canary", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo_marker",
      description: "Return a deterministic canary marker",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name !== "echo_marker") throw new Error("Unknown canary tool");
  const value = request.params.arguments?.value;
  if (typeof value !== "string") throw new Error("Canary value is required");
  return { content: [{ type: "text", text: value }] };
});

await server.connect(new StdioServerTransport());
