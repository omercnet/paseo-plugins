import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  contextModeSettings,
} from "../shared";

type ReadySettings = Extract<SettingsState<typeof contextModeSettings.schema>, { status: "ready" }>;

const binaryModeOptions = [
  { label: "Configured path, PATH, then bundled", value: "path" },
  { label: "PATH, then bundled", value: "automatic" },
];
const refreshOptions = [
  { label: "5 seconds", value: "5000" },
  { label: "15 seconds", value: "15000" },
  { label: "30 seconds", value: "30000" },
  { label: "60 seconds", value: "60000" },
];

function ReadyContextModeSettings({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const [binaryPath, setBinaryPath] = useState(settings.values.binaryPath);
  const styles = useMemo(
    () => ({
      root: { gap: 16 },
      value: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
  const save = useCallback(
    (patch: Partial<ContextModeSettings>) =>
      settings.save({ ...settings.values, ...patch }, settings.revision),
    [settings],
  );
  const normalizedPath = binaryPath.trim();
  const pathResult = ContextModeSettingsSchema.safeParse({
    ...settings.values,
    binaryMode: "path",
    binaryPath: normalizedPath,
  });
  const pathError = pathResult.success
    ? null
    : (pathResult.error.issues[0]?.message ?? "Enter an absolute executable path.");

  return (
    <View style={styles.root}>
      <SettingsSection
        title="Executable"
        info="The daemon checks a configured absolute path first, then PATH, then the bundled runtime."
      >
        <SettingsCard>
          <SettingsSelect
            label="Binary lookup"
            value={settings.values.binaryMode}
            options={binaryModeOptions}
            disabled={settings.saving}
            onValueChange={(binaryMode) =>
              void save({ binaryMode: binaryMode as ContextModeSettings["binaryMode"] })
            }
          />
          <SettingsInput
            label="Absolute binary path"
            hint="Optional external override. Leave empty to use PATH or the bundled runtime."
            error={normalizedPath === settings.values.binaryPath ? null : pathError}
            initialValue={binaryPath}
            onChangeText={setBinaryPath}
            placeholder="/usr/local/bin/context-mode"
            disabled={settings.saving || settings.values.binaryMode === "automatic"}
          />
          <SettingsAction
            label="Save binary path"
            actionLabel="Save"
            disabled={
              settings.saving ||
              settings.values.binaryMode === "automatic" ||
              normalizedPath === settings.values.binaryPath ||
              !pathResult.success
            }
            onPress={() => void save({ binaryPath: normalizedPath })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Agent activation"
        info="Context Mode is added to supported Paseo agents when their sessions are created."
      >
        <SettingsCard>
          <SettingsSwitch
            label="Automatically activate Context Mode"
            hint="Inject the bundled MCP server into new agents and provider-specific storage variables whenever sessions open."
            value={settings.values.autoInject}
            disabled={settings.saving}
            onValueChange={(autoInject) => void save({ autoInject })}
          />
          <SettingsSwitch
            label="Prefer native integrations"
            hint="Keep OMP, Pi, and OpenCode native plugins when detected instead of registering duplicate MCP tools."
            value={settings.values.preferNativeIntegrations}
            disabled={settings.saving || !settings.values.autoInject}
            onValueChange={(preferNativeIntegrations) => void save({ preferNativeIntegrations })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Display">
        <SettingsCard>
          <SettingsSelect
            label="Refresh interval"
            value={String(settings.values.refreshIntervalMs)}
            options={refreshOptions}
            disabled={settings.saving}
            onValueChange={(value) =>
              void save({
                refreshIntervalMs: Number(value) as ContextModeSettings["refreshIntervalMs"],
              })
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Safety">
        <SettingsCard>
          <SettingsRow
            label="Storage reuse"
            hint="Existing provider-specific Context Mode roots are reused. Session databases are never merged across providers."
          >
            <Text style={styles.value}>Provider scoped</Text>
          </SettingsRow>
          <SettingsRow label="Context Mode runtime">
            <Text style={styles.muted}>Bundled with this Paseo plugin</Text>
          </SettingsRow>
          <SettingsRow label="Upgrades">
            <Text style={styles.muted}>Explicit command only</Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Persistence">
        <SettingsCard>
          <SettingsRow label="Settings" hint="Shared by clients connected to this host">
            <Text style={styles.value}>{settings.saving ? "Saving…" : "Saved on host"}</Text>
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
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
    </View>
  );
}

export function ContextModeSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(contextModeSettings);
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );

  if (settings.status === "loading") return <Text style={styles.text}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Context Mode settings">
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.error}
        </Text>
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
