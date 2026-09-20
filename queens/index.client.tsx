import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerPaseoQueensClient } from "./client/contribute";

export default function contribute(client: PluginClientContext) {
  return registerPaseoQueensClient(client);
}
