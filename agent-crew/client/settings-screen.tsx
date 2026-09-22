import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text } from "react-native";
import { agentCrewSettings } from "../shared/settings";

export interface AgentCrewSettingsScreenProps extends PluginSurfaceProps {
  onAutoOpenChange(enabled: boolean): void;
}

export function AgentCrewSettingsScreen({ onAutoOpenChange, theme }: AgentCrewSettingsScreenProps) {
  const settings = useSettings(agentCrewSettings);
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
      <SettingsSection title="Agent Crew settings">
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
              onPress={async () => {
                if (await settings.reset()) onAutoOpenChange(false);
              }}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Explorer">
      <SettingsCard>
        <SettingsSwitch
          label="Open Agent Crew automatically"
          hint="Open the Explorer panel once for each workspace this host has not opened before"
          value={settings.values.autoOpenExplorer}
          disabled={settings.saving}
          onValueChange={async (autoOpenExplorer) => {
            const saved = await settings.save(
              { ...settings.values, autoOpenExplorer },
              settings.revision,
            );
            if (saved) onAutoOpenChange(autoOpenExplorer);
          }}
        />
      </SettingsCard>
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
