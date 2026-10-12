import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import {
  accessibilityValue,
  MAJOR_EVERY,
  needleDegrees,
  SWEEP,
  sparkHeights,
  TICKS,
  tickPercent,
} from "./dial";
import { levelColor, loadLevel, zoneColor } from "./format";

const TICK_ROWS = Array.from({ length: TICKS }, (_, index) => index);

interface DialProps {
  theme: PluginTheme;
  size: number;
  icon: string;
  label: string;
  /** 0-100, or null when the host cannot report it. */
  value: number | null;
  text: string;
}

/** A speedometer: green, amber and red zones light up to the value, and the needle sweeps there. */
export function Dial({ theme, size, icon, label, value, text }: DialProps) {
  const radius = size / 2;
  const needleLength = radius * 0.72;
  const degrees = useRef(new Animated.Value(needleDegrees(value))).current;
  useEffect(() => {
    const animation = Animated.timing(degrees, {
      toValue: needleDegrees(value),
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [degrees, value]);
  const rotate = degrees.interpolate({
    inputRange: [-SWEEP / 2, SWEEP / 2],
    outputRange: [`${-SWEEP / 2}deg`, `${SWEEP / 2}deg`],
  });

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${label} ${text}`}
      accessibilityValue={accessibilityValue(value)}
      style={{ width: size, height: size * 0.9 }}
    >
      {TICK_ROWS.map((index) => {
        const major = index % MAJOR_EVERY === 0;
        const length = major ? 15 : 9;
        const width = major ? 3 : 2;
        const percent = tickPercent(index);
        const lit = value !== null && percent <= value;
        return (
          <View
            key={index}
            style={{
              position: "absolute",
              left: radius - width / 2,
              top: radius - length / 2,
              width,
              height: length,
              borderRadius: width / 2,
              backgroundColor: lit ? zoneColor(theme, percent) : theme.colors.foregroundMuted,
              opacity: lit ? 1 : 0.2,
              transform: [
                { rotate: `${(percent / 100) * SWEEP - SWEEP / 2}deg` },
                { translateY: -(radius - 6 - length / 2) },
              ],
            }}
          />
        );
      })}
      <Animated.View
        style={{
          position: "absolute",
          left: radius - 1.5,
          top: radius - needleLength,
          width: 3,
          height: needleLength,
          borderRadius: 2,
          backgroundColor: value === null ? theme.colors.foregroundMuted : theme.colors.foreground,
          transform: [
            { translateY: needleLength / 2 },
            { rotate },
            { translateY: -needleLength / 2 },
          ],
        }}
      />
      <View
        style={{
          position: "absolute",
          left: radius - 8,
          top: radius - 8,
          width: 16,
          height: 16,
          borderRadius: 8,
          borderWidth: 3,
          borderColor: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
        }}
      />
      <View
        style={{ position: "absolute", left: 0, right: 0, top: radius + 18, alignItems: "center" }}
      >
        <Text
          style={{
            color:
              value === null || loadLevel(value) === "ok"
                ? theme.colors.foreground
                : levelColor(theme, value),
            fontSize: size * 0.19,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {text}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
          <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, letterSpacing: 0.6 }}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

interface SparklineProps {
  theme: PluginTheme;
  /** Oldest first; `scale` is the value that fills the bar. */
  values: readonly (number | null)[];
  scale: number;
  width: number;
  /** Bars always occupy `slots` positions, so a young history does not stretch. */
  slots: number;
  color: (value: number | null) => string;
}

/** A strip of bars for the last few minutes, so a spike is still visible after it passes. */
export function Sparkline({ theme, values, scale, width, slots, color }: SparklineProps) {
  const heights = sparkHeights(values, scale);
  const empty = Math.max(0, slots - values.length);
  return (
    <View
      style={{
        width,
        height: 28,
        flexDirection: "row",
        alignItems: "flex-end",
        gap: 2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      {Array.from({ length: slots }, (_, slot) => {
        const sample = slot - empty;
        // Slots are positional: samples are only ever appended and have no id.
        const key = slot;
        if (sample < 0) {
          return (
            <View key={key} style={{ flex: 1, height: 2, backgroundColor: theme.colors.border }} />
          );
        }
        return (
          <View
            key={key}
            style={{
              flex: 1,
              height: Math.max(2, (heights[sample] ?? 0) * 28),
              borderRadius: 1,
              backgroundColor: color(values[sample] ?? null),
              opacity: 0.35 + 0.65 * ((slot + 1) / slots),
            }}
          />
        );
      })}
    </View>
  );
}
