import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  type AutoLaunchMode,
  type CwdMode,
  DEFAULT_PR_RADAR_SETTINGS,
  PrRadarSettingsSchema,
  prRadarSettings,
} from "../shared/settings";

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

const EFFORT_OPTIONS: readonly { label: string; value: string }[] = [
  { label: "Profile / provider default", value: "" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high (xhigh)", value: "xhigh" },
];

function ReadyPrRadarSettings({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const toast = useToast();
  const [sourceCodeDir, setSourceCodeDir] = useState(settings.values.sourceCodeDir);
  const [defaultProfile, setDefaultProfile] = useState(settings.values.defaultProfile);
  const [defaultProvider, setDefaultProvider] = useState(settings.values.defaultProvider);
  const [defaultModel, setDefaultModel] = useState(settings.values.defaultModel);
  const [defaultModeId, setDefaultModeId] = useState(settings.values.defaultModeId);
  const [defaultContextMode, setDefaultContextMode] = useState(settings.values.defaultContextMode);
  const [routingScriptPath, setRoutingScriptPath] = useState(settings.values.routingScriptPath);
  const [error, setError] = useState<string | null>(null);

  async function savePatch(patch: Partial<typeof settings.values>) {
    setError(null);
    const parsed = PrRadarSettingsSchema.safeParse({ ...settings.values, ...patch });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid setting value.");
      return;
    }
    try {
      await settings.save(parsed.data, settings.revision);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not save settings.");
    }
  }

  async function handleReset() {
    setSourceCodeDir(DEFAULT_PR_RADAR_SETTINGS.sourceCodeDir);
    setDefaultProfile(DEFAULT_PR_RADAR_SETTINGS.defaultProfile);
    setDefaultProvider(DEFAULT_PR_RADAR_SETTINGS.defaultProvider);
    setDefaultModel(DEFAULT_PR_RADAR_SETTINGS.defaultModel);
    setDefaultModeId(DEFAULT_PR_RADAR_SETTINGS.defaultModeId);
    setDefaultContextMode(DEFAULT_PR_RADAR_SETTINGS.defaultContextMode);
    setRoutingScriptPath(DEFAULT_PR_RADAR_SETTINGS.routingScriptPath);
    await savePatch({ ...DEFAULT_PR_RADAR_SETTINGS });
    toast.show("PR Radar settings reset to defaults.", { variant: "success" });
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
          <SettingsInput
            label="Source code directory"
            hint="Default base directory for repositories and auto-clones (default: ~/src)"
            initialValue={sourceCodeDir}
            placeholder="~/src"
            onChangeText={(text) => {
              setSourceCodeDir(text);
              if (text.trim()) void savePatch({ sourceCodeDir: text.trim() });
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
        info="Pre-configure any agent launch settings. Leave fields blank to inherit from your selected Paseo profile."
      >
        <SettingsCard>
          <SettingsInput
            label="Default profile"
            hint="Paseo agent profile name (default: Model Router)"
            initialValue={defaultProfile}
            placeholder="Model Router"
            onChangeText={(text) => {
              setDefaultProfile(text);
              void savePatch({ defaultProfile: text });
            }}
          />
          <SettingsInput
            label="TUI vendor / provider"
            hint="Optional provider override (e.g. claude, codex, omp, pi)"
            initialValue={defaultProvider}
            placeholder="Use profile default"
            onChangeText={(text) => {
              setDefaultProvider(text);
              void savePatch({ defaultProvider: text });
            }}
          />
          <SettingsInput
            label="Model"
            hint="Optional model ID or version override (e.g. sonnet, gpt-6.1-sol)"
            initialValue={defaultModel}
            placeholder="Use provider default"
            onChangeText={(text) => {
              setDefaultModel(text);
              void savePatch({ defaultModel: text });
            }}
          />
          <SettingsSelect
            label="Reasoning effort"
            hint="Thinking / reasoning effort level"
            value={settings.values.defaultEffort}
            options={EFFORT_OPTIONS}
            onValueChange={(value) => void savePatch({ defaultEffort: value })}
          />
          <SettingsInput
            label="Permission / mode"
            hint="Optional modeId (e.g. default, bypassPermissions, plan)"
            initialValue={defaultModeId}
            placeholder="Use profile default"
            onChangeText={(text) => {
              setDefaultModeId(text);
              void savePatch({ defaultModeId: text });
            }}
          />
          <SettingsInput
            label="Context mode"
            hint="Optional contextMode option passed to the provider"
            initialValue={defaultContextMode}
            placeholder="Use provider default"
            onChangeText={(text) => {
              setDefaultContextMode(text);
              void savePatch({ defaultContextMode: text });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Routing script"
        info="Optional executable script that receives PR, repo, and workspace JSON on stdin and returns provider, model, effort, and mode JSON."
      >
        <SettingsCard>
          <SettingsInput
            label="Routing script path"
            hint="Leave empty to use static defaults above (example: examples/pr-radar-route.py)"
            initialValue={routingScriptPath}
            placeholder="~/src/paseo-plugins-omercnet/pr-radar/examples/pr-radar-route.py"
            onChangeText={(text) => {
              setRoutingScriptPath(text);
              void savePatch({ routingScriptPath: text });
            }}
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
