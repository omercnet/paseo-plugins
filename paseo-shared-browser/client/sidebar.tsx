import {
  type PluginClientContext,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { listOpenBrowserWorkspacesRpc } from "../shared/browser";

const PANEL_ID = "shared-browser";
const PRESENCE_POLL_MS = 5_000;
const TOUCH_TARGET = 44;
const ROW_HEIGHT = 36;
const RADIUS = 8;

function useOpenBrowserWorkspaceIds(): readonly string[] {
  const listOpen = useRpc(listOpenBrowserWorkspacesRpc);
  const query = useQuery({
    queryKey: ["shared-browser", "presence"],
    queryFn: async () => (await listOpen({})).workspaceIds,
    refetchInterval: PRESENCE_POLL_MS,
    retry: false,
  });
  return query.data ?? [];
}

function SessionRow({
  workspaceId,
  theme,
  compact,
  onPress,
}: {
  workspaceId: string;
  theme: PluginPopoverProps["theme"];
  compact: boolean;
  onPress(): void;
}) {
  const name = useWorkspace(workspaceId, (workspace) => workspace.title ?? workspace.name);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          minHeight: compact ? TOUCH_TARGET : ROW_HEIGHT,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: RADIUS,
        },
        label: { color: theme.colors.foreground, fontSize: 14 },
      }),
    [theme, compact],
  );
  // A workspace this client has not loaded cannot host the panel; openPanel would throw.
  if (name === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open Shared Browser for ${name}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed ? { backgroundColor: theme.colors.surface1 } : null,
      ]}
    >
      <Text numberOfLines={1} style={styles.label}>
        {name}
      </Text>
    </Pressable>
  );
}

function createSessionsPopover(client: PluginClientContext) {
  return function SessionsPopover({ theme, layout, close }: PluginPopoverProps) {
    const workspaceIds = useOpenBrowserWorkspaceIds();
    const styles = useMemo(
      () =>
        StyleSheet.create({
          container: { padding: layout.compact ? 16 : 8, gap: 4, minWidth: 220 },
          title: {
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            paddingHorizontal: 12,
            paddingBottom: 4,
          },
        }),
      [theme, layout.compact],
    );
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Open browser sessions</Text>
        {workspaceIds.map((workspaceId) => (
          <SessionRow
            key={workspaceId}
            workspaceId={workspaceId}
            theme={theme}
            compact={layout.compact}
            onPress={() => {
              close();
              client.openPanel(PANEL_ID, { workspaceId });
            }}
          />
        ))}
      </View>
    );
  };
}

function createSidebarItem(client: PluginClientContext) {
  const SessionsPopover = createSessionsPopover(client);
  return function SharedBrowserSidebarItem({ openPopover }: PluginSidebarItemProps) {
    const count = useOpenBrowserWorkspaceIds().length;
    if (count === 0) return null;
    return (
      <SidebarRow
        icon="PanelsTopLeft"
        label={`Shared Browser (${count})`}
        onPress={() => openPopover(SessionsPopover)}
      />
    );
  };
}

/** Sidebar footer row listing open sessions. */
export function contributeSharedBrowserSidebar(client: PluginClientContext): () => void {
  return client.addSidebarFooterItem({
    id: "shared-browser-sessions",
    title: "Shared Browser",
    Component: createSidebarItem(client),
  });
}
