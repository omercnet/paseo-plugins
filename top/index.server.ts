import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createOwnership } from "./server/names";
import { startSampler } from "./server/usage";
import { getUsage } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  const sampler = startSampler();
  const ownSessions = createOwnership();
  server.handle(getUsage, async (_input, { paseo }) => {
    const usage = sampler.usage();
    if (!usage.sessions) return usage;
    return { ...usage, ...(await ownSessions(paseo, usage.sessions, usage.other)) };
  });
  return () => {
    sampler.stop();
    ownSessions.stop();
  };
}
