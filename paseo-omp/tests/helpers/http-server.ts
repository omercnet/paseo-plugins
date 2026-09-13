import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface TestHttpServer {
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${request.headers.host}${request.url}`, {
    method: request.method,
    headers: request.headers as HeadersInit,
    body,
  });
}

async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) target.setHeader(name, value);
  target.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

export async function startFetchServer(
  handler: (request: Request) => Response | Promise<Response>,
  options: { hostname?: string; port?: number } = {},
): Promise<TestHttpServer> {
  const server = createServer(async (request, response) => {
    try {
      await sendResponse(await handler(await toRequest(request)), response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind TCP");
  return {
    port: address.port,
    stop(closeActiveConnections = false) {
      if (closeActiveConnections) server.closeAllConnections();
      server.close();
    },
  };
}
