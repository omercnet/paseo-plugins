import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { CellState, Puzzle } from "./game";
import { GameMark } from "./game-mark";

const CELL_STATE_LABEL: Record<CellState, string> = {
  empty: "empty",
  excluded: "excluded",
  marked: "queen marked",
};

const CELL_ACTION_HINT: Record<CellState, string> = {
  empty: "Tap once to mark this square excluded. Double tap to place a queen.",
  excluded: "Tap once to clear this X. Double tap to place a queen.",
  marked: "Tap once to replace this queen with an X. Double tap to clear the queen.",
};

const DOUBLE_TAP_DELAY_MS = 300;

type BoardLayout = {
  readonly width: number;
  readonly height: number;
};

type DragReplacement = "empty" | "excluded";

type DragSelection = {
  readonly indexes: ReadonlySet<number>;
  readonly replacement: DragReplacement;
};

type DragGesture = {
  readonly startIndex: number;
  indexes: Set<number>;
  replacement: DragReplacement;
  moved: boolean;
  cancelled: boolean;
};

export function resolveDraggedCellState(
  index: number,
  persistedState: CellState,
  dragSelection: DragSelection | null,
): CellState {
  if (persistedState === "marked" || dragSelection === null || !dragSelection.indexes.has(index)) {
    return persistedState;
  }

  if (dragSelection.replacement === "empty") {
    return persistedState === "excluded" ? "empty" : persistedState;
  }

  return persistedState === "empty" ? "excluded" : persistedState;
}

export function collectDragIndexes(
  cells: readonly CellState[],
  selection: DragSelection,
): number[] {
  return [...selection.indexes].filter((index) => {
    const persistedState = cells[index] ?? "empty";
    return resolveDraggedCellState(index, persistedState, selection) !== persistedState;
  });
}

type PendingTap = {
  readonly releasedAt: number;
  cancel(): void;
};

function cellIndexAtLocation(
  event: GestureResponderEvent,
  size: number,
  layout: BoardLayout,
): number | null {
  if (layout.width <= 0 || layout.height <= 0) return null;

  const { locationX, locationY } = event.nativeEvent;
  if (locationX < 0 || locationY < 0 || locationX >= layout.width || locationY >= layout.height) {
    return null;
  }

  const column = Math.min(size - 1, Math.floor((locationX / layout.width) * size));
  const row = Math.min(size - 1, Math.floor((locationY / layout.height) * size));
  return row * size + column;
}

type Rgb = readonly [red: number, green: number, blue: number];

function parseHexColor(color: string): Rgb | null {
  const value = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(value)?.[1];
  if (short) {
    return [
      Number.parseInt(`${short[0]}${short[0]}`, 16),
      Number.parseInt(`${short[1]}${short[1]}`, 16),
      Number.parseInt(`${short[2]}${short[2]}`, 16),
    ];
  }

  const full = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value)?.[1];
  if (!full) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function mixColor(base: string, tint: string, tintWeight: number): string {
  const baseRgb = parseHexColor(base);
  const tintRgb = parseHexColor(tint);
  if (!baseRgb || !tintRgb) return tint;

  const baseWeight = 1 - tintWeight;
  const red = Math.round(baseRgb[0] * baseWeight + tintRgb[0] * tintWeight);
  const green = Math.round(baseRgb[1] * baseWeight + tintRgb[1] * tintWeight);
  const blue = Math.round(baseRgb[2] * baseWeight + tintRgb[2] * tintWeight);
  return `rgb(${red}, ${green}, ${blue})`;
}

