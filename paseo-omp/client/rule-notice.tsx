import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { OmpRuleNotice } from "../shared/rule-notices";

export function OmpRuleNoticeRow({ item, theme }: PluginTimelineItemProps<OmpRuleNotice>) {
  const color = theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 2, paddingVertical: 2 }}>
      {item.data.rules.map((rule) => (
        <View key={rule.name} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="ShieldAlert" size={14} color={color} />
          <Text style={{ color, fontSize: 13, flexShrink: 1 }} numberOfLines={2}>
            {rule.matched === null
              ? `OMP rule ${rule.name} fired`
              : `OMP rule ${rule.name} fired on “${rule.matched}”`}
          </Text>
        </View>
      ))}
    </View>
  );
}
