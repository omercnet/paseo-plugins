import type { HostSummary } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, type TextStyle, View, type ViewStyle } from "react-native";
import {
  buildAddInput,
  buildUpdatePatch,
  errorMessage,
  formatMetadata,
  useHostDirectory,
} from "./hosts";

type FormTarget = { kind: "add" } | { kind: "edit"; host: HostSummary };

const STATUS_LABEL: Record<HostSummary["status"], string> = {
  online: "Online",
  connecting: "Connecting",
  offline: "Offline, retrying",
  error: "Error",
  disabled: "Disabled",
};

function statusColor(theme: PluginTheme, status: HostSummary["status"]) {
  const colors = theme.colors;
  if (status === "online") return colors.statusSuccess;
  if (status === "error") return colors.statusDanger;
  if (status === "disabled") return colors.foregroundMuted;
  return colors.statusWarning;
}

type StyleKey =
  | "screen"
  | "content"
  | "title"
  | "muted"
  | "card"
  | "row"
  | "name"
  | "body"
  | "mono"
  | "error"
  | "button"
  | "primary"
  | "danger"
  | "buttonText"
  | "primaryText"
  | "dangerText"
  | "disabled"
  | "input"
  | "chip"
  | "field"
  | "label";
type Styles = Record<StyleKey, ViewStyle & TextStyle>;

function makeStyles(theme: PluginTheme, compact: boolean): Styles {
  const c = theme.colors;
  const button = {
    minHeight: compact ? 44 : 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface2,
  };
  return {
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 16 : 24, gap: 12, maxWidth: 880, width: "100%" as const },
    title: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" as const },
    muted: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 },
    card: {
      gap: 8,
      padding: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    name: { color: c.foreground, fontSize: 16, fontWeight: "600" as const, flexShrink: 1 },
    body: { color: c.foreground, fontSize: 13 },
    mono: { color: c.foregroundMuted, fontSize: 12 },
    error: { color: c.statusDanger, fontSize: 13 },
    button,
    primary: { ...button, backgroundColor: c.accent, borderColor: c.accent },
    danger: { ...button, borderColor: c.statusDanger },
    buttonText: { color: c.foreground, fontSize: 14 },
    primaryText: { color: c.accentForeground, fontSize: 14, fontWeight: "600" as const },
    dangerText: { color: c.statusDanger, fontSize: 14 },
    disabled: { opacity: 0.5 },
    input: {
      minHeight: 40,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface0,
      color: c.foreground,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 14,
    },
    chip: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
    },
    field: { gap: 4 },
    label: { color: c.foreground, fontSize: 13, fontWeight: "600" as const },
  };
}

function Action({
  label,
  onPress,
  style,
  textStyle,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPress(): void;
  style: object;
  textStyle: object;
  disabled?: boolean;
  /** Defaults to `label`; set it when several buttons share a label. */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[style, disabled && { opacity: 0.5 }]}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

function Field({
  styles,
  theme,
  label,
  hint,
  ...input
}: {
  styles: Styles;
  theme: PluginTheme;
  label: string;
  hint?: string;
  value: string;
  onChangeText(text: string): void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[styles.input, input.multiline && { minHeight: 72, textAlignVertical: "top" }]}
        {...input}
      />
      {hint ? <Text style={styles.muted}>{hint}</Text> : null}
    </View>
  );
}

