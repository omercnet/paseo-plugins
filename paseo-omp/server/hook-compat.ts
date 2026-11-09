import type { PaseoApi } from "@getpaseo/client";

/**
 * Turn lifecycle hooks the plugin consumes, paired with the names hosts before the 0.15 rename
 * publish instead. Paseo 0.14 has no `addHook` and fires only these legacy events.
 */
export const LEGACY_TURN_EVENTS = {
  "agent.turn.before": "agent.turn_started",
  "agent.turn.after": "agent.turn_ended",
} as const;

export type OmpTurnHookName = keyof typeof LEGACY_TURN_EVENTS;

/** How the running Paseo host lets a plugin observe agent turns. */
export type OmpHostHookApi = "addHook" | "legacy-events" | "not-supported";

export interface OmpTurnHookAgent {
  id: string;
  provider: string;
}

export interface OmpTurnHookContext {
  paseo: PaseoApi;
}

export interface OmpTurnHookPayload {
  agent: OmpTurnHookAgent;
  turnId: string | null;
}

export type OmpTurnHookHandler = (
  payload: OmpTurnHookPayload,
  context: OmpTurnHookContext,
) => Promise<void>;

interface HookRegistrar {
  addHook?: (name: string, handler: OmpTurnHookHandler) => () => void;
  on?: (name: string, handler: OmpTurnHookHandler) => () => void;
}

/** Detects the lifecycle API of the running host without looking at its version. */
export function detectHostHookApi(server: object): OmpHostHookApi {
  const candidate = server as HookRegistrar;
  if (typeof candidate.addHook === "function") return "addHook";
  if (typeof candidate.on === "function") return "legacy-events";
  return "not-supported";
}

/** Registers a turn hook through `addHook`, or through the legacy event name on older hosts. */
export function addTurnHook(
  server: object,
  name: OmpTurnHookName,
  handler: OmpTurnHookHandler,
): () => void {
  const candidate = server as HookRegistrar;
  if (typeof candidate.addHook === "function") return candidate.addHook(name, handler);
  if (typeof candidate.on === "function") return candidate.on(LEGACY_TURN_EVENTS[name], handler);
  throw new Error("This Paseo host exposes no plugin lifecycle hooks");
}

let hostHookApi: OmpHostHookApi = "not-supported";

/** Records what the plugin registered against, for the diagnostics report. */
export function recordHostHookApi(api: OmpHostHookApi): void {
  hostHookApi = api;
}

export function currentHostHookApi(): OmpHostHookApi {
  return hostHookApi;
}
