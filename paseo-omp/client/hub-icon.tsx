import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

// omp (oh-my-pi) uses the option/alt-key glyph "⌥" as its mark; there is no separate
// logo asset to bundle, so the pill renders the glyph directly at the host's icon size.
export function OmpIcon({ size, color }: PluginButtonIconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size * 0.85, lineHeight: size, color, fontWeight: "600" }}>⌥</Text>
    </View>
  );
}
