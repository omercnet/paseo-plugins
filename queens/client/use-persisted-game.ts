import { useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTINGS_LIMITS,
  type GameSettings,
  gameSettings,
} from "../shared/game-settings";
import {
  createGameState,
  type GameAction,
  type GameState,
  gameReducer,
  isSolved,
  PUZZLES,
  type Puzzle,
  type PuzzleSolution,
} from "./game";

const EMPTY_SOLUTIONS: Readonly<Record<string, PuzzleSolution>> = {};
const NOOP_SUBSCRIPTION = () => {};

export interface HydratedGame {
  readonly state: GameState;
  readonly hintUsed: Readonly<Record<string, boolean>>;
  readonly records: GameSettings["records"];
}

export interface GamePersistenceControllerSnapshot {
  readonly state: GameState;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly hintUsed: boolean;
}

export interface GamePersistenceControllerOptions {
  readonly settings: GameSettings;
  readonly revision: string;
  readonly save: SaveGameSettings;
  readonly puzzles?: readonly Puzzle[];
  readonly knownSolutions?: Readonly<Record<string, PuzzleSolution>>;
  readonly now?: number;
}

export type SaveGameSettings = (values: GameSettings, revision: string) => Promise<boolean>;

type AttemptMetadata = {
  readonly hintUsed: boolean;
  readonly completionCredited: boolean;
};

type PendingSave = {
  readonly generation: number;
  readonly values: GameSettings;
};

type InFlightSave = PendingSave & {
  readonly epoch: number;
  readonly revision: string;
};

export type PersistedGameSession =
  | {
      readonly status: "loading";
      readonly saving: boolean;
      readonly saveError: string | null;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly saving: boolean;
      readonly saveError: string | null;
      reload(): Promise<void>;
    }
  | {
      readonly status: "invalid";
      readonly error: string;
      readonly saving: boolean;
      readonly saveError: string | null;
      reload(): Promise<void>;
      reset(): Promise<boolean>;
    }
  | {
      readonly status: "ready";
      readonly state: GameState;
      readonly hintUsed: boolean;
      readonly saving: boolean;
      readonly saveError: string | null;
      dispatch(action: GameAction): void;
      reload(): Promise<void>;
    };

function persistedTimer(startedAtMs: number | null, completedAtMs: number | null, now: number) {
  if (startedAtMs === null) {
    return {
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      lastTickAt: null,
    } as const;
  }

  const end = completedAtMs ?? Math.max(startedAtMs, now);
  return {
    startedAt: startedAtMs,
    completedAt: completedAtMs,
    elapsedMs: Math.max(0, end - startedAtMs),
    lastTickAt: completedAtMs === null ? end : null,
  };
}

/**
 * Hydrates reducer state by puzzle id. Undo history and derived conflict state are
 * deliberately reconstructed locally rather than persisted.
 */
export function gameStateFromSettings(
  settings: GameSettings,
  puzzles: readonly Puzzle[] = PUZZLES,
  knownSolutions: Readonly<Record<string, PuzzleSolution>> = EMPTY_SOLUTIONS,
  now = Date.now(),
): HydratedGame {
  const initial = createGameState(puzzles, knownSolutions);
  const progress = initial.progress.slice();
  const hintUsed: Record<string, boolean> = {};

  for (let index = 0; index < initial.puzzles.length; index += 1) {
    const puzzle = initial.puzzles[index];
    const persisted = settings.puzzleStates[puzzle.id];
    if (persisted === undefined) continue;

    hintUsed[puzzle.id] = persisted.hintUsed;
    if (persisted.cells.length !== puzzle.size * puzzle.size) continue;

    const cells = persisted.cells.slice();
    progress[index] = {
      cells,
      history: [],
      solved: isSolved(puzzle, cells),
      timer: persistedTimer(persisted.startedAtMs, persisted.completedAtMs, now),
    };
  }

  const selectedIndex = initial.puzzles.findIndex(
    (puzzle) => puzzle.id === settings.currentPuzzleId,
  );

  return {
    state: {
      ...initial,
      progress,
      activePuzzleIndex: selectedIndex < 0 ? 0 : selectedIndex,
    },
    hintUsed,
    records: { ...settings.records },
  };
}

