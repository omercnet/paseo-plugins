import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { OmpStore } from "../shared/omp-store";
import {
  type OmpToolConfigKind,
  readOmpToolConfig,
  writeOmpToolConfig,
} from "../shared/omp-tool-config";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];

const KINDS: readonly { kind: OmpToolConfigKind; label: string; example: string }[] = [
  {
    kind: "lsp",
    label: "Language servers (lsp.json)",
    example: '{\n  "servers": {\n    "pylsp": { "disabled": true }\n  }\n}',
  },
  {
    kind: "dap",
    label: "Debug adapters (dap.json)",
    example:
      '{\n  "adapters": {\n    "my-adapter": { "command": "my-dap-server", "fileTypes": [".xyz"] }\n  }\n}',
  },
];

function Choice({
  styles,
  label,
  selected,
  disabled,
  onPress,
}: {
  styles: OmpConfigStyles;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: selected === true }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.editorAction, selected ? styles.editorActionPrimary : null]}
    >
      <Text style={[styles.editorActionText, selected ? styles.editorActionTextPrimary : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function OmpToolConfigSection({
  styles,
  theme,
  store,
  cwd,
}: {
  styles: OmpConfigStyles;
  theme: Theme;
  store: OmpStore | undefined;
  cwd: string | undefined;
}) {
  const read = useRpc(readOmpToolConfig);
  const write = useRpc(writeOmpToolConfig);
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<OmpToolConfigKind>("lsp");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const scope = `${ompStoreKey(store)}:${cwd ?? "user"}:${kind}`;
  const queryKey = ["paseo-omp", "tool-config", ompStoreKey(store), cwd ?? "user", kind];
  const target = { ...(store ? { store } : {}), ...(cwd ? { cwd } : {}), kind };
  const file = useQuery({ queryKey, queryFn: () => read(target) });
  const save = useMutation({
    mutationKey: ["paseo-omp", "tool-config-save"],
    mutationFn: (input: { revision: string; text: string }) => write({ ...target, ...input }),
    onSuccess: async (result) => {
      if (result.outcome !== "saved") return;
      await queryClient.invalidateQueries({ queryKey });
      setDrafts(({ [scope]: _saved, ...rest }) => rest);
    },
  });

  const loaded = file.data;
  const text = drafts[scope] ?? loaded?.text ?? "";
  const dirty = loaded !== undefined && text !== loaded.text;
  const result = save.data;
  const example = KINDS.find((entry) => entry.kind === kind)?.example ?? "";

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Language server and debugger config</Text>
      </View>
      <View style={styles.setting}>
        <View style={styles.editorActions}>
          {KINDS.map((entry) => (
            <Choice
              key={entry.kind}
              styles={styles}
              label={entry.label}
              selected={entry.kind === kind}
              onPress={() => {
                save.reset();
                setKind(entry.kind);
              }}
            />
          ))}
        </View>
        <Text style={styles.settingDescription}>
          {cwd ? "Project file" : "User file"} for new sessions only. OMP keeps running agents on
          their current servers, and reports server status only inside a session. OMP ignores an
          invalid definition and only logs a warning, so Save checks the file first. Save cannot
          tell which servers are built in, so a new server still needs command, fileTypes and
          rootMarkers.
        </Text>
        {loaded ? (
          <Text selectable style={styles.settingPath}>
            {loaded.path}
            {loaded.exists ? "" : " (not created yet)"}
          </Text>
        ) : null}
        {loaded && loaded.otherFiles.length > 0 ? (
          <Text style={styles.settingDescription}>
            OMP also merges {loaded.otherFiles.join(", ")} from the same folder. This editor does
            not change those files.
          </Text>
        ) : null}
        {file.error ? (
          <Text style={styles.error}>Could not read the file. Check its permissions.</Text>
        ) : null}
        <TextInput
          accessibilityLabel={`Edit ${kind}.json`}
          multiline
          editable={loaded !== undefined && !save.isPending}
          placeholder={example}
          placeholderTextColor={theme.colors.foregroundMuted}
          value={text}
          onChangeText={(next) => {
            save.reset();
            setDrafts((current) => ({ ...current, [scope]: next }));
          }}
          style={[styles.scalarInput, { minHeight: 200, maxWidth: undefined }]}
        />
        {result?.outcome === "invalid"
          ? result.errors.map((error) => (
              <Text key={error} style={styles.error}>
                {error}
              </Text>
            ))
          : null}
        {result?.outcome === "conflict" ? (
          <Text style={styles.error}>
            The file changed on disk. Revert to load the current version.
          </Text>
        ) : null}
        {save.error ? <Text style={styles.error}>Could not save the file.</Text> : null}
        {result?.outcome === "saved" ? (
          <Text style={styles.muted}>Saved. New sessions will use it.</Text>
        ) : null}
        <View style={styles.editorActions}>
          <Choice
            styles={styles}
            label="Revert"
            disabled={!dirty || save.isPending}
            onPress={() => {
              save.reset();
              setDrafts(({ [scope]: _discarded, ...rest }) => rest);
              void file.refetch();
            }}
          />
          <Choice
            styles={styles}
            label={save.isPending ? "Saving..." : "Save"}
            selected
            disabled={!loaded || !dirty || save.isPending}
            onPress={() => save.mutate({ revision: loaded?.revision ?? "", text })}
          />
        </View>
      </View>
    </View>
  );
}
