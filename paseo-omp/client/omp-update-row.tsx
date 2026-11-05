import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { getOmpUpdateStatus, installOmpUpdate, type OmpUpdateStatus } from "../shared/omp-update";
import { ActionButton, ConfirmModal } from "./omp-accounts-section";
import type { OmpConfigStyles } from "./omp-config-styles";

export const UPDATE_QUERY_KEY = ["paseo-omp", "update-status"] as const;

export function summarizeUpdateStatus(status: OmpUpdateStatus): string {
  if (status.state === "available") return `${status.version} available`;
  if (status.state === "up-to-date") return "Up to date";
  return "Could not check for updates";
}

/** The "Update available" line for the omp binary card, with a confirmed Update button. */
export function OmpUpdateRow({
  styles,
  theme,
  onInstalled,
}: {
  styles: OmpConfigStyles;
  theme: PluginSurfaceProps["theme"];
  onInstalled(): void;
}) {
  const queryClient = useQueryClient();
  const loadStatus = useRpc(getOmpUpdateStatus);
  const install = useRpc(installOmpUpdate);
  const status = useQuery({ queryKey: UPDATE_QUERY_KEY, queryFn: () => loadStatus({}) });
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const update = useMutation({
    mutationFn: () => install({}),
    onSuccess: async (result) => {
      await queryClient.cancelQueries({ queryKey: UPDATE_QUERY_KEY });
      queryClient.setQueryData(UPDATE_QUERY_KEY, result.status);
      setMessage({ ok: result.ok, text: result.message });
      onInstalled();
    },
    onError: () => setMessage({ ok: false, text: "Could not update OMP. Try again." }),
    onSettled: () => setConfirming(false),
  });

  if (status.isLoading) return <Text style={styles.muted}>Checking for an OMP update…</Text>;
  const current = status.data ?? { state: "unknown" as const };
  return (
    <>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Update</Text>
        <Text
          style={[
            styles.rowValue,
            current.state === "available" ? { color: theme.colors.statusWarning } : null,
          ]}
        >
          {summarizeUpdateStatus(current)}
        </Text>
        {current.state === "available" ? (
          <ActionButton
            styles={styles}
            theme={theme}
            label={update.isPending ? "Updating…" : "Update"}
            disabled={update.isPending}
            onPress={() => setConfirming(true)}
          />
        ) : null}
      </View>
      {message ? (
        <Text style={message.ok ? styles.muted : styles.error}>{message.text}</Text>
      ) : null}
      {confirming ? (
        <ConfirmModal
          styles={styles}
          theme={theme}
          title="Update OMP"
          body="Installs the newest OMP on this host. Agents that are running keep the old version until they restart."
          confirmLabel="Update"
          tone="primary"
          busy={update.isPending}
          onConfirm={() => update.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}
