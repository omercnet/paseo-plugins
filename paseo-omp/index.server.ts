import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveListHubProcesses, resolveTailHubLog } from "./server/hub";
import {
  OmpBrowserAuthorizationRegistry,
  resolveOpenOmpMcpAuthorizationInPaseoBrowser,
} from "./server/mcp-browser";
import { resolveListOmpMemory } from "./server/memory";
import { resolveListOmpConfig } from "./server/omp-config";
import { resolveListOmpModels } from "./server/omp-models";
import {
  resolveInspectOmpPluginConfig,
  resolveListOmpPlugins,
  resolveMutateOmpPlugin,
  resolveMutateOmpPluginConfig,
} from "./server/omp-plugins";
import { resolveListOmpSettings, resolveUpdateOmpSettings } from "./server/omp-settings";
import { OmpOperationalFailureCollector } from "./server/operational-failure-diagnostics";
import { withOmpStore } from "./server/paths";
import { OmpProtocolViolationCollector } from "./server/protocol-violation-diagnostics";
import { withOmpSessionOpenEnv } from "./server/provider/host-tools";
import { ompImageCache, resolveGetOmpImage } from "./server/provider/image-cache";
import {
  createProfileOmpProvider,
  discoverOmpProfiles,
  discoverOmpProfilesSync,
} from "./server/provider/profile-providers";
import { createOmpProvider } from "./server/provider/registration";
import { OmpPublicError } from "./server/provider/security";
import { OmpSessionLimit } from "./server/provider/session-limit";
import { resolveGetOmpProviderHealth } from "./server/provider-diagnostics";
import { resolveListOmpQuotas } from "./server/quota";
import { resolveListOmpSessions } from "./server/sessions";
import {
  OmpSubagentControlRegistry,
  resolveCancelOmpSubagent,
  resolveSteerOmpSubagent,
} from "./server/subagents";
import { resolveGetOmpSupportReport } from "./server/support-diagnostics";
import { composerPillSettings } from "./shared/composer-pill-settings";
import { listHubProcesses, tailHubLog } from "./shared/hub";
import { openOmpMcpAuthorizationInPaseoBrowser } from "./shared/mcp";
import { listOmpMemory } from "./shared/memory";
import { listOmpConfig } from "./shared/omp-config";
import { listOmpModels } from "./shared/omp-models";
import {
  inspectOmpPluginConfig,
  listOmpPlugins,
  mutateOmpPlugin,
  mutateOmpPluginConfig,
} from "./shared/omp-plugins";
import { listOmpSettings, updateOmpSettings } from "./shared/omp-settings";
import { listOmpStores, type OmpStore } from "./shared/omp-store";
import { getOmpProviderHealth } from "./shared/provider-diagnostics";
import { getOmpImage } from "./shared/provider-image";
import { providerLaunchSettings } from "./shared/provider-launch-settings";
import { listOmpQuotas } from "./shared/quota";
import { listOmpSessions } from "./shared/sessions";
import { cancelOmpSubagent, steerOmpSubagent } from "./shared/subagents";
import { getOmpSupportReport } from "./shared/support-diagnostics";

function scoped<T extends { store?: OmpStore }, R>(handler: (input: T) => R) {
  return (input: T): R => withOmpStore(input.store, () => handler(input));
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(composerPillSettings);
  const launchSettings = server.registerSettings(providerLaunchSettings);
  const resolveHostInheritEnv = async (): Promise<readonly string[]> => {
    const current = await launchSettings.read();
    if (current.status === "ready") return current.values.inheritEnv;
    throw new OmpPublicError("OMP host launch settings are unavailable");
  };
  const browserAuthorizationRegistry = new OmpBrowserAuthorizationRegistry();
  const sessionLimit = new OmpSessionLimit(async () => {
    const current = await launchSettings.read();
    return current.status === "ready" ? current.values.maxSessions : undefined;
  });
  const removeSessionLimitListener = launchSettings.subscribe(() => sessionLimit.refresh());
  const subagentControlRegistry = new OmpSubagentControlRegistry();
  const protocolViolations = new OmpProtocolViolationCollector();
  const operationalFailures = new OmpOperationalFailureCollector();
  const profiles = discoverOmpProfilesSync();
  server.handle(listOmpStores, async () => ({ profiles: await discoverOmpProfiles() }));
  for (const profile of profiles) {
    server.registerProvider(
      createProfileOmpProvider(profile, {
        browserAuthorizationRegistry,
        sessionLimit,
        subagentControlRegistry,
        reportProtocolViolation: protocolViolations.report,
        reportOperationalFailure: operationalFailures.report,
        resolveHostInheritEnv,
      }),
    );
  }
  server.handle(listHubProcesses, resolveListHubProcesses);
  server.handle(tailHubLog, resolveTailHubLog);
  server.handle(listOmpQuotas, scoped(resolveListOmpQuotas));
  server.handle(listOmpMemory, scoped(resolveListOmpMemory));
  server.handle(listOmpSessions, scoped(resolveListOmpSessions));
  server.handle(listOmpConfig, scoped(resolveListOmpConfig));
  server.handle(listOmpModels, scoped(resolveListOmpModels));
  server.handle(listOmpPlugins, scoped(resolveListOmpPlugins));
  server.handle(inspectOmpPluginConfig, scoped(resolveInspectOmpPluginConfig));
  server.handle(mutateOmpPlugin, scoped(resolveMutateOmpPlugin));
  server.handle(mutateOmpPluginConfig, scoped(resolveMutateOmpPluginConfig));
  server.handle(listOmpSettings, scoped(resolveListOmpSettings));
  server.handle(updateOmpSettings, scoped(resolveUpdateOmpSettings));
  server.handle(getOmpProviderHealth, scoped(resolveGetOmpProviderHealth));
  server.handle(getOmpImage, (input) => resolveGetOmpImage(input, ompImageCache()));
  server.handle(
    getOmpSupportReport,
    scoped((input) => resolveGetOmpSupportReport(input, protocolViolations, operationalFailures)),
  );
  server.handle(openOmpMcpAuthorizationInPaseoBrowser, (input) =>
    resolveOpenOmpMcpAuthorizationInPaseoBrowser(input, browserAuthorizationRegistry),
  );
  server.handle(cancelOmpSubagent, (input) =>
    resolveCancelOmpSubagent(input, subagentControlRegistry),
  );
  server.handle(steerOmpSubagent, (input) =>
    resolveSteerOmpSubagent(input, subagentControlRegistry),
  );
  const removeSessionOpenHook = server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "omp-plugin" && !request.provider.startsWith("omp-plugin-")) return;
    return withOmpSessionOpenEnv(request);
  });
  server.registerProvider(
    createOmpProvider({
      browserAuthorizationRegistry,
      sessionLimit,
      subagentControlRegistry,
      reportProtocolViolation: protocolViolations.report,
      reportOperationalFailure: operationalFailures.report,
      resolveHostInheritEnv,
    }),
  );
  return () => {
    browserAuthorizationRegistry.clear();
    removeSessionLimitListener();
    subagentControlRegistry.clear();
    removeSessionOpenHook();
  };
}
