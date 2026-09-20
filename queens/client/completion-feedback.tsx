import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

export type CompletionFeedbackProps = {
  solved: boolean;
  color: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Adds a static, non-interactive solved-state illumination around existing content.
 * Keeping this to core View primitives makes the surface safe in every plugin runtime.
 */
export function CompletionFeedback({ solved, color, children, style }: CompletionFeedbackProps) {
  return (
    <View style={[styles.container, style]}>
      {children}
      {solved ? (
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.overlay}
        >
          <View style={[styles.tint, { backgroundColor: color }]} />
          <View style={[styles.outline, { borderColor: color }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 14,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 14,
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.055,
  },
  outline: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderRadius: 14,
    opacity: 0.34,
  },
});
