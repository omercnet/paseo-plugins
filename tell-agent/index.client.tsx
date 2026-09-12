import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeAgentMessaging } from "./client/message-agent";

export default function contribute(client: PluginClientContext) {
  return contributeAgentMessaging(client);
}
