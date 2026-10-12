import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { HISTORY_EVERY_MS, HISTORY_LENGTH, type Sample } from "../shared/usage";
import { formatPercent, formatRate, zoneColor } from "./format";
import { Dial, Sparkline } from "./gauge";
import { Sessions } from "./sessions";
import { useUsage } from "./usage";

const DIALS = [
  { label: "CPU", icon: "Cpu", pick: (usage: Sample) => usage.cpu },
  { label: "MEMORY", icon: "MemoryStick", pick: (usage: Sample) => usage.memory },
  { label: "DISK", icon: "HardDrive", pick: (usage: Sample) => usage.disk },
] as const;

function Card({
  theme,
  width,
  children,
}: {
  theme: PluginTheme;
  width: number;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        width,
        alignItems: "center",
        gap: 12,
        padding: 16,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

/** The screen header carries Paseo's host picker; the footer follows the host picked here. */
export function TopScreen({ theme, layout, host, navigation }: PluginScreenProps) {
  const usage = useUsage(host.id);
  const history = usage.data?.history ?? [];
  const dial = layout.compact ? 156 : 200;
  const inner = dial;
  const io = history.map((sample) => sample.io);
  // The live reading is fresher than the newest history point, so it counts toward the peak too.
  const peak = [...io, usage.data?.io ?? null].reduce<number | null>(
    (max, value) => (value === null ? max : Math.max(max ?? 0, value)),
    null,
  );
  // The floor only keeps a near-idle disk from filling the bars; the label shows the real peak.
  const scale = Math.max(1_000_000, peak ?? 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="Activity" size={22} color={theme.colors.foreground} />
        <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 26 }}>
          {host.label}
        </Text>
        <View
          accessible
          accessibilityLabel={
            usage.isError ? "Usage unavailable" : usage.data ? "Usage live" : "Usage loading"
          }
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: usage.isError ? theme.colors.statusDanger : theme.colors.statusSuccess,
          }}
        />
      </View>
      {usage.isError && (
        <Text style={{ color: theme.colors.statusDanger }}>
          Usage is unavailable. Check that the top plugin is running on this host.
        </Text>
      )}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 16,
          justifyContent: layout.compact ? "center" : "flex-start",
        }}
      >
        {DIALS.map(({ label, icon, pick }) => {
          const value = usage.data ? pick(usage.data) : null;
          return (
            <Card key={label} theme={theme} width={dial + 32}>
              <Dial
                theme={theme}
                size={dial}
                icon={icon}
                label={label}
                value={value}
                text={formatPercent(value)}
              />
              <Sparkline
                theme={theme}
                values={history.map(pick)}
                scale={100}
                width={inner}
                slots={HISTORY_LENGTH}
                color={(sample) =>
                  sample === null ? theme.colors.foregroundMuted : zoneColor(theme, sample)
                }
              />
            </Card>
          );
        })}
        <Card theme={theme} width={dial + 32}>
          <View style={{ height: dial * 0.9, width: dial, justifyContent: "center", gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="Gauge" size={14} color={theme.colors.foregroundMuted} />
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 12, letterSpacing: 0.6 }}
              >
                DISK I/O
              </Text>
            </View>
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: dial * 0.2,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatRate(usage.data?.io ?? null)}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {`peak ${formatRate(peak)}`}
            </Text>
          </View>
          <Sparkline
            theme={theme}
            values={io}
            scale={scale}
            width={inner}
            slots={HISTORY_LENGTH}
            color={() => theme.colors.accent}
          />
        </Card>
      </View>
      {usage.data && (
        <Sessions
          theme={theme}
          sessions={usage.data.sessions}
          other={usage.data.other}
          onOpenAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
        />
      )}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Updates every 5 seconds. Bars cover the last {(HISTORY_LENGTH * HISTORY_EVERY_MS) / 60_000}{" "}
        minutes.
      </Text>
    </ScrollView>
  );
}
