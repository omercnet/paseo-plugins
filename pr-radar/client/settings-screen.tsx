import {
  type PluginSurfaceProps,
  type SettingsState,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { describeFallbackStatus, parseFallbackRuleInput } from "../shared/routed-labels";
import {
  type AutoLaunchMode,
  type CwdMode,
  DEFAULT_PR_RADAR_SETTINGS,
  type PrRadarSettings,
  PrRadarSettingsSchema,
  prRadarSettings,
} from "../shared/settings";
import { listLocalDirs } from "../shared/viewer-scope";
import {
  type ComboOption,
  ComboSelect,
  dedupeOptions,
  EFFORT_OPTIONS,
  useAgentLaunchOptions,
} from "./agent-launch-options";
import {
  addFallbackRule,
  createSettingsSaveQueue,
  removeFallbackRule,
  type SettingsPatch,
} from "./settings-save";

type ReadySettings = Extract<SettingsState<typeof prRadarSettings.schema>, { status: "ready" }>;

const CWD_MODE_OPTIONS: readonly { label: string; value: CwdMode }[] = [
  { label: "Worktree (CWD-WORKTREE)", value: "CWD-WORKTREE" },
  { label: "Base checkout (CWD-BASE)", value: "CWD-BASE" },
];

const AUTO_LAUNCH_OPTIONS: readonly { label: string; value: AutoLaunchMode }[] = [
  { label: "Always prompt before starting", value: "prompt" },
  { label: "Auto-launch when local checkout exists", value: "existing_only" },
  { label: "Auto-launch (clone & create worktree if needed)", value: "existing_or_clone" },
];

const KNOWN_ROUTING_SCRIPTS: readonly ComboOption[] = [
  {
    label: "None (use static defaults above)",
    value: "",
  },
  {
    label: "User config example: ~/.config/pr-radar/route.py",
    value: "~/.config/pr-radar/route.py",
  },
];

function ReadyPrRadarSettings({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const fetchDirs = useRpc(listLocalDirs);
  const toast = useToast();
  const [dirQueryText, setDirQueryText] = useState(settings.values.sourceCodeDir);
  const [error, setError] = useState<string | null>(null);
  const [ruleText, setRuleText] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleInputKey, setRuleInputKey] = useState(0);

  const { profileOptions, providerOptions, modelOptions, modeOptions, contextModeOptions } =
    useAgentLaunchOptions();

  const dirsQuery = useQuery({
    queryKey: ["pr-radar-settings-dirs", settings.values.sourceCodeDir, dirQueryText],
    queryFn: () =>
      fetchDirs({
        query: dirQueryText,
        repository: "",
      }),
    staleTime: 10_000,
  });

  const sourceDirOptions = useMemo<ComboOption[]>(() => {
    const suggestions = dirsQuery.data?.entries ?? [];
    return dedupeOptions([
      { label: "~/src", value: "~/src", detail: "Default" },
      { label: "~/code", value: "~/code" },
      { label: "~/projects", value: "~/projects" },
      ...suggestions.map((dir) => ({
        label: dir.label,
        value: dir.path,
        detail: dir.kind !== "dir" ? dir.kind : undefined,
      })),
    ]);
  }, [dirsQuery.data]);

  const routingScriptOptions = useMemo<ComboOption[]>(
    () => dedupeOptions([...KNOWN_ROUTING_SCRIPTS]),
    [],
  );

  const latestSettingsRef = useRef({
    values: settings.values,
    revision: settings.revision,
  });
  latestSettingsRef.current = {
    values: settings.values,
    revision: settings.revision,
  };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [saveQueue] = useState(() =>
    createSettingsSaveQueue<PrRadarSettings>({
      latest: () => latestSettingsRef.current,
      remember: (values) => {
        latestSettingsRef.current = { values, revision: latestSettingsRef.current.revision };
      },
      parse: (values) => {
        const parsed = PrRadarSettingsSchema.safeParse(values);
        return parsed.success
          ? { success: true, data: parsed.data }
          : {
              success: false,
              message: parsed.error.issues[0]?.message ?? "Invalid setting value.",
            };
      },
      write: (values, revision) => settingsRef.current.save(values, revision),
      report: setError,
    }),
  );

  // A plain patch replaces fields; a function patch is applied to the newest saved document, so
  // list edits (fallback rules) never build on a list that an in-flight save already changed.
  function savePatch(patch: SettingsPatch<PrRadarSettings>): Promise<boolean> {
    return saveQueue(patch);
  }

  async function handleAddRule() {
    const parsedRule = parseFallbackRuleInput(ruleText, Date.now());
    if ("error" in parsedRule) {
      setRuleError(parsedRule.error);
      return;
    }
    const listed = latestSettingsRef.current.values.routingLabelFallbacks;
    if (addFallbackRule(listed, parsedRule.rule).length === listed.length) {
      setRuleError(
        "A rule for this repository and end time already exists. Remove it first to change its note.",
      );
      return;
    }
    setRuleError(null);
    const saved = await savePatch((latest) => ({
      routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, parsedRule.rule),
    }));
    if (saved) {
      setRuleText("");
      setRuleInputKey((key) => key + 1);
    }
  }

  async function handleReset() {
    setDirQueryText(DEFAULT_PR_RADAR_SETTINGS.sourceCodeDir);
    const saved = await savePatch({ ...DEFAULT_PR_RADAR_SETTINGS });
    if (saved) {
      toast.show("PR Radar settings reset to defaults.", { variant: "success" });
    }
  }

  return (
    <View style={{ gap: 20 }}>
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text>
      ) : null}

      <SettingsSection
        title="Workspace and launch"
        info="Configure where PR Radar looks for or clones repositories and whether Start New Agent prompts or launches immediately."
      >
        <SettingsCard>
          <ComboSelect
            label="Source code directory"
            hint="Default base directory for repositories and auto-clones (default: ~/src)"
            value={settings.values.sourceCodeDir}
            placeholder="~/src"
            options={sourceDirOptions}
            allowEmpty={false}
            theme={theme}
            onQueryChange={setDirQueryText}
            onSelect={(next) => {
              if (next.trim()) void savePatch({ sourceCodeDir: next.trim() });
            }}
          />
          <SettingsSelect
            label="Default workspace mode"
            hint="Start new agents in a dedicated PR worktree or the base checkout"
            value={settings.values.defaultCwdMode}
            options={CWD_MODE_OPTIONS}
            onValueChange={(value) => void savePatch({ defaultCwdMode: value })}
          />
          <SettingsSelect
            label="Auto-launch behavior"
            hint="Choose when Start New Agent opens immediately without showing the chooser"
            value={settings.values.autoLaunchMode}
            options={AUTO_LAUNCH_OPTIONS}
            onValueChange={(value) => void savePatch({ autoLaunchMode: value })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="New agent defaults"
        info="Pre-configure any agent launch settings. Type to filter options continuously or pick from the pull-down list."
      >
        <SettingsCard>
          <ComboSelect
            label="Default profile"
            hint="Paseo agent profile name (default: Model Router)"
            value={settings.values.defaultProfile}
            placeholder="Model Router"
            options={profileOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultProfile: next })}
          />
          <ComboSelect
            label="TUI vendor / provider"
            hint="Optional provider override (e.g. claude, codex, pi)"
            value={settings.values.defaultProvider}
            placeholder="Use profile default"
            options={providerOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultProvider: next })}
          />
          <ComboSelect
            label="Model"
            hint="Optional model ID or version override (e.g. sonnet, gpt-6.1-sol)"
            value={settings.values.defaultModel}
            placeholder="Use provider default"
            options={modelOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultModel: next })}
          />
          <SettingsSelect
            label="Reasoning effort"
            hint="Thinking / reasoning effort level"
            value={settings.values.defaultEffort}
            options={EFFORT_OPTIONS}
            onValueChange={(value) => void savePatch({ defaultEffort: value })}
          />
          <ComboSelect
            label="Permission / mode"
            hint="Optional modeId (e.g. default, bypassPermissions, plan)"
            value={settings.values.defaultModeId}
            placeholder="Use profile default"
            options={modeOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultModeId: next })}
          />
          <ComboSelect
            label="Context mode"
            hint="Optional contextMode option passed to the provider"
            value={settings.values.defaultContextMode}
            placeholder="Use provider default"
            options={contextModeOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultContextMode: next })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Routing script"
        info="Optional executable script that receives PR, repo, and workspace JSON on stdin and returns provider, model, effort, and mode JSON."
      >
        <SettingsCard>
          <ComboSelect
            label="Routing script path"
            hint="Leave empty to use static defaults above (example: ~/.config/pr-radar/route.py)"
            value={settings.values.routingScriptPath}
            placeholder="~/.config/pr-radar/route.py"
            options={routingScriptOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ routingScriptPath: next })}
          />
          <SettingsInput
            label="Allowed label prefixes"
            hint="Routing script labels that start with one of these (comma or space separated) keep their name. Prefer the narrowest prefix, such as ade.kind: a prefix admits every key that starts with it. Every other script label is stored as pr-radar.route.<key>. pr-radar, pr-radar.*, paseo and paseo.* are always reserved."
            initialValue={settings.values.routingLabelPrefixes}
            placeholder="None: all script labels go under pr-radar.route."
            onChangeText={(next) => void savePatch({ routingLabelPrefixes: next })}
          />
          {settings.values.routingLabelFallbacks.map((rule) => (
            <SettingsAction
              key={`${rule.repository}-${rule.until}-${rule.note ?? ""}`}
              label={`Label fallback: ${rule.repository}`}
              hint={`${describeFallbackStatus(rule, Date.now())}${rule.note ? ` - ${rule.note}` : ""}`}
              actionLabel="Remove"
              onPress={() =>
                void savePatch((latest) => ({
                  routingLabelFallbacks: removeFallbackRule(latest.routingLabelFallbacks, rule),
                }))
              }
            />
          ))}
          <SettingsInput
            key={ruleInputKey}
            label="Add temporary label fallback"
            hint="owner/name (or *), an ISO-8601 end time within 7 days, then an optional note, e.g. acme/api 2026-11-25T18:00Z fixing the script. While a rule is active, invalid routing script labels are skipped with a warning instead of blocking the launch."
            error={ruleError}
            initialValue=""
            placeholder="owner/name 2026-11-25T18:00Z note"
            onChangeText={setRuleText}
          />
          <SettingsAction
            label="Add fallback rule"
            actionLabel="Add rule"
            onPress={() => void handleAddRule()}
          />
          <SettingsAction
            label="Reset settings"
            hint="Restore all PR Radar settings to their defaults"
            actionLabel="Reset defaults"
            onPress={() => void handleReset()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

export function PrRadarSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(prRadarSettings);
  if (settings.status === "loading") return <Loading />;
  if (settings.status === "error" || settings.status === "invalid") {
    return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>;
  }
  return <ReadyPrRadarSettings settings={settings} theme={theme} />;
}