function HostForm({
  target,
  styles,
  theme,
  onCancel,
  onDone,
}: {
  target: FormTarget;
  styles: Styles;
  theme: PluginTheme;
  onCancel(): void;
  onDone(message: string): void;
}) {
  const paseo = usePaseo();
  const host = target.kind === "edit" ? target.host : null;
  const [connection, setConnection] = useState("");
  const [label, setLabel] = useState(host?.label ?? "");
  const [metadata, setMetadata] = useState(host ? formatMetadata(host.metadata) : "");
  const [sourceKey, setSourceKey] = useState("");
  const mismatch = host?.error?.code === "server_id_mismatch";
  const [replaceIdentity, setReplaceIdentity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    const add = host ? null : buildAddInput({ connection, label, metadata, sourceKey });
    const update = host
      ? buildUpdatePatch(host, { label, metadata, connection, replaceIdentity })
      : null;
    const invalid = [add, update].find((built) => built && !built.ok);
    if (invalid && !invalid.ok) {
      setError(invalid.error);
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (add?.ok) {
        await paseo.hosts.add(add.value);
        onDone("Host added");
      } else if (host && update?.ok && Object.keys(update.value).length > 0) {
        await paseo.hosts.update(host.registrationId, update.value);
        onDone("Host updated");
      } else {
        onCancel();
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Field
        styles={styles}
        theme={theme}
        label={host ? "New connection" : "Connection"}
        value={connection}
        onChangeText={setConnection}
        placeholder={
          host ? "Leave blank to keep the saved connection" : "host:6767 or ssh://user@host"
        }
        hint={
          host
            ? `Currently ${host.targetDescription}. Saved credentials are never shown.${
                mismatch
                  ? " This host reached a different daemon. Enter the connection again and tick the box below to accept the new identity."
                  : ""
              }`
            : "Saved on this daemon. Unreachable hosts are kept and retried."
        }
      />
      {host && connection.trim() ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel="Accept a different server identity"
          accessibilityState={{ checked: replaceIdentity }}
          onPress={() => setReplaceIdentity((value) => !value)}
          style={styles.row}
        >
          <Icon
            name={replaceIdentity ? "SquareCheck" : "Square"}
            size={18}
            color={theme.colors.foreground}
          />
          <Text style={[styles.body, { flex: 1 }]}>
            Accept a different server identity. Required when the new connection reaches another
            daemon than the one pinned for this host.
          </Text>
        </Pressable>
      ) : null}
      <Field
        styles={styles}
        theme={theme}
        label="Label"
        value={label}
        onChangeText={setLabel}
        placeholder="Build box"
      />
      <Field
        styles={styles}
        theme={theme}
        label="Metadata"
        value={metadata}
        onChangeText={setMetadata}
        placeholder="team=infra"
        hint="One key=value per line. Saving replaces the whole map."
        multiline
      />
      {host ? null : (
        <Field
          styles={styles}
          theme={theme}
          label="Source key"
          value={sourceKey}
          onChangeText={setSourceKey}
          placeholder="Optional"
          hint="Names this registration. Repeating an add with the same connection, label and metadata returns the saved entry."
        />
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        <Action
          label="Cancel"
          onPress={onCancel}
          disabled={pending}
          style={styles.button}
          textStyle={styles.buttonText}
        />
        <Action
          label={pending ? "Saving..." : host ? "Save changes" : "Add host"}
          onPress={submit}
          disabled={pending}
          style={styles.primary}
          textStyle={styles.primaryText}
        />
      </View>
    </View>
  );
}

function HostCard({
  host,
  styles,
  theme,
  busy,
  onToggle,
  onEdit,
  onRemove,
}: {
  host: HostSummary;
  styles: Styles;
  theme: PluginTheme;
  busy: boolean;
  onToggle(): void;
  onEdit(): void;
  onRemove(): void;
}) {
  const name = host.label ?? host.targetDescription;
  const color = statusColor(theme, host.status);
  const metadata = Object.entries(host.metadata);
  return (
    <View style={styles.card} accessibilityLabel={`Connected host ${name}`}>
      <View style={styles.row}>
        <Text style={styles.name}>{name}</Text>
        <View style={[styles.chip, { borderColor: color }]}>
          <Text style={{ color, fontSize: 12 }}>{STATUS_LABEL[host.status]}</Text>
        </View>
      </View>
      <Text style={styles.mono}>{host.targetDescription}</Text>
      <Text style={styles.mono}>
        Server {host.serverId ?? "not learned yet"} | Source {host.source.id}
      </Text>
      {host.lastOnlineAt ? (
        <Text style={styles.muted}>Last online {new Date(host.lastOnlineAt).toLocaleString()}</Text>
      ) : null}
      {host.nextRetryAt && host.status !== "online" ? (
        <Text style={styles.muted}>Next retry {new Date(host.nextRetryAt).toLocaleString()}</Text>
      ) : null}
      {host.error ? (
        <Text style={styles.error}>
          {host.error.message} ({host.error.code})
        </Text>
      ) : null}
      {metadata.length > 0 ? (
        <View style={styles.row}>
          {metadata.map(([key, value]) => (
            <View key={key} style={styles.chip}>
              <Text style={styles.mono}>
                {key}={value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Action
          label={host.enabled ? "Disable" : "Enable"}
          accessibilityLabel={`${host.enabled ? "Disable" : "Enable"} ${name}`}
          onPress={onToggle}
          disabled={busy}
          style={styles.button}
          textStyle={styles.buttonText}
        />
        <Action
          label="Edit"
          accessibilityLabel={`Edit ${name}`}
          onPress={onEdit}
          disabled={busy}
          style={styles.button}
          textStyle={styles.buttonText}
        />
        <Action
          label="Remove"
          accessibilityLabel={`Remove ${name}`}
          onPress={onRemove}
          disabled={busy}
          style={styles.danger}
          textStyle={styles.dangerText}
        />
      </View>
    </View>
  );
}

export function ConnectedHostsScreen({ theme, layout, host: selected }: PluginScreenProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const { directory, error, retry } = useHostDirectory(paseo);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [removing, setRemoving] = useState<HostSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(registrationId: string, action: () => Promise<unknown>, done: string) {
    setBusyId(registrationId);
    try {
      await action();
      toast.show(done, { variant: "success" });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  function finishForm(message: string) {
    toast.show(message, { variant: "success" });
    setForm(null);
  }

  const hosts = directory?.hosts ?? [];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={[styles.title, { flex: 1 }]}>Connected hosts</Text>
        <Action
          label="Add host"
          onPress={() => setForm({ kind: "add" })}
          disabled={!directory}
          style={styles.primary}
          textStyle={styles.primaryText}
        />
      </View>
      <Text style={styles.muted}>
        Hosts saved on {directory?.self.label ?? selected.label}. Agents here can delegate to them.
        This list is separate from the connections saved in the app.
      </Text>
      {error ? (
        <View style={styles.card}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Action
            label="Retry"
            onPress={retry}
            style={styles.button}
            textStyle={styles.buttonText}
          />
        </View>
      ) : null}
      {!directory && !error ? <Text style={styles.muted}>Loading connected hosts...</Text> : null}
      {directory && hosts.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.name}>No connected hosts yet</Text>
          <Text style={styles.muted}>
            Add another daemon to start agents and workspaces on it from this one.
          </Text>
        </View>
      ) : null}
      {hosts.map((host) => (
        <HostCard
          key={host.registrationId}
          host={host}
          styles={styles}
          theme={theme}
          busy={busyId === host.registrationId}
          onToggle={() =>
            run(
              host.registrationId,
              () => paseo.hosts.update(host.registrationId, { enabled: !host.enabled }),
              host.enabled ? "Host disabled" : "Host enabled",
            )
          }
          onEdit={() => setForm({ kind: "edit", host })}
          onRemove={() => setRemoving(host)}
        />
      ))}

      <Modal
        title={form?.kind === "edit" ? "Edit host" : "Add host"}
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
      >
        <Modal.Content>
          {form ? (
            <HostForm
              key={form.kind === "edit" ? form.host.registrationId : "add"}
              target={form}
              styles={styles}
              theme={theme}
              onCancel={() => setForm(null)}
              onDone={finishForm}
            />
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title="Remove host"
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <Modal.Content>
          <View style={{ gap: 12 }}>
            <Text style={styles.body}>
              Remove {removing?.label ?? removing?.targetDescription} from this daemon? Agents
              already running on it keep running on their own daemon, but this daemon can no longer
              reach them. If another process registered this host, it can add it again. Disable the
              host instead to keep it saved and switched off.
            </Text>
            <View style={[styles.row, { justifyContent: "flex-end" }]}>
              <Action
                label="Cancel"
                onPress={() => setRemoving(null)}
                style={styles.button}
                textStyle={styles.buttonText}
              />
              <Action
                label="Remove host"
                onPress={() => {
                  const target = removing;
                  setRemoving(null);
                  if (target) {
                    void run(
                      target.registrationId,
                      () => paseo.hosts.remove(target.registrationId),
                      "Host removed",
                    );
                  }
                }}
                style={styles.danger}
                textStyle={styles.dangerText}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}
