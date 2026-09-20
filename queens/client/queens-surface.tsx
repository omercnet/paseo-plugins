import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { CompletionFeedback } from "./completion-feedback";
import { findConflicts } from "./game";
import type { CuratedPuzzleDeck } from "./game/curated";
import { GameControls } from "./game-controls";
import { GameMark } from "./game-mark";
import { PuzzleSelector } from "./puzzle-selector";
import { QueensBoard } from "./queens-board";
import { usePersistedGame } from "./use-persisted-game";
import { type PuzzleCatalogState, usePuzzleCatalog } from "./use-puzzle-catalog";

const EMPTY_CONFLICTS: ReadonlySet<number> = new Set();
const AGENT_PAGE_LIMIT = 200;
const AGENT_MAX_PAGES = 10;
const AGENT_BACKSTOP_REFRESH_MS = 30_000;

export function PaseoQueensSurface(props: PluginSurfaceProps) {
  return <QueensGame key={props.host.id} {...props} />;
}

function QueensGame(props: PluginSurfaceProps) {
  const catalog = usePuzzleCatalog();
  if (!catalog.deck) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: 24,
          backgroundColor: props.theme.colors.surface0,
        }}
      >
        {catalog.loading ? <ActivityIndicator color={props.theme.colors.accent} /> : null}
        <Text
          accessibilityRole={catalog.error ? "alert" : undefined}
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
    <QueensLoadedGame
      key={`${props.host.id}:${catalog.deck.key}`}
      {...props}
      deck={catalog.deck}
      catalog={catalog}
    />
  );
}

