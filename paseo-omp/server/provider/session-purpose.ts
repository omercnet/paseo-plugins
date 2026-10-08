import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import { OmpPublicError } from "./security";

type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;

/**
 * Paseo tells plugins why a session is being opened only through `before("agent.session_open")`
 * hooks, whose sole writable field is `env`; the plugin provider protocol forwards that env
 * untouched as `session.open.config.env`. The hook is therefore the single writer of this launch
 * marker and the connection is the single reader. It is never part of the stored agent config.
 */
export const OMP_SESSION_PURPOSE_ENV = "PASEO_OMP_SESSION_PURPOSE";
const HISTORY_PURPOSE = "history";

/**
 * Derives the launch marker from the host-decided purpose. Any marker already present is caller
 * input (for example `env` on agent creation), so it is always discarded first: only a host
 * resume whose purpose is history can produce it, and an absent purpose (older hosts) never does.
 */
export function withOmpSessionPurpose<
  T extends { reason?: string; purpose?: string; env: Record<string, string> },
>(request: T): Omit<T, "env"> & { env: Record<string, string> } {
  const env: Record<string, string> = { ...request.env };
  delete env[OMP_SESSION_PURPOSE_ENV];
  if (request.purpose === HISTORY_PURPOSE && request.reason === "resume") {
    env[OMP_SESSION_PURPOSE_ENV] = HISTORY_PURPOSE;
  }
  return { ...request, env };
}

/**
 * True when this open must be served from the persisted transcript alone, without a runtime
 * process or any working-directory access. The marker only narrows a persisted replay: it can
 * never be satisfied by a create, a non-replaying open, or a non-persisted config.
 */
export function isOmpHistoryOnlyOpen(input: SessionOpenInput): boolean {
  const marker = input.config.env[OMP_SESSION_PURPOSE_ENV];
  if (marker === undefined) return false;
  if (marker !== HISTORY_PURPOSE) throw new OmpPublicError("Invalid OMP session purpose");
  if (input.history !== "replay" || !input.persistence || !input.config.persist) {
    throw new OmpPublicError("OMP history purpose requires a persisted session replay");
  }
  return true;
}

/**
 * Removes the reserved launch marker from any env bound for an OMP process. The marker steers
 * the plugin only; it must never be forwarded to, or settable through per-agent provider options
 * for, a real OMP runtime.
 */
export function withoutOmpSessionPurpose(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const { [OMP_SESSION_PURPOSE_ENV]: _reserved, ...rest } = env;
  return rest;
}
