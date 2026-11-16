import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { getOmpSessionModelProvider } from "../shared/quota";
import type { cancelOmpSubagent, steerOmpSubagent } from "../shared/subagents";
import type { OmpLogoutAccount } from "./provider/omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "./provider/omp-rpc-transport";
import { isOmpPublicError, OmpPublicError } from "./provider/security";

/** Controls of one live OMP session; history-only sessions never register. */
export interface OmpSubagentControls {
  /** Resolves `false` when the subagent is no longer running. */
  cancelSubagent(handle: string): Promise<boolean>;
  steerSubagent(handle: string, message: string): Promise<void>;
  /** The OMP provider of the session's current model, or null once the session has ended. */
  modelProvider(): string | null;
  /** The provider's stored logins; `active` marks the ones this session may be using. */
  listProviderAccounts(provider: string): Promise<OmpLogoutAccount[]>;
}

export class OmpSubagentNotRunningError extends OmpPublicError {
  constructor() {
    super("This subagent is no longer running");
  }
}

type SubagentOperation = "cancel" | "steer";

const OPERATION_FAILURES: Record<SubagentOperation, string> = {
  cancel: "OMP could not cancel the subagent",
  steer: "OMP did not accept the message. The subagent may have finished or refused it",
};

// A timed-out request is not withdrawn from OMP, so its outcome is unknown rather than failed.
const OPERATION_TIMEOUTS: Record<SubagentOperation, string> = {
  cancel: "OMP did not confirm the cancellation in time. Check the subagent before retrying",
  steer: "OMP did not confirm delivery in time. The subagent may still receive the message",
};

/**
 * Routes subagent controls to the OMP session that owns a Paseo agent. Keys are the agent ID the
 * plugin's own `agent.session_open` hook injects, so a request can only reach that agent's
 * runtime, and OMP then resolves the subagent only within that runtime's roster.
 */
export class OmpSubagentControlRegistry {
  private readonly agents = new Map<string, { controls: OmpSubagentControls }>();

  /** A newer session for the same agent replaces the older one; its removal is then a no-op. */
  register(agentId: string, controls: OmpSubagentControls): () => void {
    const entry = { controls };
    this.agents.set(agentId, entry);
    return () => {
      if (this.agents.get(agentId) === entry) this.agents.delete(agentId);
    };
  }

  get(agentId: string): OmpSubagentControls | undefined {
    return this.agents.get(agentId)?.controls;
  }

  clear(): void {
    this.agents.clear();
  }
}

async function withPublicFailure<T>(operation: SubagentOperation, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (isOmpPublicError(error)) throw error;
    if (error instanceof OmpRpcRequestRejectedError && error.code === "unsupported_command") {
      throw new OmpPublicError("Update OMP to 18.4.9 or newer to control subagents from Paseo");
    }
    if (error instanceof Error && error.message === "OMP RPC request timed out") {
      throw new OmpPublicError(OPERATION_TIMEOUTS[operation]);
    }
    // Native OMP error text is never forwarded; it can echo arbitrary subagent output.
    throw new OmpPublicError(OPERATION_FAILURES[operation]);
  }
}

function controlsFor(registry: OmpSubagentControlRegistry, agentId: string): OmpSubagentControls {
  const controls = registry.get(agentId);
  if (!controls) throw new OmpPublicError("This agent has no running OMP Plugin session");
  return controls;
}

export async function resolveCancelOmpSubagent(
  input: RpcInput<typeof cancelOmpSubagent>,
  registry: OmpSubagentControlRegistry,
): Promise<RpcOutput<typeof cancelOmpSubagent>> {
  const controls = controlsFor(registry, input.agentId);
  return {
    cancelled: await withPublicFailure("cancel", () => controls.cancelSubagent(input.subagentId)),
  };
}

export async function resolveSteerOmpSubagent(
  input: RpcInput<typeof steerOmpSubagent>,
  registry: OmpSubagentControlRegistry,
): Promise<RpcOutput<typeof steerOmpSubagent>> {
  const controls = controlsFor(registry, input.agentId);
  await withPublicFailure("steer", () => controls.steerSubagent(input.subagentId, input.message));
  return { accepted: true };
}

/** No live session (closed, history-only or another daemon's) answers null rather than failing. */
export function resolveGetOmpSessionModelProvider(
  input: RpcInput<typeof getOmpSessionModelProvider>,
  registry: OmpSubagentControlRegistry,
): RpcOutput<typeof getOmpSessionModelProvider> {
  return { provider: registry.get(input.agentId)?.modelProvider() ?? null };
}
