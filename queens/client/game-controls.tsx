import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

export type GameControlsProps = {
  canUndo: boolean;
  canHint: boolean;
  canReset: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  saving: boolean;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
  dense?: boolean;
  showNavigation?: boolean;
  showSavingStatus?: boolean;
  onUndo(): void;
  onHint(): void;
  onReset(): void;
  onPrevious(): void;
  onNext(): void;
};

export function GameControls({
  canUndo,
  canHint,
  canReset,
  canGoPrevious,
  canGoNext,
  saving,
  disabled,
  dense = false,
  theme,
  showNavigation = true,
  showSavingStatus = true,
  onUndo,
  onHint,
  onReset,
  onPrevious,
  onNext,
}: GameControlsProps) {
  const styles = useMemo(() => createStyles(theme, dense), [dense, theme]);
  const controls = [
    {
      key: "previous",
      label: "Previous",
      accessibilityLabel: "Go to previous puzzle",
      available: canGoPrevious,
      onPress: onPrevious,
    },
    {
      key: "undo",
      label: "Undo",
      accessibilityLabel: "Undo last move",
      available: canUndo,
      onPress: onUndo,
    },
    {
      key: "hint",
      label: "Hint",
      accessibilityLabel: "Show a hint",
      available: canHint,
      onPress: onHint,
    },
    {
      key: "reset",
      label: "Reset",
      accessibilityLabel: "Reset puzzle",
      available: canReset,
      onPress: onReset,
    },
    {
      key: "next",
      label: "Next",
      accessibilityLabel: "Go to next puzzle",
      available: canGoNext,
      onPress: onNext,
    },
  ] as const;

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        {controls
          .filter(
            (control) => showNavigation || (control.key !== "previous" && control.key !== "next"),
          )
          .map((control) => {
            const controlDisabled = disabled || !control.available;

            return (
              <Pressable
                key={control.key}
                accessibilityRole="button"
                accessibilityLabel={control.accessibilityLabel}
                accessibilityState={{ disabled: controlDisabled }}
                disabled={controlDisabled}
                hitSlop={2}
                onPress={control.onPress}
                style={({ pressed }) => [
                  styles.control,
                  pressed && !controlDisabled && styles.controlPressed,
                ]}
              >
                <Text style={[styles.controlText, controlDisabled && styles.controlTextDisabled]}>
                  {control.label}
                </Text>
              </Pressable>
            );
          })}
      </View>
      {showSavingStatus ? (
        <View style={styles.savingSlot}>
          {saving ? (
            <View
              accessibilityLiveRegion="polite"
              accessibilityRole="progressbar"
              accessibilityLabel="Saving game progress"
              accessibilityState={{ busy: true }}
              accessibilityValue={{ text: "Saving" }}
              style={styles.savingStatus}
            >
              <ActivityIndicator size="small" color={theme.colors.accent} />
              <Text style={styles.savingText}>Saving…</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"], dense: boolean) {
  return StyleSheet.create({
    container: {
      width: "100%",
      alignItems: "center",
      gap: 8,
    },
    controls: {
      width: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "stretch",
      justifyContent: "center",
      gap: 8,
    },
    control: {
      minWidth: dense ? 68 : 94,
      maxWidth: dense ? 96 : 132,
      minHeight: 44,
      flexGrow: 1,
      flexBasis: dense ? 68 : 94,
      flexShrink: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 9,
      backgroundColor: theme.colors.surface2,
    },
    controlPressed: {
      opacity: 0.7,
      transform: [{ scale: 0.98 }],
    },
    controlText: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "600",
    },
    controlTextDisabled: {
      color: theme.colors.foregroundMuted,
    },
    savingSlot: {
      minHeight: 24,
      alignItems: "center",
      justifyContent: "center",
    },
    savingStatus: {
      minHeight: 24,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 10,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
    },
    savingText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600",
    },
  });
}
