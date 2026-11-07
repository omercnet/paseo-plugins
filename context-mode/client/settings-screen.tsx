import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  contextModeSettings,
} from "../shared/settings";
import { type ChoiceOption, ErrorText } from "./controls";

type ReadySettings = Extract<SettingsState<typeof contextModeSettings.schema>, { status: "ready" }>;
type RefreshInterval = ContextModeSettings["refreshIntervalMs"];
type RefreshValue = `${RefreshInterval}`;
type RuntimeChoice = "bundled" | "own";

const RUNTIME_OPTIONS: readonly ChoiceOption<RuntimeChoice>[] = [
  { label: "Bundled", value: "bundled" },
  { label: "Your own binary", value: "own" },
];

const REFRESH_INTERVALS: Record<RefreshValue, RefreshInterval> = {
  "5000": 5_000,
  "15000": 15_000,
  "30000": 30_000,
  "60000": 60_000,
};

const REFRESH_OPTIONS: readonly ChoiceOption<RefreshValue>[] = [
  { label: "5 seconds", value: "5000" },
  { label: "15 seconds", value: "15000" },
  { label: "30 seconds", value: "30000" },
  { label: "60 seconds", value: "60000" },
];

function refreshValue(interval: RefreshInterval): RefreshValue {
  return `${interval}`;
}

interface ReadyContextModeSettingsProps {
  settings: ReadySettings;
  theme: PluginTheme;
}

function ReadyContextModeSettings({ settings, theme }: ReadyContextModeSettingsProps) {
  const savedPath = settings.values.binaryPath;
  const [runtime, setRuntime] = useState<RuntimeChoice>(savedPath === null ? "bundled" : "own");
  const [binaryPath, setBinaryPath] = useState(savedPath ?? "");
  const textStyle = { color: theme.colors.foreground };
  const mutedStyle = { color: theme.colors.foregroundMuted };

  function save(patch: Partial<ContextModeSettings>) {
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  }

  function chooseRuntime(next: RuntimeChoice) {
    setRuntime(next);
    if (next === "bundled" && savedPath !== null) save({ binaryPath: null });
  }

  const normalizedPath = binaryPath.trim();
  const pathChanged = normalizedPath !== savedPath;
  const pathResult = ContextModeSettingsSchema.safeParse({
    ...settings.values,
    binaryPath: normalizedPath,
  });
  const pathError =
    pathResult.success || normalizedPath === ""
      ? null
      : pathResult.error.issues.map((issue) => issue.message).join(" ");
  const canSavePath = !settings.saving && pathChanged && pathResult.success;

  return (
    <View style={{ gap: 16 }}>
      <SettingsSection
        title="Runtime"
        info="Context Mode runs from the runtime bundled with this plugin unless you point it at your own executable."
      >
        <SettingsCard>
          <SettingsSelect
            label="Runtime"
            value={runtime}
            options={RUNTIME_OPTIONS}
            disabled={settings.saving}
            onValueChange={chooseRuntime}
          />
          {runtime === "own" ? (
            <>
              <SettingsInput
                label="Absolute binary path"
                hint="The Context Mode executable the daemon should run"
                error={pathChanged ? pathError : null}
                initialValue={binaryPath}
                onChangeText={setBinaryPath}
                placeholder="/usr/local/bin/context-mode"
                disabled={settings.saving}
              />
              <SettingsAction
                label="Use this binary"
                actionLabel="Save"
                disabled={!canSavePath}
                onPress={() => save({ binaryPath: normalizedPath })}
              />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Agent activation"
        info="Context Mode is added to supported Paseo agents when their sessions are created."
      >
        <SettingsCard>
          <SettingsSwitch
            label="Automatically activate Context Mode"
            hint="Inject the Context Mode MCP server into new Claude, Codex, Copilot, and OpenCode agents"
            value={settings.values.autoInject}
            disabled={settings.saving}
            onValueChange={(autoInject) => save({ autoInject })}
          />
          <SettingsSwitch
            label="Prefer native integrations"
            hint="Skip injection when Context Mode is already installed natively for a provider, so its tools are not registered twice"
            value={settings.values.preferNativeIntegrations}
            disabled={settings.saving || !settings.values.autoInject}
            onValueChange={(preferNativeIntegrations) => save({ preferNativeIntegrations })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Display">
        <SettingsCard>
          <SettingsSelect
            label="Status refresh interval"
            value={refreshValue(settings.values.refreshIntervalMs)}
            options={REFRESH_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) => save({ refreshIntervalMs: REFRESH_INTERVALS[value] })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Storage">
        <SettingsCard>
          <SettingsRow
            label="Storage"
            hint="Context Mode keeps one store per project, shared by every provider"
          >
            <Text style={textStyle}>Per project</Text>
          </SettingsRow>
          <SettingsRow label="Context Mode runtime">
            <Text selectable style={mutedStyle}>
              {savedPath ?? "Bundled with this plugin"}
            </Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Persistence">
        <SettingsCard>
          <SettingsRow label="Settings" hint="Shared by clients connected to this host">
            <Text style={textStyle}>{settings.saving ? "Saving..." : "Saved on host"}</Text>
          </SettingsRow>
          <SettingsAction
            label="Restore defaults"
            actionLabel="Reset"
            disabled={settings.saving}
            onPress={() => void settings.reset()}
          />
          {settings.saveError ? (
            <SettingsAction
              label="Reload saved values"
              error={settings.saveError}
              actionLabel="Reload"
              disabled={settings.saving}
              onPress={settings.reload}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

export function ContextModeSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(contextModeSettings);

  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Context Mode settings">
        <ErrorText theme={theme} error={settings.error} />
        <SettingsCard>
          <SettingsAction
            label="Read settings again"
            actionLabel="Reload"
            onPress={settings.reload}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="Replace invalid data with defaults"
              actionLabel="Reset"
              disabled={settings.saving}
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  return <ReadyContextModeSettings key={settings.revision} settings={settings} theme={theme} />;
}
