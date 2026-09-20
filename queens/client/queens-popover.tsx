import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { CompletionFeedback } from "./completion-feedback";
import { findConflicts } from "./game";
import type { CuratedPuzzleDeck } from "./game/curated";
import { GameControls } from "./game-controls";
import { GameMark } from "./game-mark";
import { PuzzleSelector } from "./puzzle-selector";
import { QueensBoard } from "./queens-board";
import { usePersistedGame } from "./use-persisted-game";
import { type PuzzleCatalogState, usePuzzleCatalog } from "./use-puzzle-catalog";

const IGNORE_GESTURE = () => {};

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function QueenPillIcon({ size, color }: { size: number; color: string }) {
  return <GameMark size={size} color={color} />;
}

export function QueensPopover(props: PluginButtonContentProps) {
  const catalog = usePuzzleCatalog();
  if (!catalog.deck) {
    return (
      <View style={{ minHeight: 180, alignItems: "center", justifyContent: "center", gap: 10 }}>
        {catalog.loading ? <ActivityIndicator color={props.theme.colors.accent} /> : null}
        <Text
          style={{
            color: catalog.error
              ? props.theme.colors.statusDanger
              : props.theme.colors.foregroundMuted,
          }}
        >
          {catalog.error ?? "Loading curated puzzles…"}
        </Text>
        {catalog.error ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry puzzle download"
            onPress={catalog.retry}
            style={{
              minHeight: 40,
              justifyContent: "center",
              paddingHorizontal: 16,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: props.theme.colors.border,
              borderRadius: 8,
              backgroundColor: props.theme.colors.surface2,
            }}
          >
            <Text style={{ color: props.theme.colors.foreground, fontWeight: "700" }}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <QueensPopoverGame
      key={`${props.host.id}:${catalog.deck.key}`}
      {...props}
      deck={catalog.deck}
      catalog={catalog}
    />
  );
}

function QueensPopoverGame({
  theme,
  host,
  layout,
  close,
  deck,
  catalog,
}: PluginButtonContentProps & {
  readonly deck: CuratedPuzzleDeck;
  readonly catalog: PuzzleCatalogState;
}) {
  const session = usePersistedGame(`${host.id}:${deck.key}`, deck.puzzles, deck.solutions);
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const state = session.status === "ready" ? session.state : null;
  const puzzle = state?.puzzles[state.activePuzzleIndex];
  const progress = state?.progress[state.activePuzzleIndex];
  const timerRunning = progress?.timer.startedAt !== null && progress?.timer.completedAt === null;

  useEffect(() => {
    if (session.status !== "ready" || !timerRunning) return;
    const interval = setInterval(() => {
      session.dispatch({ type: "tick", now: Date.now() });
    }, 1_000);
    return () => clearInterval(interval);
  }, [session, timerRunning]);

  if (session.status === "loading") {
    return (
      <View style={styles.stateCard}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.stateText}>Loading Queens…</Text>
      </View>
    );
  }

  if (session.status !== "ready" || !state || !puzzle || !progress) {
    const message =
      session.status === "error" || session.status === "invalid"
        ? session.error
        : "The selected puzzle is unavailable.";
    return (
      <View style={styles.stateCard}>
        <Text accessibilityRole="alert" style={styles.errorText}>
          {message}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void session.reload()}
          style={styles.doneButton}
        >
          <Text style={styles.doneText}>Reload</Text>
        </Pressable>
      </View>
    );
  }

  const conflicts = findConflicts(puzzle, progress.cells);
  const markedCount = progress.cells.reduce(
    (count, cell) => count + (cell === "marked" ? 1 : 0),
    0,
  );
  const hasProgress =
    progress.timer.startedAt !== null || progress.cells.some((cell) => cell !== "empty");
  const statusText = progress.solved
    ? "Solved"
    : conflicts.size > 0
      ? `${conflicts.size} conflicting ${conflicts.size === 1 ? "square" : "squares"}`
      : `${markedCount} of ${puzzle.size} queens`;
  const statusColor = progress.solved
    ? theme.colors.statusSuccess
    : conflicts.size > 0
      ? theme.colors.statusDanger
      : theme.colors.foregroundMuted;
  const puzzleNumber = state.activePuzzleIndex + 1;

  return (
    <View style={styles.root}>
      {!layout.compact ? (
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <GameMark size={22} color={theme.colors.accent} />
            <Text accessibilityRole="header" style={styles.title}>
              Queens
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close Queens"
            onPress={close}
            style={styles.doneButton}
          >
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>
          #{puzzleNumber}/{state.puzzles.length}
        </Text>
        <Text
          accessibilityLabel={`Elapsed time ${formatElapsed(progress.timer.elapsedMs)}`}
          style={styles.timerText}
        >
          {formatElapsed(progress.timer.elapsedMs)}
        </Text>
        <Text style={styles.metaText}>{session.saving ? "Saving…" : "Saved"}</Text>
      </View>

      <PuzzleSelector
        size={catalog.size}
        difficulty={catalog.difficulty}
        disabled={catalog.loading || session.saving}
        compact
        theme={theme}
        onChange={(size, difficulty) => {
          void catalog.select(size, difficulty);
        }}
      />
      {catalog.error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {catalog.error}
        </Text>
      ) : null}

      <CompletionFeedback
        solved={progress.solved}
        color={theme.colors.statusSuccess}
        style={styles.boardFrame}
      >
        <QueensBoard
          key={`${host.id}:${puzzle.id}:popover`}
          dragEnabled={!layout.compact}
          maxSize={layout.compact ? 296 : 184}
          puzzle={puzzle}
          cells={progress.cells}
          conflicts={conflicts}
          solved={progress.solved}
          disabled={progress.solved || session.saving}
          compact
          theme={theme}
          onGestureActiveChange={IGNORE_GESTURE}
          onSetCells={(indexes, cellState) => {
            session.dispatch({ type: "set-cells", indexes, state: cellState, now: Date.now() });
          }}
        />
      </CompletionFeedback>

      <View style={styles.statusCard} accessibilityLiveRegion="polite">
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>{statusText}</Text>
      </View>

      <GameControls
        canUndo={progress.history.length > 0}
        canHint={!progress.solved}
        canReset={hasProgress}
        canGoPrevious={false}
        canGoNext={false}
        saving={session.saving}
        disabled={session.saving}
        dense
        showNavigation={false}
        showSavingStatus={false}
        theme={theme}
        onUndo={() => session.dispatch({ type: "undo", now: Date.now() })}
        onHint={() => session.dispatch({ type: "hint", now: Date.now() })}
        onReset={() => session.dispatch({ type: "reset", now: Date.now() })}
        onPrevious={IGNORE_GESTURE}
        onNext={IGNORE_GESTURE}
      />
    </View>
  );
}

function createStyles(theme: PluginButtonContentProps["theme"], compact: boolean) {
  return StyleSheet.create({
    root: {
      width: compact ? "100%" : 300,
      alignSelf: "center",
      alignItems: "center",
      gap: compact ? 12 : 6,
    },
    header: {
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: 18,
      fontWeight: "800",
    },
    doneButton: {
      minHeight: 36,
      justifyContent: "center",
      paddingHorizontal: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    doneText: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "700",
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 14,
    },
    metaText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "700",
    },
    timerText: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "800",
      fontVariant: ["tabular-nums"],
    },
    boardFrame: {
      width: "100%",
      maxWidth: compact ? 296 : 184,
    },
    statusCard: {
      minHeight: 30,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    statusText: {
      fontSize: 11,
      fontWeight: "700",
    },
    stateCard: {
      width: compact ? "100%" : 252,
      minHeight: 180,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: 20,
    },
    stateText: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
    },
    errorText: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
    },
  });
}
