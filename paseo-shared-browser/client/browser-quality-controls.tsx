/** Independent viewer compression/rate choices. These settings never resize or
 * navigate the shared page; pixel density remains its existing owner control. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BrowserDisplayPreferences } from "../shared/browser-display-preferences";
import type { CaptureDensity } from "../shared/capture-density";
import { JPEG_QUALITY } from "../shared/capture-settings";
import { VIDEO_BITRATES, VIDEO_FRAME_RATES } from "../shared/video-settings";
import { BrowserCaptureDensityControls } from "./browser-capture-density-controls";

const styles = StyleSheet.create({
  group: { gap: 8 },
  heading: { fontSize: 11, fontWeight: "600" },
  choice: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: { flex: 1, fontSize: 13, fontWeight: "600" },
  detail: { fontSize: 11 },
});
interface Props {
  theme: PluginHostProps["theme"];
  disabled: boolean;
  density: number;
  viewport: { width: number; height: number } | null;
  densityDisabled: boolean;
  onDensityChange(value: CaptureDensity): void;
  captureQuality: BrowserDisplayPreferences["captureQuality"];
  videoBitrate: BrowserDisplayPreferences["videoBitrate"];
  videoFps: BrowserDisplayPreferences["videoFps"];
  onQualityChange(value: Props["captureQuality"]): void;
  onVideoBitrateChange(value: Props["videoBitrate"]): void;
  onVideoFpsChange(value: Props["videoFps"]): void;
}
function Choices<T extends string | number>(props: {
  theme: Props["theme"];
  disabled: boolean;
  title: string;
  value: T;
  options: readonly { value: T; label: string; detail?: string }[];
  onChange(value: T): void;
}) {
  const colors = props.theme.colors;
  return (
    <View style={styles.group}>
      <Text style={[styles.heading, { color: colors.foregroundMuted }]}>{props.title}</Text>
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={`${props.title}: ${option.label}`}
            accessibilityState={{ selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange(option.value)}
            style={({ pressed }) => [
              styles.choice,
              {
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: selected ? colors.surface2 : colors.surface1,
                opacity: props.disabled ? 0.45 : pressed ? 0.72 : 1,
              },
            ]}
          >
            <Text style={[styles.label, { color: colors.foreground }]}>{option.label}</Text>
            {option.detail ? (
              <Text style={[styles.detail, { color: colors.foregroundMuted }]}>
                {option.detail}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
/** Explicit values describe the actual JPEG encoder and independently bounded video cohorts. */
export function BrowserQualityControls(props: Props) {
  const jpeg = (["low", "medium", "high", "maximum"] as const).map((value) => ({
    value,
    label: `${JPEG_QUALITY[value]}%`,
    ...(value === "maximum"
      ? { detail: "Largest JPEGs" }
      : value === "high"
        ? { detail: "Default" }
        : {}),
  }));
  return (
    <View style={{ gap: 12 }}>
      <BrowserCaptureDensityControls
        theme={props.theme}
        density={props.density}
        viewport={props.viewport}
        disabled={props.densityDisabled}
        onChange={props.onDensityChange}
      />
      <Choices
        theme={props.theme}
        disabled={props.disabled}
        title="JPEG quality target"
        value={props.captureQuality}
        options={jpeg}
        onChange={props.onQualityChange}
      />
      <Choices
        theme={props.theme}
        disabled={props.disabled}
        title="Video bitrate"
        value={props.videoBitrate}
        options={VIDEO_BITRATES.map((value) => ({ value, label: `${value / 1_000_000} Mbps` }))}
        onChange={props.onVideoBitrateChange}
      />
      <Choices
        theme={props.theme}
        disabled={props.disabled}
        title="Video frame rate"
        value={props.videoFps}
        options={VIDEO_FRAME_RATES.map((value) => ({ value, label: `${value} FPS` }))}
        onChange={props.onVideoFpsChange}
      />
      <Text style={[styles.detail, { color: props.theme.colors.foregroundMuted }]}>
        Large JPEGs may reduce quality to fit the frame limit. Video settings apply where supported.
        Other clients use JPEGs. Capture density changes detail without resizing the page.
      </Text>
    </View>
  );
}
