import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type AttentionItem, age, attentionCount, attentionItems } from "./monitor";
import { type MonitorData, useMonitorQuery } from "./monitor-data";

export const MONITOR_SCREEN_ID = "monitor";
const POPOVER_LIMIT = 8;

function selectAttention(data: MonitorData) {
  return { items: attentionItems(data.entries), truncated: data.truncated };
}

/** Attention state from the shared directory query; `count` is null while it cannot be trusted. */
function useAttention(hostId: string) {
  const { data, isError } = useMonitorQuery(hostId, selectAttention);
  return {
    items: data?.items,
    summary: attentionCount({
      items: data?.items,
      truncated: data?.truncated ?? false,
      failed: isError,
    }),
  };
}

export function MonitorSidebarItem({
  host,
  theme,
  currentScreen,
  openScreen,
  openPopover,
}: PluginSidebarItemProps) {
  const { summary } = useAttention(host.id);
  const label =
    summary && summary.count > 0 ? `${summary.count}${summary.lowerBound ? "+" : ""}` : null;
  const styles = useMemo(
    () => ({
      badge: {
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 10,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.accent,
      },
      badgeText: { color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" as const },
    }),
    [theme],
  );
  return (
    <SidebarRow
      icon="Radar"
      label="Agent monitor"
      active={currentScreen?.screenId === MONITOR_SCREEN_ID}
      onPress={() => openScreen({ screenId: MONITOR_SCREEN_ID })}
      trailing={
        label ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} agents need attention`}
            onPress={() => openPopover(AttentionPopover)}
            style={styles.badge}
          >
            <Text style={styles.badgeText}>{label}</Text>
          </Pressable>
        ) : null
      }
    />
  );
}

function AttentionPopover({ host, theme, layout, openScreen }: PluginPopoverProps) {
  const { items, summary } = useAttention(host.id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(clock);
  }, []);
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 6 },
      heading: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      rowTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13 },
      rowState: { color: theme.colors.foregroundMuted, fontSize: 12 },
      action: {
        minHeight: 36,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionText: { color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme, layout.compact],
  );
  const shown: readonly AttentionItem[] = items?.slice(0, POPOVER_LIMIT) ?? [];
  const hidden = (items?.length ?? 0) - shown.length;
  let heading = "Checking agents…";
  if (summary) {
    heading =
      summary.count === 0
        ? summary.lowerBound
          ? "None of the newest agents need attention; older ones were not checked"
          : "No agents need attention"
        : `${summary.count}${summary.lowerBound ? "+" : ""} need attention`;
  } else if (items) {
    heading = "Attention list may be out of date";
  }
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>{heading}</Text>
      {shown.map((item) => (
        <View key={item.id} style={styles.row}>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {item.title}
          </Text>
          <Text style={styles.rowState}>
            {item.state} · {age(item.since, now)}
          </Text>
        </View>
      ))}
      {hidden > 0 ? <Text style={styles.detail}>and {hidden} more</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open monitor"
        onPress={() => openScreen({ screenId: MONITOR_SCREEN_ID, params: { bucket: "attention" } })}
        style={styles.action}
      >
        <Text style={styles.actionText}>Open monitor</Text>
      </Pressable>
    </View>
  );
}