function persistedTimestamp(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function trimOldestEntries(collection: Record<string, unknown>, protectedKey: string): void {
  let excess = Object.keys(collection).length - GAME_SETTINGS_LIMITS.puzzles;
  if (excess <= 0) return;
  for (const key of Object.keys(collection)) {
    if (key === protectedKey) continue;
    delete collection[key];
    excess -= 1;
    if (excess === 0) return;
  }
}

/** Serializes only stable gameplay data; timer ticks and undo history stay local. */
export function gameSettingsFromState(
  state: GameState,
  metadata: Pick<HydratedGame, "hintUsed" | "records">,
  baseline: GameSettings = DEFAULT_GAME_SETTINGS,
): GameSettings {
  const puzzleStates: GameSettings["puzzleStates"] = { ...baseline.puzzleStates };

  for (let index = 0; index < state.puzzles.length; index += 1) {
    const puzzle = state.puzzles[index];
    const progress = state.progress[index];
    const startedAtMs = persistedTimestamp(progress.timer.startedAt);
    const rawCompletedAtMs = persistedTimestamp(progress.timer.completedAt);
    const completedAtMs =
      startedAtMs === null || rawCompletedAtMs === null
        ? null
        : Math.max(startedAtMs, rawCompletedAtMs);
    const hintUsed = metadata.hintUsed[puzzle.id] ?? false;
    const pristine =
      startedAtMs === null && !hintUsed && progress.cells.every((cell) => cell === "empty");
    if (pristine) {
      delete puzzleStates[puzzle.id];
      continue;
    }

    delete puzzleStates[puzzle.id];
    puzzleStates[puzzle.id] = {
      cells: progress.cells.slice(),
      startedAtMs,
      completedAtMs,
      hintUsed,
    };
  }

  const currentPuzzleId = state.puzzles[state.activePuzzleIndex]?.id ?? baseline.currentPuzzleId;
  const records: GameSettings["records"] = { ...baseline.records, ...metadata.records };
  trimOldestEntries(puzzleStates, currentPuzzleId);
  trimOldestEntries(records, currentPuzzleId);

  return {
    boardSize: baseline.boardSize,
    difficulty: baseline.difficulty,
    currentPuzzleId,
    puzzleStates,
    records,
  };
}

function sameGameSettings(left: GameSettings, right: GameSettings): boolean {
  if (left.currentPuzzleId !== right.currentPuzzleId) return false;
  if (left.boardSize !== right.boardSize || left.difficulty !== right.difficulty) return false;

  const leftPuzzleIds = Object.keys(left.puzzleStates);
  const rightPuzzleIds = Object.keys(right.puzzleStates);
  if (leftPuzzleIds.length !== rightPuzzleIds.length) return false;

  for (const puzzleId of leftPuzzleIds) {
    const leftState = left.puzzleStates[puzzleId];
    const rightState = right.puzzleStates[puzzleId];
    if (
      leftState === undefined ||
      rightState === undefined ||
      leftState.startedAtMs !== rightState.startedAtMs ||
      leftState.completedAtMs !== rightState.completedAtMs ||
      leftState.hintUsed !== rightState.hintUsed ||
      leftState.cells.length !== rightState.cells.length
    ) {
      return false;
    }
    for (let index = 0; index < leftState.cells.length; index += 1) {
      if (leftState.cells[index] !== rightState.cells[index]) return false;
    }
  }

  const leftRecordIds = Object.keys(left.records);
  const rightRecordIds = Object.keys(right.records);
  if (leftRecordIds.length !== rightRecordIds.length) return false;
  for (const puzzleId of leftRecordIds) {
    const leftRecord = left.records[puzzleId];
    const rightRecord = right.records[puzzleId];
    if (
      leftRecord === undefined ||
      rightRecord === undefined ||
      leftRecord.completions !== rightRecord.completions ||
      leftRecord.bestTimeMs !== rightRecord.bestTimeMs
    ) {
      return false;
    }
  }

  return true;
}

function actionableSaveError(detail?: string | null): string {
  const reason = detail?.trim();
  return reason
    ? `Progress is not saved: ${reason} Your local game is still available. Reload saved progress to recover.`
    : "Progress is not saved. Your local game is still available. Reload saved progress to recover.";
}

/**
 * Owns the optimistic reducer state and the revision-aware save queue. A
 * successful write must be acknowledged with synchronize() before another
 * queued write starts, so every write uses the latest host revision.
 */
export interface GamePersistenceController {
  getSnapshot(): GamePersistenceControllerSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: GameAction): void;
  synchronize(
    settings: GameSettings,
    revision: string,
    saveError?: string | null,
    now?: number,
  ): void;
  replace(settings: GameSettings, revision: string, now?: number): void;
  dispose(): void;
  setSave(save: SaveGameSettings): void;
}

