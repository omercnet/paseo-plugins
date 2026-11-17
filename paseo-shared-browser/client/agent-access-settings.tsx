import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { Text } from "react-native";
import { type AgentAccessMode, agentAccessSettings, parseEntries } from "../shared/agent-access";

const MODE_OPTIONS: readonly { label: string; value: AgentAccessMode }[] = [
  { label: "Every new agent", value: "all" },
  { label: "Only the agents listed below", value: "listed" },
];

/** Settings screen: which new agents get the browser tool. */
export function AgentAccessSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(agentAccessSettings);
  const providers = useRef<SettingsInputHandle>(null);
  const workspaces = useRef<SettingsInputHandle>(null);
  const projects = useRef<SettingsInputHandle>(null);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 };

  if (settings.status === "loading") {
    return (
      <SettingsSection title="Shared Browser: agent access">
        <Text style={muted}>Loading</Text>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Shared Browser: agent access">
        <Text style={muted}>{settings.error}</Text>
        <SettingsCard>
          <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="Back to the default"
              actionLabel="Reset"
              onPress={settings.reset}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const { values } = settings;
  const save = (next: typeof values) => void settings.save(next, settings.revision);
  return (
    <SettingsSection title="Shared Browser: agent access">
      <SettingsCard>
        <SettingsSelect
          label="Browser tool for"
          hint="Applies to agents created from now on. With the lists empty, no agent gets the tool."
          error={settings.saveError}
          value={values.mode}
          options={MODE_OPTIONS}
          disabled={settings.saving}
          onValueChange={(mode) => save({ ...values, mode })}
        />
        <SettingsInput
          ref={providers}
          label="Provider ids"
          hint="Separated by commas or new lines. An agent whose provider is listed gets the tool."
          initialValue={values.providers.join(", ")}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsInput
          ref={workspaces}
          label="Workspace ids"
          hint="Every new agent in a listed workspace gets the tool."
          initialValue={values.workspaces.join(", ")}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsInput
          ref={projects}
          label="Project ids"
          hint="Every new agent in a workspace of a listed project gets the tool."
          initialValue={values.projects.join(", ")}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Save the lists"
          actionLabel="Save"
          disabled={settings.saving}
          onPress={() =>
            save({
              ...values,
              providers: parseEntries(providers.current?.getText() ?? ""),
              workspaces: parseEntries(workspaces.current?.getText() ?? ""),
              projects: parseEntries(projects.current?.getText() ?? ""),
            })
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
