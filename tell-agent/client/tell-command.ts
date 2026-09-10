import type { PluginAgentCommandContext } from "@getpaseo/plugin/client";
import { loadAgents, placement, title } from "./agents";
import { formatTellInstruction, parseTellArguments, resolveMessageTarget } from "./messaging";

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
  await paseo.agents.ref(agent.id).send(formatTellInstruction(target.agent.id, parsed.message));
}