export function createGamePersistenceController(
  options: GamePersistenceControllerOptions,
): GamePersistenceController {
  const puzzles = options.puzzles ?? PUZZLES;
  const knownSolutions = options.knownSolutions ?? EMPTY_SOLUTIONS;
  let save = options.save;
  let revision = options.revision;
  let baseline = options.settings;
  const hydrated = gameStateFromSettings(options.settings, puzzles, knownSolutions, options.now);
  let hintUsed = { ...hydrated.hintUsed };
  let records = { ...hydrated.records };
  const metadataHistory = new Map<string, AttemptMetadata[]>();
  let completionCredited: Record<string, boolean> = {};
  const listeners = new Set<() => void>();
  const activePuzzle = hydrated.state.puzzles[hydrated.state.activePuzzleIndex];
  let snapshot: GamePersistenceControllerSnapshot = {
    state: hydrated.state,
    saving: false,
    saveError: null,
    hintUsed: activePuzzle === undefined ? false : (hintUsed[activePuzzle.id] ?? false),
  };
  let pending: PendingSave | null = null;
  let inFlight: InFlightSave | null = null;
  let awaitingRevision: string | null = null;
  let awaitingValues: GameSettings | null = null;
  let blocked = false;
  let generation = 0;
  let epoch = 0;
  let disposed = false;

  function activeHintUsed(state: GameState): boolean {
    const puzzle = state.puzzles[state.activePuzzleIndex];
    return puzzle === undefined ? false : (hintUsed[puzzle.id] ?? false);
  }

  function resetAttemptMetadata(settings: GameSettings): void {
    completionCredited = {};
    for (const puzzle of puzzles) {
      completionCredited[puzzle.id] =
        settings.puzzleStates[puzzle.id]?.completedAtMs !== null &&
        settings.puzzleStates[puzzle.id]?.completedAtMs !== undefined;
    }
  }

  function publish(update: Partial<GamePersistenceControllerSnapshot>): void {
    const next = { ...snapshot, ...update };
    if (
      next.state === snapshot.state &&
      next.saving === snapshot.saving &&
      next.saveError === snapshot.saveError &&
      next.hintUsed === snapshot.hintUsed
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function publishSaving(): void {
    publish({ saving: inFlight !== null || awaitingRevision !== null });
  }

  function serializeCurrentState(): GameSettings {
    return gameSettingsFromState(snapshot.state, { hintUsed, records }, baseline);
  }

  function finishSave(job: InFlightSave, saved: boolean, detail?: string): void {
    if (disposed || job.epoch !== epoch || inFlight !== job) return;
    inFlight = null;
    if (!saved) {
      if (pending === null || pending.generation < job.generation) {
        pending = { generation: job.generation, values: job.values };
      }
      if (revision !== job.revision) {
        blocked = false;
        publish({ saveError: null });
        pump();
        return;
      }
      blocked = true;
      publish({
        saving: false,
        saveError: snapshot.saveError ?? actionableSaveError(detail),
      });
      return;
    }

    baseline = job.values;
    publish({ saveError: null });
    if (revision === job.revision) {
      awaitingRevision = job.revision;
      awaitingValues = job.values;
      publishSaving();
      return;
    }
    pump();
  }

  function pump(): void {
    if (disposed || blocked || inFlight !== null || awaitingRevision !== null || pending === null) {
      publishSaving();
      return;
    }
    const nextPending = pending;
    const job: InFlightSave = { ...nextPending, epoch, revision };
    pending = null;
    inFlight = job;
    publishSaving();
    void save(job.values, job.revision).then(
      (saved) => finishSave(job, saved),
      (error: unknown) =>
        finishSave(
          job,
          false,
          error instanceof Error ? error.message : "The settings write failed.",
        ),
    );
  }

  function enqueueCurrentState(): void {
    generation += 1;
    pending = { generation, values: serializeCurrentState() };
    blocked = false;
    pump();
  }

  function updateAttemptMetadata(
    previousState: GameState,
    nextState: GameState,
    action: GameAction,
  ): void {
    if (action.type === "select-puzzle" || action.type === "tick") return;
    const index = previousState.activePuzzleIndex;
    const puzzle = previousState.puzzles[index];
    const previous = previousState.progress[index];
    const next = nextState.progress[index];
    if (previous === next) return;

    const history = metadataHistory.get(puzzle.id) ?? [];
    if (action.type === "undo") {
      const restored = history.pop();
      if (restored !== undefined) {
        hintUsed[puzzle.id] = restored.hintUsed;
        completionCredited[puzzle.id] = restored.completionCredited;
      }
      metadataHistory.set(puzzle.id, history);
      return;
    }
    if (next.history.length > previous.history.length) {
      history.push({
        hintUsed: hintUsed[puzzle.id] ?? false,
        completionCredited: completionCredited[puzzle.id] ?? false,
      });
      metadataHistory.set(puzzle.id, history);
    }
    if (action.type === "reset") {
      hintUsed[puzzle.id] = false;
      completionCredited[puzzle.id] = false;
    } else if (action.type === "hint") {
      hintUsed[puzzle.id] = true;
    }
    if (!previous.solved && next.solved && !completionCredited[puzzle.id]) {
      completionCredited[puzzle.id] = true;
      if (!(hintUsed[puzzle.id] ?? false)) {
        const elapsedMs = Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(0, Math.floor(next.timer.elapsedMs)),
        );
        const previousRecord = records[puzzle.id];
        records = {
          ...records,
          [puzzle.id]: previousRecord
            ? {
                completions: Math.min(
                  GAME_SETTINGS_LIMITS.completionsPerPuzzle,
                  previousRecord.completions + 1,
                ),
                bestTimeMs: Math.min(previousRecord.bestTimeMs, elapsedMs),
              }
            : { completions: 1, bestTimeMs: elapsedMs },
        };
      }
    }
  }

  function getSnapshot(): GamePersistenceControllerSnapshot {
    return snapshot;
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return NOOP_SUBSCRIPTION;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispatch(action: GameAction): void {
    if (disposed) return;
    const previousState = snapshot.state;
    const nextState = gameReducer(previousState, action);
    if (nextState === previousState) return;
    updateAttemptMetadata(previousState, nextState, action);
    publish({ state: nextState, hintUsed: activeHintUsed(nextState) });
    if (action.type !== "tick") enqueueCurrentState();
  }

  function replace(settings: GameSettings, nextRevision: string, now = Date.now()): void {
    if (disposed) return;
    epoch += 1;
    pending = null;
    inFlight = null;
    awaitingRevision = null;
    awaitingValues = null;
    blocked = false;
    revision = nextRevision;
    baseline = settings;
    const nextHydrated = gameStateFromSettings(settings, puzzles, knownSolutions, now);
    hintUsed = { ...nextHydrated.hintUsed };
    records = { ...nextHydrated.records };
    metadataHistory.clear();
    resetAttemptMetadata(settings);
    publish({
      state: nextHydrated.state,
      saving: false,
      hintUsed: activeHintUsed(nextHydrated.state),
      saveError: null,
    });
  }

  function synchronize(
    settings: GameSettings,
    nextRevision: string,
    saveError: string | null = null,
    now = Date.now(),
  ): void {
    if (disposed) return;
    const revisionChanged = nextRevision !== revision;
    if (revisionChanged) {
      const acknowledgesOwnSave =
        awaitingRevision !== null &&
        awaitingValues !== null &&
        sameGameSettings(settings, awaitingValues);
      const hasUnsavedDraft = pending !== null || inFlight !== null;
      if (!acknowledgesOwnSave && !hasUnsavedDraft) {
        replace(settings, nextRevision, now);
        return;
      }
      revision = nextRevision;
      baseline = settings;
      blocked = false;
      awaitingRevision = null;
      awaitingValues = null;
      if (hasUnsavedDraft) {
        const nextGeneration = pending?.generation ?? inFlight?.generation ?? generation;
        pending = { generation: nextGeneration, values: serializeCurrentState() };
      }
      publish({ saveError: null });
      pump();
      return;
    }
    if (awaitingValues === null) baseline = settings;
    if (saveError !== null && saveError.trim() !== "") {
      blocked = true;
      publish({ saveError: actionableSaveError(saveError) });
    }
  }

  function setSave(nextSave: SaveGameSettings): void {
    save = nextSave;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    epoch += 1;
    pending = null;
    inFlight = null;
    awaitingRevision = null;
    awaitingValues = null;
    listeners.clear();
  }

  resetAttemptMetadata(options.settings);
  return { getSnapshot, subscribe, dispatch, synchronize, replace, dispose, setSave };
}

const CONTROLLERS_BY_HOST = new Map<string, GamePersistenceController>();
const CONTROLLER_RELEASE_DELAY_MS = 30_000;
const CONTROLLER_RELEASES = new Map<string, () => void>();
const CONTROLLER_MOUNTS = new Map<string, number>();

export function disposePersistedGames(): void {
  for (const controller of CONTROLLERS_BY_HOST.values()) controller.dispose();
  for (const cancelRelease of CONTROLLER_RELEASES.values()) cancelRelease();
  CONTROLLER_RELEASES.clear();
  CONTROLLER_MOUNTS.clear();
  CONTROLLERS_BY_HOST.clear();
}

export function usePersistedGame(
  hostId: string,
  puzzles: readonly Puzzle[] = PUZZLES,
  knownSolutions: Readonly<Record<string, PuzzleSolution>> = EMPTY_SOLUTIONS,
): PersistedGameSession {
  const settings = useSettings(gameSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const mounted = useRef(false);
  const recoveringRef = useRef(false);
  const [recovering, setRecovering] = useState(false);
  const [controller, setController] = useState<GamePersistenceController | null>(
    () => CONTROLLERS_BY_HOST.get(hostId) ?? null,
  );
  const controllerRef = useRef<GamePersistenceController | null>(null);

  const save = useCallback<SaveGameSettings>(async (values, revision) => {
    const current = settingsRef.current;
    return current.status === "ready" ? current.save(values, revision) : false;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    CONTROLLER_MOUNTS.set(hostId, (CONTROLLER_MOUNTS.get(hostId) ?? 0) + 1);
    CONTROLLER_RELEASES.get(hostId)?.();
    CONTROLLER_RELEASES.delete(hostId);
    return () => {
      const remaining = (CONTROLLER_MOUNTS.get(hostId) ?? 1) - 1;
      if (remaining > 0) {
        CONTROLLER_MOUNTS.set(hostId, remaining);
        return;
      }
      CONTROLLER_MOUNTS.delete(hostId);
      const timeout = setTimeout(() => {
        CONTROLLER_RELEASES.delete(hostId);
        CONTROLLERS_BY_HOST.get(hostId)?.dispose();
        CONTROLLERS_BY_HOST.delete(hostId);
      }, CONTROLLER_RELEASE_DELAY_MS);
      CONTROLLER_RELEASES.set(hostId, () => clearTimeout(timeout));
    };
  }, [hostId]);

  useEffect(() => {
    if (recovering) {
      if (controller !== null) {
        if (CONTROLLERS_BY_HOST.get(hostId) === controller) CONTROLLERS_BY_HOST.delete(hostId);
        controller.dispose();
        if (controllerRef.current === controller) controllerRef.current = null;
        setController(null);
      }
      return;
    }
    if (settings.status !== "ready") return;

    if (controller === null) {
      const existing = CONTROLLERS_BY_HOST.get(hostId);
      const next =
        existing ??
        createGamePersistenceController({
          settings: settings.values,
          revision: settings.revision,
          save,
          puzzles,
          knownSolutions,
        });
      CONTROLLERS_BY_HOST.set(hostId, next);
      next.setSave(save);
      controllerRef.current = next;
      setController(next);
      return;
    }

    controllerRef.current = controller;
    controller.setSave(save);
    controller.synchronize(settings.values, settings.revision, settings.saveError);
  }, [controller, hostId, knownSolutions, puzzles, recovering, save, settings]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? NOOP_SUBSCRIPTION,
    [controller],
  );
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? null, [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const dispatch = useCallback((action: GameAction) => controller?.dispatch(action), [controller]);

  const beginRecovery = useCallback(() => {
    recoveringRef.current = true;
    const current = controllerRef.current;
    if (current && CONTROLLERS_BY_HOST.get(hostId) === current) CONTROLLERS_BY_HOST.delete(hostId);
    current?.dispose();
    controllerRef.current = null;
    setController(null);
    setRecovering(true);
  }, [hostId]);

  const finishRecovery = useCallback(() => {
    if (!mounted.current) return;
    recoveringRef.current = false;
    setRecovering(false);
  }, []);

  const reload = useCallback(async () => {
    if (recoveringRef.current) return;
    const operation = settingsRef.current.reload;
    beginRecovery();
    try {
      await operation();
    } finally {
      finishRecovery();
    }
  }, [beginRecovery, finishRecovery]);

  const reset = useCallback(async () => {
    if (recoveringRef.current) return false;
    const operation = settingsRef.current.reset;
    beginRecovery();
    try {
      return await operation();
    } finally {
      finishRecovery();
    }
  }, [beginRecovery, finishRecovery]);

  if (recovering || settings.status === "loading") {
    return {
      status: "loading",
      saving: settings.saving,
      saveError: settings.saveError,
    };
  }

  if (settings.status === "error") {
    return {
      status: "error",
      error: settings.error,
      saving: settings.saving,
      saveError: settings.saveError,
      reload,
    };
  }

  if (settings.status === "invalid") {
    return {
      status: "invalid",
      error: settings.error,
      saving: settings.saving,
      saveError: settings.saveError,
      reload,
      reset,
    };
  }

  if (snapshot === null || controller === null) {
    return {
      status: "loading",
      saving: settings.saving,
      saveError: settings.saveError,
    };
  }

  return {
    status: "ready",
    state: snapshot.state,
    hintUsed: snapshot.hintUsed,
    saving: snapshot.saving,
    saveError: snapshot.saveError,
    dispatch,
    reload,
  };
}
