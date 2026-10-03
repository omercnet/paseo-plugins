import {
  type PluginPopoverProps,
  type PluginSidebarItemProps,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { discoverSupervisor, gasCitySettings } from "../shared";
import {
  CITY_SCREEN_ID,
  cityScreenParams,
  type SupervisorTone,
  supervisorHealth,
} from "./view-model";

type Theme = PluginSidebarItemProps["theme"];

function toneColor(theme: Theme, tone: SupervisorTone): string {
  switch (tone) {
    case "healthy":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "unavailable":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function useDiscovery(hostId: string) {
  const settings = useSettings(gasCitySettings);
  const loadDiscovery = useRpc(discoverSupervisor);
  const ready = settings.status === "ready";
  const query = useQuery({
    // Same key as the main screen so both share one poll.
    queryKey: ["gas-city", hostId, ready ? settings.values.endpointUrl : null, "discovery"],
    queryFn: () => loadDiscovery({}),
    enabled: ready,
    refetchInterval: ready ? settings.values.refreshIntervalMs : false,
  });
  // Invalid or unreadable settings must not fall back to any cached discovery.
  const data = ready ? query.data : undefined;
  const health = supervisorHealth({
    data,
    error: settings.status === "error" ? new Error(settings.error) : ready ? query.error : null,
    pending: settings.status === "loading" || (ready && query.isPending),
  });
  return { data, health, refetch: () => void query.refetch() };
}

export function GasCitySidebarItem({
  theme,
  host,
  currentScreen,
  openScreen,
  openPopover,
}: PluginSidebarItemProps) {
  const { health } = useDiscovery(host.id);
  const color = toneColor(theme, health.tone);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const active =
    currentScreen?.screenId === "gas-city" || currentScreen?.screenId === CITY_SCREEN_ID;
  return (
    <SidebarRow
      icon="Factory"
      active={active}
      onPress={() => openScreen({ screenId: "gas-city" })}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Gas City ${health.tone}: ${health.summary} Show cities`}
          onPress={() => openPopover(CitiesPopover)}
          style={styles.trailing}
        >
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.badge, { color }]}>{health.badge}</Text>
        </Pressable>
      }
    />
  );
}

function CitiesPopover({ theme, host, layout, close, openScreen }: PluginPopoverProps) {
  const { data, health } = useDiscovery(host.id);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const color = toneColor(theme, health.tone);
  const cities = data?.cities ?? [];
  return (
    <View style={[styles.popover, layout.compact && styles.popoverCompact]}>
      <View style={styles.popoverHeader}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text accessibilityRole="header" style={styles.popoverTitle}>
          Gas City
        </Text>
      </View>
      <Text style={[styles.summary, health.tone !== "healthy" && { color }]}>{health.summary}</Text>
      {cities.map((city) => (
        <Pressable
          key={`${city.path}:${city.name}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${city.name}, ${city.running ? "running" : (city.status ?? "stopped")}`}
          onPress={() => {
            close();
            openScreen({ screenId: CITY_SCREEN_ID, params: cityScreenParams(city.name) });
          }}
          style={({ pressed }) => [styles.cityRow, pressed && styles.pressed]}
        >
          <View
            style={[
              styles.dot,
              {
                backgroundColor: city.running
                  ? theme.colors.statusSuccess
                  : theme.colors.statusWarning,
              },
            ]}
          />
          <Text style={styles.cityName} numberOfLines={1}>
            {city.name}
          </Text>
          <Text style={styles.cityStatus} numberOfLines={1}>
            {city.error ?? city.status ?? (city.running ? "running" : "stopped")}
          </Text>
        </Pressable>
      ))}
      {data?.state === "available" && cities.length === 0 ? (
        <Text style={styles.summary}>No cities reported.</Text>
      ) : null}
    </View>
  );
}

function createStyles(theme: Theme) {
  return StyleSheet.create({
    trailing: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    badge: { fontSize: 11, fontWeight: "700" },
    popover: { minWidth: 260, gap: 6, padding: 12 },
    popoverCompact: { padding: 16, paddingBottom: 24 },
    popoverHeader: { flexDirection: "row", alignItems: "center", gap: 7 },
    popoverTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "800" },
    summary: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    cityRow: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 8,
      borderRadius: 6,
    },
    cityName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
    cityStatus: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "right" },
    pressed: { opacity: 0.72 },
  });
}
