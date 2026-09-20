import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, type TextStyle, View, type ViewStyle } from "react-native";
import { PUZZLE_DIFFICULTIES, PUZZLE_SIZES, type PuzzleDifficulty } from "../shared/puzzle-catalog";

export type PuzzleSelectorProps = {
  readonly size: number;
  readonly difficulty: PuzzleDifficulty;
  readonly disabled: boolean;
  readonly compact: boolean;
  readonly theme: PluginSurfaceProps["theme"];
  readonly onChange: (size: number, difficulty: PuzzleDifficulty) => void;
};

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function PuzzleSelector({
  size,
  difficulty,
  disabled,
  compact,
  theme,
  onChange,
}: PuzzleSelectorProps) {
  const styles = useMemo(() => createStyles(theme, compact), [compact, theme]);
  const sizeIndex = Math.max(0, PUZZLE_SIZES.indexOf(size as (typeof PUZZLE_SIZES)[number]));
  const difficultyIndex = Math.max(0, PUZZLE_DIFFICULTIES.indexOf(difficulty));

  const changeSize = (offset: number) => {
    const nextIndex = (sizeIndex + offset + PUZZLE_SIZES.length) % PUZZLE_SIZES.length;
    onChange(PUZZLE_SIZES[nextIndex], difficulty);
  };
  const changeDifficulty = (offset: number) => {
    const nextIndex =
      (difficultyIndex + offset + PUZZLE_DIFFICULTIES.length) % PUZZLE_DIFFICULTIES.length;
    onChange(size, PUZZLE_DIFFICULTIES[nextIndex]);
  };

  return (
    <View style={styles.container}>
      <SelectorStep
        label="Board size"
        value={`${size}×${size}`}
        disabled={disabled}
        styles={styles}
        onPrevious={() => changeSize(-1)}
        onNext={() => changeSize(1)}
      />
      <SelectorStep
        label="Difficulty"
        value={titleCase(difficulty)}
        disabled={disabled}
        styles={styles}
        onPrevious={() => changeDifficulty(-1)}
        onNext={() => changeDifficulty(1)}
      />
    </View>
  );
}

type SelectorStyles = {
  readonly container: ViewStyle;
  readonly step: ViewStyle;
  readonly arrow: ViewStyle;
  readonly arrowText: TextStyle;
  readonly valueBlock: ViewStyle;
  readonly label: TextStyle;
  readonly value: TextStyle;
  readonly disabled: ViewStyle;
  readonly pressed: ViewStyle;
};

function SelectorStep({
  label,
  value,
  disabled,
  styles,
  onPrevious,
  onNext,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly styles: SelectorStyles;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={`${label}, ${value}`}
      style={styles.step}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Previous ${label.toLowerCase()}`}
        disabled={disabled}
        onPress={onPrevious}
        style={({ pressed }) => [
          styles.arrow,
          disabled && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.arrowText}>‹</Text>
      </Pressable>
      <View style={styles.valueBlock}>
        <Text style={styles.label}>{label.toUpperCase()}</Text>
        <Text style={styles.value}>{value}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Next ${label.toLowerCase()}`}
        disabled={disabled}
        onPress={onNext}
        style={({ pressed }) => [
          styles.arrow,
          disabled && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.arrowText}>›</Text>
      </Pressable>
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean): SelectorStyles {
  return StyleSheet.create({
    container: {
      width: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: compact ? 8 : 12,
    },
    step: {
      minWidth: compact ? 136 : 152,
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      overflow: "hidden",
    },
    arrow: {
      width: 40,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    arrowText: {
      color: theme.colors.foreground,
      fontSize: 24,
      lineHeight: 28,
      fontWeight: "500",
    },
    valueBlock: {
      minWidth: compact ? 56 : 68,
      flex: 1,
      alignItems: "center",
      gap: 1,
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontSize: 8,
      fontWeight: "700",
      letterSpacing: 0.8,
    },
    value: {
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 13,
      fontWeight: "800",
    },
    disabled: {
      opacity: 0.4,
    },
    pressed: {
      backgroundColor: theme.colors.surface2,
    },
  });
}
