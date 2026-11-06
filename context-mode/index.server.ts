import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createContextModeActionHandlers } from "./server/actions";
import { createContextModeAnalyticsHandler } from "./server/analytics";
import { resolveContextModeBinary } from "./server/binary";
import { createContextModeHandlers } from "./server/handlers";
import { injectContextModeOnCreate, readProviderOverrides } from "./server/integration";
import { createContextModeKnowledgeHandlers } from "./server/knowledge";
import {
  contextModeSettings,
  fetchAndIndexContextMode,
  getContextModeAnalyticsDashboard,
  getContextModeDoctorReport,
  getContextModeInstallAction,
  getContextModeIntegrationAudit,
  getContextModeStatus,
  getContextModeUpgradeAction,
  indexContextModePath,
  purgeContextModeKnowledge,
  resumeContextModeSession,
  searchContextModeKnowledge,
} from "./shared";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(contextModeSettings);
  const handlers = createContextModeHandlers(settings);
  const knowledgeHandlers = createContextModeKnowledgeHandlers(settings);
  const actionHandlers = createContextModeActionHandlers(settings);
  server.handle(getContextModeStatus, handlers.status);
  server.handle(getContextModeIntegrationAudit, handlers.audit);
  server.handle(getContextModeAnalyticsDashboard, (_input, context) =>
    createContextModeAnalyticsHandler({
      resolveVersion: async () => {
        const status = await handlers.status({ fresh: false }, context).catch(() => null);
        return status?.state === "ready" ? status.version : null;
      },
    })(),
  );
  server.handle(searchContextModeKnowledge, knowledgeHandlers.search);
  server.handle(indexContextModePath, knowledgeHandlers.indexPath);
  server.handle(fetchAndIndexContextMode, knowledgeHandlers.fetchAndIndex);
  server.handle(resumeContextModeSession, knowledgeHandlers.resume);
  server.handle(purgeContextModeKnowledge, knowledgeHandlers.purge);
  server.handle(getContextModeDoctorReport, actionHandlers.doctor);
  server.handle(getContextModeInstallAction, actionHandlers.install);
  server.handle(getContextModeUpgradeAction, actionHandlers.upgrade);
  server.before("agent.create", async ({ request }, { paseo }) => {
    const current = await settings.read();
    if (current.status !== "ready") return request;
    const binary = await resolveContextModeBinary(current.values, { paseo });
    if (binary.state !== "found") return request;
    const providers = await readProviderOverrides(paseo);
    return injectContextModeOnCreate(request, current.values, binary.launch, { providers });
  });
  return () => {};
}
