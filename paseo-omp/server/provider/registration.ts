import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { createOmpConnection } from "./connection";
import type { OmpMcpConnector } from "./host-tools";
import { OmpRpcRuntime, type OmpRuntime } from "./omp-rpc";
import { boundedJsonBytes } from "./security";
import type { OmpTimelineScheduler } from "./timeline-projector";

const CAPABILITIES = [
  "prompt.message",
  "prompt.steer",
  "session.configure",
  "permission.tool_policy",
] as const;
const ConnectRequestSchema = z.object({
  versions: z.array(z.number().int().positive().max(16)).min(1).max(8),
  capabilities: z.array(z.string().min(1).max(64)).max(32),
});

export interface OmpProviderOptions {
  runtime?: OmpRuntime;
  timelineScheduler?: OmpTimelineScheduler;
  environment?: NodeJS.ProcessEnv;
  mcpInitializationTimeoutMs?: number;
  mcpConnector?: OmpMcpConnector;
}

export function createOmpProvider(options: OmpProviderOptions = {}): ProviderRegistration {
  return {
    id: "omp-plugin",
    label: "OMP (Plugin Preview)",
    description: "Canary direct provider for OMP's rpc-ui protocol",
    icon: "server/provider/omp.svg",
    async connect(request) {
      if (boundedJsonBytes(request, 8 * 1024, 32, 256, 64) === Number.POSITIVE_INFINITY) {
        throw new Error("OMP Plugin Preview received an oversized connection request");
      }
      const parsed = ConnectRequestSchema.safeParse(request);
      if (!parsed.success || !parsed.data.versions.includes(1)) {
        throw new Error("OMP Plugin Preview requires a valid provider protocol version 1 request");
      }
      const requestedCapabilities = new Set(parsed.data.capabilities);
      const capabilities = CAPABILITIES.filter((capability) =>
        requestedCapabilities.has(capability),
      );
      return createOmpConnection(
        options.runtime ?? new OmpRpcRuntime({ environment: options.environment }),
        capabilities,
        options.timelineScheduler,
        options.environment,
        options.mcpConnector,
        options.mcpInitializationTimeoutMs,
      );
    },
  };
}
