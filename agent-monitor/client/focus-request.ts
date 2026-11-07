/**
 * A pending request to focus an agent's card in the graph, set by the sidebar
 * quick access just before opening the monitor. Module state survives screen
 * reuse: opening the same screen again does not always deliver fresh params,
 * but it always runs in this same client bundle.
 */
let pendingAgentId: string | null = null;

/**
 * A pending request to open an agent's own screen instead of the graph. The
 * sidebar popover cannot navigate (it only receives `openScreen`), so it leaves
 * the request here and the monitor screen consumes it once. The token ties the
 * request to the screen open that carried it, so a request whose screen never
 * mounted cannot fire on a later, unrelated monitor visit.
 */
export type AgentOpenRequest = {
  agentId: string;
  serverId?: string;
  token: string;
};
let pendingOpen: AgentOpenRequest | null = null;

export function requestAgentFocus(agentId: string): void {
  pendingAgentId = agentId;
}

export function peekAgentFocus(): string | null {
  return pendingAgentId;
}

export function takeAgentFocus(): string | null {
  const id = pendingAgentId;
  pendingAgentId = null;
  return id;
}

/**
 * The agent a deep link should focus: the pending request or the screen param,
 * whichever is in the roster first. A stale pending id (archived or absent
 * agent) must not shadow a valid param.
 */
export function resolveDeepFocus(
  pending: string | null,
  param: string | undefined,
  entryIds: readonly string[],
): string | null {
  return [pending, param].find((id) => id && entryIds.includes(id)) ?? null;
}

export function requestAgentOpen(request: AgentOpenRequest): void {
  pendingOpen = { ...request };
}

export function peekAgentOpen(): AgentOpenRequest | null {
  return pendingOpen;
}

export function takeAgentOpen(): AgentOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

export type CycleTarget = {
  agentId: string;
  serverId?: string;
};

let cycleList: CycleTarget[] = [];
let cycleIndex = -1;

/**
 * The ids the next/previous commands cycle through, in overview order. The
 * always-mounted sidebar row refreshes it from the merged multi-host roster,
 * because global commands cannot enumerate hosts themselves.
 */
export function setCycleList(targets: readonly CycleTarget[]): void {
  cycleList = [...targets];
  if (cycleIndex >= cycleList.length) cycleIndex = cycleList.length - 1;
}

/** Step the pointer and return the target, wrapping around. Null when empty. */
export function stepCycle(delta: 1 | -1): CycleTarget | null {
  if (cycleList.length === 0) return null;
  // An unstarted pointer (-1) steps back from the first item, so Previous lands on the last one.
  const from = cycleIndex < 0 && delta < 0 ? 0 : cycleIndex;
  cycleIndex = (((from + delta) % cycleList.length) + cycleList.length) % cycleList.length;
  return cycleList[cycleIndex] ?? null;
}
