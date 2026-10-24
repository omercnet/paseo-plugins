import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import {
  CREDENTIAL_PRESETS,
  type CredentialSummary,
  credentialNotice,
  HOST_LOGINS,
} from "../shared/credentials";
import { useCredentials, useHostLogins } from "./queries";

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

const HOST_LOGINS_INFO =
  "The sandbox and this host then use one login, like two agents on the same machine. A sandbox agent can also read and change that folder, so turn this on only for sandboxes you trust. Known hook, skill, plugin and settings entries in Claude and Codex folders are mounted read-only, as a best-effort list: everything else in the folder stays writable. Linux hosts only.";

function HostLoginsSection({ hostId }: { hostId: string }) {
  const { query, set } = useHostLogins(hostId);
  const enabled = new Set(query.data?.hostLogins.filter((l) => l.enabled).map((l) => l.id));
  return (
    <SettingsSection title="Shared logins" info={HOST_LOGINS_INFO}>
      <SettingsCard>
        {HOST_LOGINS.map((login) => (
          <SettingsSwitch
            key={login.id}
            label={login.label}
            hint={login.hint}
            error={
              set.variables?.id === login.id ? set.error?.message : (query.error?.message ?? null)
            }
            value={enabled.has(login.id)}
            disabled={!query.data || set.isPending}
            onValueChange={(value) => set.mutate({ id: login.id, enabled: value })}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/** One-time setup: each value is written to the daemon host and never read back by any client. */
export function CredentialsSection({ hostId }: { hostId: string }) {
  const { query, clear } = useCredentials(hostId);
  const saved = query.data?.credentials ?? [];
  const presetNames = new Set<string>(CREDENTIAL_PRESETS.map((preset) => preset.name));
  const custom = saved.filter((entry) => !presetNames.has(entry.name));
  return (
    <>
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
      <HostLoginsSection hostId={hostId} />
    </>
  );
}
