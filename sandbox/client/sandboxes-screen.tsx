import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import type { Sandbox } from "../shared/sandbox";
import { CredentialsSection } from "./credentials-section";
import { useCredentials, useSandboxActions, useSandboxes } from "./queries";
import { describeSandbox, hasModelCredential, repositoryName } from "./view-model";

function SandboxCard({ hostId, sandbox }: { hostId: string; sandbox: Sandbox }) {
  const actions = useSandboxActions(hostId);
  const [confirming, setConfirming] = useState(false);
  const running = sandbox.runtime === "running";
  const failure = [actions.start, actions.stop, actions.remove].find((action) => action.error);
  return (
    <SettingsSection title={sandbox.name}>
      <SettingsCard>
        <SettingsRow
          label={sandbox.repoUrl ?? "Sandbox"}
          hint={describeSandbox(sandbox)}
          error={failure?.error?.message}
        />
        {sandbox.stale ? (
          <SettingsAction
            label="Restart"
            hint="Applies the saved credentials. The project data is kept."
            actionLabel="Restart"
            disabled={Boolean(sandbox.busy)}
            onPress={() => actions.start.mutate({ id: sandbox.id })}
          />
        ) : null}
        <SettingsAction
          label={running ? "Stop" : "Start"}
          hint={running ? "Keeps the project data." : "Starts the sandbox and registers it."}
          actionLabel={running ? "Stop" : "Start"}
          disabled={Boolean(sandbox.busy)}
          onPress={() => (running ? actions.stop : actions.start).mutate({ id: sandbox.id })}
        />
        <SettingsAction
          label="Remove"
          hint={
            confirming
              ? "This deletes the sandbox and everything stored in it."
              : "Deletes the sandbox and its project data."
          }
          actionLabel={confirming ? "Confirm remove" : "Remove"}
          disabled={Boolean(sandbox.busy)}
          onPress={() => {
            if (confirming) actions.remove.mutate({ id: sandbox.id });
            setConfirming(!confirming);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function CreateSandbox({ hostId }: { hostId: string }) {
  const { create } = useSandboxActions(hostId);
  const nameInput = useRef<SettingsInputHandle>(null);
  const repoInput = useRef<SettingsInputHandle>(null);
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const submit = () =>
    create.mutate(
      { name: name.trim() || repositoryName(repo), repoUrl: repo.trim() },
      {
        onSuccess: () => {
          nameInput.current?.replaceText("");
          repoInput.current?.replaceText("");
          setName("");
          setRepo("");
        },
      },
    );
  return (
    <SettingsSection title="New sandbox">
      <SettingsCard>
        <SettingsInput
          ref={repoInput}
          label="Repository"
          hint="owner/repo on GitHub, or an https URL. It is cloned inside the sandbox."
          placeholder="owner/repo"
          onChangeText={setRepo}
          error={create.error?.message}
        />
        <SettingsInput
          ref={nameInput}
          label="Name"
          hint="Defaults to the repository name."
          onChangeText={setName}
        />
        <SettingsAction
          label="Create sandbox"
          hint="Runs this project's workspaces, agents and terminals in their own sandbox."
          actionLabel="Create"
          disabled={!repo.trim() || create.isPending}
          onPress={submit}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function SandboxesScreen({ theme, layout, host }: PluginScreenProps) {
  const sandboxes = useSandboxes(host.id);
  const credentials = useCredentials(host.id);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const runtime = sandboxes.data?.runtime;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {runtime && !runtime.available ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {runtime.problem}
        </Text>
      ) : null}
      {sandboxes.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {sandboxes.error.message}
        </Text>
      ) : null}
      {credentials.query.data && !hasModelCredential(credentials.query.data.credentials) ? (
        <Text accessibilityRole="alert" style={styles.warning}>
          No model credentials are saved. Agents in a sandbox can only use free models until you add
          one under Credentials below.
        </Text>
      ) : null}
      {sandboxes.data?.sandboxes.map((sandbox) => (
        <SandboxCard key={sandbox.id} hostId={host.id} sandbox={sandbox} />
      ))}
      <CreateSandbox hostId={host.id} />
      <CredentialsSection hostId={host.id} theme={theme} />
    </ScrollView>
  );
}

function createStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: {
      padding: compact ? 16 : 24,
      gap: compact ? 16 : 20,
      backgroundColor: theme.colors.surface0,
    },
    error: { color: theme.colors.statusDanger },
    warning: { color: theme.colors.statusWarning },
  };
}
