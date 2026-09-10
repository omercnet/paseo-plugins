import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveListHubProcesses, resolveTailHubLog } from "./server/hub";
import { resolveListOmpMemory } from "./server/memory";
import { resolveListOmpConfig } from "./server/omp-config";
import { createOmpProvider } from "./server/provider/registration";
import { resolveListOmpQuotas } from "./server/quota";
import { resolveListOmpSessions } from "./server/sessions";
import { listHubProcesses, tailHubLog } from "./shared/hub";
import { listOmpMemory } from "./shared/memory";
import { listOmpConfig } from "./shared/omp-config";
import { listOmpQuotas } from "./shared/quota";
import { listOmpSessions } from "./shared/sessions";

export default function contribute(server: PluginServerContext) {
  server.handle(listHubProcesses, resolveListHubProcesses);
  server.handle(tailHubLog, resolveTailHubLog);
  server.handle(listOmpQuotas, resolveListOmpQuotas);
  server.handle(listOmpMemory, resolveListOmpMemory);
  server.handle(listOmpSessions, resolveListOmpSessions);
  server.handle(listOmpConfig, resolveListOmpConfig);
  server.registerProvider(createOmpProvider());
  return () => {};
}
