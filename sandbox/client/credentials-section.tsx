import type { PluginTheme } from "@getpaseo/plugin";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import {
  CREDENTIAL_PRESETS,
  type CredentialSummary,
  credentialNotice,
} from "../shared/credentials";
import { useCredentials } from "./queries";

function CredentialRow({
  hostId,
  name,
  label,
  hint,
  summary,
}: {
  hostId: string;
  name: string;
  label: string;
  hint: string;
  summary: CredentialSummary | undefined;
}) {
  const { save, clear } = useCredentials(hostId);
  const input = useRef<SettingsInputHandle>(null);
  const [value, setValue] = useState("");
  const notice = credentialNotice(summary);
  return (
    <SettingsCard>
      <SettingsInput
        ref={input}
        label={label}
        hint={`${hint} ${notice.hint}`}
        error={notice.warning}
        secureTextEntry
        placeholder={summary ? "Saved" : name}
        onChangeText={setValue}
      />
      <SettingsAction
        label={`Save ${name}`}
        actionLabel="Save"
        disabled={!value.trim() || save.isPending}
        onPress={() =>
          save.mutate(
            { name, value: value.trim() },
            {
              onSuccess: () => {
                input.current?.replaceText("");
                setValue("");
              },
            },
          )
        }
      />
      {summary ? (
        <SettingsAction
          label={`Remove ${name}`}
          actionLabel="Remove"
          disabled={clear.isPending}
          onPress={() => clear.mutate({ name })}
        />
      ) : null}
    </SettingsCard>
  );
}

function CustomCredential({ hostId }: { hostId: string }) {
  const { save } = useCredentials(hostId);
  const nameInput = useRef<SettingsInputHandle>(null);
  const valueInput = useRef<SettingsInputHandle>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <SettingsCard>
      <SettingsInput
        ref={nameInput}
        label="Custom variable"
        hint="Another environment variable for the sandbox, such as a provider key."
        placeholder="NAME"
        onChangeText={(text) => setName(text.trim().toUpperCase())}
      />
      <SettingsInput
        ref={valueInput}
        label="Value"
        secureTextEntry
        onChangeText={setValue}
        error={save.error ? save.error.message : null}
      />
      <SettingsAction
        label="Save custom variable"
        actionLabel="Save"
        disabled={!name || !value.trim() || save.isPending}
        onPress={() =>
          save.mutate(
            { name, value: value.trim() },
            {
              onSuccess: () => {
                nameInput.current?.replaceText("");
                valueInput.current?.replaceText("");
                setName("");
                setValue("");
              },
            },
          )
        }
      />
    </SettingsCard>
  );
}

/** One-time setup: each value is written to the daemon host and never read back by any client. */
export function CredentialsSection({ hostId, theme }: { hostId: string; theme: PluginTheme }) {
  const { query, clear } = useCredentials(hostId);
  const saved = query.data?.credentials ?? [];
  const known = new Set<string>(CREDENTIAL_PRESETS.map((preset) => preset.name));
  return (
    <SettingsSection title="Credentials">
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Sandboxes receive these as environment variables when they start. They stay on this host and
        are never shown again. Save only what you need, once.
      </Text>
      {query.error ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {query.error.message}
        </Text>
      ) : null}
      {CREDENTIAL_PRESETS.map((preset) => (
        <CredentialRow
          key={preset.name}
          hostId={hostId}
          name={preset.name}
          label={preset.label}
          hint={preset.hint}
          summary={saved.find((entry) => entry.name === preset.name)}
        />
      ))}
      {saved
        .filter((entry) => !known.has(entry.name))
        .map((entry) => (
          <SettingsCard key={entry.name}>
            <SettingsAction
              label={entry.name}
              hint={`Saved ${new Date(entry.savedAt).toLocaleDateString()}`}
              actionLabel="Remove"
              disabled={clear.isPending}
              onPress={() => clear.mutate({ name: entry.name })}
            />
          </SettingsCard>
        ))}
      <CustomCredential hostId={hostId} />
    </SettingsSection>
  );
}
