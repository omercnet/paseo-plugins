import { Text, View } from "react-native";

export type GameMarkProps = {
  size: number;
  color: string;
  conflicted?: boolean;
};

export function GameMark({ size, color, conflicted = false }: GameMarkProps) {
  const visualOffset = -Math.max(1, Math.round(size * 0.1));
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        accessible={false}
        importantForAccessibility="no"
        style={{
          width: size,
          height: size,
          color,
          fontSize: size,
          lineHeight: size,
          fontWeight: "700",
          includeFontPadding: false,
          textAlign: "center",
          textAlignVertical: "center",
          transform: [{ translateY: visualOffset }],
        }}
      >
        ♛
      </Text>
      {conflicted ? (
        <View
          style={{
            position: "absolute",
            width: size * 0.9,
            height: Math.max(2, size * 0.08),
            borderRadius: size,
            backgroundColor: color,
            transform: [{ translateY: visualOffset }, { rotate: "-45deg" }],
          }}
        />
      ) : null}
    </View>
  );
}