function createRegionFills(theme: PluginSurfaceProps["theme"], count: number): readonly string[] {
  const { colors } = theme;
  const accent = parseHexColor(colors.accent);
  if (!accent) {
    return [
      colors.accent,
      colors.statusSuccess,
      colors.statusWarning,
      colors.statusDanger,
      colors.foregroundMuted,
      colors.surface2,
    ];
  }

  const red = accent[0] / 255;
  const green = accent[1] / 255;
  const blue = accent[2] / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let accentHue = 0;
  if (delta > 0 && maximum === red) accentHue = 60 * (((green - blue) / delta) % 6);
  if (delta > 0 && maximum === green) accentHue = 60 * ((blue - red) / delta + 2);
  if (delta > 0 && maximum === blue) accentHue = 60 * ((red - green) / delta + 4);
  if (accentHue < 0) accentHue += 360;

  const regionColors = Array.from({ length: count }, (_, region) => {
    const hue = (accentHue + (region * 360) / count) % 360;
    const chroma = 0.82 * 0.72;
    const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const offset = 0.82 - chroma;
    let spectrum: Rgb;
    if (hue < 60) spectrum = [chroma, secondary, 0];
    else if (hue < 120) spectrum = [secondary, chroma, 0];
    else if (hue < 180) spectrum = [0, chroma, secondary];
    else if (hue < 240) spectrum = [0, secondary, chroma];
    else if (hue < 300) spectrum = [secondary, 0, chroma];
    else spectrum = [chroma, 0, secondary];

    const spectrumRed = Math.round((spectrum[0] + offset) * 255)
      .toString(16)
      .padStart(2, "0");
    const spectrumGreen = Math.round((spectrum[1] + offset) * 255)
      .toString(16)
      .padStart(2, "0");
    const spectrumBlue = Math.round((spectrum[2] + offset) * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${spectrumRed}${spectrumGreen}${spectrumBlue}`;
  });

  return regionColors.map((color) => mixColor(colors.surface1, color, 0.34));
}

export type QueensBoardProps = {
  dragEnabled?: boolean;
  maxSize?: number;
  puzzle: Puzzle;
  cells: readonly CellState[];
  conflicts: ReadonlySet<number>;
  solved: boolean;
  disabled: boolean;
  compact: boolean;
  theme: PluginSurfaceProps["theme"];
  onSetCells(indexes: readonly number[], state: CellState): void;
  onGestureActiveChange(active: boolean): void;
};

export function QueensBoard({
  dragEnabled = true,
  maxSize,
  puzzle,
  cells,
  conflicts,
  solved,
  disabled,
  compact,
  theme,
  onSetCells,
  onGestureActiveChange,
}: QueensBoardProps) {
  const nominalBoardSize = maxSize ?? (compact ? 360 : 440);
  const cellSize = nominalBoardSize / puzzle.size;
  const markSize = Math.max(9, Math.min(compact ? 26 : 32, Math.floor(cellSize * 0.64)));
  const styles = useMemo(
    () => createStyles(theme, compact, puzzle.size, maxSize),
    [compact, maxSize, puzzle.size, theme],
  );
  const coordinates = useMemo(
    () => Array.from({ length: puzzle.size }, (_, coordinate) => coordinate),
    [puzzle.size],
  );
  const regionFills = useMemo(() => createRegionFills(theme, puzzle.size), [puzzle.size, theme]);
  const layoutRef = useRef<BoardLayout>({ width: 0, height: 0 });
  const gestureRef = useRef<DragGesture | null>(null);
  const pendingTapsRef = useRef(new Map<number, PendingTap>());
  const cellsRef = useRef(cells);
  const onSetCellsRef = useRef(onSetCells);
  const onGestureActiveChangeRef = useRef(onGestureActiveChange);
  const [dragPreview, setDragPreview] = useState<DragSelection | null>(null);
  cellsRef.current = cells;
  onSetCellsRef.current = onSetCells;
  onGestureActiveChangeRef.current = onGestureActiveChange;

  useEffect(() => {
    const pendingTaps = pendingTapsRef.current;
    return () => {
      for (const pending of pendingTaps.values()) pending.cancel();
      pendingTaps.clear();
      gestureRef.current = null;
      onGestureActiveChangeRef.current(false);
    };
  }, []);

  const handleBoardLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    layoutRef.current = { width, height };
  }, []);

  const toggleExcluded = useCallback((index: number) => {
    const state = cellsRef.current[index];
    onSetCellsRef.current([index], state === "excluded" ? "empty" : "excluded");
  }, []);

  const toggleQueen = useCallback((index: number) => {
    const state = cellsRef.current[index];
    onSetCellsRef.current([index], state === "marked" ? "empty" : "marked");
  }, []);

  const handleTapRelease = useCallback(
    (index: number) => {
      const releasedAt = Date.now();
      const pending = pendingTapsRef.current.get(index);
      if (pending && releasedAt - pending.releasedAt <= DOUBLE_TAP_DELAY_MS) {
        pending.cancel();
        pendingTapsRef.current.delete(index);
        toggleQueen(index);
        return;
      }

      const timeout = setTimeout(() => {
        pendingTapsRef.current.delete(index);
        toggleExcluded(index);
      }, DOUBLE_TAP_DELAY_MS);
      pendingTapsRef.current.set(index, {
        releasedAt,
        cancel() {
          clearTimeout(timeout);
        },
      });
    },
    [toggleExcluded, toggleQueen],
  );

  const handleResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const index = cellIndexAtLocation(event, puzzle.size, layoutRef.current);
      if (index === null) return;
      gestureRef.current = {
        startIndex: index,
        indexes: new Set([index]),
        replacement: cellsRef.current[index] === "excluded" ? "empty" : "excluded",
        moved: false,
        cancelled: false,
      };
      onGestureActiveChangeRef.current(true);
    },
    [puzzle.size],
  );

  const handleResponderMove = useCallback(
    (event: GestureResponderEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const gesture = gestureRef.current;
      const index = cellIndexAtLocation(event, puzzle.size, layoutRef.current);
      if (!gesture || index === null || gesture.indexes.has(index)) return;
      if (!dragEnabled) {
        if (index !== gesture.startIndex) gesture.cancelled = true;
        return;
      }

      gesture.indexes.add(index);
      if (index !== gesture.startIndex) gesture.moved = true;
      setDragPreview({ indexes: new Set(gesture.indexes), replacement: gesture.replacement });
    },
    [dragEnabled, puzzle.size],
  );

  const finishGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragPreview(null);
    onGestureActiveChangeRef.current(false);
    if (!gesture) return;

    if (gesture.cancelled) return;
    if (!gesture.moved) {
      handleTapRelease(gesture.startIndex);
      return;
    }

    for (const index of gesture.indexes) {
      const pending = pendingTapsRef.current.get(index);
      pending?.cancel();
      pendingTapsRef.current.delete(index);
    }

    const indexes = collectDragIndexes(cellsRef.current, gesture);
    if (indexes.length > 0) onSetCellsRef.current(indexes, gesture.replacement);
  }, [handleTapRelease]);

  const cancelGesture = useCallback(() => {
    gestureRef.current = null;
    setDragPreview(null);
    onGestureActiveChangeRef.current(false);
  }, []);

  return (
    <View style={[styles.boardFrame, maxSize === undefined ? null : { maxWidth: maxSize }]}>
      <View style={styles.boardGrid}>
        {coordinates.map((row) => (
          <View key={`${puzzle.id}:row:${row}`} style={styles.boardRow}>
            {coordinates.map((column) => {
              const index = row * puzzle.size + column;
              const persistedState = cells[index] ?? "empty";
              const region = puzzle.regions[index] ?? 0;
              const state = resolveDraggedCellState(index, persistedState, dragPreview);
              const conflicted = conflicts.has(index);
              const markColor = solved
                ? theme.colors.statusSuccess
                : conflicted
                  ? theme.colors.statusDanger
                  : theme.colors.foreground;
              const accessibilityLabel = [
                `Row ${row + 1}`,
                `column ${column + 1}`,
                `region ${region + 1}`,
                `state ${CELL_STATE_LABEL[state]}`,
                conflicted ? "conflict" : "no conflict",
                solved ? "puzzle solved" : undefined,
              ]
                .filter(Boolean)
                .join(", ");

              return (
                <Pressable
                  key={`${puzzle.id}:cell:${row}:${column}:region:${region}`}
                  accessibilityRole="button"
                  accessibilityLabel={accessibilityLabel}
                  accessibilityHint={disabled ? undefined : CELL_ACTION_HINT[state]}
                  accessibilityState={{
                    disabled,
                    selected: state === "marked",
                  }}
                  delayLongPress={DOUBLE_TAP_DELAY_MS}
                  disabled={disabled}
                  onLongPress={() => toggleQueen(index)}
                  onPress={() => toggleExcluded(index)}
                  style={({ pressed }) => [
                    styles.cell,
                    {
                      backgroundColor:
                        regionFills[Math.abs(region) % regionFills.length] ?? theme.colors.surface1,
                    },
                    disabled && !solved && styles.disabledCell,
                    pressed && !disabled && styles.pressedCell,
                  ]}
                >
                  {state === "marked" ? (
                    <GameMark size={markSize} color={markColor} conflicted={conflicted} />
                  ) : state === "excluded" ? (
                    <Text
                      accessible={false}
                      importantForAccessibility="no"
                      style={styles.excludedMark}
                    >
                      ×
                    </Text>
                  ) : null}
                  {conflicted ? (
                    <Text
                      accessible={false}
                      importantForAccessibility="no"
                      style={styles.conflictIndicator}
                    >
                      !
                    </Text>
                  ) : null}
                  {conflicted ? (
                    <>
                      <View
                        accessible={false}
                        importantForAccessibility="no"
                        pointerEvents="none"
                        style={styles.conflictTint}
                      />
                      <View
                        accessible={false}
                        importantForAccessibility="no"
                        pointerEvents="none"
                        style={styles.conflictBorder}
                      />
                    </>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}

        {/* Region boundaries are drawn once, centered on the grid lines, above every cell so
            adjacent segments overlap at joins instead of leaving one-sided notches. */}
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={styles.boundaryLayer}
        >
          {coordinates.map((row) => (
            <View key={`${puzzle.id}:boundary-row:${row}`} style={styles.boardRow}>
              {coordinates.map((column) => {
                const index = row * puzzle.size + column;
                const region = puzzle.regions[index] ?? 0;
                const aboveRegion = row > 0 ? puzzle.regions[index - puzzle.size] : region;
                const leftRegion = column > 0 ? puzzle.regions[index - 1] : region;

                return (
                  <View key={`${puzzle.id}:boundary:${row}:${column}`} style={styles.boundaryCell}>
                    {aboveRegion !== region ? <View style={styles.boundaryTop} /> : null}
                    {leftRegion !== region ? <View style={styles.boundaryLeft} /> : null}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          onLayout={handleBoardLayout}
          onMoveShouldSetResponder={() => !disabled}
          onMoveShouldSetResponderCapture={() => !disabled}
          onResponderGrant={handleResponderGrant}
          onResponderMove={handleResponderMove}
          onResponderRelease={(event) => {
            event.preventDefault();
            event.stopPropagation();
            finishGesture();
          }}
          onResponderTerminate={cancelGesture}
          onResponderTerminationRequest={() => !dragEnabled}
          onStartShouldSetResponder={() => !disabled}
          onStartShouldSetResponderCapture={() => !disabled}
          pointerEvents={disabled ? "none" : "auto"}
          style={styles.gestureLayer}
        />
      </View>
    </View>
  );
}

const BOUNDARY_WIDTH = 2;
const FRAME_RADIUS = 10;

function createStyles(
  theme: PluginSurfaceProps["theme"],
  compact: boolean,
  size: number,
  maxSize?: number,
) {
  const nominalBoardSize = maxSize ?? (compact ? 360 : 440);
  const cellSize = nominalBoardSize / size;
  const excludedSize = Math.max(10, Math.min(compact ? 27 : 32, Math.floor(cellSize * 0.72)));
  const conflictSize = Math.max(7, Math.min(compact ? 13 : 15, Math.floor(cellSize * 0.36)));
  const overhang = (BOUNDARY_WIDTH + StyleSheet.hairlineWidth) / 2;
  return StyleSheet.create({
    boardFrame: {
      width: "100%",
      maxWidth: compact ? 360 : 440,
      aspectRatio: 1,
      alignSelf: "center",
      borderWidth: BOUNDARY_WIDTH,
      borderColor: theme.colors.foreground,
      borderRadius: FRAME_RADIUS,
      backgroundColor: theme.colors.foreground,
    },
    boardGrid: {
      flex: 1,
      gap: StyleSheet.hairlineWidth,
      overflow: "hidden",
      borderRadius: FRAME_RADIUS - BOUNDARY_WIDTH,
      backgroundColor: theme.colors.border,
    },
    boardRow: {
      flex: 1,
      flexDirection: "row",
      gap: StyleSheet.hairlineWidth,
    },
    cell: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    boundaryLayer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      gap: StyleSheet.hairlineWidth,
    },
    boundaryCell: {
      flex: 1,
    },
    boundaryTop: {
      position: "absolute",
      top: -overhang,
      left: -overhang,
      right: -overhang,
      height: BOUNDARY_WIDTH,
      backgroundColor: theme.colors.foreground,
    },
    gestureLayer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    boundaryLeft: {
      position: "absolute",
      top: -overhang,
      bottom: -overhang,
      left: -overhang,
      width: BOUNDARY_WIDTH,
      backgroundColor: theme.colors.foreground,
    },
    conflictTint: {
      position: "absolute",
      top: 3,
      right: 3,
      bottom: 3,
      left: 3,
      backgroundColor: theme.colors.statusDanger,
      opacity: 0.12,
    },
    conflictBorder: {
      position: "absolute",
      top: 3,
      right: 3,
      bottom: 3,
      left: 3,
      borderWidth: 2,
      borderColor: theme.colors.statusDanger,
      borderRadius: 3,
    },
    disabledCell: {
      opacity: 0.54,
    },
    pressedCell: {
      opacity: 0.66,
      transform: [{ scale: 0.97 }],
    },
    conflictIndicator: {
      position: "absolute",
      top: 4,
      right: 7,
      color: theme.colors.statusDanger,
      fontSize: conflictSize,
      lineHeight: conflictSize + 2,
      fontWeight: "800",
    },
    excludedMark: {
      color: theme.colors.foregroundMuted,
      fontSize: excludedSize,
      lineHeight: excludedSize + 4,
      fontWeight: "300",
    },
  });
}
