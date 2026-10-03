import { type AgentEntry, matches, title } from "./agents";

export type TellArguments = { target: string; message: string; interrupt: boolean };

// Best effort: the host may still replace the active turn when the provider cannot steer.
export function sourceSendOptions(interrupt = false) {
  return { activeTurnBehavior: interrupt ? "interrupt" : "steer" } as const;
}

export type TargetResolution =
  | { kind: "match"; entry: AgentEntry }
  | { kind: "none" }
  | { kind: "ambiguous"; entries: AgentEntry[] };

export function isMessageable(entry: AgentEntry, sourceAgentId: string): boolean {
  const agent = entry.agent;
  return agent.id !== sourceAgentId && !agent.archivedAt && agent.status !== "closed";
}

export function messageTargets(
  entries: readonly AgentEntry[],
  sourceAgentId: string,
  query: string,
): AgentEntry[] {
  const needle = query.trim().replace(/^@/, "").toLowerCase();
  return entries
    .filter((entry) => isMessageable(entry, sourceAgentId) && matches(entry, needle))
    .sort((left, right) => {
      const leftTitle = title(left).toLowerCase();
      const rightTitle = title(right).toLowerCase();
      const leftExact = left.agent.id.toLowerCase() === needle || leftTitle === needle;
      const rightExact = right.agent.id.toLowerCase() === needle || rightTitle === needle;
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return Date.parse(right.agent.updatedAt) - Date.parse(left.agent.updatedAt);
    });
}

export function resolveMessageTarget(
  entries: readonly AgentEntry[],
  sourceAgentId: string,
  query: string,
): TargetResolution {
  const needle = query.trim().replace(/^@/, "").toLowerCase();
  if (!needle) return { kind: "none" };
  const candidates = entries.filter((entry) => isMessageable(entry, sourceAgentId));
  const idMatches = candidates.filter((entry) => entry.agent.id.toLowerCase().startsWith(needle));
  if (idMatches.length === 1) return { kind: "match", entry: idMatches[0] as AgentEntry };
  if (idMatches.length > 1) return { kind: "ambiguous", entries: idMatches };
  const titleMatches = candidates.filter((entry) => title(entry).toLowerCase() === needle);
  if (titleMatches.length === 1) return { kind: "match", entry: titleMatches[0] as AgentEntry };
  if (titleMatches.length > 1) return { kind: "ambiguous", entries: titleMatches };
  const fuzzyMatches = messageTargets(candidates, sourceAgentId, needle);
  if (fuzzyMatches.length === 1) return { kind: "match", entry: fuzzyMatches[0] as AgentEntry };
  if (fuzzyMatches.length > 1) return { kind: "ambiguous", entries: fuzzyMatches };
  return { kind: "none" };
}

export function parseTellArguments(args: string): TellArguments | null {
  const flag = /^\s*--interrupt(?=\s)/.exec(args);
  const rest = flag ? args.slice(flag[0].length) : args;
  const separator = rest.indexOf("::");
  if (separator < 1) return null;
  const target = rest.slice(0, separator).trim();
  const message = rest.slice(separator + 2).trim();
  return target && message ? { target, message, interrupt: Boolean(flag) } : null;
}

export function formatTellInstruction(targetAgentId: string, message: string): string {
  return `tell ${targetAgentId}: ${message.trim()}`;
}
