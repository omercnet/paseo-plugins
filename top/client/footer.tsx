import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { formatPercent, formatRate, type Level, levelColor, loadLevel } from "./format";
import { SCREEN_ID, useUsage } from "./usage";

const LEVEL_NAME: Record<Level, string> = { ok: "", warn: ", high", hot: ", critical" };

/** What a screen reader says: the reading in words, with the level spelled out, not just coloured. */
function metricLabel(name: string, text: string, level: Level): string {
  return text === "--" ? `${name} unavailable` : `${name} ${text}${LEVEL_NAME[level]}`;
}

export function TopFooter({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const usage = useUsage(host.id);
  const heavy = usage.data?.sessions?.filter((session) => session.heavy).length ?? 0;
  const metrics =
    usage.data &&
    ([
      ["Cpu", "CPU", formatPercent(usage.data.cpu), usage.data.cpu],
      ["MemoryStick", "Memory", formatPercent(usage.data.memory), usage.data.memory],
      ["HardDrive", "Disk", formatPercent(usage.data.disk), usage.data.disk],
      ["Gauge", "Disk I/O", formatRate(usage.data.io), null],
    ] as const);

  return (
    <SidebarRow
      icon="Activity"
      label={host.label}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {usage.isError && (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>unavailable</Text>
          )}
          {heavy > 0 && (
            <View
              accessible
              accessibilityLabel={`${heavy} heavy ${heavy === 1 ? "session" : "sessions"}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
            >
              <Icon name="Flame" size={11} color={theme.colors.statusDanger} />
              <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{heavy}</Text>
            </View>
          )}
          {metrics?.map(([icon, name, text, percent]) => {
            const color = levelColor(theme, percent);
            const level = loadLevel(percent);
            return (
              <View
                key={icon}
                accessible
                accessibilityLabel={metricLabel(name, text, level)}
                style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
              >
                <Icon name={icon} size={11} color={color} />
                <Text
                  numberOfLines={1}
                  style={{ color, fontSize: 11, fontVariant: ["tabular-nums"] }}
                >
                  {text}
                </Text>
              </View>
            );
          })}
        </View>
      }
    />
  );
}
