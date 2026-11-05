import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveGeneratedImages } from "./server/generated-images";
import { resolveListHubProcesses, resolveTailHubLog } from "./server/hub";
import {
  OmpBrowserAuthorizationRegistry,
  resolveOpenOmpMcpAuthorizationInPaseoBrowser,
} from "./server/mcp-browser";
import { resolveListOmpMemory } from "./server/memory";
import { OmpAccounts } from "./server/omp-accounts";
import { resolveListOmpAgents } from "./server/omp-agents";
import { resolveListOmpConfig } from "./server/omp-config";
import { resolveListOmpExtensions, resolveSetOmpExtensionEnabled } from "./server/omp-extensions";
import { OmpMcps } from "./server/omp-mcps";
import { resolveListOmpModels } from "./server/omp-models";
import { resolveGetOmpModelsFileStatus, resolveRefreshOmpModels } from "./server/omp-models-file";
import {
  resolveBrowseOmpMarketplace,
  resolveInspectOmpPluginConfig,
  resolveListOmpMarketplaces,
  resolveListOmpPlugins,
  resolveMutateOmpMarketplace,
  resolveMutateOmpPlugin,
  resolveMutateOmpPluginConfig,
} from "./server/omp-plugins";
import { readHostAppendPrompt, readOmpPromptFiles } from "./server/omp-prompt-files";
import { resolveListOmpRules } from "./server/omp-rules";
import { resolveListOmpSettings, resolveUpdateOmpSettings } from "./server/omp-settings";
import {
  resolveDeleteOmpManagedSkill,
  resolveListOmpSkills,
  resolveSetOmpSkillEnabled,
} from "./server/omp-skills";
import { resolveGetOmpUpdateStatus, resolveInstallOmpUpdate } from "./server/omp-update";
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
import { registerOmpRuleNotices } from "./server/rule-notices";
import {
  OmpSubagentControlRegistry,
  resolveCancelOmpSubagent,
  resolveSteerOmpSubagent,
} from "./server/subagents";
import { resolveGetOmpSupportReport } from "./server/support-diagnostics";
import { composerPillSettings } from "./shared/composer-pill-settings";
import { resolveOmpGeneratedImages } from "./shared/generated-image";
import { listHubProcesses, tailHubLog } from "./shared/hub";
import { openOmpMcpAuthorizationInPaseoBrowser } from "./shared/mcp";
import { listOmpMemory } from "./shared/memory";
import {
  cancelOmpAccountLogin,
  listOmpAccounts,
  redeemOmpAccountReset,
  removeOmpAccount,
  setOmpAccountSteering,
  setOmpAccountsSetting,
  startOmpAccountLogin,
  submitOmpAccountLoginCode,
} from "./shared/omp-accounts";
import { listOmpAgents } from "./shared/omp-agents";
import { listOmpConfig } from "./shared/omp-config";
import { listOmpExtensions, setOmpExtensionEnabled } from "./shared/omp-extensions";
import {
  addOmpMcp,
  cancelOmpMcpAuth,
  listOmpMcps,
  runOmpMcpAction,
  startOmpMcpAuth,
  submitOmpMcpAuthCode,
} from "./shared/omp-mcps";
import { listOmpModels } from "./shared/omp-models";
import { getOmpModelsFileStatus, refreshOmpModels } from "./shared/omp-models-file";
import {
  browseOmpMarketplace,
  inspectOmpPluginConfig,
  listOmpMarketplaces,
  listOmpPlugins,
  mutateOmpMarketplace,
  mutateOmpPlugin,
  mutateOmpPluginConfig,
} from "./shared/omp-plugins";
import { getOmpPromptFiles } from "./shared/omp-prompt-files";
import { listOmpRules } from "./shared/omp-rules";
import { listOmpSettings, updateOmpSettings } from "./shared/omp-settings";
import { deleteOmpManagedSkill, listOmpSkills, setOmpSkillEnabled } from "./shared/omp-skills";
import { listOmpStores, type OmpStore } from "./shared/omp-store";
import { getOmpUpdateStatus, installOmpUpdate } from "./shared/omp-update";
import { getOmpProviderHealth } from "./shared/provider-diagnostics";
import { getOmpImage } from "./shared/provider-image";
import { providerLaunchSettings } from "./shared/provider-launch-settings";
import { listOmpQuotas } from "./shared/quota";
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
  const accounts = new OmpAccounts();
  const mcps = new OmpMcps();
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
  server.handle(
    listOmpAccounts,
    scoped(({ store, refresh }) => accounts.list(store, refresh ?? false)),
  );
  server.handle(
    startOmpAccountLogin,
    scoped(({ store, provider }) => accounts.startLogin(store, provider)),
  );
  server.handle(
    submitOmpAccountLoginCode,
    scoped(({ loginId, code }) => accounts.submitCode(loginId, code)),
  );
  server.handle(
    cancelOmpAccountLogin,
    scoped(({ loginId }) => accounts.cancelLogin(loginId)),
  );
  server.handle(
    removeOmpAccount,
    scoped(async ({ store, provider, credentialId }) => {
      await accounts.remove(store, provider, credentialId);
      return { ok: true as const };
    }),
  );
  server.handle(
    redeemOmpAccountReset,
    scoped(({ store, provider, credentialId }) => accounts.redeem(store, provider, credentialId)),
  );
  server.handle(
    setOmpAccountSteering,
    scoped(async ({ store, provider, credentialId, preferred, reservePct }) => {
      await accounts.setSteering(store, provider, credentialId, { preferred, reservePct });
      return { ok: true as const };
    }),
  );
  server.handle(
    setOmpAccountsSetting,
    scoped(async ({ store, path, value }) => {
      await accounts.setSetting(store, path, value);
      return { ok: true as const };
    }),
  );
  server.handle(
    listOmpMcps,
    scoped(({ store, refresh }) => mcps.list(store, refresh ?? false)),
  );
  server.handle(
    addOmpMcp,
    scoped(({ name, target }) => mcps.add(name, target)),
  );
  server.handle(
    runOmpMcpAction,
    scoped(({ store, name, action }) => mcps.run(store, name, action)),
  );
  server.handle(
    startOmpMcpAuth,
    scoped(({ store, name }) => mcps.startAuth(store, name)),
  );
  server.handle(
    submitOmpMcpAuthCode,
    scoped(({ authId, code }) => mcps.submitCode(authId, code)),
  );
  server.handle(
    cancelOmpMcpAuth,
    scoped(({ authId }) => mcps.cancelAuth(authId)),
  );
  server.handle(listOmpMemory, scoped(resolveListOmpMemory));
  server.handle(listOmpConfig, scoped(resolveListOmpConfig));
  server.handle(listOmpModels, scoped(resolveListOmpModels));
  server.handle(listOmpAgents, scoped(resolveListOmpAgents));
  server.handle(listOmpPlugins, scoped(resolveListOmpPlugins));
  server.handle(listOmpMarketplaces, scoped(resolveListOmpMarketplaces));
  server.handle(browseOmpMarketplace, scoped(resolveBrowseOmpMarketplace));
  server.handle(mutateOmpMarketplace, scoped(resolveMutateOmpMarketplace));
  server.handle(listOmpRules, scoped(resolveListOmpRules));
  server.handle(listOmpExtensions, scoped(resolveListOmpExtensions));
  server.handle(setOmpExtensionEnabled, scoped(resolveSetOmpExtensionEnabled));
  server.handle(listOmpSkills, scoped(resolveListOmpSkills));
  server.handle(setOmpSkillEnabled, scoped(resolveSetOmpSkillEnabled));
  server.handle(deleteOmpManagedSkill, scoped(resolveDeleteOmpManagedSkill));
  server.handle(inspectOmpPluginConfig, scoped(resolveInspectOmpPluginConfig));
  server.handle(mutateOmpPlugin, scoped(resolveMutateOmpPlugin));
  server.handle(mutateOmpPluginConfig, scoped(resolveMutateOmpPluginConfig));
  server.handle(listOmpSettings, scoped(resolveListOmpSettings));
  server.handle(updateOmpSettings, scoped(resolveUpdateOmpSettings));
  server.handle(getOmpProviderHealth, scoped(resolveGetOmpProviderHealth));
  // Not `scoped`: the handler also needs the host context to read Paseo's Append system prompt.
  server.handle(getOmpPromptFiles, ({ store, cwd }, { paseo }) =>
    withOmpStore(store, async () => readOmpPromptFiles(cwd, await readHostAppendPrompt(paseo))),
  );
  server.handle(getOmpModelsFileStatus, scoped(resolveGetOmpModelsFileStatus));
  server.handle(refreshOmpModels, scoped(resolveRefreshOmpModels));
  server.handle(getOmpUpdateStatus, resolveGetOmpUpdateStatus);
  server.handle(installOmpUpdate, resolveInstallOmpUpdate);
  server.handle(getOmpImage, (input) => resolveGetOmpImage(input, ompImageCache()));
  server.handle(resolveOmpGeneratedImages, (input) =>
    resolveGeneratedImages(input, ompImageCache()),
  );
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
  const removeRuleNotices = registerOmpRuleNotices(server);
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
    accounts.stop();
    mcps.stop();
    removeSessionLimitListener();
    subagentControlRegistry.clear();
    removeRuleNotices();
    removeSessionOpenHook();
  };
}
