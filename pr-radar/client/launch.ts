import {
  decideRoutedLabels,
  type LabelPolicy,
  RoutedLabelsBlockedError,
} from "../shared/routed-labels";
import type { PrRadarSettings } from "../shared/settings";
import type { RoutingScriptResult } from "../shared/viewer-scope";
import {
  type AgentLaunchOverrides,
  type AgentProfileLike,
  buildAgentConfig,
  buildAgentLabels,
  buildAgentPrompt,
  type CwdTag,
  type LabelableWorkspace,
  labelWorkspaceCwd,
  type RadarRow,
  restrictRoutedLaunch,
  routedProviderModel,
  vetRoutedProfile,
} from "./radar";
import type { StartAgentLaunchRequest } from "./start-agent-modal";

type LaunchProfile = AgentProfileLike & { name: string };

export interface LaunchWorkspace extends LabelableWorkspace {
  agents: {
    create(options: {
      config: ReturnType<typeof buildAgentConfig>;
      title: string;
      prompt: string;
      labels: Record<string, string>;
    }): Promise<{ id: string }>;
  };
}

export interface LaunchPaseo {
  workspaces: { open(cwd: string): Promise<LaunchWorkspace> };
  config: { get(): Promise<{ config: { agentProfiles?: readonly LaunchProfile[] } }> };
}

export interface PrepareCwdInput {
  repository: string;
  prNumber: number;
  itemKind: "pr" | "issue";
  headRefName: string;
  baseRefName: string;
  targetDir: string | null;
  allowClone: boolean;
  cwdMode: StartAgentLaunchRequest["cwdMode"];
  worktreeName: string | null;
}

export interface PreparedCwd {
  cwd: string;
  cwdTag: Exclude<CwdTag, "CWD-TBD">;
  warning?: string;
}

export interface LaunchDeps {
  paseo: LaunchPaseo;
  prepareCwd(input: PrepareCwdInput): Promise<PreparedCwd>;
  policy: LabelPolicy;
  now(): number;
}

export interface LaunchedAgent {
  agentId: string;
  message: string;
}

/**
 * Starts the agent for a Start New Agent request, from the modal or from auto-launch. The routing
 * script's labels are validated here, before any worktree is prepared, so a path that skips its own
 * check still cannot launch with a label set PR Radar rejected.
 */
export async function launchNewAgent(
  deps: LaunchDeps,
  request: StartAgentLaunchRequest,
): Promise<LaunchedAgent> {
  const { row } = request;
  if (!row.number) {
    throw new Error("An issue or pull request number is required to start a new agent.");
  }
  const decision = decideRoutedLabels({
    labels: request.overrides.labels,
    repository: row.repository,
    policy: deps.policy,
    now: deps.now(),
  });
  if (decision.status === "blocked") {
    throw new RoutedLabelsBlockedError(decision.message, decision.rejected);
  }

  const prepared = await deps.prepareCwd({
    repository: row.repository,
    prNumber: row.number,
    itemKind: row.itemKind ?? "pr",
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    targetDir: request.targetDir,
    allowClone: request.allowClone ?? false,
    cwdMode: request.cwdMode,
    worktreeName: request.worktreeName,
  });

  const targetWorkspace = await deps.paseo.workspaces.open(prepared.cwd);
  await labelWorkspaceCwd(targetWorkspace, prepared.cwdTag);

  const { config } = await deps.paseo.config.get();
  const profiles = config.agentProfiles ?? [];
  const wantedProfile = request.profileName.trim().toLowerCase();
  const profile =
    (wantedProfile
      ? profiles.find((candidate) => candidate.name.toLowerCase() === wantedProfile)
      : undefined) ??
    profiles.find((candidate) => candidate.name.toLowerCase() === "model router") ??
    profiles[0];

  const accepted = decision.status === "ok" ? decision.labels : {};
  const created = await targetWorkspace.agents.create({
    config: buildAgentConfig(profile, request.overrides),
    title: `PR Radar: ${row.repository}#${row.number}`,
    prompt: buildAgentPrompt(row),
    labels: buildAgentLabels(prepared.cwdTag, accepted),
  });

  const baseMsg = `Started new agent in ${prepared.cwdTag} (${prepared.cwd}) for ${row.repository}#${row.number}.`;
  const fallbackWarning = decision.status === "fallback" ? decision.warning : undefined;
  const warnings = [request.routingWarning, fallbackWarning, prepared.warning].filter(Boolean);
  return {
    agentId: created.id,
    message: warnings.length > 0 ? `${warnings.join(" ")} ${baseMsg}` : baseMsg,
  };
}

export function defaultLaunchOverrides(settings: PrRadarSettings): AgentLaunchOverrides {
  return {
    provider: settings.defaultProvider,
    model: settings.defaultModel,
    thinkingOptionId: settings.defaultEffort,
    modeId: settings.defaultModeId,
    contextMode: settings.defaultContextMode,
  };
}

export interface AutoRoutingInput {
  settings: PrRadarSettings;
  routed: RoutingScriptResult;
  // Agent profiles from Paseo; only read when the script names a profile.
  profiles: readonly LaunchProfile[];
  row: Pick<RadarRow, "repository">;
  now: number;
}

export type AutoRouting =
  | { status: "blocked"; message: string }
  | {
      status: "launch";
      profileName: string;
      overrides: AgentLaunchOverrides;
      routingWarning?: string;
    };

/**
 * Applies a routing script's result to the auto-launch defaults. Auto-launch shows no preview, so a
 * label set PR Radar rejects stops the launch here instead of reaching the agent.
 */
export function applyAutoRouting(input: AutoRoutingInput): AutoRouting {
  const { settings, routed, profiles, row, now } = input;
  const decision = decideRoutedLabels({
    labels: routed.labels,
    repository: row.repository,
    policy: settings,
    now,
  });
  if (decision.status === "blocked") return { status: "blocked", message: decision.message };

  let overrides = defaultLaunchOverrides(settings);
  let profileName = settings.defaultProfile;

  const vetted = routed.profile
    ? vetRoutedProfile(profiles, routed.profile)
    : { profileName: undefined, ignored: [] as string[] };
  if (vetted.profileName) profileName = vetted.profileName;
  overrides = { ...overrides, ...routedProviderModel(overrides, routed) };
  if (routed.thinkingOptionId) {
    overrides = { ...overrides, thinkingOptionId: routed.thinkingOptionId };
  }
  const restricted = restrictRoutedLaunch(routed);
  restricted.ignored.push(...vetted.ignored);
  if (restricted.modeId) overrides = { ...overrides, modeId: restricted.modeId };
  if (routed.contextMode) overrides = { ...overrides, contextMode: routed.contextMode };
  if (restricted.options) overrides = { ...overrides, options: restricted.options };
  if (routed.labels !== undefined) overrides = { ...overrides, labels: routed.labels };
  const routingWarning =
    restricted.ignored.length > 0
      ? `Routing script values ignored (${restricted.ignored.join(", ")}).`
      : undefined;
  return { status: "launch", profileName, overrides, routingWarning };
}
