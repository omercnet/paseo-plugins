import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { type AgentAccessMode, agentAccessSettings, parseEntries } from "../shared/agent-access";

const MODE_OPTIONS: readonly { label: string; value: AgentAccessMode }[] = [
  { label: "Every new agent", value: "all" },
  { label: "Only the agents listed below", value: "listed" },
];

type ListName = "providers" | "workspaces" | "projects" | "labels";
const NO_ERRORS: Record<ListName, string | null> = {
  providers: null,
  workspaces: null,
  projects: null,
  labels: null,
};

/** Settings screen: which new agents get the browser tool. */
export function AgentAccessSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(agentAccessSettings);
  const providers = useRef<SettingsInputHandle>(null);
  const workspaces = useRef<SettingsInputHandle>(null);
  const projects = useRef<SettingsInputHandle>(null);
  const labels = useRef<SettingsInputHandle>(null);
  // Errors belong to the revision they were found on; a newer revision (another client saved) clears them.
  const [found, setFound] = useState<{
    revision: string | null;
    errors: Record<ListName, string | null>;
  }>({ revision: null, errors: NO_ERRORS });
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
  const listErrors = found.revision === settings.revision ? found.errors : NO_ERRORS;
  const save = (next: typeof values) => void settings.save(next, settings.revision);
  // The lists as typed, parsed the same way for Save and for a mode change, so unsaved text is never
  // lost to the revision remount. A list that does not parse shows its error and nothing is saved.
  const typedLists = () => {
    const parsed = {
      providers: parseEntries(providers.current?.getText() ?? ""),
      workspaces: parseEntries(workspaces.current?.getText() ?? ""),
      projects: parseEntries(projects.current?.getText() ?? ""),
      labels: parseEntries(labels.current?.getText() ?? ""),
    };
    const errors = {
      providers: parsed.providers.error,
      workspaces: parsed.workspaces.error,
      projects: parsed.projects.error,
      labels: parsed.labels.error,
    };
    setFound({ revision: settings.revision, errors });
    if (errors.providers || errors.workspaces || errors.projects || errors.labels) return null;
    return {
      providers: parsed.providers.entries,
      workspaces: parsed.workspaces.entries,
      projects: parsed.projects.entries,
      labels: parsed.labels.entries,
    };
  };
  return (
    <SettingsSection title="Shared Browser: agent access">
      {/* Keyed on the revision, so the text inputs start over from the saved lists when another client changes them. */}
      <SettingsCard key={settings.revision}>
        <SettingsSelect
          label="Browser tool for"
          hint="Providers, workspaces and projects apply to agents created from now on; labels apply to every session of a labelled agent. With the lists empty, no agent gets the tool."
          error={settings.saveError}
          value={values.mode}
          options={MODE_OPTIONS}
          disabled={settings.saving}
          onValueChange={(mode) => {
            const lists = typedLists();
            if (lists) save({ ...values, ...lists, mode });
          }}
        />
        <SettingsInput
          ref={providers}
          label="Provider ids"
          hint="Separated by commas or new lines. An agent whose provider is listed gets the tool."
          initialValue={values.providers.join(", ")}
          error={listErrors.providers}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsInput
          ref={workspaces}
          label="Workspace ids"
          hint="Every new agent in a listed workspace gets the tool."
          initialValue={values.workspaces.join(", ")}
          error={listErrors.workspaces}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsInput
          ref={projects}
          label="Project ids"
          hint="Every new agent in a workspace of a listed project gets the tool."
          initialValue={values.projects.join(", ")}
          error={listErrors.projects}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsInput
          ref={labels}
          label="Labels"
          hint="A label key (team) or key=value (team=blue). An agent with a matching label gets the tool in every session, including after a resume. Labels pick agents for convenience; they do not keep an untrusted agent away from the browser, because any agent with Paseo tools can set its own labels."
          initialValue={values.labels.join(", ")}
          error={listErrors.labels}
          onChangeText={() => {}}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Save the lists"
          actionLabel="Save"
          disabled={settings.saving}
          onPress={() => {
            const lists = typedLists();
            if (lists) save({ ...values, ...lists });
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
