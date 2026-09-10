import type { PluginAgentCommandContext } from "@getpaseo/plugin/client";
import { loadAgents, placement, title } from "./agents";
import { formatCrossSessionMessage, parseTellArguments, resolveMessageTarget } from "./messaging";

export async function handleTellCommand({
  args,
  agent,
  paseo,
  openPanel,
}: PluginAgentCommandContext & { args: string }) {
  if (!args.trim()) {
    openPanel("tell-agent");
    return;
  }
  const parsed = parseTellArguments(args);
  if (!parsed) {
    throw new Error("Usage: /tell <agent or workspace> :: <message>");
  }
  const { entries } = await loadAgents(paseo);
  const resolution = resolveMessageTarget(entries, agent.id, parsed.target);
  if (resolution.kind === "none") {
    throw new Error(`No active agent matches “${parsed.target}”.`);
  }
  if (resolution.kind === "ambiguous") {
    const examples = resolution.entries
      .slice(0, 3)
      .map((entry) => `${title(entry)} (${placement(entry)})`)
      .join(", ");
    throw new Error(`More than one agent matches “${parsed.target}”: ${examples}. Refine it.`);
  }
  const target = resolution.entry;
  const working = target.agent.status === "running" || target.agent.status === "initializing";
  if (working || target.agent.pendingPermissions.length > 0) {
    throw new Error(
      `${title(target)} is ${working ? "working" : "waiting for permission"}. Use the Tell agent pill to review and confirm the interruption.`,
    );
  }
  const source = entries.find((entry) => entry.agent.id === agent.id);
  await paseo.agents
    .ref(target.agent.id)
    .send(formatCrossSessionMessage(source, agent.id, parsed.message));
}
