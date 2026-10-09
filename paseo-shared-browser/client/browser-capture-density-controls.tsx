/** Controller-only physical capture density, independent of CSS resolution and emulation. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { type CaptureDensity, canUseCaptureDensity } from "../shared/browser";

interface Props {
  theme: PluginHostProps["theme"];
  density: number;
  viewport: { width: number; height: number } | null;
  disabled: boolean;
  onChange(value: CaptureDensity): void;
}
const styles = StyleSheet.create({
  group: { gap: 8 },
  heading: { fontSize: 11, fontWeight: "600" },
  choice: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 8 },
  label: { fontSize: 13, fontWeight: "600" },
  detail: { fontSize: 11 },
});

/** Selection reflects actual state, including a preset whose density was changed independently. */
export function BrowserCaptureDensityControls(props: Props) {
  const colors = props.theme.colors;
  return (
    <View style={styles.group}>
      <Text style={[styles.heading, { color: colors.foregroundMuted }]}>Capture density</Text>
      {([1, 2] as const).map((density) => {
        const supported = props.viewport !== null && canUseCaptureDensity(props.viewport, density);
        const disabled = props.disabled || !supported;
        const selected = props.density === density;
        return (
          <Pressable
            key={density}
            accessibilityRole="button"
            accessibilityLabel={`Capture density: ${density}×`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              if (!disabled) props.onChange(density);
            }}
            style={({ pressed }) => [
              styles.choice,
              {
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: selected ? colors.surface2 : colors.surface1,
                opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
              },
            ]}
          >
            <Text style={[styles.label, { color: colors.foreground }]}>{density}×</Text>
          </Pressable>
        );
      })}
      {props.viewport && !canUseCaptureDensity(props.viewport, 2) ? (
        <Text style={[styles.detail, { color: colors.foregroundMuted }]}>
          2× requires a page width and height of 1280 or less.
        </Text>
      ) : null}
    </View>
  );
}
