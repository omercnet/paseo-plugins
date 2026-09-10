import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { createOmpConnection } from "./connection";
import { OmpRpcRuntime, type OmpRuntime } from "./omp-rpc";
import type { OmpTimelineScheduler } from "./timeline-projector";

const CAPABILITIES = ["prompt.message", "prompt.steer", "session.configure"] as const;

export interface OmpProviderOptions {
  runtime?: OmpRuntime;
  timelineScheduler?: OmpTimelineScheduler;
}

export function createOmpProvider(options: OmpProviderOptions = {}): ProviderRegistration {
  return {
    id: "omp-plugin",
    label: "OMP (Plugin Preview)",
    description: "Canary direct provider for OMP's rpc-ui protocol",
    icon: "server/provider/omp.svg",
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("OMP Plugin Preview requires provider protocol version 1");
      }
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return createOmpConnection(
        options.runtime ?? new OmpRpcRuntime(),
        capabilities,
        options.timelineScheduler,
      );
    },
  };
}
