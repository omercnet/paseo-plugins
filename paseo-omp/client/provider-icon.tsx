import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ComponentType } from "react";
import { View } from "react-native";
import { type QuotaSeverity, quotaProviderIconName } from "./quota-state";

export function quotaProviderIcon(
  provider: string | null,
  severity: QuotaSeverity,
): ComponentType<PluginButtonIconProps> {
  function ProviderIcon({ size, color, theme }: PluginButtonIconProps) {
    const severityColor =
      severity === "danger"
        ? theme.colors.statusDanger
        : severity === "warning"
          ? theme.colors.statusWarning
          : severity === "ok"
            ? theme.colors.statusSuccess
            : color;
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Icon name={quotaProviderIconName(provider)} size={size} color={severityColor} />
      </View>
    );
  }
  return ProviderIcon;
}
