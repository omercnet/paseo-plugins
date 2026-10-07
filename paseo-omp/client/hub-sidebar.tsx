import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { HubProcessList } from "./hub-popover";
import { CONFIG_SCREEN_ID, type HubSnapshot, hubTrailing } from "./sidebar-compat";

// The row is always mounted; a slower poll bounds per-client RPC fan-out across workspaces.
const HUB_POLL_MS = 15_000;
const HUB_SIDEBAR_QUERY_KEY = ["paseo-omp", "hub-sidebar"] as const;

export function ConfigSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Settings"
      label="OMP"
      active={currentScreen?.screenId === CONFIG_SCREEN_ID}
      onPress={() => openScreen({ screenId: CONFIG_SCREEN_ID })}
    />
  );
}

export function createHubSidebar(loadSnapshot: () => Promise<HubSnapshot>) {
  const useHubSnapshot = () =>
    useQuery({
      queryKey: HUB_SIDEBAR_QUERY_KEY,
      queryFn: loadSnapshot,
      refetchInterval: HUB_POLL_MS,
    });

  function HubSidebarPopover({ theme, layout }: PluginPopoverProps) {
    const snapshot = useHubSnapshot();
    const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
    if (snapshot.isLoading) return <Text style={muted}>Loading hub processes…</Text>;
    if (!snapshot.data) {
      return (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
          Could not read omp hub state.
        </Text>
      );
    }
    const active = snapshot.data.workspaces.filter(({ processes }) => processes.length > 0);
    const notes = [
      snapshot.data.unreadable > 0
        ? `${snapshot.data.unreadable} workspace(s) could not be read.`
        : undefined,
      snapshot.data.truncated ? "Showing the first 50 workspaces." : undefined,
    ].filter(Boolean);
    return (
      <View style={{ gap: layout.compact ? 12 : 14 }}>
        {notes.map((note) => (
          <Text key={note} style={{ ...muted, fontSize: 12 }}>
            {note}
          </Text>
        ))}
        {active.length === 0 ? <Text style={muted}>No hub-supervised processes.</Text> : null}
        {active.map(({ cwd, processes }) => (
          <View key={cwd} style={{ gap: 6 }}>
            <Text numberOfLines={1} style={{ ...muted, fontSize: 12 }}>
              {cwd}
            </Text>
            <HubProcessList theme={theme} layout={layout} cwd={cwd} processes={processes} />
          </View>
        ))}
      </View>
    );
  }

  function HubSidebarItem({ theme, openPopover }: PluginSidebarItemProps) {
    const snapshot = useHubSnapshot();
    const state = hubTrailing(snapshot.data, snapshot.error !== null);
    const trailing = state ? (
      <View
        accessibilityLabel={state.accessibilityLabel}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        {state.running ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{state.running}</Text>
        ) : null}
        {state.failed || state.unreadable ? (
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
            {[state.failed, state.unreadable ? "!" : undefined].filter(Boolean).join(" ")}
          </Text>
        ) : null}
      </View>
    ) : undefined;
    return (
      <SidebarRow
        icon="Activity"
        label="OMP Hub"
        trailing={trailing}
        onPress={() => openPopover(HubSidebarPopover)}
      />
    );
  }

  return { HubSidebarItem, HubSidebarPopover };
}
