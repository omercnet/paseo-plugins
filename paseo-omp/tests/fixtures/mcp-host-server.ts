const port = Number(process.env.MCP_HOST_PORT);
if (!Number.isInteger(port) || port < 0) throw new Error("MCP_HOST_PORT is required");

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    if (request.method === "GET") return new Response(null, { status: 405 });
    const payload = (await request.json()) as {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    let result: Record<string, unknown>;
    if (payload.method === "initialize") {
      const params = payload.params as { protocolVersion?: string } | undefined;
      result = {
        protocolVersion: params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-cross-boundary-test", version: "1.0.0" },
      };
    } else if (payload.method === "tools/list") {
      result = {
        tools: [
          {
            name: "workspace_probe",
            description: "Report the MCP execution owner",
            inputSchema: { type: "object" },
          },
        ],
      };
    } else if (payload.method === "tools/call") {
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              callerAgentId: new URL(request.url).searchParams.get("callerAgentId"),
              workspaceId: (payload.params as { arguments?: { workspaceId?: string } } | undefined)
                ?.arguments?.workspaceId,
              ownerMarker: process.env.OWNER_MARKER,
              ownerPid: process.pid,
              ownerCwd: process.cwd(),
              input: payload.params,
            }),
          },
        ],
      };
    } else {
      return Response.json(
        { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "Not found" } },
        { status: 404 },
      );
    }
    return Response.json({ jsonrpc: "2.0", id: payload.id, result });
  },
});

console.log(`MCP_HOST_READY ${server.port} ${process.pid}`);
