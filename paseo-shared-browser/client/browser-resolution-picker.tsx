/** Grouped resolution choices with independent host favorites and capture quality. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BrowserDisplayPreferences } from "../shared/browser-display-preferences";
import type { DevicePresetId } from "../shared/device-presets";
import type { ResolutionGroup } from "../shared/resolution-menu";
import { FavoriteStar } from "./favorite-star";

export interface BrowserResolutionPickerProps {
  theme: PluginHostProps["theme"];
  groups: readonly ResolutionGroup[];
  selectedPresetId: DevicePresetId | null;
  favoritePresetIds: readonly DevicePresetId[];
  selectDisabled: boolean;
  favoriteDisabled: boolean;
  captureQuality: BrowserDisplayPreferences["captureQuality"];
  onSelect(id: DevicePresetId): void;
  onToggleFavorite(id: DevicePresetId): void;
  onQualityChange(quality: BrowserDisplayPreferences["captureQuality"]): void;
}

const STYLES = StyleSheet.create({
  group: { gap: 8 },
  header: { fontSize: 11, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  choice: {
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  title: { flex: 1, fontSize: 13, fontWeight: "600" },
  detail: { fontSize: 11 },
  star: {
    width: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  quality: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});
const QUALITY_OPTIONS = [
  { id: "low", label: "Low", detail: "Smaller images, less detail" },
  { id: "medium", label: "Medium", detail: "Balanced detail and image size" },
  { id: "high", label: "High", detail: "Sharper images, more data" },
] as const;

/** Keeps star presses outside the resolution button; favoriting never resizes the browser. */
export function BrowserResolutionPicker(props: BrowserResolutionPickerProps) {
  const { theme } = props;
  const colors = theme.colors;
  const selectedStyle = {
    borderColor: colors.accent,
    backgroundColor: colors.surface2,
  };
  const baseStyle = {
    borderColor: colors.border,
    backgroundColor: colors.surface1,
  };
  return (
    <View style={{ gap: 12 }}>
      {props.groups.map((group) => (
        <View key={group.id} style={STYLES.group}>
          <Text style={[STYLES.header, { color: colors.foregroundMuted }]}>{group.label}</Text>
          {group.presets.map((preset) => {
            const selected = preset.id === props.selectedPresetId;
            const favorite = props.favoritePresetIds.includes(preset.id);
            return (
              <View key={preset.id} style={STYLES.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Emulate ${preset.label}`}
                  accessibilityState={{
                    selected,
                    disabled: props.selectDisabled,
                  }}
                  disabled={props.selectDisabled}
                  onPress={() => props.onSelect(preset.id)}
                  style={({ pressed }) => [
                    STYLES.choice,
                    baseStyle,
                    selected ? selectedStyle : null,
                    {
                      opacity: props.selectDisabled ? 0.45 : pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <Icon
                    name={preset.isMobile ? "Smartphone" : "Monitor"}
                    size={18}
                    color={selected ? colors.accent : colors.foregroundMuted}
                  />
                  <Text style={[STYLES.title, { color: colors.foreground }]}>{preset.label}</Text>
                  <Text style={[STYLES.detail, { color: colors.foregroundMuted }]}>
                    {preset.viewport.width} × {preset.viewport.height}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${favorite ? "Remove" : "Add"} ${preset.label} ${favorite ? "from" : "to"} favorites`}
                  accessibilityState={{
                    selected: favorite,
                    disabled: props.favoriteDisabled,
                  }}
                  disabled={props.favoriteDisabled}
                  onPress={() => props.onToggleFavorite(preset.id)}
                  style={({ pressed }) => [
                    STYLES.star,
                    {
                      backgroundColor: "transparent",
                      opacity: props.favoriteDisabled ? 0.45 : pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <FavoriteStar
                    filled={favorite}
                    size={20}
                    color={favorite ? colors.accent : colors.foregroundMuted}
                  />
                </Pressable>
              </View>
            );
          })}
        </View>
      ))}
      <View style={STYLES.group}>
        <Text style={[STYLES.header, { color: colors.foregroundMuted }]}>Image quality</Text>
        {QUALITY_OPTIONS.map((option) => {
          const selected = option.id === props.captureQuality;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={`${option.label} image quality`}
              accessibilityState={{
                selected,
                disabled: props.favoriteDisabled,
              }}
              disabled={props.favoriteDisabled}
              onPress={() => props.onQualityChange(option.id)}
              style={({ pressed }) => [
                STYLES.quality,
                baseStyle,
                selected ? selectedStyle : null,
                { opacity: props.favoriteDisabled ? 0.45 : pressed ? 0.72 : 1 },
              ]}
            >
              <Text style={[STYLES.title, { color: colors.foreground }]}>{option.label}</Text>
              <Text style={[STYLES.detail, { color: colors.foregroundMuted }]}>
                {option.detail}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
