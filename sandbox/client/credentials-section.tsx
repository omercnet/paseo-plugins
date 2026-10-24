import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import {
  CREDENTIAL_PRESETS,
  type CredentialSummary,
  credentialNotice,
} from "../shared/credentials";
import { useCredentials } from "./queries";

const INFO =
  "Sandboxes receive these as environment variables when they start. They stay on this host and are never shown again. Save only what you need, once.";

interface CredentialRowProps {
  hostId: string;
  name: string;
  label: string;
  hint: string;
  summary: CredentialSummary | undefined;
}

function CredentialRow({ hostId, name, label, hint, summary }: CredentialRowProps) {
  const { save, clear } = useCredentials(hostId);
  const input = useRef<SettingsInputHandle>(null);
  const [value, setValue] = useState("");
  const notice = credentialNotice(summary);
  const failure = save.error ?? clear.error;

  function saveValue() {
    save.mutate(
      { name, value: value.trim() },
      {
        onSuccess: () => {
          input.current?.replaceText("");
          setValue("");
        },
      },
    );
  }

  return (
    <SettingsCard>
      <SettingsInput
        ref={input}
        label={label}
        hint={`${hint}. ${notice.hint}`}
        error={failure?.message ?? notice.warning}
        secureTextEntry
        placeholder={summary ? "Saved" : name}
        onChangeText={setValue}
      />
      <SettingsAction
        label={`Save ${name}`}
        actionLabel={save.isPending ? "Saving..." : "Save"}
        disabled={!value.trim() || save.isPending}
        onPress={saveValue}
      />
      {summary ? (
        <SettingsAction
          label={`Remove ${name}`}
          actionLabel={clear.isPending ? "Removing..." : "Remove"}
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

  function saveCustom() {
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
    );
  }

  return (
    <SettingsCard>
      <SettingsInput
        ref={nameInput}
        label="Custom variable"
        hint="Another environment variable for the sandbox, such as a provider key"
        placeholder="NAME"
        onChangeText={(text) => setName(text.trim().toUpperCase())}
      />
      <SettingsInput
        ref={valueInput}
        label="Value"
        secureTextEntry
        onChangeText={setValue}
        error={save.error?.message}
      />
      <SettingsAction
        label="Save custom variable"
        actionLabel={save.isPending ? "Saving..." : "Save"}
        disabled={!name || !value.trim() || save.isPending}
        onPress={saveCustom}
      />
    </SettingsCard>
  );
}

/** One-time setup: each value is written to the daemon host and never read back by any client. */
export function CredentialsSection({ hostId }: { hostId: string }) {
  const { query, clear } = useCredentials(hostId);
  const saved = query.data?.credentials ?? [];
  const presetNames = new Set<string>(CREDENTIAL_PRESETS.map((preset) => preset.name));
  const custom = saved.filter((entry) => !presetNames.has(entry.name));
  return (
    <SettingsSection title="Credentials" info={INFO}>
      {query.error ? (
        <SettingsCard>
          <SettingsAction
            label="Credentials unavailable"
            hint={query.error.message}
            actionLabel="Retry"
            onPress={() => query.refetch()}
          />
        </SettingsCard>
      ) : null}
      {CREDENTIAL_PRESETS.map((preset) => (
        <CredentialRow
          key={preset.name}
          hostId={hostId}
          name={preset.name}
          label={preset.label}
          hint={preset.hint.replace(/\.$/, "")}
          summary={saved.find((entry) => entry.name === preset.name)}
        />
      ))}
      {custom.map((entry) => (
        <SettingsCard key={entry.name}>
          <SettingsAction
            label={entry.name}
            hint={`Saved ${new Date(entry.savedAt).toLocaleDateString()}`}
            error={clear.variables?.name === entry.name ? clear.error?.message : null}
            actionLabel={clear.isPending ? "Removing..." : "Remove"}
            disabled={clear.isPending}
            onPress={() => clear.mutate({ name: entry.name })}
          />
        </SettingsCard>
      ))}
      <CustomCredential hostId={hostId} />
    </SettingsSection>
  );
}
