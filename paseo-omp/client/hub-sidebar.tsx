import type { PluginHostProps } from "@getpaseo/plugin/client";
// Namespace import: on 0.9/0.10 hosts this module lacks SidebarRow, which is only rendered from
// 0.11-only sidebar items. Typed locally so older SDK typechecks still compile.
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { Text, View } from "react-native";
import { HubProcessList } from "./hub-popover";
import {
  CONFIG_SCREEN_ID,
  type HubWorkspaceProcesses,
  summarizeHubWorkspaces,
} from "./sidebar-compat";

const HUB_POLL_MS = 4_000;
const HUB_SIDEBAR_QUERY_KEY = ["paseo-omp", "hub-sidebar"] as const;

interface OpenScreenInput {
  screenId: string;
  params?: Record<string, string>;
}
type HostProps = Pick<PluginHostProps, "theme" | "layout">;
interface PopoverProps extends HostProps {
  close(): void;
  openScreen(input: OpenScreenInput): void;
}
interface SidebarItemProps extends HostProps {
  currentScreen: { screenId: string; params: Record<string, string> } | null;
  openScreen(input: OpenScreenInput): void;
  openPopover(Content: ComponentType<PopoverProps>): void;
}
type SidebarRowComponent = ComponentType<{
  id?: string;
  icon?: string | ComponentType<{ size: number; color: string }>;
  label?: string;
  onPress(): void;
  active?: boolean;
  trailing?: ReactNode;
}>;

const uiModule: object = pluginUi;
// Presence check only: host components may be memo/forwardRef objects, not plain functions.
// Unchecked cast: older SDK typings do not declare SidebarRow; only 0.11 code paths render this.
const SidebarRow: SidebarRowComponent | undefined =
  "SidebarRow" in uiModule && uiModule.SidebarRow
    ? (uiModule.SidebarRow as SidebarRowComponent)
    : undefined;

export function ConfigSidebarItem({ currentScreen, openScreen }: SidebarItemProps) {
  if (!SidebarRow) return null;
  return (
    <SidebarRow
      icon="Settings"
      label="OMP"
      active={currentScreen?.screenId === CONFIG_SCREEN_ID}
      onPress={() => openScreen({ screenId: CONFIG_SCREEN_ID })}
    />
  );
}

export function createHubSidebar(loadWorkspaces: () => Promise<HubWorkspaceProcesses[]>) {
  const useHubWorkspaces = () =>
    useQuery({
      queryKey: HUB_SIDEBAR_QUERY_KEY,
      queryFn: loadWorkspaces,
      refetchInterval: HUB_POLL_MS,
    });

  function HubSidebarPopover({ theme, layout }: PopoverProps) {
    const workspaces = useHubWorkspaces();
    const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
    if (workspaces.isLoading) return <Text style={muted}>Loading hub processes…</Text>;
    if (workspaces.error) {
      return (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
          Could not read omp hub state.
        </Text>
      );
    }
    const active = (workspaces.data ?? []).filter(({ processes }) => processes.length > 0);
    if (active.length === 0) return <Text style={muted}>No hub-supervised processes.</Text>;
    return (
      <View style={{ gap: layout.compact ? 12 : 14 }}>
        {active.map(({ cwd }) => (
          <View key={cwd} style={{ gap: 6 }}>
            <Text numberOfLines={1} style={{ ...muted, fontSize: 12 }}>
              {cwd}
            </Text>
            <HubProcessList theme={theme} layout={layout} cwd={cwd} />
          </View>
        ))}
      </View>
    );
  }

  function HubSidebarItem({ theme, openPopover }: SidebarItemProps) {
    const workspaces = useHubWorkspaces();
    if (!SidebarRow) return null;
    const summary = summarizeHubWorkspaces(workspaces.data ?? []);
    const unreadable = workspaces.error !== null;
    const trailing =
      unreadable || summary.total > 0 ? (
        <View
          accessibilityLabel={
            unreadable
              ? "Hub state unreadable"
              : `${summary.running} running, ${summary.failed} failed`
          }
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          {summary.total > 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {`${summary.running} running`}
            </Text>
          ) : null}
          {unreadable || summary.failed > 0 ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
              {unreadable ? "!" : `${summary.failed} failed`}
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