function QueensLoadedGame({
  theme,
  layout,
  host,
  deck,
  catalog,
}: PluginSurfaceProps & {
  readonly deck: CuratedPuzzleDeck;
  readonly catalog: PuzzleCatalogState;
}) {
  const session = usePersistedGame(`${host.id}:${deck.key}`, deck.puzzles, deck.solutions);
  const paseo = usePaseo();
  const toast = useToast();
  const [runningAgentCount, setRunningAgentCount] = useState<number | null>(null);
  const previousRunningAgentCount = useRef<number | null>(null);
  const [boardGestureActive, setBoardGestureActive] = useState(false);
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const state = session.status === "ready" ? session.state : null;
  const puzzle = state?.puzzles[state.activePuzzleIndex];
  const progress = state?.progress[state.activePuzzleIndex];
  const cells = progress?.cells;
  const conflicts = useMemo(
    () => (puzzle && cells ? findConflicts(puzzle, cells) : EMPTY_CONFLICTS),
    [cells, puzzle],
  );
  const dispatch = session.status === "ready" ? session.dispatch : null;
  const timerRunning = progress?.timer.startedAt !== null && progress?.timer.completedAt === null;

  useEffect(() => {
    if (!dispatch || !timerRunning) return;

    const interval = setInterval(() => {
      dispatch({ type: "tick", now: Date.now() });
    }, 1_000);

    return () => clearInterval(interval);
  }, [dispatch, timerRunning]);

  useEffect(() => {
    let mounted = true;
    let request = 0;

    const refresh = async () => {
      const currentRequest = ++request;
      let running = 0;
      let cursor: string | undefined;
      try {
        for (let page = 0; page < AGENT_MAX_PAGES; page += 1) {
          const result = await paseo.agents.list({
            sort: [{ key: "updated_at", direction: "desc" }],
            page: { limit: AGENT_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
          });
          for (const entry of result.entries) {
            if (entry.agent.status === "running" || entry.agent.status === "initializing") {
              running += 1;
            }
          }
          cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
          if (!cursor) break;
        }
        if (mounted && currentRequest === request) setRunningAgentCount(running);
      } catch {
        // Preserve the last known count when the host is temporarily unavailable.
      }
    };

    void refresh();
    const unsubscribe = paseo.agents.subscribe(() => void refresh());
    const backstop = setInterval(() => void refresh(), AGENT_BACKSTOP_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(backstop);
      unsubscribe();
    };
  }, [paseo]);

  useEffect(() => {
    const previous = previousRunningAgentCount.current;
    if (previous !== null && previous > 0 && runningAgentCount === 0) {
      toast.show("All agents are idle. Back to work!", { variant: "success" });
    }
    previousRunningAgentCount.current = runningAgentCount;
  }, [runningAgentCount, toast]);

  if (session.status === "loading") {
    return (
      <View style={styles.screen}>
        <ScrollView
          style={styles.messageScroll}
          contentContainerStyle={styles.messageScrollContent}
        >
          <View accessibilityLiveRegion="polite" style={styles.messageCard}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text accessibilityRole="header" style={styles.messageTitle}>
              Loading saved game
            </Text>
            <Text style={styles.messageBody}>Restoring your puzzle progress.</Text>
            {session.saveError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {session.saveError}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </View>
    );
  }

  if (session.status === "error") {
    return (
      <View style={styles.screen}>
        <ScrollView
          style={styles.messageScroll}
          contentContainerStyle={styles.messageScrollContent}
        >
          <View style={styles.messageCard}>
            <Text accessibilityRole="header" style={styles.messageTitle}>
              Saved game unavailable
            </Text>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {session.error}
            </Text>
            <RecoveryButton
              label="Reload"
              disabled={session.saving}
              onPress={() => void session.reload()}
              styles={styles}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  if (session.status === "invalid") {
    return (
      <View style={styles.screen}>
        <ScrollView
          style={styles.messageScroll}
          contentContainerStyle={styles.messageScrollContent}
        >
          <View style={styles.messageCard}>
            <Text accessibilityRole="header" style={styles.messageTitle}>
              Saved game needs attention
            </Text>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {session.error}
            </Text>
            <Text style={styles.messageBody}>
              Reload to try again, or reset the invalid data and start fresh.
            </Text>
            <View style={styles.recoveryActions}>
              <RecoveryButton
                label="Reload"
                disabled={session.saving}
                onPress={() => void session.reload()}
                styles={styles}
              />
              <RecoveryButton
                label="Reset saved game"
                disabled={session.saving}
                onPress={() => void session.reset()}
                styles={styles}
              />
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (!state || !puzzle || !progress) {
    return (
      <View style={styles.screen}>
        <ScrollView
          style={styles.messageScroll}
          contentContainerStyle={styles.messageScrollContent}
        >
          <View style={styles.messageCard}>
            <Text accessibilityRole="header" style={styles.messageTitle}>
              Puzzle unavailable
            </Text>
            <Text accessibilityRole="alert" style={styles.errorText}>
              The saved game does not contain a playable puzzle.
            </Text>
            <RecoveryButton
              label="Reload"
              disabled={session.saving}
              onPress={() => void session.reload()}
              styles={styles}
            />
          </View>
        </ScrollView>
      </View>
    );
  }
  const readyState = state;
  const readyDispatch = session.dispatch;
  const hintUsed = session.hintUsed;

  const markedCount = progress.cells.reduce(
    (count, cell) => count + (cell === "marked" ? 1 : 0),
    0,
  );
  const hasProgress =
    progress.timer.startedAt !== null || progress.cells.some((cell) => cell !== "empty");
  const puzzleNumber = state.activePuzzleIndex + 1;
  const puzzleLabel = puzzle.id.split("-").pop() ?? String(puzzleNumber);
  const statusText = progress.solved
    ? hintUsed
      ? "Assisted — solved with every queen in a safe place."
      : "Solved — every queen has a safe place."
    : conflicts.size > 0
      ? `${conflicts.size} conflicting ${conflicts.size === 1 ? "square" : "squares"}`
      : `${markedCount} of ${puzzle.size} queens placed`;
  const statusColor = progress.solved
    ? theme.colors.statusSuccess
    : conflicts.size > 0
      ? theme.colors.statusDanger
      : theme.colors.foregroundMuted;
  const agentStatusText =
    runningAgentCount === null
      ? "Checking agents…"
      : runningAgentCount === 0
        ? "All agents idle"
        : `${runningAgentCount} ${runningAgentCount === 1 ? "agent" : "agents"} running`;
  const agentStatusColor =
    runningAgentCount === null
      ? theme.colors.foregroundMuted
      : runningAgentCount === 0
        ? theme.colors.statusSuccess
        : theme.colors.accent;

  const selectPuzzle = (index: number) => {
    const clampedIndex = Math.min(Math.max(index, 0), readyState.puzzles.length - 1);
    readyDispatch({ type: "select-puzzle", index: clampedIndex, now: Date.now() });
  };

  return (
    <View style={styles.screen}>
      <ScrollView scrollEnabled={!boardGestureActive} contentContainerStyle={styles.scrollContent}>
        <View style={styles.gameShell}>
          <View style={styles.heading}>
            <View style={styles.eyebrowRow}>
              <View style={styles.eyebrowLine} />
              <Text style={styles.eyebrow}>
                LOGIC, {puzzle.size} BY {puzzle.size}
              </Text>
              <View style={styles.eyebrowLine} />
            </View>
            <View style={styles.titleRow}>
              <GameMark size={layout.compact ? 28 : 34} color={theme.colors.accent} />
              <Text accessibilityRole="header" style={styles.title}>
                Queens
              </Text>
            </View>
            <Text style={styles.instructions}>
              Place one queen in every row, column, and region. Queens cannot touch, even
              diagonally. Tap once to toggle an X, double tap to toggle a queen, or drag from an
              empty square to mark Xs and from an X to erase them.
            </Text>
          </View>

          <PuzzleSelector
            size={catalog.size}
            difficulty={catalog.difficulty}
            disabled={catalog.loading || session.saving || boardGestureActive}
            compact={layout.compact}
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

          <View style={styles.puzzleMeta}>
            <View style={styles.metaItem}>
              <Text style={styles.puzzleMetaLabel}>PUZZLE</Text>
              <Text style={styles.puzzleMetaValue}>
                #{puzzleLabel} · {puzzleNumber}/{state.puzzles.length}
              </Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.puzzleMetaLabel}>TIME</Text>
              <Text
                accessibilityLabel={`Elapsed time ${formatElapsedAccessible(progress.timer.elapsedMs)}`}
                style={styles.timerValue}
              >
                {formatElapsed(progress.timer.elapsedMs)}
              </Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.puzzleMetaLabel}>SYNC</Text>
              <Text style={styles.puzzleMetaValue}>{session.saving ? "Saving…" : "Saved"}</Text>
            </View>
            {hintUsed ? (
              <>
                <View style={styles.metaDivider} />
                <View style={styles.metaItem}>
                  <Text style={styles.puzzleMetaLabel}>RUN</Text>
                  <Text style={styles.puzzleMetaValue}>Assisted</Text>
                </View>
              </>
            ) : null}
          </View>

          {session.saveError ? (
            <View accessibilityRole="alert" style={styles.saveErrorCard}>
              <View style={styles.saveErrorCopy}>
                <Text style={styles.saveErrorTitle}>Progress not saved</Text>
                <Text style={styles.saveErrorBody}>{session.saveError}</Text>
              </View>
              <RecoveryButton
                label="Reload saved game"
                disabled={session.saving}
                onPress={() => void session.reload()}
                styles={styles}
              />
            </View>
          ) : null}

          <CompletionFeedback
            solved={progress.solved}
            color={theme.colors.statusSuccess}
            style={styles.boardFeedback}
          >
            <QueensBoard
              key={puzzle.id}
              puzzle={puzzle}
              cells={progress.cells}
              conflicts={conflicts}
              solved={progress.solved}
              disabled={progress.solved}
              compact={layout.compact}
              theme={theme}
              onGestureActiveChange={setBoardGestureActive}
              onSetCells={(indexes, cellState) => {
                readyDispatch({ type: "set-cells", indexes, state: cellState, now: Date.now() });
              }}
            />
          </CompletionFeedback>

          <View style={styles.statusRail}>
            <View style={styles.statusCard} accessibilityLiveRegion="polite">
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.statusText, { color: statusColor }]}>{statusText}</Text>
            </View>
            <View style={styles.statusCard} accessibilityLiveRegion="polite">
              <View style={[styles.statusDot, { backgroundColor: agentStatusColor }]} />
              <Text style={[styles.statusText, { color: agentStatusColor }]}>
                {agentStatusText}
              </Text>
            </View>
          </View>

          <GameControls
            canUndo={progress.history.length > 0}
            canHint={!progress.solved}
            canReset={hasProgress}
            canGoPrevious={state.activePuzzleIndex > 0}
            canGoNext={state.activePuzzleIndex < state.puzzles.length - 1}
            saving={session.saving}
            disabled={false}
            theme={theme}
            onUndo={() => {
              readyDispatch({ type: "undo", now: Date.now() });
            }}
            onHint={() => {
              readyDispatch({ type: "hint", now: Date.now() });
            }}
            onReset={() => {
              readyDispatch({ type: "reset", now: Date.now() });
            }}
            onPrevious={() => selectPuzzle(readyState.activePuzzleIndex - 1)}
            onNext={() => selectPuzzle(readyState.activePuzzleIndex + 1)}
          />
        </View>
      </ScrollView>
    </View>
  );
}

interface RecoveryStyles {
  readonly recoveryButton: ViewStyle;
  readonly disabled: ViewStyle;
  readonly pressed: ViewStyle;
  readonly recoveryButtonText: TextStyle;
}

interface RecoveryButtonProps {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly styles: RecoveryStyles;
}

function RecoveryButton({ label, disabled, onPress, styles }: RecoveryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.recoveryButton,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.recoveryButtonText}>{label}</Text>
    </Pressable>
  );
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatElapsedAccessible(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(", ");
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surface0,
    },
    messageScroll: {
      width: "100%",
    },
    messageScrollContent: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    scrollContent: {
      flexGrow: 1,
      alignItems: compact ? "stretch" : "center",
      justifyContent: compact ? "flex-start" : "center",
      paddingHorizontal: compact ? 14 : 28,
      paddingVertical: compact ? 18 : 32,
    },
    gameShell: {
      width: compact ? undefined : "100%",
      maxWidth: 620,
      alignSelf: compact ? "stretch" : "center",
      alignItems: "center",
      gap: compact ? 14 : 20,
    },
    heading: {
      width: "100%",
      alignItems: "center",
      gap: compact ? 7 : 9,
    },
    eyebrowRow: {
      width: "100%",
      maxWidth: 330,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    eyebrowLine: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border,
    },
    eyebrow: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 1.6,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: compact ? 9 : 12,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 30 : 38,
      lineHeight: compact ? 36 : 45,
      fontWeight: "800",
      letterSpacing: -1,
    },
    instructions: {
      maxWidth: 540,
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
      lineHeight: compact ? 17 : 19,
      textAlign: "center",
    },
    puzzleMeta: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: compact ? 8 : 12,
    },
    metaItem: {
      alignItems: "center",
      gap: 2,
    },
    puzzleMetaLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 9 : 11,
      fontWeight: "700",
      letterSpacing: 1.1,
    },
    puzzleMetaValue: {
      color: theme.colors.foreground,
      minWidth: compact ? 52 : 60,
      fontSize: compact ? 11 : 13,
      fontWeight: "700",
      textAlign: "center",
    },
    timerValue: {
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 15,
      fontWeight: "800",
      fontVariant: ["tabular-nums"],
    },
    metaDivider: {
      width: StyleSheet.hairlineWidth,
      height: 28,
      backgroundColor: theme.colors.border,
    },
    boardFeedback: {
      width: "100%",
      maxWidth: compact ? 360 : 440,
    },
    statusRail: {
      width: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    statusCard: {
      minHeight: 34,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
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
      fontSize: 12,
      fontWeight: "600",
    },
    messageCard: {
      width: "100%",
      maxWidth: 460,
      alignItems: "center",
      gap: 12,
      padding: compact ? 20 : 28,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 14,
      backgroundColor: theme.colors.surface1,
    },
    messageTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 20 : 24,
      lineHeight: compact ? 25 : 30,
      fontWeight: "800",
      textAlign: "center",
    },
    messageBody: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 19,
      textAlign: "center",
    },
    errorText: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
    },
    recoveryActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 8,
    },
    recoveryButton: {
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 15,
      paddingVertical: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 9,
      backgroundColor: theme.colors.surface2,
    },
    recoveryButtonText: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "700",
      textAlign: "center",
    },
    saveErrorCard: {
      width: "100%",
      flexDirection: compact ? "column" : "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusDanger,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
    },
    saveErrorCopy: {
      flex: compact ? undefined : 1,
      alignItems: compact ? "center" : "flex-start",
      gap: 3,
    },
    saveErrorBody: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      lineHeight: 18,
      textAlign: compact ? "center" : "left",
    },
    saveErrorTitle: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      fontWeight: "800",
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
