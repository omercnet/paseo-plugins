import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkspaceSummary } from "./workspace-summary";

export function registerWorkspaceFooter(client: PluginClientContext, summary: WorkspaceSummary) {
  if (typeof client.addSidebarFooterItem !== "function" || typeof SidebarRow !== "function") return;

  function Popover({ theme, layout }: PluginPopoverProps) {
    const entries = useSyncExternalStore(summary.subscribe, summary.getSnapshot);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function refreshAll() {
      setPending(true);
      setError(null);
      try {
        await summary.refreshAll();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
    }
    return (
      <View
        style={{
          padding: layout.compact ? 16 : 20,
          gap: 12,
          backgroundColor: theme.colors.surface0,
          width: layout.compact ? "100%" : 360,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          Behind its source branch
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Refresh fetches and rechecks. It does not merge workspace branches.
        </Text>
        <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 12 }}>
          {entries.map((entry) => (
            <View key={entry.id} style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foreground }}>{entry.directory}</Text>
              <Text style={{ color: theme.colors.foregroundMuted }}>
                {entry.behindBy} {entry.behindBy === 1 ? "commit" : "commits"} behind{" "}
                {entry.remoteRef}
              </Text>
            </View>
          ))}
          {!entries.length && (
            <Text style={{ color: theme.colors.foregroundMuted }}>
              No workspaces behind their source branch.
            </Text>
          )}
        </ScrollView>
        {error && <Text style={{ color: theme.colors.statusDanger }}>{error}</Text>}
        <Pressable
          accessibilityRole="button"
          disabled={pending || !entries.length}
          onPress={() => {
            void refreshAll();
          }}
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor: theme.colors.surface2,
            opacity: pending || !entries.length ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.colors.foreground }}>
            {pending ? "Refreshing..." : "Refresh all"}
          </Text>
        </Pressable>
      </View>
    );
  }
  function Footer({ theme, openPopover }: PluginSidebarItemProps) {
    const entries = useSyncExternalStore(summary.subscribe, summary.getSnapshot);
    return (
      <SidebarRow
        icon="GitPullRequest"
        label="Behind source branch"
        onPress={() => openPopover(Popover)}
        trailing={<Text style={{ color: theme.colors.foregroundMuted }}>{entries.length}</Text>}
      />
    );
  }
  return client.addSidebarFooterItem({
    id: "workspace-freshness",
    title: "Behind source branch",
    Component: Footer,
  });
}
