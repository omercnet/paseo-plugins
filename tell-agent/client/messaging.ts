import { type AgentEntry, matches, placement, title } from "./agents";

export type TellArguments = { target: string; message: string };

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
  const separator = args.indexOf("::");
  if (separator < 1) return null;
  const target = args.slice(0, separator).trim();
  const message = args.slice(separator + 2).trim();
  return target && message ? { target, message } : null;
}

export function formatCrossSessionMessage(
  source: AgentEntry | undefined,
  sourceAgentId: string,
  message: string,
): string {
  const sourceLabel = source
    ? `${title(source)} (${placement(source)})`
    : `agent ${sourceAgentId.slice(0, 8)}`;
  return `[Cross-session message from the user while viewing ${sourceLabel}]\n\n${message.trim()}`;
}
