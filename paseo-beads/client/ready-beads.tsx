import {
  type PluginPopoverProps,
  type PluginSidebarItemProps,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { getWorkspaceBeads } from "../shared/beads";
import { BEAD_SCREEN_ID, describeReadyBeads } from "./beads-view";
import { errorMessage, ID_FONT_FAMILY, priorityColor } from "./paseo-beads";
import { READY_LIST_LIMIT, scanReadyBeads } from "./ready-scan";

/** The scan reads every project's Beads, so it runs rarely in the background and on popover open. */
const READY_REFRESH_INTERVAL_MS = 120_000;

function useReadyBeads(hostId: string, refetchOnMount: true | "always") {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const loadSnapshot = useRpc(getWorkspaceBeads);
  return useQuery({
    queryKey: ["paseo-beads", "ready", hostId],
    queryFn: ({ signal }) =>
      scanReadyBeads({
        hostId,
        signal,
        queryClient,
        loadSnapshot,
        listWorkspaces: async () => (await paseo.workspaces.list()).entries,
      }),
    staleTime: READY_REFRESH_INTERVAL_MS / 2,
    refetchInterval: READY_REFRESH_INTERVAL_MS,
    refetchOnMount,
    refetchOnWindowFocus: false,
  });
}

export function ReadyBeadsItem({
  theme,
  host,
  currentScreen,
  openPopover,
}: PluginSidebarItemProps) {
  const { data } = useReadyBeads(host.id, true);
  return (
    <SidebarRow
      icon="CircleDot"
      active={currentScreen?.screenId === BEAD_SCREEN_ID}
      onPress={() => openPopover(ReadyBeadsPopover)}
      trailing={
        data?.count ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{data.count}</Text>
        ) : null
      }
    />
  );
}

function ReadyBeadsPopover({ theme, layout, host, openScreen }: PluginPopoverProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const { data, error } = useReadyBeads(host.id, "always");

  if (!data) {
    return (
      <View style={styles.state}>
        {error ? null : <ActivityIndicator color={theme.colors.accent} />}
        <Text style={styles.note}>
          {error ? `Could not load Beads. ${errorMessage(error)}` : "Loading ready beads…"}
        </Text>
      </View>
    );
  }

  const { empty, notices } = describeReadyBeads(data, error ? errorMessage(error) : null);

  return (
    <View style={styles.list}>
      {empty ? <Text style={styles.note}>{empty}</Text> : null}
      {data.groups.map(({ workspace, beads }) => (
        <View key={workspace.id} style={styles.group}>
          <View style={styles.groupHeading}>
            <Text accessibilityRole="header" style={styles.workspace} numberOfLines={1}>
              {workspace.name}
            </Text>
            <Text style={styles.project} numberOfLines={1}>
              {workspace.projectDisplayName}
            </Text>
          </View>
          {beads.map((bead) => (
            <Pressable
              key={bead.id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${bead.id}: ${bead.title}. Priority P${bead.priority}.`}
              onPress={() =>
                openScreen({
                  screenId: BEAD_SCREEN_ID,
                  params: { workspace: workspace.id, bead: bead.id },
                })
              }
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Text
                style={[styles.priority, { color: priorityColor(bead.priority, theme.colors) }]}
              >
                P{bead.priority}
              </Text>
              <Text style={styles.id}>{bead.id}</Text>
              <Text style={styles.title} numberOfLines={1}>
                {bead.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
      {data.count > READY_LIST_LIMIT ? (
        <Text style={styles.note}>
          Showing {READY_LIST_LIMIT} of {data.count} ready beads.
        </Text>
      ) : null}
      {notices.map((notice) => (
        <Text key={notice} style={styles.note}>
          {notice}
        </Text>
      ))}
    </View>
  );
}

function createStyles(theme: PluginPopoverProps["theme"], compact: boolean) {
  return StyleSheet.create({
    list: { gap: 12 },
    state: { alignItems: "center", gap: 8, paddingVertical: 12 },
    group: { gap: 2 },
    groupHeading: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 6,
      paddingHorizontal: 6,
      paddingBottom: 2,
    },
    workspace: { flexShrink: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "700" },
    project: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 11 },
    row: {
      minHeight: compact ? 44 : 32,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 6,
      borderRadius: 6,
    },
    pressed: { backgroundColor: theme.colors.surface2 },
    priority: { fontSize: 11, fontWeight: "800" },
    id: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: ID_FONT_FAMILY },
    title: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 13 },
    note: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
  });
}
