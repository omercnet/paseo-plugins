import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Image, Text, View } from "react-native";
import type { OmpImageTimelineData } from "../shared/provider-image";

export function OmpImageTimeline({ item, theme }: PluginTimelineItemProps<OmpImageTimelineData>) {
  const styles = useMemo(
    () => ({
      root: { gap: 8 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      text: { color: theme.colors.foreground, fontSize: 13 },
      image: {
        width: "100%" as const,
        minHeight: 220,
        aspectRatio: 16 / 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
    }),
    [theme],
  );
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{item.data.label}</Text>
      {item.data.text ? <Text style={styles.text}>{item.data.text}</Text> : null}
      {item.data.images.map((image, index) => (
        <Image
          key={image.id}
          source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
          resizeMode="contain"
          accessibilityLabel={`${item.data.label} image ${index + 1}`}
          style={styles.image}
        />
      ))}
    </View>
  );
}
