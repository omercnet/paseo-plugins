import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createContextModeActionHandlers } from "./server/actions";
import { createContextModeAnalyticsHandler } from "./server/analytics";
import { resolveContextModeBinary } from "./server/binary";
import { createContextModeHandlers } from "./server/handlers";
import { injectContextModeEnvironment, injectContextModeOnCreate } from "./server/integration";
import { createContextModeKnowledgeHandlers } from "./server/knowledge";
import {
  contextModeSettings,
  fetchAndIndexContextMode,
  getContextModeAnalyticsDashboard,
  getContextModeDoctor,
  getContextModeDoctorReport,
  getContextModeInstallAction,
  getContextModeIntegrationAudit,
  getContextModeStats,
  getContextModeStatus,
  getContextModeUpgradeAction,
  indexContextModePath,
  purgeContextModeKnowledge,
  searchContextModeKnowledge,
} from "./shared";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(contextModeSettings);
  const handlers = createContextModeHandlers(settings);
  const knowledgeHandlers = createContextModeKnowledgeHandlers(settings);
  const actionHandlers = createContextModeActionHandlers(settings);
  server.handle(getContextModeStatus, handlers.status);
  server.handle(getContextModeDoctor, handlers.doctor);
  server.handle(getContextModeStats, handlers.stats);
  server.handle(getContextModeIntegrationAudit, handlers.audit);
  server.handle(getContextModeAnalyticsDashboard, createContextModeAnalyticsHandler());
  server.handle(searchContextModeKnowledge, knowledgeHandlers.search);
  server.handle(indexContextModePath, knowledgeHandlers.indexPath);
  server.handle(fetchAndIndexContextMode, knowledgeHandlers.fetchAndIndex);
  server.handle(purgeContextModeKnowledge, knowledgeHandlers.purge);
  server.handle(getContextModeDoctorReport, actionHandlers.doctor);
  server.handle(getContextModeInstallAction, actionHandlers.install);
  server.handle(getContextModeUpgradeAction, actionHandlers.upgrade);
  server.before("agent.create", async ({ request }) => {
    const current = await settings.read();
    if (current.status !== "ready") return request;
    const binary = await resolveContextModeBinary(current.values);
    if (binary.state !== "found") return request;
    return injectContextModeOnCreate(request, current.values, binary.launch);
  });
  server.before("agent.session_open", async ({ request }) => {
    const current = await settings.read();
    if (current.status !== "ready") return request;
    return injectContextModeEnvironment(request, current.values);
  });
  return () => {};
}
