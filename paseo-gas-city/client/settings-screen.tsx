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
import { type GasCitySettings, gasCitySettings } from "../shared";

type ReadySettings = Extract<SettingsState<typeof gasCitySettings.schema>, { status: "ready" }>;

const refreshOptions = [
  { label: "2 seconds", value: "2000" },
  { label: "5 seconds", value: "5000" },
  { label: "10 seconds", value: "10000" },
  { label: "30 seconds", value: "30000" },
  { label: "60 seconds", value: "60000" },
] as const;
const eventLimitOptions = [25, 50, 100, 250, 500].map((value) => ({
  label: `${value} events`,
  value: String(value),
}));

function ReadySettingsScreen({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const [endpointUrl, setEndpointUrl] = useState(settings.values.endpointUrl);
  const [workspaceId, setWorkspaceId] = useState("");
  const [cityName, setCityName] = useState("");
  const [rigName, setRigName] = useState("");
  const [mappingError, setMappingError] = useState<string | null>(null);
  const styles = useMemo(
    () => ({
      root: { gap: 16 },
      danger: { color: theme.colors.statusDanger },
      muted: { color: theme.colors.foregroundMuted },
      value: { color: theme.colors.foreground },
      warning: { color: theme.colors.statusWarning },
    }),
    [theme],
  );
  const save = useCallback(
    (patch: Partial<GasCitySettings>) =>
      settings.save({ ...settings.values, ...patch }, settings.revision),
    [settings],
  );

  async function addMapping() {
    const normalized = {
      workspaceId: workspaceId.trim(),
      cityName: cityName.trim(),
      rigName: rigName.trim(),
    };
    if (!normalized.workspaceId || !normalized.cityName || !normalized.rigName) {
      setMappingError("Workspace ID, city, and rig are required.");
      return;
    }
    if (
      settings.values.workspaceMappings.some(
        (mapping) => mapping.workspaceId === normalized.workspaceId,
      )
    ) {
      setMappingError(`A mapping already exists for ${normalized.workspaceId}.`);
      return;
    }
    const saved = await save({
      workspaceMappings: [...settings.values.workspaceMappings, normalized],
    });
    if (saved) {
      setWorkspaceId("");
      setCityName("");
      setRigName("");
      setMappingError(null);
    }
  }

  return (
    <View style={styles.root}>
      <SettingsSection
        title="Connection"
        info="The endpoint is stored on the Paseo host and shared by connected clients."
      >
        <SettingsCard>
          <SettingsInput
            label="Supervisor endpoint"
            hint="HTTP or HTTPS URL for the Gas City supervisor"
            initialValue={endpointUrl}
            onChangeText={setEndpointUrl}
            placeholder="http://127.0.0.1:7375"
            disabled={settings.saving}
          />
          <SettingsAction
            label="Save endpoint"
            actionLabel="Save"
            disabled={settings.saving || endpointUrl.trim() === settings.values.endpointUrl}
            onPress={() => void save({ endpointUrl: endpointUrl.trim() })}
          />
          <SettingsSwitch
            label="Allow remote endpoint"
            hint="Permit connections beyond localhost. Enable only for a trusted network."
            value={settings.values.allowRemoteEndpoint}
            disabled={settings.saving}
            onValueChange={(allowRemoteEndpoint) => void save({ allowRemoteEndpoint })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Operator controls">
        <SettingsCard>
          <SettingsSwitch
            label="Enable mutations"
            hint="Allows confirmed dispatch and session actions. Off keeps Gas City observe-only."
            value={settings.values.mutationsEnabled}
            disabled={settings.saving}
            onValueChange={(mutationsEnabled) => void save({ mutationsEnabled })}
          />
          <SettingsSelect
            label="Refresh interval"
            value={String(settings.values.refreshIntervalMs)}
            options={refreshOptions}
            disabled={settings.saving}
            onValueChange={(value) => void save({ refreshIntervalMs: Number(value) })}
          />
          <SettingsSelect
            label="Recent event limit"
            value={String(settings.values.eventLimit)}
            options={eventLimitOptions}
            disabled={settings.saving}
            onValueChange={(value) => void save({ eventLimit: Number(value) })}
          />
        </SettingsCard>
        {!settings.values.mutationsEnabled ? (
          <Text style={styles.muted}>Observe-only mode is active.</Text>
        ) : (
          <Text accessibilityRole="alert" style={styles.warning}>
            Mutations are enabled. Every operation still requires confirmation.
          </Text>
        )}
      </SettingsSection>

      <SettingsSection
        title="Workspace mappings"
        info="Explicit mappings take precedence over longest-ancestor discovery."
      >
        <SettingsCard>
          {settings.values.workspaceMappings.map((mapping) => (
            <SettingsAction
              key={mapping.workspaceId}
              label={mapping.workspaceId}
              hint={`${mapping.cityName} / ${mapping.rigName}`}
              actionLabel="Remove"
              disabled={settings.saving}
              onPress={() =>
                void save({
                  workspaceMappings: settings.values.workspaceMappings.filter(
                    (candidate) => candidate.workspaceId !== mapping.workspaceId,
                  ),
                })
              }
            />
          ))}
          {settings.values.workspaceMappings.length === 0 ? (
            <SettingsRow label="No overrides" hint="Automatic longest-ancestor mapping is used." />
          ) : null}
          <SettingsInput
            label="Workspace ID"
            initialValue={workspaceId}
            onChangeText={setWorkspaceId}
            placeholder="workspace-id"
            disabled={settings.saving}
          />
          <SettingsInput
            label="City"
            initialValue={cityName}
            onChangeText={setCityName}
            placeholder="city-name"
            disabled={settings.saving}
          />
          <SettingsInput
            label="Rig"
            initialValue={rigName}
            onChangeText={setRigName}
            placeholder="rig-name"
            disabled={settings.saving}
          />
          <SettingsAction
            label="Add explicit mapping"
            error={mappingError}
            actionLabel="Add"
            disabled={settings.saving}
            onPress={() => void addMapping()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Persistence">
        <SettingsCard>
          <SettingsRow label="Status" hint="Saved on the Paseo host">
            <Text style={styles.value}>{settings.saving ? "Saving…" : "Saved"}</Text>
          </SettingsRow>
          <SettingsAction
            label="Restore safe defaults"
            hint="Returns Gas City to localhost observe-only mode"
            actionLabel="Reset"
            disabled={settings.saving}
            onPress={() => void settings.reset()}
          />
          {settings.saveError ? (
            <SettingsAction
              label="Reload persisted values"
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

export function GasCitySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(gasCitySettings);
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );

  if (settings.status === "loading")
    return <Text style={styles.text}>Loading Gas City settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Gas City settings">
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
              label="Replace invalid data with safe defaults"
              actionLabel="Reset"
              disabled={settings.saving}
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  return <ReadySettingsScreen key={settings.revision} settings={settings} theme={theme} />;
}
