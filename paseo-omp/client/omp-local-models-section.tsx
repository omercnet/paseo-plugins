import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  downloadOmpLocalModel,
  listOmpLocalModels,
  type OmpLocalModel,
} from "../shared/omp-local-models";
import { updateOmpSettings } from "../shared/omp-settings";
import type { OmpStore } from "../shared/omp-store";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

const POLL_MS = 3_000;
const ACTION_GROUP = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;

const ROLES = [
  { role: "tiny", label: "titles" },
  { role: "memory", label: "memory" },
] as const;

function Choice({
  styles,
  label,
  accessibilityLabel,
  selected,
  disabled,
  onPress,
}: {
  styles: OmpConfigStyles;
  label: string;
  accessibilityLabel: string;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
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

function status(model: OmpLocalModel): string {
  if (model.download === "running") return "Downloading...";
  if (model.download === "failed") return `Download failed: ${model.error ?? "unknown error"}`;
  return model.downloaded ? "Downloaded" : "Not downloaded";
}

/** OMP's own on-device models for titles and memory. Not Paseo's Voice and Dictation models. */
export function OmpLocalModelsSection({
  styles,
  store,
  modelRoles,
  settingsRevision,
  rolesPending,
  onRolesChanged,
}: {
  styles: OmpConfigStyles;
  store: OmpStore | undefined;
  modelRoles: Readonly<Record<string, unknown>>;
  settingsRevision: string | undefined;
  /** Unapplied edits to modelRoles would be overwritten by a role assignment made here. */
  rolesPending: boolean;
  onRolesChanged(): void;
}) {
  const list = useRpc(listOmpLocalModels);
  const download = useRpc(downloadOmpLocalModel);
  const update = useRpc(updateOmpSettings);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const queryKey = ["paseo-omp", "local-models", ompStoreKey(store)];
  const models = useQuery({
    queryKey,
    queryFn: () => list(store ? { store } : {}),
    refetchInterval: (query) =>
      query.state.data?.models.some((model) => model.download === "running") ? POLL_MS : false,
  });
  const start = useMutation({
    mutationKey: ["paseo-omp", "local-model-download"],
    mutationFn: (key: string) => download({ ...(store ? { store } : {}), key }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const assign = useMutation({
    mutationKey: ["paseo-omp", "settings", ompStoreKey(store)],
    mutationFn: async (next: Record<string, unknown>) => {
      if (!settingsRevision) throw new Error("OMP settings cannot be edited without a revision.");
      const input = updateOmpSettings.input.parse({
        ...(store ? { store } : {}),
        revision: settingsRevision,
        changes: [{ operation: "set", path: "modelRoles", value: next }],
      });
      return update(input);
    },
    onSettled: onRolesChanged,
  });

  const busy = models.data?.models.some((model) => model.download === "running") === true;
  const blocked = !settingsRevision || rolesPending || assign.isPending;
  const failed = start.data && start.data.outcome !== "started";

  function assignRole(role: string, selector: string | null) {
    const { [role]: _removed, ...rest } = modelRoles;
    assign.mutate(selector === null ? rest : { ...rest, [role]: selector });
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>OMP local models</Text>
      </View>
      <View style={styles.setting}>
        <Text style={styles.settingDescription}>
          Small models OMP runs on this machine for session titles and memory. They belong to OMP
          only and are separate from Paseo's own Voice and Dictation models. Role changes apply to
          new sessions or after a reload. A local titles role never falls back to an online model:
          if the local model fails, the session stays untitled. The first download can also install
          OMP's inference runtime, so it may take longer and use more disk than the model size.
        </Text>
        {models.data && !models.data.available ? (
          <Text style={styles.error}>OMP could not list its local models.</Text>
        ) : null}
        {failed ? (
          <Text style={styles.error}>
            {start.data?.outcome === "busy"
              ? "Another download is still running."
              : "OMP could not start that download."}
          </Text>
        ) : null}
        {assign.error || (assign.data && (assign.data.conflict || assign.data.failed)) ? (
          <Text style={styles.error}>
            Could not change the role. Refresh the settings and try again.
          </Text>
        ) : null}
      </View>
      {models.data?.models.map((model) => (
        <View key={model.key} style={styles.setting}>
          <View style={styles.settingHeader}>
            <Text style={styles.cardTitle}>{model.label}</Text>
            <Text style={styles.source}>{status(model)}</Text>
          </View>
          <Text selectable style={styles.settingPath}>
            {model.key}
          </Text>
          <Text style={styles.settingDescription}>{model.description}</Text>
          {confirming === model.key ? (
            <View style={styles.recordList}>
              <Text style={styles.settingDescription}>
                Download {model.label}
                {model.sizeMb ? ` (about ${model.sizeMb} MB)` : ""} to this machine? OMP shows no
                progress, so this can take several minutes.
              </Text>
              <View style={ACTION_GROUP}>
                <Choice
                  styles={styles}
                  label="Download"
                  accessibilityLabel={`Confirm download of ${model.label}`}
                  selected
                  disabled={busy || start.isPending}
                  onPress={() => {
                    setConfirming(null);
                    start.mutate(model.key);
                  }}
                />
                <Choice
                  styles={styles}
                  label="Cancel"
                  accessibilityLabel={`Cancel download of ${model.label}`}
                  onPress={() => setConfirming(null)}
                />
              </View>
            </View>
          ) : (
            <View style={ACTION_GROUP}>
              <Choice
                styles={styles}
                label={model.downloaded ? "Download again" : "Download"}
                accessibilityLabel={`Download ${model.label}`}
                disabled={busy || start.isPending}
                onPress={() => setConfirming(model.key)}
              />
              {ROLES.map(({ role, label }) => {
                const selector = `local/${model.key}`;
                const assigned = modelRoles[role] === selector;
                return (
                  <Choice
                    key={role}
                    styles={styles}
                    label={assigned ? `Using for ${label}` : `Use for ${label}`}
                    accessibilityLabel={`${assigned ? "Stop using" : "Use"} ${model.label} for ${label}`}
                    selected={assigned}
                    disabled={blocked}
                    onPress={() => assignRole(role, assigned ? null : selector)}
                  />
                );
              })}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}
