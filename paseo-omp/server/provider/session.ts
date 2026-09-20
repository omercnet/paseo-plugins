import { randomUUID } from "node:crypto";
import type {
  ProviderConfigState,
  ProviderError,
  ProviderEvent,
  ProviderInput,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type {
  OmpOperationalFailure,
  OmpOperationalFailureReporter,
} from "../operational-failure-diagnostics";
import {
  mapOmpModels,
  nativeOmpModelId,
  OMP_MODES,
  ompModelId,
  selectOmpModels,
  thinkingForModel,
  validateOmpModelIdentities,
} from "./catalog";
import {
  normalizeOmpSessionConfig,
  type OmpRecoveryOptions,
  withCommittedOmpSelection,
} from "./config-normalization";
import { OmpHostToolsBridge, type OmpMcpConnector, validateOmpHostToolConfig } from "./host-tools";
import { isOmpImageMimeType, OmpImageMaterializer } from "./image";
import type { OmpRuntime, OmpRuntimeSession } from "./omp-rpc";
import { buildOmpSpawnRequest, type OmpStartOptions } from "./omp-rpc-environment";
import type {
  OmpAvailableCommand,
  OmpBranchResult,
  OmpCompactionResult,
  OmpMessage,
  OmpModel,
  OmpRpcEvent,
  OmpSessionState,
} from "./omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "./omp-rpc-transport";
import {
  inlinePromptFrameBytes,
  isSafeCommandName,
  MAX_PROMPT_TEXT_LENGTH,
  type OmpPromptPayload,
  promptPayload,
  slashCommandName,
} from "./prompt-payload";
import {
  BoundedStringSet,
  boundedJsonBytes,
  configuredOutputRedactionValues,
  isOmpCleanupFailure,
  isOmpPublicError,
  OmpCleanupFailure,
  OmpPublicDataSerializer,
  OmpPublicError,
  utf8Bytes,
} from "./security";
import { OmpSessionCompaction } from "./session-compaction";
import type { OmpSessionDescriptor } from "./session-descriptors";
import { validateNativeSessionId } from "./session-descriptors";
import { isNativeTurnActivity, isPassiveUiMethod, isRuntimeConfigEvent } from "./session-events";
import { OmpSessionPermissions } from "./session-permissions";
import {
  type ActiveTurn,
  assistantTerminalOutcome,
  classifyTerminalCandidate,
  createActiveTurn,
  historyTerminalOutcome,
  nativeEntryId,
  type PendingUser,
  type TerminalCandidate,
  terminalOutcome,
  unknownTerminalOutcomeError,
} from "./session-terminal";
import { OmpSessionUsage } from "./session-usage";
import { OmpSubsessionProjector } from "./subsessions";
import {
  defaultOmpTimelineScheduler,
  OmpTimelineProjector,
  type OmpTimelineScheduler,
} from "./timeline-projector";

type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;
type SessionPromptInput = Extract<ProviderInput, { type: "session.prompt" }>;
type SessionInterruptInput = Extract<ProviderInput, { type: "session.interrupt" }>;
type SessionConfigureInput = Extract<ProviderInput, { type: "session.configure" }>;
type SessionRevertInput = Extract<ProviderInput, { type: "session.revert" }>;
type SessionCloseInput = Extract<ProviderInput, { type: "session.close" }>;
type NativeSessionTransition = (previousSessionId: string, nextSessionId: string) => void;
type RewindCleanupQuarantine = (cleanup: Promise<void>) => void;
type RewindSessionRetirement = () => void;
type SessionPermissionInput = Extract<ProviderInput, { type: "session.permission" }>;
type Emit = (event: ProviderEvent) => void;
const LOCAL_ONLY_SETTLE_MS = 5_000;
const AGENT_END_STATE_TIMEOUT_MS = 2_000;
const AGENT_END_HISTORY_TIMEOUT_MS = 2_000;
const CONFIG_REFRESH_RETRY_BASE_MS = 250;
const CONFIG_REFRESH_MAX_ATTEMPTS = 3;
const USAGE_POLL_MS = 1_000;
const USAGE_REFRESH_MS = 100;
const FINAL_USAGE_WAIT_MS = 250;
const COMPACTION_MAX_WAIT_MS = 5 * 60_000;
const AGENT_END_SETTLE_MS = 5_000;
const MAX_AGENT_END_CORRELATION_MESSAGES = 512;
const MAX_TRACKED_ENTRY_IDS = 1_024;
const MAX_UNCLAIMED_BRANCH_ENTRIES = 1_024;
const MAX_PENDING_USERS = 256;
const _MAX_PENDING_PERMISSIONS = 32;
const _MAX_PENDING_PERMISSION_BYTES = 2 * 1024 * 1024;
const MAX_USER_ECHOES = 512;
const MAX_BUFFERED_TURN_EVENTS = 512;
const MAX_BUFFERED_VALUE_ITEMS = 1_024;
const MAX_BUFFERED_VALUE_NODES = 4_096;
const MAX_BUFFERED_TURN_BYTES = 4 * 1024 * 1024;
const MAX_USER_ECHO_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_USER_BYTES = 2 * 1024 * 1024;
const MAX_UNCLAIMED_BRANCH_BYTES = 4 * 1024 * 1024;
class OmpCatalogEscape extends OmpPublicError {}
const MAX_REPLAY_MESSAGES = 100_000;
const REPLAY_TIMEOUT_MS = 20_000;
const _OMP_ASK_USER_FREEFORM_SENTINEL = "✏️ Type custom response...";
const _MAX_FREEFORM_RESPONSE_BYTES = 64 * 1024;
const OMP_BUILTIN_COMMANDS: readonly OmpAvailableCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    input: { hint: "[instructions]" },
    source: "builtin",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    input: { hint: "[on|off|toggle]" },
    source: "builtin",
  },
  {
    name: "handoff",
    description: "Hand off from planning to implementation",
    input: { hint: "[instructions]" },
    source: "builtin",
  },
  {
    name: "steer",
    description: "Steer the active OMP turn",
    input: { hint: "<message>" },
    source: "builtin",
  },
  {
    name: "follow-up",
    description: "Queue a follow-up message for OMP",
    input: { hint: "<message>" },
    source: "builtin",
  },
];

function applicableThinkingLevel(
  model: OmpModel | undefined,
  level: OmpSessionState["thinkingLevel"],
): OmpSessionState["thinkingLevel"] {
  return model?.reasoning === false ? undefined : level;
}

function fixedSessionMode(modeId = "full") {
  const mode = OMP_MODES.find((candidate) => candidate.id === modeId);
  if (!mode) throw new OmpPublicError("OMP mode is unavailable");
  return {
    ...mode,
    label: `${mode.label} (fixed for session)`,
    description: `${mode.description} Approval mode is fixed for this session; create a new session to choose another mode.`,
  };
}

export function ompPersistenceSessionId(input: SessionOpenInput): string | undefined {
  if (!input.persistence) return;
  if (input.persistence.version !== 1) {
    throw new OmpPublicError("Unsupported OMP persistence version");
  }
  const data = input.persistence.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.hasOwn(data, "sessionId") ||
    Object.keys(data).length !== 1
  ) {
    throw new OmpPublicError("Invalid OMP session persistence");
  }
  try {
    return validateNativeSessionId((data as Record<string, unknown>).sessionId);
  } catch {
    throw new OmpPublicError("Invalid OMP session identifier");
  }
}

async function authorizeNativeSession(
  runtime: OmpRuntime,
  sessionId: string,
  cwd: string,
  sessionDir?: string,
): Promise<OmpSessionDescriptor> {
  const matches = await runtime.listSessions({ sessionId, cwd, limit: 2, sessionDir });
  const descriptor = matches[0];
  if (matches.length !== 1 || descriptor?.id !== sessionId) {
    throw new OmpPublicError("OMP session could not be resolved in this workspace");
  }
  if (descriptor.cwd !== cwd) {
    throw new OmpPublicError("OMP session belongs to a different working directory");
  }
  return descriptor;
}

function retainedBytes(values: readonly unknown[], maxBytes: number): number {
  let total = 0;
  for (const value of values) {
    const bytes = boundedJsonBytes(
      value,
      maxBytes,
      MAX_BUFFERED_VALUE_ITEMS,
      maxBytes,
      MAX_BUFFERED_VALUE_NODES,
    );
    if (bytes === Number.POSITIVE_INFINITY) return bytes;
    total += bytes;
    if (total > maxBytes) return Number.POSITIVE_INFINITY;
  }
  return total;
}

async function waitForReplay<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

type PendingAbort = {
  turn: ActiveTurn;
  generation: number;
  runtime: OmpRuntimeSession;
  forceTerminal: boolean;
  promise: Promise<void>;
};
function providerError(error: unknown, fallback: string): { message: string } {
  return { message: isOmpPublicError(error) ? error.message : fallback };
}
async function settleSessionCleanup(promises: readonly Promise<void>[]): Promise<void> {
  const pending = [...promises];
  const seen = new Set<Promise<void>>();
  const failures: unknown[] = [];
  while (pending.length > 0) {
    const batch = pending.splice(0).filter((promise) => !seen.has(promise));
    for (const promise of batch) seen.add(promise);
    const results = await Promise.allSettled(batch);
    for (const result of results) {
      if (result.status !== "rejected") continue;
      if (isOmpCleanupFailure(result.reason)) {
        if (!seen.has(result.reason.cleanup)) pending.push(result.reason.cleanup);
        continue;
      }
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "OMP session initialization cleanup failed");
  }
}
export class OmpProviderSession {
  readonly id: string;
  readonly cwd: string;

  private readonly projector: OmpTimelineProjector;
  private readonly subsessions: OmpSubsessionProjector | null;
  private unsubscribe: () => void = () => {};
  private activeTurn: ActiveTurn | null = null;
  private closed = false;
  private disposalPromise: Promise<void> | null = null;
  private sessionClosedPublished = false;
  private readyPublished = false;
  private readonly emittedEntryIds = new BoundedStringSet(MAX_TRACKED_ENTRY_IDS);
  private readonly seenEntryIds = new BoundedStringSet(MAX_TRACKED_ENTRY_IDS);
  private branchWatermarkValid = true;
  private readonly branchEntryIds = new Set<string>();
  private readonly unclaimedBranchEntries: Array<{ entryId: string; text: string }> = [];
  private readonly scheduler: OmpTimelineScheduler;
  private readonly dataFilter: OmpPublicDataSerializer;
  private readonly nativeModelsByPublicId: ReadonlyMap<string, OmpModel>;
  private readonly lifetime = new AbortController();
  private generation = 0;
  private runtimeDead: string | null = null;
  private runtimeDisposal: Promise<void> | null = null;
  private hostToolsDisposal: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private configRefreshInFlight: Promise<void> | null = null;
  private configRefreshDirty = false;
  private configRefreshAttempts = 0;
  private configRefreshRetryHandle: unknown | null = null;
  private configRefreshRetryResolve: (() => void) | null = null;
  private configMutationInFlight = false;
  private configRevision = 0;
  private recoveryUsesNativeConfig = false;
  private activeAbort: PendingAbort | null = null;
  private readonly usage: OmpSessionUsage;
  private readonly compaction: OmpSessionCompaction;
  private revertInFlight = false;
  private runtimeTurnCompleted = false;
  private commandCatalog: OmpAvailableCommand[];
  private readonly permissions: OmpSessionPermissions;
  private unsupportedThinkingNoticePending = false;
  private unsupportedThinkingNoticePublished = false;

  private constructor(
    id: string,
    private runtime: OmpRuntimeSession,
    private readonly runtimeFactory: OmpRuntime,
    private recoveryOptions: OmpRecoveryOptions,
    private readonly hostTools: OmpHostToolsBridge,
    private nativeSessionId: string,
    private readonly nativeSessionFile: string | undefined,
    private readonly config: ProviderSessionConfig,
    private configState: ProviderConfigState,
    outputRedactionValues: readonly string[],
    nativeModelsByPublicId: ReadonlyMap<string, OmpModel>,
    private readonly capabilities: readonly string[],
    private readonly slashCommands: Set<string>,
    commandCatalog: OmpAvailableCommand[],
    private commandDiscoveryAvailable: boolean,
    private readonly emit: Emit,
    private readonly replayHistoryOnOpen: boolean,
    private readonly persistSession: boolean,
    private readonly replayTimeoutMs: number,
    private readonly transitionNativeSession: NativeSessionTransition,
    private readonly quarantineRewindCleanup: RewindCleanupQuarantine,
    private readonly retireRewindSession: RewindSessionRetirement,
    private readonly reportOperationalFailure: OmpOperationalFailureReporter,
    scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
  ) {
    this.id = id;
    this.cwd = config.cwd;
    this.scheduler = scheduler;
    this.usage = new OmpSessionUsage(
      id,
      emit,
      scheduler,
      () => ({
        closed: this.closed,
        runtimeDead: this.runtimeDead !== null,
        generation: this.generation,
        runtime: this.runtime,
        activeTurn: this.activeTurn,
      }),
      (turn) =>
        !this.closed &&
        !this.runtimeDead &&
        !turn.terminal &&
        !turn.terminalizing &&
        !turn.agentEndPending &&
        turn.generation === this.generation &&
        this.activeTurn === turn,
    );
    this.dataFilter = new OmpPublicDataSerializer(outputRedactionValues);
    this.nativeModelsByPublicId = nativeModelsByPublicId;
    this.commandCatalog = commandCatalog;
    this.hostTools.onFatal(() => this.handleRuntimeFailure());
    this.projector = new OmpTimelineProjector(
      id,
      emit,
      scheduler,
      outputRedactionValues,
      capabilities.includes("session.revert.conversation"),
      capabilities.includes("timeline.plugin"),
      hostTools.labels,
    );
    this.compaction = new OmpSessionCompaction(
      id,
      emit,
      this.projector,
      this.dataFilter,
      this.usage,
    );
    this.permissions = new OmpSessionPermissions({
      sessionId: id,
      emit,
      scheduler,
      dataFilter: this.dataFilter,
      projector: this.projector,
      readContext: () => ({
        runtime: this.runtime,
        generation: this.generation,
        activeTurn: this.activeTurn,
        closed: this.closed,
        runtimeDead: this.runtimeDead !== null,
      }),
      handleRuntimeFailure: (message) => this.handleRuntimeFailure(message),
      invalidateRuntime: (message) => this.invalidateRuntime(message),
      markAgentEvidence: (turn) => this.markAgentEvidence(turn),
      reevaluateDeferredTerminal: () => this.reevaluateDeferredPermissionTerminal(),
    });
    this.subsessions = capabilities.includes("session.subsession")
      ? new OmpSubsessionProjector(
          id,
          persistSession ? `persisted:${nativeSessionId}` : `ephemeral:${id}`,
          nativeSessionFile,
          config.cwd,
          emit,
          scheduler,
          () => this.resumeDeferredAgentEnd(),
          outputRedactionValues,
          capabilities.includes("timeline.plugin"),
        )
      : null;
    this.bindRuntime(runtime);
  }
  private recordOperationalFailure(failure: OmpOperationalFailure): void {
    try {
      this.reportOperationalFailure(failure);
    } catch {
      // Diagnostics must never affect provider or session flow.
    }
  }
  get persistenceSessionId(): string | undefined {
    return this.persistSession ? this.nativeSessionId : undefined;
  }
  async openPaseoBrowser(url: string): Promise<void> {
    if (this.closed) throw new OmpPublicError("The OMP session is closed");
    await this.hostTools.openPaseoBrowser(url);
  }
  setBrowserAuthorizationIssuer(issue: ((url: string) => string | undefined) | null): void {
    this.projector.setBrowserAuthorizationIssuer(issue);
  }

  private readonly imageMaterializer = new OmpImageMaterializer();
  static async open(
    input: SessionOpenInput,
    runtime: OmpRuntime,
    capabilities: readonly string[],
    emit: Emit,
    transitionNativeSession: NativeSessionTransition,
    quarantineRewindCleanup: RewindCleanupQuarantine,
    retireRewindSession: RewindSessionRetirement,
    scheduler?: OmpTimelineScheduler,
    replayTimeoutMs = REPLAY_TIMEOUT_MS,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
    mcpConnector?: OmpMcpConnector,
    mcpInitializationTimeoutMs?: number,
    reportOperationalFailure: OmpOperationalFailureReporter = () => {},
  ): Promise<OmpProviderSession> {
    const resumeSessionId = ompPersistenceSessionId(input);
    if (resumeSessionId && !input.config.persist) {
      throw new OmpPublicError("OMP persisted sessions require persist: true");
    }
    if (input.history === "replay" && !resumeSessionId) {
      throw new OmpPublicError("OMP history replay requires persisted session identity");
    }
    if (input.history === "skip" && resumeSessionId) {
      throw new OmpPublicError("OMP persisted sessions require history replay");
    }
    const effectiveConfig: ProviderSessionConfig = { ...input.config };
    const normalizedConfig = normalizeOmpSessionConfig(
      effectiveConfig,
      capabilities.includes("permission"),
    );
    const configuredRedactionValues = configuredOutputRedactionValues(
      normalizedConfig.outputRedaction ?? "none",
      normalizedConfig.env,
      effectiveConfig.mcpServers,
    );
    const persistedDescriptor = resumeSessionId
      ? await authorizeNativeSession(
          runtime,
          resumeSessionId,
          input.config.cwd,
          normalizedConfig.sessionDir,
        )
      : undefined;
    validateOmpHostToolConfig(effectiveConfig);
    if (input.config.title && utf8Bytes(input.config.title) > 256) {
      throw new OmpPublicError("OMP session title is too large");
    }
    const startOptions: OmpStartOptions = {
      ...normalizedConfig,
      // Thinking is authorized only after this runtime reports its exact model catalog.
      thinkingOption: undefined,
      ...(resumeSessionId ? { systemPrompt: undefined, resumeSessionId } : {}),
      signal,
      environment,
    };
    buildOmpSpawnRequest(startOptions);
    const hostTools = await OmpHostToolsBridge.open(effectiveConfig, {
      connectMcp: mcpConnector,
      signal,
      initializationTimeoutMs: mcpInitializationTimeoutMs,
      reportOperationalFailure,
    });
    let native: OmpRuntimeSession | undefined;
    let cleanupNativeSessionId: string | undefined;
    let unsubscribeBootstrap = () => {};
    let bootstrapConfigRevision = 0;
    try {
      native = await runtime.startSession(startOptions);
      const outputRedactionValues =
        normalizedConfig.outputRedaction === "configured-values"
          ? [...configuredRedactionValues, ...(native.inheritedRedactionValues ?? [])]
          : configuredRedactionValues;
      unsubscribeBootstrap = native.onEvent((event) => {
        if (event.type === "host_tool_call" || event.type === "host_tool_cancel") {
          hostTools.handle(event);
          return;
        }
        if (isRuntimeConfigEvent(event)) bootstrapConfigRevision += 1;
      });
      await hostTools.bind(native);
      const [initialState, nativeModels, commandDiscovery] = await Promise.all([
        native.getState(),
        native.getAvailableModels(),
        native.getAvailableCommands().then(
          (commands) => ({ available: true, commands }),
          () => ({ available: false, commands: [] }),
        ),
      ]);
      validateOmpModelIdentities(nativeModels);
      if (effectiveConfig.persist && !native.canReplayHistory) {
        throw new OmpPublicError("OMP session persistence requires negotiated RPC protocol v2");
      }
      if (capabilities.includes("session.revert.conversation") && !native.canReplayHistory) {
        throw new OmpPublicError("OMP conversation rewind requires negotiated RPC protocol v2");
      }
      let state = initialState;
      if (effectiveConfig.persist || resumeSessionId) {
        cleanupNativeSessionId = validateNativeSessionId(initialState.sessionId);
      }
      if (resumeSessionId && initialState.sessionId !== resumeSessionId) {
        throw new OmpPublicError("OMP resumed a different native session");
      }
      if (!resumeSessionId && input.config.model) {
        const selected = selectOmpModels(nativeModels, state.model).find(
          (model) => ompModelId(model) === input.config.model,
        );
        if (!selected) {
          throw new OmpPublicError("OMP model is not advertised by the configured session runtime");
        }
        if (state.model?.provider !== selected.provider || state.model.id !== selected.id) {
          await native.setModel(selected.provider, selected.id);
          state = await native.getState();
        }
      }
      let currentModel = state.model
        ? nativeModels.find(
            (model) => model.provider === state.model?.provider && model.id === state.model.id,
          )
        : undefined;
      if (state.model && !currentModel) {
        throw new OmpPublicError("OMP runtime selected an unadvertised model");
      }
      if (!resumeSessionId && input.config.thinkingOption !== undefined) {
        if (
          !thinkingForModel(currentModel).some(
            (option) => option.id === input.config.thinkingOption,
          )
        ) {
          throw new OmpPublicError("OMP thinking level is unavailable for the selected model");
        }
        if (state.thinkingLevel !== input.config.thinkingOption) {
          await native.setThinkingLevel(input.config.thinkingOption);
        }
      }
      const reconciledConfigRevision = bootstrapConfigRevision;
      state = await native.getState();
      currentModel = state.model
        ? nativeModels.find(
            (model) => model.provider === state.model?.provider && model.id === state.model.id,
          )
        : undefined;
      if (state.model && !currentModel) {
        throw new OmpPublicError("OMP runtime selected an unadvertised model");
      }
      const selectedNativeModels = selectOmpModels(nativeModels, state.model);
      const models = mapOmpModels(
        selectedNativeModels,
        new OmpPublicDataSerializer(outputRedactionValues),
      );
      const nativeModelsByPublicId = new Map(
        nativeModels.map((model) => [ompModelId(model), model] as const),
      );
      const thinkingOptions = thinkingForModel(currentModel);
      const applicableLevel = applicableThinkingLevel(currentModel, state.thinkingLevel);
      const committedThinkingLevel = thinkingOptions.some((option) => option.id === applicableLevel)
        ? applicableLevel
        : undefined;
      const unsupportedThinkingLevel =
        applicableLevel !== undefined && committedThinkingLevel === undefined;
      const configState: ProviderConfigState = {
        ...(state.model ? { model: ompModelId(state.model) } : {}),
        mode: normalizedConfig.mode ?? "full",
        ...(committedThinkingLevel ? { thinkingOption: committedThinkingLevel } : {}),
        models,
        // OMP fixes approval mode at process launch. Publish only the selected mode so
        // Paseo shows the security state without offering unsupported transitions.
        modes: [fixedSessionMode(normalizedConfig.mode)],
        thinkingOptions,
        settings: [],
      };
      const { signal: _signal, ...recoveryTemplate } = startOptions;
      const recoveryOptions = withCommittedOmpSelection(recoveryTemplate, {
        model: state.model ? nativeOmpModelId(state.model) : undefined,
        thinkingOption: committedThinkingLevel,
      });
      if (!hostTools.isBoundTo(native)) {
        throw new Error("OMP host tool bridge detached during session initialization");
      }
      unsubscribeBootstrap();
      unsubscribeBootstrap = () => {};
      let sessionCapabilities = capabilities;
      if (capabilities.includes("session.subsession")) {
        try {
          await native.setSubagentSubscription("events");
        } catch {
          sessionCapabilities = capabilities.filter(
            (capability) => capability !== "session.subsession",
          );
        }
      }
      const session = new OmpProviderSession(
        input.sessionId,
        native,
        runtime,
        recoveryOptions,
        hostTools,
        state.sessionId,
        persistedDescriptor?.transcriptFile ?? state.sessionFile,
        effectiveConfig,
        configState,
        outputRedactionValues,
        nativeModelsByPublicId,
        sessionCapabilities,
        new Set([
          ...OMP_BUILTIN_COMMANDS.map((command) => command.name),
          ...commandDiscovery.commands.flatMap((command) => [
            command.name,
            ...(command.aliases ?? []),
          ]),
        ]),
        commandDiscovery.commands,
        commandDiscovery.available,
        emit,
        input.history === "replay",
        effectiveConfig.persist,
        replayTimeoutMs,
        transitionNativeSession,
        quarantineRewindCleanup,
        retireRewindSession,
        reportOperationalFailure,
        scheduler,
      );
      session.unsupportedThinkingNoticePending = unsupportedThinkingLevel;

      if (bootstrapConfigRevision !== reconciledConfigRevision) {
        session.configRefreshDirty = true;
      }
      return session;
    } catch (error) {
      unsubscribeBootstrap();
      const directCleanup = [
        Promise.resolve().then(() => hostTools.close()),
        ...(native ? [native] : []).map((session) => Promise.resolve().then(() => session.close())),
      ];
      if (isOmpCleanupFailure(error)) {
        throw new OmpCleanupFailure(
          "OMP session initialization cleanup pending",
          settleSessionCleanup([error.cleanup, ...directCleanup]),
          cleanupNativeSessionId ?? error.nativeSessionId,
        );
      }
      const directResults = await Promise.allSettled(directCleanup);
      const nestedCleanup: Promise<void>[] = [];
      const cleanupFailures: unknown[] = [];
      for (const result of directResults) {
        if (result.status !== "rejected") continue;
        if (isOmpCleanupFailure(result.reason)) nestedCleanup.push(result.reason.cleanup);
        else cleanupFailures.push(result.reason);
      }
      if (nestedCleanup.length > 0 || cleanupFailures.length > 0) {
        const failed =
          cleanupFailures.length > 0
            ? [
                Promise.reject(
                  new AggregateError(cleanupFailures, "OMP session initialization cleanup failed"),
                ),
              ]
            : [];
        throw new OmpCleanupFailure(
          "OMP session initialization cleanup pending",
          settleSessionCleanup([...nestedCleanup, ...failed]),
          cleanupNativeSessionId,
        );
      }
      throw error;
    }
  }

  async publishOpened(requestId: string): Promise<void> {
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities: this.capabilities,
      restoration: "core",
      cwd: this.cwd,
      ...(this.persistSession
        ? { persistence: { version: 1, data: { sessionId: this.nativeSessionId } } }
        : {}),
      ...(this.config.title ? { title: this.dataFilter.text(this.config.title, 256) } : {}),
    });
    this.publishUnsupportedThinkingNotice();
    this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
    if (this.replayHistoryOnOpen) await this.replayHistory(true);
    this.publishCommands(this.commandCatalog);
    this.emit({ type: "session.ready", requestId, sessionId: this.id });
    this.readyPublished = true;
    if (this.configRefreshDirty) this.scheduleCommittedConfigRefresh();
  }
  private publishUnsupportedThinkingNotice(): void {
    if (!this.unsupportedThinkingNoticePending || this.unsupportedThinkingNoticePublished) return;
    this.unsupportedThinkingNoticePending = false;
    this.unsupportedThinkingNoticePublished = true;
    this.emit({
      type: "session.notice",
      sessionId: this.id,
      notice: {
        id: "omp:unsupported-thinking-level",
        severity: "warning",
        title: "OMP thinking level unavailable",
        description:
          "OMP reported a thinking level that the active model does not advertise. Paseo omitted it from the session configuration.",
      },
    });
  }

  private async replayHistory(preferPersistedTranscript = false): Promise<void> {
    if (!this.runtime.canReplayHistory) {
      throw new OmpPublicError("OMP session history cannot be replayed safely");
    }
    this.lifetime.signal.throwIfAborted();
    const replay = new AbortController();
    const onAbort = () =>
      replay.abort(new OmpPublicError("OMP session history replay was canceled"));
    this.lifetime.signal.addEventListener("abort", onAbort, { once: true });
    const timeoutHandle = setTimeout(
      () => replay.abort(new OmpPublicError("OMP session history replay timed out")),
      this.replayTimeoutMs,
    );
    try {
      let messages: OmpMessage[] | undefined;
      // OMP's RPC history is model context, which excludes failed/aborted turns. On initial
      // resume/import prefer the already authorized journal; rewinds still use the runtime's
      // in-memory branch because an uncommitted leaf move is not represented by file order.
      if (
        preferPersistedTranscript &&
        this.nativeSessionFile &&
        this.runtimeFactory.readPersistedSessionTranscript
      ) {
        try {
          const transcript = await waitForReplay(
            this.runtimeFactory.readPersistedSessionTranscript({
              sessionFile: this.nativeSessionFile,
              sessionId: this.nativeSessionId,
              cwd: this.cwd,
              signal: replay.signal,
            }),
            replay.signal,
          );
          messages = transcript.messages;
          if (transcript.imageReplayWarning) {
            this.emit({
              type: "timeline.item",
              sessionId: this.id,
              item: {
                id: "omp:replay-image-unavailable",
                type: "notification",
                level: "warning",
                message: "OMP skipped one or more unavailable images while replaying this session.",
              },
            });
          }
        } catch (error) {
          if (replay.signal.aborted) throw error;
          this.recordOperationalFailure({
            category: "replay-recovery",
            stage: "persisted-replay",
          });
          this.emit({
            type: "timeline.item",
            sessionId: this.id,
            item: {
              id: "omp:replay-incomplete",
              type: "error",
              message:
                "OMP could not read its complete persisted transcript; displayed history may be incomplete.",
            },
          });
        }
      }
      messages ??= await waitForReplay(this.runtime.getMessages(replay.signal), replay.signal);
      this.quarantineBranchEntries();
      for (const message of messages) {
        replay.signal.throwIfAborted();
        const entryId = nativeEntryId(message);
        if (entryId) this.seenEntryIds.add(entryId);
        this.projector.projectReplayMessage(message);
      }
      this.projector.finishReplay();
      await this.subsessions?.replay(messages, this.runtime, this.runtimeFactory, replay.signal);
      replay.signal.throwIfAborted();
    } catch (error) {
      if (replay.signal.aborted) throw replay.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      this.lifetime.signal.removeEventListener("abort", onAbort);
    }
  }
  async revert(input: SessionRevertInput): Promise<void> {
    if (input.scope !== "conversation") {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "OMP supports conversation rewind only" },
      });
      return;
    }
    if (this.activeTurn) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "Cannot rewind the OMP conversation while a turn is active" },
      });
      return;
    }
    if (this.revertInFlight || this.configMutationInFlight || this.activeAbort) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "OMP session is busy" },
      });
      return;
    }

    this.revertInFlight = true;
    let branchMutationPossible = false;
    let runtime = this.runtime;
    let generation = this.generation;
    try {
      await this.recoverRuntime();
      if (this.closed) throw new OmpPublicError("OMP session is closed");
      if (this.activeTurn) {
        throw new OmpPublicError("Cannot rewind the OMP conversation while a turn is active");
      }
      runtime = this.runtime;
      generation = this.generation;
      if (!runtime.canReplayHistory) {
        throw new OmpPublicError("OMP conversation rewind requires negotiated RPC protocol v2");
      }
      const entryId = this.projector.resolveRevertToken(input.token);
      const beforeState = await runtime.getState();
      this.requireCurrentRuntime(runtime, generation);
      if (this.activeTurn || beforeState.isStreaming || beforeState.isCompacting) {
        throw new OmpPublicError("Cannot rewind the OMP conversation while a turn is active");
      }
      const beforeAdvertisedModel = beforeState.model
        ? this.nativeModelsByPublicId.get(ompModelId(beforeState.model))
        : undefined;
      if (beforeState.model && !beforeAdvertisedModel) {
        throw new OmpPublicError("OMP runtime selected an unadvertised model");
      }
      const restorableThinkingLevel = thinkingForModel(beforeAdvertisedModel).some(
        (option) => option.id === beforeState.thinkingLevel,
      )
        ? beforeState.thinkingLevel
        : undefined;
      branchMutationPossible = true;
      let result: OmpBranchResult;
      try {
        result = await runtime.branch(entryId);
      } catch (error) {
        if (error instanceof OmpRpcRequestRejectedError) {
          branchMutationPossible = false;
          throw new OmpPublicError("OMP conversation rewind token is stale");
        }
        throw error;
      }
      this.requireCurrentRuntime(runtime, generation);
      if (result.cancelled) {
        branchMutationPossible = false;
        throw new OmpPublicError("OMP conversation rewind was cancelled");
      }

      let state = await runtime.getState();
      this.requireCurrentRuntime(runtime, generation);
      const nextNativeSessionId = validateNativeSessionId(state.sessionId);
      if (nextNativeSessionId !== this.nativeSessionId) {
        this.transitionNativeSession(this.nativeSessionId, nextNativeSessionId);
        this.nativeSessionId = nextNativeSessionId;
        if (this.persistSession) {
          this.emit({
            type: "session.persistence",
            sessionId: this.id,
            persistence: { version: 1, data: { sessionId: nextNativeSessionId } },
          });
        }
      }

      const modelChanged =
        beforeState.model?.provider !== state.model?.provider ||
        beforeState.model?.id !== state.model?.id;
      const thinkingChanged = beforeState.thinkingLevel !== state.thinkingLevel;
      if (modelChanged) {
        if (!beforeState.model) {
          throw new OmpPublicError("OMP changed model while rewinding the conversation");
        }
        await runtime.setModel(beforeState.model.provider, beforeState.model.id);
      }
      if (thinkingChanged && restorableThinkingLevel) {
        await runtime.setThinkingLevel(restorableThinkingLevel);
      }
      if (modelChanged || (thinkingChanged && restorableThinkingLevel)) {
        state = await runtime.getState();
        this.requireCurrentRuntime(runtime, generation);
      }
      if (
        state.sessionId !== this.nativeSessionId ||
        state.model?.provider !== beforeState.model?.provider ||
        state.model?.id !== beforeState.model?.id ||
        (restorableThinkingLevel !== undefined && state.thinkingLevel !== restorableThinkingLevel)
      ) {
        throw new OmpPublicError("OMP did not preserve session configuration while rewinding");
      }

      this.projector.resetForRewindReplay();
      this.quarantineBranchEntries();
      await this.replayHistory();
      this.requireCurrentRuntime(runtime, generation);
      this.publishCommittedConfig(state, runtime, generation);
      this.emit({ type: "request.completed", requestId: input.requestId });
    } catch (error) {
      this.recordOperationalFailure({ category: "replay-recovery", stage: "rewind" });
      const failure = branchMutationPossible
        ? { message: "OMP conversation rewind left native state indeterminate" }
        : providerError(error, "OMP conversation rewind failed");
      if (branchMutationPossible) {
        await this.closeAfterCommittedRewindFailure(runtime, failure.message);
      }
      this.emit({ type: "request.failed", requestId: input.requestId, error: failure });
      if (branchMutationPossible) {
        this.publishSessionClosed(failure);
        this.retireRewindSession();
      }
    } finally {
      this.revertInFlight = false;
      if (this.configRefreshDirty && !this.configMutationInFlight && !this.closed) {
        this.scheduleCommittedConfigRefresh();
      }
    }
  }
  private async closeAfterCommittedRewindFailure(
    runtime: OmpRuntimeSession,
    message: string,
  ): Promise<void> {
    this.closed = true;
    this.generation += 1;
    this.runtimeDead = message;
    this.configRefreshAttempts = 0;
    this.configRefreshDirty = false;
    const configRefresh = this.configRefreshInFlight;
    this.cancelConfigRefreshRetry();
    this.lifetime.abort(new Error(message));
    this.permissions.resolveAllPermissions(true);
    this.subsessions?.close();
    this.projector.close();
    this.unsubscribe();
    this.unsubscribe = () => {};
    this.hostTools.detach();
    this.runtimeDisposal ??= runtime.close();
    this.hostToolsDisposal ??= this.hostTools.close();
    const cleanup = settleSessionCleanup(
      [
        this.runtimeDisposal,
        this.hostToolsDisposal,
        this.recoveryPromise,
        configRefresh,
        this.configRefreshInFlight,
      ].filter((pending): pending is Promise<void> => pending !== null),
    );
    this.disposalPromise = cleanup;
    this.quarantineRewindCleanup(cleanup);
    await Promise.allSettled([cleanup]);
  }

  async prompt(input: SessionPromptInput): Promise<void> {
    let payload: OmpPromptPayload;
    try {
      payload = promptPayload(input);
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: providerError(error, "OMP prompt was rejected") },
      });
      return;
    }
    if (this.revertInFlight) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "OMP conversation rewind is in progress" } },
      });
      return;
    }

    if (input.prompt.delivery === "steer") {
      await this.steer(input.prompt.clientMessageId, payload);
      return;
    }
    if (
      payload.commandName &&
      payload.commandName !== "compact" &&
      OMP_BUILTIN_COMMANDS.some((command) => command.name === payload.commandName)
    ) {
      await this.runBuiltinCommand(input.prompt.clientMessageId, payload);
      return;
    }
    if (this.activeTurn) {
      await this.routeActivePrompt(
        input.prompt.clientMessageId,
        payload,
        this.activeTurn,
        input.prompt.delivery === "auto" && input.prompt.input.type === "message",
      );
      return;
    }
    try {
      await this.recoverRuntime();
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: providerError(error, "OMP session recovery failed") },
      });
      return;
    }
    if (this.closed) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "OMP session is closed" } },
      });
      return;
    }
    if (this.revertInFlight) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "OMP conversation rewind is in progress" } },
      });
      return;
    }
    if (this.activeTurn) {
      await this.routeActivePrompt(
        input.prompt.clientMessageId,
        payload,
        this.activeTurn,
        input.prompt.delivery === "auto" && input.prompt.input.type === "message",
      );
      return;
    }
    if (this.activeAbort) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "OMP interrupt is still settling" } },
      });
      return;
    }

    if (payload.commandName && !this.slashCommands.has(payload.commandName)) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "OMP command is unavailable" } },
      });
      return;
    }
    let materializedPaths: string[] = [];
    try {
      const prepared = this.preparePromptPayload(payload, "prompt");
      payload = prepared.payload;
      materializedPaths = prepared.materializedPaths;
    } catch (error) {
      this.imageMaterializer.release(materializedPaths);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: providerError(error, "OMP prompt was rejected") },
      });
      return;
    }
    const turn = createActiveTurn(
      input.prompt.clientMessageId,
      payload.text,
      this.generation,
      this.runtimeTurnCompleted ? "ordered-legacy" : "initial-turn",
      slashCommandName(payload.text) === "compact",
    );
    this.activeTurn = turn;
    const runtime = this.runtime;
    try {
      if (turn.manualCompaction) {
        const instructions = payload.text.slice("/compact".length).trim() || undefined;
        const compaction = runtime.compact(instructions);
        this.publishPromptResult(turn, { type: "turn", turnId: turn.turnId });
        turn.starting = false;
        turn.acknowledged = true;
        this.startTurn(turn, false);
        this.compaction.start(turn, "manual");
        this.usage.poll(turn);
        const bufferedEvents = turn.bufferedEvents.splice(0);
        turn.replayingBufferedEvents = true;
        for (const event of bufferedEvents) this.handleTurnEvent(turn, event);
        turn.replayingBufferedEvents = false;
        void this.settleManualCompaction(turn, compaction);
        turn.manualCompactionDeadlineTimer = this.scheduler.set(() => {
          turn.manualCompactionDeadlineTimer = undefined;
          if (
            turn.terminal ||
            this.activeTurn !== turn ||
            turn.generation !== this.generation ||
            !turn.manualCompactionPending
          )
            return;
          const message = "OMP compaction was canceled after it stopped responding";
          turn.manualCompactionPending = false;
          this.invalidateRuntime(message, "canceled");
          void this.finishTurn(turn, "canceled", undefined, true, true);
        }, COMPACTION_MAX_WAIT_MS);
        return;
      }
      const ownershipPending = turn.pendingUsers[0];
      if (
        turn.terminalCorrelation.policy === "ordered-legacy" &&
        !this.branchWatermarkValid &&
        ownershipPending
      ) {
        await this.refreshBranchEntries(turn, ownershipPending);
        if (
          this.closed ||
          turn.terminal ||
          this.activeTurn !== turn ||
          turn.generation !== this.generation
        ) {
          return;
        }
      }
      const acknowledgement = await runtime.prompt(
        payload.text,
        payload.images,
        () => {
          turn.promptAcceptedEventIndex ??= turn.bufferedEvents.length;
        },
        (requestId) => {
          turn.nativeRequestId = requestId;
        },
      );
      if (this.closed || turn.terminal) return;
      turn.nativeRequestId = acknowledgement.requestId;
      this.publishPromptResult(turn, { type: "turn", turnId: turn.turnId });
      this.startTurn(turn);
      turn.starting = false;
      turn.acknowledged = true;
      if (acknowledgement.agentInvoked === true) this.markAgentEvidence(turn);
      if (acknowledgement.agentInvoked === false && turn.agentInvoked !== true) {
        turn.agentInvoked = false;
        turn.localOnlyEligible = true;
      }
      const bufferedEvents = turn.bufferedEvents.splice(0);
      turn.replayingBufferedEvents = true;
      const preAcceptanceEvents = bufferedEvents.splice(
        0,
        turn.promptAcceptedEventIndex ?? bufferedEvents.length,
      );
      for (const event of preAcceptanceEvents) this.handleTurnEvent(turn, event, false);
      this.projector.acceptLiveTurn(turn.turnId);
      for (const event of bufferedEvents) this.handleTurnEvent(turn, event);
      turn.replayingBufferedEvents = false;
      if (
        acknowledgement.agentInvoked === false &&
        turn.agentInvoked !== true &&
        !turn.nativeActivity &&
        !turn.awaitingPermissionEvidence
      ) {
        this.scheduleLocalOnlyCompletion(turn);
      }
    } catch (error) {
      this.imageMaterializer.release(materializedPaths);
      const failure = providerError(error, "OMP prompt failed");
      if (this.isCurrentRuntime(runtime, turn.generation)) {
        this.handleRuntimeFailure(failure.message);
        return;
      }
      this.publishPendingUsers(turn);
      this.publishPromptResult(turn, { type: "failed", error: failure });
      this.subsessions?.terminalize("failed");
      if (turn.started) await this.finishTurn(turn, "failed", failure);
      else {
        turn.steerReady.resolve();
        turn.terminal = true;
        this.compaction.finish("failed", { message: "OMP prompt failed" });
        this.permissions.resolveTurnPermissions(turn.turnId);
        this.projector.finishTurn(turn.turnId);
        if (this.activeTurn === turn) this.activeTurn = null;
      }
    }
  }
  private preparePromptPayload(
    payload: OmpPromptPayload,
    delivery: "prompt" | "steer",
  ): {
    payload: OmpPromptPayload;
    materializedPaths: string[];
  } {
    const currentModel = this.configState.model
      ? this.nativeModelsByPublicId.get(this.configState.model)
      : undefined;
    // OMP chunks protocol v2 output only; every stdin command must fit one physical frame.
    const inlineImagesFit =
      this.runtime.maxInputFrameBytes === undefined ||
      inlinePromptFrameBytes(payload, delivery) <= this.runtime.maxInputFrameBytes;
    if (
      payload.images.length === 0 ||
      (currentModel?.input?.includes("image") && inlineImagesFit)
    ) {
      return { payload, materializedPaths: [] };
    }
    const materializedPaths: string[] = [];
    try {
      for (const image of payload.images) {
        if (!isOmpImageMimeType(image.mimeType)) {
          throw new OmpPublicError("OMP prompt image is invalid");
        }
        materializedPaths.push(this.imageMaterializer.materialize(image.data, image.mimeType));
      }
      const hints = materializedPaths.map((path) => `[Image available at: ${path}]`);
      const text = [payload.text, ...hints].filter(Boolean).join("\n\n");
      if (utf8Bytes(text) > MAX_PROMPT_TEXT_LENGTH) {
        throw new OmpPublicError("OMP prompt is too large");
      }
      return { payload: { ...payload, text, images: [] }, materializedPaths };
    } catch (error) {
      this.imageMaterializer.release(materializedPaths);
      throw error;
    }
  }

  private async runBuiltinCommand(
    clientMessageId: string,
    payload: OmpPromptPayload,
  ): Promise<void> {
    const commandName = payload.commandName;
    if (!commandName) return;
    const argumentsText = payload.text.slice(commandName.length + 1).trim();
    try {
      if (commandName === "steer") {
        if (!argumentsText) throw new OmpPublicError("Usage: /steer <message>");
        await this.steer(clientMessageId, { text: argumentsText, images: [] });
        return;
      }
      if (this.activeTurn && (commandName === "handoff" || commandName === "follow-up")) {
        throw new OmpPublicError("OMP already has an active turn; send this message as a steer");
      }
      await this.recoverRuntime();
      if (this.closed) throw new OmpPublicError("OMP session is closed");
      if (commandName === "follow-up") {
        if (!argumentsText) throw new OmpPublicError("Usage: /follow-up <message>");
        await this.startNativeCommandTurn(clientMessageId, argumentsText, () =>
          this.runtime.followUp(argumentsText),
        );
        return;
      }
      if (commandName === "handoff") {
        await this.startNativeCommandTurn(clientMessageId, payload.text, () =>
          this.runtime.handoff(argumentsText || undefined),
        );
        return;
      }
      if (commandName === "autocompact") {
        const requested = argumentsText.toLowerCase() || "toggle";
        if (!["on", "off", "toggle"].includes(requested)) {
          throw new OmpPublicError("Usage: /autocompact [on|off|toggle]");
        }
        let enabled = requested === "on";
        if (requested === "toggle") {
          const state = await this.runtime.getState();
          if (typeof state.autoCompactionEnabled !== "boolean") {
            throw new OmpPublicError(
              "Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
            );
          }
          enabled = !state.autoCompactionEnabled;
        }
        await this.runtime.setAutoCompaction(enabled);
        this.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: {
            id: `omp:command:${randomUUID()}`,
            type: "assistant_message",
            text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
          },
        });
      }
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "completed" },
      });
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "failed", error: providerError(error, "OMP command failed") },
      });
    }
  }

  private async startNativeCommandTurn(
    clientMessageId: string,
    text: string,
    invoke: () => Promise<void>,
  ): Promise<void> {
    if (this.activeTurn) {
      throw new OmpPublicError("OMP already has an active turn; send this message as a steer");
    }
    const turn = createActiveTurn(clientMessageId, text, this.generation, "native-command");
    this.activeTurn = turn;
    try {
      await invoke();
      if (this.closed || turn.terminal || this.activeTurn !== turn) {
        if (!turn.terminal) {
          this.publishPendingUsers(turn);
          this.publishPromptResult(turn, {
            type: "failed",
            error: {
              message: this.closed ? "OMP session is closed" : "OMP command lost turn ownership",
            },
          });
          this.settleUnstartedTurn(turn);
        }
        return;
      }
      this.publishPromptResult(turn, { type: "turn", turnId: turn.turnId });
      turn.starting = false;
      turn.acknowledged = true;
      this.startTurn(turn);
      const bufferedEvents = turn.bufferedEvents.splice(0);
      turn.replayingBufferedEvents = true;
      this.projector.acceptLiveTurn(turn.turnId);
      for (const event of bufferedEvents) this.handleTurnEvent(turn, event);
      turn.replayingBufferedEvents = false;
    } catch (error) {
      if (turn.terminal) return;
      const ownsTurn = this.activeTurn === turn;
      const failure = providerError(error, "OMP command failed");
      this.publishPendingUsers(turn);
      this.publishPromptResult(turn, { type: "failed", error: failure });
      this.settleUnstartedTurn(turn);
      if (ownsTurn) this.imageMaterializer.clear();
    }
  }

  private async settleManualCompaction(
    turn: ActiveTurn,
    compaction: Promise<OmpCompactionResult>,
  ): Promise<void> {
    try {
      const result = await compaction;
      turn.manualCompactionPending = false;
      if (this.closed || this.runtimeDead || turn.generation !== this.generation) return;
      this.compaction.finish("completed", { tokensBefore: result.tokensBefore });
      await this.finishTurn(turn, turn.interrupted ? "canceled" : "completed");
    } catch (error) {
      if (this.closed || this.runtimeDead || turn.generation !== this.generation) return;
      turn.manualCompactionPending = false;
      const raw = providerError(error, "OMP compaction failed");
      const failure = { message: this.dataFilter.text(raw.message, 4_096) };
      const state = turn.interrupted ? "canceled" : "failed";
      this.compaction.finish(state, { message: failure.message });
      await this.finishTurn(turn, state, state === "failed" ? failure : undefined, true, true);
    }
  }

  async interrupt(input: SessionInterruptInput): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      this.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    if (turn.manualCompaction) {
      turn.interrupted = true;
      turn.manualCompactionPending = false;
      this.invalidateRuntime("OMP compaction interrupted", "canceled");
      await this.finishTurn(turn, "canceled", undefined, true, true);
      this.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    const forceTerminal = turn.awaitingPermissionEvidence;
    turn.awaitingPermissionEvidence = false;
    if (forceTerminal) this.permissions.resolveTurnPermissions(turn.turnId);
    const pending = this.activeAbort;
    if (turn.interrupted) {
      if (pending?.turn === turn) await this.settleInterrupt(input.requestId, pending);
      else this.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    turn.interrupted = true;
    const runtime = this.runtime;
    const abort: PendingAbort = {
      turn,
      generation: turn.generation,
      runtime,
      forceTerminal,
      promise: runtime.abort(),
    };
    this.activeAbort = abort;
    await this.settleInterrupt(input.requestId, abort);
  }

  private async settleInterrupt(requestId: string, abort: PendingAbort): Promise<void> {
    try {
      await abort.promise;
      if (
        (abort.turn.terminalizing || abort.forceTerminal) &&
        !abort.turn.terminal &&
        this.activeTurn === abort.turn
      ) {
        await this.finishTurn(abort.turn, "canceled", undefined, true, true);
      }
      this.emit({ type: "request.completed", requestId });
    } catch (error) {
      const { runtime, turn } = abort;
      if (
        this.runtimeDead ||
        turn.terminal ||
        turn.generation !== this.generation ||
        this.runtime !== runtime
      ) {
        await this.runtimeDisposal?.catch(() => undefined);
        this.emit({ type: "request.completed", requestId });
        return;
      }
      turn.interrupted = false;
      this.emit({
        type: "request.failed",
        requestId,
        error: providerError(error, "OMP interrupt failed"),
      });
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  beginConnectionShutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new Error("OMP provider connection closed"));
    this.unsubscribe();
    this.unsubscribe = () => {};
    const turn = this.activeTurn;
    if (turn && !turn.started) {
      this.publishPromptResult(turn, {
        type: "failed",
        error: { message: "OMP session closed before the prompt was accepted" },
      });
      this.settleUnstartedTurn(turn);
    }
  }
  async configure(input: SessionConfigureInput): Promise<void> {
    if (this.revertInFlight) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "OMP conversation rewind is in progress" },
      });
      return;
    }
    if (this.configMutationInFlight) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "OMP configuration is already in progress" },
      });
      return;
    }
    const runtime = this.runtime;
    const generation = this.generation;
    this.configMutationInFlight = true;
    let mutationAttempted = false;
    try {
      if (!this.isCurrentRuntime(runtime, generation)) {
        throw new OmpPublicError("OMP session is unavailable for configuration");
      }
      if (input.changes.mode !== undefined && input.changes.mode !== this.configState.mode) {
        throw new OmpPublicError(
          "OMP approval mode cannot change live; create a new session instead",
        );
      }
      if (input.changes.settings && Object.keys(input.changes.settings).length > 0) {
        throw new OmpPublicError("OMP does not expose live provider settings");
      }
      if (input.changes.model === null || input.changes.thinkingOption === null) {
        throw new OmpPublicError("OMP model and thinking selections cannot be cleared");
      }
      const targetModelId = input.changes.model ?? this.configState.model;
      const targetModel = targetModelId
        ? this.nativeModelsByPublicId.get(targetModelId)
        : undefined;
      const targetModelPublished = this.configState.models.some(
        (model) => model.id === targetModelId,
      );
      if (input.changes.model !== undefined && (!targetModel || !targetModelPublished)) {
        throw new OmpPublicError("OMP model selection is unavailable");
      }
      if (
        input.changes.thinkingOption !== undefined &&
        !thinkingForModel(targetModel).some((option) => option.id === input.changes.thinkingOption)
      ) {
        throw new OmpPublicError("OMP thinking level is unavailable for the selected model");
      }
      if (input.changes.model !== undefined || input.changes.thinkingOption !== undefined) {
        this.configRevision += 1;
      }
      if (input.changes.model && targetModel) {
        mutationAttempted = true;
        await runtime.setModel(targetModel.provider, targetModel.id);
        this.requireCurrentRuntime(runtime, generation);
      }
      if (input.changes.thinkingOption) {
        mutationAttempted = true;
        await runtime.setThinkingLevel(input.changes.thinkingOption);
        this.requireCurrentRuntime(runtime, generation);
      }
      const state = await runtime.getState();
      this.requireCurrentRuntime(runtime, generation);
      if (!this.publishCommittedConfig(state, runtime, generation)) {
        throw new OmpPublicError("OMP session changed before configuration committed");
      }
      const committedModel = state.model ? ompModelId(state.model) : undefined;
      if (input.changes.model !== undefined && input.changes.model !== committedModel) {
        throw new OmpPublicError("OMP did not commit the requested model");
      }
      if (
        input.changes.thinkingOption !== undefined &&
        input.changes.thinkingOption !== state.thinkingLevel
      ) {
        throw new OmpPublicError("OMP did not commit the requested thinking level");
      }
      this.requireCurrentRuntime(runtime, generation);
      this.emit({ type: "request.completed", requestId: input.requestId });
    } catch (error) {
      if (error instanceof OmpCatalogEscape && this.isCurrentRuntime(runtime, generation)) {
        this.handleRuntimeFailure(error.message);
      } else if (mutationAttempted && this.isCurrentRuntime(runtime, generation)) {
        const state = await this.readRuntimeStateWithTimeout(runtime);
        if (state && this.isCurrentRuntime(runtime, generation)) {
          try {
            this.publishCommittedConfig(state, runtime, generation);
          } catch (refreshError) {
            if (
              refreshError instanceof OmpCatalogEscape &&
              this.isCurrentRuntime(runtime, generation)
            ) {
              this.handleRuntimeFailure(refreshError.message);
            }
          }
        }
      }
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: providerError(error, "OMP configuration failed"),
      });
    } finally {
      this.configMutationInFlight = false;
      if (this.configRefreshDirty && this.isCurrentRuntime(runtime, generation)) {
        this.scheduleCommittedConfigRefresh();
      }
    }
  }

  private isCurrentRuntime(runtime: OmpRuntimeSession, generation: number): boolean {
    return (
      !this.closed &&
      this.runtimeDead === null &&
      this.runtime === runtime &&
      this.generation === generation
    );
  }

  private requireCurrentRuntime(runtime: OmpRuntimeSession, generation: number): void {
    if (!this.isCurrentRuntime(runtime, generation)) {
      throw new OmpPublicError("OMP session changed while configuration was pending");
    }
  }

  private scheduleCommittedConfigRefresh(): void {
    this.configRefreshDirty = true;
    if (!this.readyPublished) return;
    if (
      this.configRefreshInFlight ||
      this.configRefreshRetryResolve ||
      this.configMutationInFlight ||
      this.revertInFlight
    ) {
      return;
    }
    const runtime = this.runtime;
    const generation = this.generation;
    const refresh = this.refreshCommittedConfig(runtime, generation);
    this.configRefreshInFlight = refresh;
    const settleRefresh = (failed: boolean) => {
      if (this.configRefreshInFlight !== refresh) return;
      this.configRefreshInFlight = null;
      try {
        if (failed) this.scheduleConfigRefreshRetry(runtime, generation);
        else if (this.configRefreshDirty && this.isCurrentRuntime(runtime, generation)) {
          this.scheduleCommittedConfigRefresh();
        }
      } catch {
        this.configRefreshDirty = false;
        if (this.isCurrentRuntime(runtime, generation)) {
          try {
            this.handleRuntimeFailure("OMP runtime configuration refresh failed");
          } catch {
            // The runtime was already invalidated; detached refresh failures are contained.
          }
        }
      }
    };
    void refresh.then(
      () => settleRefresh(false),
      () => settleRefresh(true),
    );
  }

  private async refreshCommittedConfig(
    runtime: OmpRuntimeSession,
    generation: number,
  ): Promise<void> {
    this.configRefreshDirty = false;
    const revision = this.configRevision;
    const state = await this.readRuntimeStateWithTimeout(runtime);
    if (!this.isCurrentRuntime(runtime, generation)) return;
    if (revision !== this.configRevision) {
      this.configRefreshDirty = true;
      return;
    }
    if (!state) {
      this.scheduleConfigRefreshRetry(runtime, generation);
      return;
    }
    try {
      this.publishCommittedConfig(state, runtime, generation);
    } catch (error) {
      if (error instanceof OmpCatalogEscape) {
        this.handleRuntimeFailure(error.message);
        return;
      }
      this.scheduleConfigRefreshRetry(runtime, generation);
    }
  }

  private scheduleConfigRefreshRetry(runtime: OmpRuntimeSession, generation: number): void {
    if (!this.isCurrentRuntime(runtime, generation)) return;
    this.configRefreshDirty = true;
    this.configRefreshAttempts += 1;
    if (this.configRefreshAttempts >= CONFIG_REFRESH_MAX_ATTEMPTS) {
      this.configRefreshDirty = false;
      this.handleRuntimeFailure("OMP runtime configuration state remained unavailable");
      return;
    }
    if (this.configRefreshRetryResolve) return;
    const retry = Promise.withResolvers<void>();
    const delayMs = CONFIG_REFRESH_RETRY_BASE_MS * 2 ** (this.configRefreshAttempts - 1);
    const timer = this.scheduler.set(retry.resolve, delayMs);
    this.configRefreshRetryHandle = timer;
    this.configRefreshRetryResolve = retry.resolve;
    const finishRetry = () => {
      if (this.configRefreshRetryResolve !== retry.resolve) return;
      this.configRefreshRetryHandle = null;
      this.configRefreshRetryResolve = null;
      try {
        this.scheduler.clear(timer);
      } catch {
        // The one-shot callback already fired; a cleanup failure must not wedge refreshes.
      }
      if (this.configRefreshDirty && this.isCurrentRuntime(runtime, generation)) {
        this.scheduleCommittedConfigRefresh();
      }
    };
    void retry.promise.then(finishRetry, finishRetry);
  }

  private cancelConfigRefreshRetry(): void {
    const resolve = this.configRefreshRetryResolve;
    if (!resolve) return;
    const handle = this.configRefreshRetryHandle;
    this.configRefreshRetryHandle = null;
    this.configRefreshRetryResolve = null;
    if (handle !== null) {
      try {
        this.scheduler.clear(handle);
      } catch {
        // Resolving below is authoritative even when scheduler cleanup reports failure.
      }
    }
    resolve();
  }

  private async readRuntimeStateWithTimeout(
    runtime: OmpRuntimeSession,
  ): Promise<OmpSessionState | undefined> {
    const stateRequest = runtime.getState();
    void stateRequest.catch(() => undefined);
    const timeout = Promise.withResolvers<null>();
    const timer = this.scheduler.set(() => timeout.resolve(null), AGENT_END_STATE_TIMEOUT_MS);
    try {
      return (await Promise.race([stateRequest, timeout.promise])) ?? undefined;
    } catch {
      return undefined;
    } finally {
      this.scheduler.clear(timer);
    }
  }

  private async readRuntimeHistoryWithTimeout(
    runtime: OmpRuntimeSession,
  ): Promise<OmpMessage[] | undefined> {
    if (!runtime.canReplayHistory) return undefined;
    const historyRequest = runtime.getMessages();
    void historyRequest.catch(() => undefined);
    const timeout = Promise.withResolvers<null>();
    const timer = this.scheduler.set(() => timeout.resolve(null), AGENT_END_HISTORY_TIMEOUT_MS);
    try {
      return (await Promise.race([historyRequest, timeout.promise])) ?? undefined;
    } catch {
      return undefined;
    } finally {
      this.scheduler.clear(timer);
    }
  }

  private publishCommittedConfig(
    state: OmpSessionState,
    runtime: OmpRuntimeSession,
    generation: number,
    force = false,
  ): boolean {
    if (!this.isCurrentRuntime(runtime, generation)) return false;
    const publicModelId = state.model ? ompModelId(state.model) : undefined;
    const advertisedModel = publicModelId
      ? this.nativeModelsByPublicId.get(publicModelId)
      : undefined;
    if (state.model && !advertisedModel) {
      throw new OmpCatalogEscape("OMP runtime selected an unadvertised model");
    }
    const thinkingOptions = thinkingForModel(advertisedModel);
    const applicableLevel = applicableThinkingLevel(advertisedModel, state.thinkingLevel);
    const committedThinkingLevel = thinkingOptions.some((option) => option.id === applicableLevel)
      ? applicableLevel
      : undefined;
    if (applicableLevel !== undefined && committedThinkingLevel === undefined) {
      this.unsupportedThinkingNoticePending = true;
      this.publishUnsupportedThinkingNotice();
    }
    const models = mapOmpModels(
      selectOmpModels([...this.nativeModelsByPublicId.values()], state.model),
      this.dataFilter,
    );
    this.configRefreshAttempts = 0;
    this.cancelConfigRefreshRetry();
    const nextConfig: ProviderConfigState = {
      ...this.configState,
      ...(publicModelId ? { model: publicModelId } : { model: undefined }),
      ...(committedThinkingLevel
        ? { thinkingOption: committedThinkingLevel }
        : { thinkingOption: undefined }),
      models,
      thinkingOptions,
    };
    const changed =
      force ||
      nextConfig.model !== this.configState.model ||
      nextConfig.thinkingOption !== this.configState.thinkingOption ||
      nextConfig.models.some((model, index) => model.id !== this.configState.models[index]?.id) ||
      this.configState.models.length !== nextConfig.models.length ||
      nextConfig.thinkingOptions.length !== this.configState.thinkingOptions.length ||
      nextConfig.thinkingOptions.some(
        (option, index) =>
          option.id !== this.configState.thinkingOptions[index]?.id ||
          option.isDefault !== this.configState.thinkingOptions[index]?.isDefault,
      );
    this.configState = nextConfig;
    this.recoveryOptions = withCommittedOmpSelection(this.recoveryOptions, {
      model: state.model ? nativeOmpModelId(state.model) : undefined,
      thinkingOption: this.configState.thinkingOption,
    });
    if (changed) {
      this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
    }
    return true;
  }

  abortOpen(): Promise<void> {
    this.disposalPromise ??= this.disposeSession();
    return this.disposalPromise;
  }

  async permission(input: SessionPermissionInput): Promise<void> {
    await this.permissions.respond(input);
  }

  close(input?: SessionCloseInput): Promise<void> {
    this.disposalPromise ??= this.disposeSession();
    return this.disposalPromise.then(
      () => {
        this.publishSessionClosed();
        if (input) this.emit({ type: "request.completed", requestId: input.requestId });
      },
      (error) => {
        const failure = providerError(error, "OMP session close failed");
        this.publishSessionClosed(failure);
        if (input) {
          this.emit({ type: "request.failed", requestId: input.requestId, error: failure });
          return;
        }
        throw error;
      },
    );
  }

  private async disposeSession(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error("OMP provider session closed"));
    const turn = this.activeTurn;
    if (turn) {
      this.publishPromptResult(turn, {
        type: "failed",
        error: { message: "OMP session closed before the prompt was accepted" },
      });
      if (turn.started) await this.finishTurn(turn, "canceled", undefined, true, true);
      else {
        this.settleUnstartedTurn(turn);
        this.compaction.finish("canceled");
      }
    }
    this.imageMaterializer.clear();
    this.compaction.finish("canceled");
    this.permissions.resolveAllPermissions(true);
    this.closed = true;
    this.configRefreshAttempts = 0;
    this.configRefreshDirty = false;
    const configRefresh = this.configRefreshInFlight;
    this.cancelConfigRefreshRetry();
    this.lifetime.abort(new Error("OMP provider session closed"));
    this.subsessions?.close();
    this.projector.close();
    this.unsubscribe();
    this.hostTools.detach();
    this.runtimeDisposal ??= this.runtime.close();
    this.hostToolsDisposal ??= this.hostTools.close();
    const cleanupErrors: unknown[] = [];
    const deferredCleanup: Promise<void>[] = [];
    const seenCleanup = new Set<Promise<void>>();
    const seenCoordination = new Set<Promise<void>>();
    while (true) {
      const cleanup = [this.runtimeDisposal, this.hostToolsDisposal].filter(
        (promise): promise is Promise<void> => promise !== null && !seenCleanup.has(promise),
      );
      const coordination = [this.recoveryPromise, configRefresh, this.configRefreshInFlight].filter(
        (promise): promise is Promise<void> => promise !== null && !seenCoordination.has(promise),
      );
      if (cleanup.length === 0 && coordination.length === 0) break;
      for (const promise of cleanup) seenCleanup.add(promise);
      for (const promise of coordination) seenCoordination.add(promise);
      const results = await Promise.allSettled([...cleanup, ...coordination]);
      for (const result of results.slice(0, cleanup.length)) {
        if (result.status !== "rejected") continue;
        if (isOmpCleanupFailure(result.reason)) {
          if (!seenCleanup.has(result.reason.cleanup)) deferredCleanup.push(result.reason.cleanup);
          continue;
        }
        cleanupErrors.push(result.reason);
      }
    }
    if (deferredCleanup.length > 0) {
      const failed =
        cleanupErrors.length > 0
          ? [Promise.reject(new AggregateError(cleanupErrors, "OMP session cleanup failed"))]
          : [];
      throw new OmpCleanupFailure(
        "OMP session cleanup pending",
        settleSessionCleanup([...deferredCleanup, ...failed]),
        this.persistenceSessionId,
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "OMP session cleanup failed");
    }
  }

  private publishSessionClosed(error?: { message: string }): void {
    if (this.sessionClosedPublished) return;
    this.sessionClosedPublished = true;
    this.emit({ type: "session.closed", sessionId: this.id, ...(error ? { error } : {}) });
  }

  private bindRuntime(runtime: OmpRuntimeSession): void {
    this.unsubscribe();
    this.runtime = runtime;
    this.configRefreshAttempts = 0;
    this.runtimeTurnCompleted = false;
    const generation = this.generation;
    this.unsubscribe = runtime.onEvent((event) => {
      if (generation !== this.generation) return;
      if (event.type === "host_tool_call" || event.type === "host_tool_cancel") {
        this.hostTools.handle(event);
        return;
      }
      this.handleRuntimeEvent(event);
    });
  }

  private async recoverRuntime(): Promise<void> {
    if (!this.runtimeDead) return;
    this.recoveryPromise ??= this.startRecovery().catch((error) => {
      this.recordOperationalFailure({
        category: "replay-recovery",
        stage: "runtime-recovery",
      });
      throw error;
    });
    try {
      await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  private async startRecovery(): Promise<void> {
    if (!this.persistSession) {
      throw new OmpPublicError(
        "OMP cannot recover a non-persisted session; create a new session instead",
      );
    }
    const expectedSessionId = this.persistSession ? this.nativeSessionId : undefined;
    if (this.persistSession && !expectedSessionId) {
      throw new Error("OMP cannot recover because the original native session handle is missing");
    }
    const recoverFromNativeConfig = this.recoveryUsesNativeConfig;
    await this.runtimeDisposal;
    if (this.closed) throw new Error("OMP session closed while runtime recovery was pending");
    let recovered: OmpRuntimeSession;
    try {
      recovered = await this.runtimeFactory.startSession({
        ...this.recoveryOptions,
        ...(recoverFromNativeConfig ? { model: undefined, thinkingOption: undefined } : {}),
        ...(expectedSessionId ? { resumeSessionId: expectedSessionId } : {}),
        signal: this.lifetime.signal,
      });
    } catch (error) {
      if (isOmpCleanupFailure(error)) {
        this.runtimeDisposal = Promise.reject(error);
        void this.runtimeDisposal.catch(() => undefined);
      }
      throw error;
    }
    let unsubscribeBootstrap = () => {};
    let bootstrapConfigRevision = 0;
    try {
      unsubscribeBootstrap = recovered.onEvent((event) => {
        if (event.type === "host_tool_call" || event.type === "host_tool_cancel") {
          this.hostTools.handle(event);
          return;
        }
        if (isRuntimeConfigEvent(event)) bootstrapConfigRevision += 1;
      });
      await this.hostTools.bind(recovered);
      let state = await recovered.getState();
      const reconciledConfigRevision = bootstrapConfigRevision;
      state = await recovered.getState();
      if (expectedSessionId && state.sessionId !== expectedSessionId) {
        throw new Error(
          `OMP resumed native session '${state.sessionId}' instead of '${expectedSessionId}'`,
        );
      }
      if (!expectedSessionId) this.nativeSessionId = state.sessionId;
      const recoveredModel = state.model ? nativeOmpModelId(state.model) : undefined;
      if (
        !recoverFromNativeConfig &&
        bootstrapConfigRevision === 0 &&
        recoveredModel !== this.recoveryOptions.model
      ) {
        throw new Error("OMP recovered with a different model");
      }
      const advertisedModel = state.model
        ? this.nativeModelsByPublicId.get(ompModelId(state.model))
        : undefined;
      if (state.model && !advertisedModel) {
        throw new Error("OMP recovered with an unadvertised model");
      }
      if (this.closed) throw new Error("OMP session closed while runtime recovery was pending");
      if (!this.hostTools.isBoundTo(recovered)) {
        throw new Error("OMP host tool bridge detached during recovery");
      }
      if (this.subsessions) await recovered.setSubagentSubscription("events");
      this.generation += 1;
      this.usage.clearLatest();
      this.runtimeDead = null;
      this.runtimeDisposal = null;
      unsubscribeBootstrap();
      unsubscribeBootstrap = () => {};
      this.bindRuntime(recovered);
      if (!this.publishCommittedConfig(state, recovered, this.generation, true)) {
        throw new Error("OMP session changed while recovery configuration was pending");
      }
      this.recoveryUsesNativeConfig = false;

      if (bootstrapConfigRevision !== reconciledConfigRevision) {
        this.scheduleCommittedConfigRefresh();
      }
    } catch (error) {
      unsubscribeBootstrap();
      this.hostTools.detach();
      this.runtimeDisposal = recovered.close();
      void this.runtimeDisposal.catch(() => undefined);
      throw error;
    }
  }
  private async routeActivePrompt(
    clientMessageId: string,
    payload: OmpPromptPayload,
    turn: ActiveTurn,
    autoSteer: boolean,
  ): Promise<void> {
    if (!autoSteer) {
      this.publishSteerFailure(
        clientMessageId,
        "OMP already has an active turn; send this message as a steer",
      );
      return;
    }
    if (turn.starting) await turn.steerReady.promise;
    await this.steer(clientMessageId, payload, turn);
  }

  private async steer(
    clientMessageId: string,
    payload: OmpPromptPayload,
    expectedTurn = this.activeTurn,
  ): Promise<void> {
    const turn = expectedTurn;
    if (!this.isSteerableTurn(turn)) {
      this.publishSteerFailure(clientMessageId, "There is no active OMP turn to steer");
      return;
    }
    const commandName = slashCommandName(payload.text);
    const slashCommandUnavailable = commandName
      ? await this.slashSteerUnavailable(commandName)
      : false;
    if (!this.isSteerableTurn(turn)) {
      this.publishSteerFailure(clientMessageId, "There is no active OMP turn to steer");
      return;
    }
    if (slashCommandUnavailable) {
      this.publishSteerFailure(
        clientMessageId,
        "OMP slash commands are unavailable while steering",
      );
      return;
    }

    let materializedPaths: string[] = [];
    try {
      const prepared = this.preparePromptPayload(payload, "steer");
      payload = prepared.payload;
      materializedPaths = prepared.materializedPaths;
    } catch (error) {
      this.imageMaterializer.release(materializedPaths);
      this.publishSteerFailure(clientMessageId, providerError(error, "OMP steer failed").message);
      return;
    }
    const pending: PendingUser = {
      clientMessageId,
      text: payload.text,
      accepted: false,
      fallbackOnFinish: false,
      bufferedEchoes: [],
    };
    if (
      turn.pendingUsers.length >= MAX_PENDING_USERS ||
      retainedBytes(turn.pendingUsers, MAX_PENDING_USER_BYTES) +
        boundedJsonBytes(pending, MAX_PENDING_USER_BYTES, MAX_USER_ECHOES) >
        MAX_PENDING_USER_BYTES
    ) {
      this.imageMaterializer.release(materializedPaths);
      this.publishSteerFailure(clientMessageId, "OMP has too many pending steer messages");
      return;
    }
    turn.pendingUsers.push(pending);
    turn.steersInFlight += 1;
    this.cancelLocalOnlyCompletion(turn);
    try {
      await this.runtime.steer(payload.text, payload.images);
      turn.steersInFlight -= 1;
      if (turn.terminal || turn.terminalizing || this.activeTurn !== turn) {
        this.imageMaterializer.release(materializedPaths);
        this.removePendingUser(turn, pending);
        this.emit({
          type: "session.prompt_result",
          sessionId: this.id,
          clientMessageId,
          result: {
            type: "failed",
            error: { message: "The active OMP turn ended before the steer was accepted" },
          },
        });
        this.resumeAfterFailedSteer(turn);
        return;
      }
      turn.localOnlyDisabled = true;
      this.cancelAmbiguousTerminal(turn);
      turn.deferredAgentEnd = undefined;
      this.acceptPendingUser(turn, pending);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "steer", turnId: turn.turnId },
      });
    } catch (error) {
      this.imageMaterializer.release(materializedPaths);
      turn.steersInFlight -= 1;
      this.removePendingUser(turn, pending);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "failed", error: providerError(error, "OMP steer failed") },
      });
      this.resumeAfterFailedSteer(turn);
    }
  }

  private handleRuntimeEvent(event: OmpRpcEvent): void {
    if (this.closed) return;
    if (
      event.type === "subagent_lifecycle" ||
      event.type === "subagent_progress" ||
      event.type === "subagent_event"
    ) {
      try {
        this.subsessions?.handle(event);
      } catch {
        this.recordOperationalFailure({
          category: "tool-projector",
          stage: "subsession-projector",
        });
        this.handleRuntimeFailure("OMP subagent event processing failed");
      }
      return;
    }
    if (event.type === "available_commands_update") {
      this.replaceSlashCommands(event.commands);
      this.commandCatalog = event.commands;
      this.publishCommands(event.commands);
      return;
    }
    if (event.type === "tool_approval_request") {
      if (!this.capabilities.includes("permission") || !this.runtime.supportsTypedToolApprovals) {
        this.handleRuntimeFailure("OMP emitted an unnegotiated tool approval request");
        return;
      }
      this.permissions.publishToolPermission(event);
      return;
    }
    if (event.type === "tool_approval_cancel") {
      if (!this.runtime.supportsTypedToolApprovals) {
        this.handleRuntimeFailure("OMP emitted an unnegotiated tool approval cancellation");
        return;
      }
      this.permissions.cancelToolPermission(event);
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "cancel") {
        this.permissions.clearPendingFreeformSelection(event.targetId);
        this.permissions.resolvePermissionByNativeId(event.targetId ?? "");
        return;
      }
      if (event.method === "input" && this.permissions.submitPendingFreeformSelection(event))
        return;
      if (
        event.method === "select" ||
        event.method === "confirm" ||
        event.method === "input" ||
        event.method === "editor"
      ) {
        if (!this.capabilities.includes("permission")) {
          this.handleRuntimeFailure();
          return;
        }
        this.permissions.publishPermission(event);
        return;
      }

      if (isPassiveUiMethod(event.method)) {
        this.projector.projectPassive(event);
        return;
      }
      this.handleRuntimeFailure();
      return;
    }
    if (
      event.type === "config_warnings_changed" ||
      event.type === "advisor_cost_changed" ||
      event.type === "ttsr_triggered"
    ) {
      return;
    }
    if (event.type === "irc_message") {
      this.projector.projectPassive(event);
      return;
    }
    if (
      event.type === "notice" ||
      event.type === "todo_reminder" ||
      event.type === "todo_auto_clear" ||
      event.type === "goal_updated" ||
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "advisor_yielded"
    ) {
      this.projector.projectPassive(event);
      return;
    }
    if (event.type === "process_exit") {
      this.handleRuntimeFailure();
      return;
    }
    if (event.type === "retry_fallback_applied" || event.type === "retry_fallback_succeeded") {
      this.projector.projectPassive(event);
      this.scheduleCommittedConfigRefresh();
      return;
    }
    if (event.type === "model_changed" || event.type === "thinking_level_changed") {
      this.scheduleCommittedConfigRefresh();
      return;
    }
    const turn = this.activeTurn;
    if (!turn) {
      if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
        this.projector.projectPassive(event);
      }
      return;
    }
    if (
      event.type === "agent_end" &&
      event.requestId !== undefined &&
      event.requestId !== turn.nativeRequestId
    ) {
      return;
    }
    if (turn.starting) {
      if (
        turn.bufferedEvents.length >= MAX_BUFFERED_TURN_EVENTS ||
        retainedBytes(turn.bufferedEvents, MAX_BUFFERED_TURN_BYTES) +
          boundedJsonBytes(
            event,
            MAX_BUFFERED_TURN_BYTES,
            MAX_BUFFERED_VALUE_ITEMS,
            MAX_BUFFERED_TURN_BYTES,
            MAX_BUFFERED_VALUE_NODES,
          ) >
          MAX_BUFFERED_TURN_BYTES
      ) {
        this.handleRuntimeFailure();
        return;
      }
      turn.bufferedEvents.push(event);
      return;
    }
    this.handleTurnEvent(turn, event);
  }

  private handleTurnEvent(
    turn: ActiveTurn,
    event: OmpRpcEvent,
    correlatesToAcceptedPrompt = true,
  ): void {
    if (
      turn.generation !== this.generation ||
      turn.terminal ||
      (turn.terminalizing && turn.terminalization !== undefined) ||
      this.activeTurn !== turn
    ) {
      return;
    }
    if (
      event.type === "agent_end" &&
      event.requestId !== undefined &&
      event.requestId !== turn.nativeRequestId
    ) {
      return;
    }
    if (event.type === "message_end" && correlatesToAcceptedPrompt) {
      const entryId = nativeEntryId(event.message);
      if (!entryId || turn.streamedMessageEntryIds.length >= MAX_AGENT_END_CORRELATION_MESSAGES) {
        turn.streamedMessageIdentityComplete = false;
      } else {
        turn.streamedMessageEntryIds.push(entryId);
      }
      turn.completedMessageCount += 1;
      if (event.message.role === "assistant") {
        turn.lastCompletedAssistantOutcome = assistantTerminalOutcome(event.message);
        turn.lastCompletedAssistantEntryId = entryId;
      }
    }
    if (event.type === "prompt_error") {
      if (event.id !== turn.nativeRequestId) return;
      const error: ProviderError = {
        message: this.dataFilter.text(event.error, 4_096),
        ...(event.code ? { code: this.dataFilter.text(event.code, 256) } : {}),
      };
      this.publishPendingUsers(turn);
      void this.finishTurn(turn, "failed", error);
      return;
    }
    if (event.type === "prompt_result") {
      if (!event.id || event.id !== turn.nativeRequestId) return;
      if (event.agentInvoked) {
        // A request-keyed prompt result proves dispatch, but an unkeyed terminal still needs
        // ordered native user and assistant evidence from this accepted prompt.
        this.markAgentEvidence(turn);
        return;
      }
      if (turn.localOnlyDisabled || turn.steersInFlight > 0) return;
      if (!turn.nativeActivity && !turn.awaitingPermissionEvidence) {
        turn.agentInvoked = false;
        turn.localOnlyEligible = true;
        if (turn.deferredAgentEnd?.confidence === "ambiguous") {
          turn.deferredAgentEnd = undefined;
          this.cancelAmbiguousTerminal(turn);
        }
        this.scheduleLocalOnlyCompletion(turn);
      }
      return;
    }
    if (event.type === "auto_compaction_start") {
      turn.nativeActivity = true;
      this.cancelLocalOnlyCompletion(turn);
      this.compaction.start(turn, "auto", event.action);
      return;
    }
    if (event.type === "auto_compaction_end") {
      if (this.compaction.handleAutoEnd(turn, event)) {
        this.usage.schedulePoll(turn, USAGE_REFRESH_MS);
      }
      return;
    }
    if (event.type === "agent_end" && turn.manualCompactionPending) return;
    if (event.type === "tool_execution_start") turn.activeToolCallIds.add(event.toolCallId);
    if (event.type === "tool_execution_end") {
      turn.activeToolCallIds.delete(event.toolCallId);
      if (event.toolName === "ask_user") this.permissions.clearPendingFreeformSelection();
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      try {
        this.subsessions?.observeSessionEvent(this.id, event);
      } catch {
        this.recordOperationalFailure({
          category: "tool-projector",
          stage: "subsession-projector",
        });
        this.handleRuntimeFailure("OMP subagent dispatch tracking failed");
        return;
      }
    }
    if (event.type === "agent_end") {
      if (event.isTerminal === false) {
        turn.completedMessageCount = 0;
        turn.streamedMessageEntryIds.length = 0;
        turn.streamedMessageIdentityComplete = true;
        turn.lastCompletedAssistantOutcome = undefined;
        turn.lastCompletedAssistantEntryId = undefined;
        return;
      }
      const candidate: TerminalCandidate = turn.interrupted
        ? { event, confidence: "interrupted", arrivalSequence: turn.activitySequence }
        : classifyTerminalCandidate(turn, event);
      if (candidate.confidence === "ambiguous") {
        this.deferAmbiguousTerminal(turn, candidate);
        return;
      }
      turn.nativeActivity = true;
      this.cancelLocalOnlyCompletion(turn);
      if (
        (!turn.interrupted &&
          candidate.confidence !== "keyed" &&
          this.hasTerminalConflict(turn, false)) ||
        turn.steersInFlight > 0 ||
        turn.terminalizing
      ) {
        turn.deferredAgentEnd = candidate;
        return;
      }
      this.beginTerminalization(turn, candidate);
      return;
    }
    if (isNativeTurnActivity(event)) {
      turn.nativeActivity = true;
      this.cancelLocalOnlyCompletion(turn);
    }
    if (event.type === "message_end" && event.message.role === "user") {
      this.markAgentEvidence(turn);
      this.projectUserEcho(turn, event.message);
      return;
    }
    if (
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      turn.awaitingPermissionEvidence = false;
      if (correlatesToAcceptedPrompt) {
        turn.terminalCorrelation.evidence.set("current-assistant", turn.activitySequence + 1);
      }
    }
    if (isNativeTurnActivity(event)) this.markAgentEvidence(turn);
    try {
      this.projector.project(event, turn.turnId);
    } catch (error) {
      this.recordOperationalFailure({
        category: "tool-projector",
        stage: "timeline-projector",
      });
      throw error;
    }
    if (event.type === "tool_execution_end") this.resumeDeferredAgentEnd();
  }

  private projectUserEcho(turn: ActiveTurn, message: OmpMessage): void {
    turn.userEchoObserved = true;
    const entryId = nativeEntryId(message);
    if (
      entryId &&
      this.seenEntryIds.has(entryId) &&
      !this.unclaimedBranchEntries.some((entry) => entry.entryId === entryId)
    ) {
      return;
    }
    if (
      turn.userEchoes.length >= MAX_USER_ECHOES ||
      retainedBytes(turn.userEchoes, MAX_USER_ECHO_BYTES) +
        boundedJsonBytes(message, MAX_USER_ECHO_BYTES, MAX_USER_ECHOES) >
        MAX_USER_ECHO_BYTES
    ) {
      this.handleRuntimeFailure();
      return;
    }
    turn.userEchoes.push(message);
    this.drainUserEchoes(turn);
  }

  private drainUserEchoes(turn: ActiveTurn): void {
    if (turn.userCorrelationActive) return;
    turn.userCorrelationActive = true;
    const correlation = this.correlateUserEchoes(turn);
    turn.userLookups.add(correlation);
    void correlation.finally(() => {
      turn.userLookups.delete(correlation);
      turn.userCorrelationActive = false;
      if (!turn.terminal && !turn.terminalizing && turn.userEchoes.length > 0) {
        this.drainUserEchoes(turn);
      }
    });
  }

  private async correlateUserEchoes(turn: ActiveTurn): Promise<void> {
    while (turn.userEchoes.length > 0) {
      const message = turn.userEchoes[0];
      if (!message) return;
      const entryId = nativeEntryId(message);
      if (
        entryId &&
        this.emittedEntryIds.has(entryId) &&
        !this.unclaimedBranchEntries.some((entry) => entry.entryId === entryId)
      ) {
        turn.userEchoes.shift();
        continue;
      }
      const pending = turn.pendingUsers[0];
      if (!pending) {
        turn.userEchoes.shift();
        continue;
      }
      if (!pending.accepted) {
        if (
          pending.bufferedEchoes.length + turn.userEchoes.length > MAX_USER_ECHOES ||
          retainedBytes(pending.bufferedEchoes, MAX_USER_ECHO_BYTES) +
            retainedBytes(turn.userEchoes, MAX_USER_ECHO_BYTES) >
            MAX_USER_ECHO_BYTES
        ) {
          this.handleRuntimeFailure();
          return;
        }
        pending.bufferedEchoes.push(...turn.userEchoes.splice(0));
        return;
      }
      const observedSequence = turn.activitySequence;
      let resolvedId = entryId ?? this.claimUnclaimedBranchEntry(turn, pending.text);
      if (!resolvedId && (await this.refreshBranchEntries(turn, pending))) {
        resolvedId = this.claimUnclaimedBranchEntry(turn, pending.text);
      }
      if (
        this.closed ||
        turn.terminal ||
        this.activeTurn !== turn ||
        turn.pendingUsers[0] !== pending
      ) {
        return;
      }
      turn.userEchoes.shift();
      if (!resolvedId) return;
      turn.pendingUsers.shift();
      this.publishCorrelatedUser(turn, pending, resolvedId, observedSequence);
    }
  }
  private async refreshBranchEntries(turn: ActiveTurn, pending: PendingUser): Promise<boolean> {
    const runtime = this.runtime;
    try {
      const messages = await runtime.getBranchMessages();
      if (
        this.closed ||
        turn.terminal ||
        this.activeTurn !== turn ||
        turn.pendingUsers[0] !== pending ||
        turn.generation !== this.generation ||
        runtime !== this.runtime
      ) {
        return false;
      }
      if (
        messages.length > MAX_UNCLAIMED_BRANCH_ENTRIES ||
        retainedBytes(messages, MAX_UNCLAIMED_BRANCH_BYTES) === Number.POSITIVE_INFINITY
      ) {
        this.quarantineBranchEntries();
        return false;
      }
      const unseen: Array<{ entryId: string; text: string }> = [];
      const snapshotIds = new Set<string>();
      for (const message of messages) {
        if (snapshotIds.has(message.entryId)) {
          this.quarantineBranchEntries();
          return false;
        }
        snapshotIds.add(message.entryId);
        if (!this.branchEntryIds.has(message.entryId)) unseen.push(message);
      }
      if (!this.branchWatermarkValid) {
        this.unclaimedBranchEntries.length = 0;
        this.branchWatermarkValid = true;
      } else if (
        unseen.length <= MAX_UNCLAIMED_BRANCH_ENTRIES - this.unclaimedBranchEntries.length &&
        this.branchEntryIds.size + unseen.length <= MAX_UNCLAIMED_BRANCH_ENTRIES &&
        retainedBytes(this.unclaimedBranchEntries, MAX_UNCLAIMED_BRANCH_BYTES) +
          retainedBytes(unseen, MAX_UNCLAIMED_BRANCH_BYTES) <=
          MAX_UNCLAIMED_BRANCH_BYTES
      ) {
        this.unclaimedBranchEntries.push(...unseen);
      } else {
        this.quarantineBranchEntries();
        return false;
      }
      for (const message of messages) {
        this.branchEntryIds.add(message.entryId);
        this.seenEntryIds.add(message.entryId);
      }
      return true;
    } catch {
      if (
        !this.closed &&
        !turn.terminal &&
        this.activeTurn === turn &&
        turn.pendingUsers[0] === pending &&
        turn.generation === this.generation &&
        runtime === this.runtime
      ) {
        this.quarantineBranchEntries();
      }
      return false;
    }
  }

  private claimUnclaimedBranchEntry(turn: ActiveTurn, text: string): string | undefined {
    const index = this.unclaimedBranchEntries.findIndex((entry) => entry.text === text);
    if (index < 0) return undefined;
    let matches = 0;
    let expected = 0;
    for (const entry of this.unclaimedBranchEntries) if (entry.text === text) matches += 1;
    for (const pending of turn.pendingUsers) {
      if (pending.accepted && pending.text === text) expected += 1;
    }
    if (matches > expected) {
      this.quarantineBranchEntries();
      return undefined;
    }
    return this.unclaimedBranchEntries.splice(index, 1)[0]?.entryId;
  }

  private quarantineBranchEntries(): void {
    this.unclaimedBranchEntries.length = 0;
    this.branchEntryIds.clear();
    this.branchWatermarkValid = false;
  }

  private isSteerableTurn(turn: ActiveTurn | null): turn is ActiveTurn {
    return (
      turn !== null &&
      this.activeTurn === turn &&
      !turn.terminal &&
      !turn.terminalizing &&
      !turn.deferredAgentEnd &&
      !turn.agentEndPending &&
      !turn.manualCompactionPending &&
      turn.started
    );
  }

  private publishSteerFailure(clientMessageId: string, message: string): void {
    this.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "failed", error: { message } },
    });
  }

  private replaceSlashCommands(commands: OmpAvailableCommand[]): void {
    this.slashCommands.clear();
    for (const command of [...OMP_BUILTIN_COMMANDS, ...commands]) {
      if (isSafeCommandName(command.name)) this.slashCommands.add(command.name);
      for (const alias of command.aliases ?? []) {
        if (isSafeCommandName(alias)) this.slashCommands.add(alias);
      }
    }
    this.commandDiscoveryAvailable = true;
  }

  private publishCommands(commands: OmpAvailableCommand[]): void {
    const merged = new Map(OMP_BUILTIN_COMMANDS.map((command) => [command.name, command] as const));
    for (const command of commands) merged.set(command.name, command);
    this.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: [...merged.values()]
        .filter((command) => isSafeCommandName(command.name))
        .map((command) => {
          const name = this.dataFilter.text(command.name, 256);
          return {
            name,
            description: this.dataFilter.text(command.description ?? `Run /${name}`, 4_096),
            ...(command.input?.hint
              ? { argumentHint: this.dataFilter.text(command.input.hint, 1_024) }
              : {}),
          };
        }),
    });
  }

  private hasTerminalConflict(turn: ActiveTurn, includeChildren = true): boolean {
    return (
      turn.awaitingPermissionEvidence ||
      this.permissions.hasForTurn(turn.turnId) ||
      turn.activeToolCallIds.size > 0 ||
      turn.steersInFlight > 0 ||
      (includeChildren && Boolean(this.subsessions?.hasActiveChildren()))
    );
  }

  private reevaluateDeferredPermissionTerminal(): void {
    const turn = this.activeTurn;
    if (!turn?.deferredAgentEnd || turn.terminal || turn.terminalizing) return;
    if (this.hasTerminalConflict(turn)) return;
    const deferred = turn.deferredAgentEnd;
    if (deferred.confidence === "ambiguous") return;
    turn.deferredAgentEnd = undefined;
    this.beginTerminalization(turn, deferred);
  }
  private async slashSteerUnavailable(commandName: string): Promise<boolean> {
    if (!this.commandDiscoveryAvailable || !this.slashCommands.has(commandName)) {
      try {
        this.replaceSlashCommands(await this.runtime.getAvailableCommands());
      } catch {
        this.commandDiscoveryAvailable = false;
        return true;
      }
    }
    return this.slashCommands.has(commandName);
  }

  private publishCorrelatedUser(
    turn: ActiveTurn,
    pending: PendingUser,
    entryId: string | undefined,
    observedSequence: number,
  ): void {
    if (entryId) {
      if (this.emittedEntryIds.has(entryId)) return;
      this.seenEntryIds.add(entryId);
      this.emittedEntryIds.add(entryId);
      turn.terminalCorrelation.evidence.set("fresh-native-user", observedSequence);
      this.refreshAmbiguousTerminal(turn);
      if (this.branchWatermarkValid && !this.branchEntryIds.has(entryId)) {
        if (this.branchEntryIds.size >= MAX_UNCLAIMED_BRANCH_ENTRIES)
          this.quarantineBranchEntries();
        else this.branchEntryIds.add(entryId);
      }
      const unclaimedIndex = this.unclaimedBranchEntries.findIndex(
        (entry) => entry.entryId === entryId,
      );
      if (unclaimedIndex >= 0) this.unclaimedBranchEntries.splice(unclaimedIndex, 1);
    }
    this.projector.publishUser(pending.text, pending.clientMessageId, entryId);
  }

  private markAgentEvidence(turn: ActiveTurn): void {
    turn.agentInvoked = true;
    turn.nativeActivity = true;
    turn.activitySequence += 1;
    turn.localOnlyEligible = false;
    this.cancelLocalOnlyCompletion(turn);
    this.refreshAmbiguousTerminal(turn);
  }

  private scheduleLocalOnlyCompletion(turn: ActiveTurn): void {
    if (
      turn.agentInvoked !== false ||
      !turn.localOnlyEligible ||
      turn.awaitingPermissionEvidence ||
      turn.localOnlyDisabled ||
      turn.steersInFlight > 0
    ) {
      return;
    }
    this.cancelLocalOnlyCompletion(turn);
    turn.localOnlyTimer = this.scheduler.set(() => {
      turn.localOnlyTimer = undefined;
      return this.completeLocalOnlyTurn(turn);
    }, LOCAL_ONLY_SETTLE_MS);
  }

  private cancelLocalOnlyCompletion(turn: ActiveTurn): void {
    if (turn.localOnlyTimer === undefined) return;
    this.scheduler.clear(turn.localOnlyTimer);
    turn.localOnlyTimer = undefined;
  }

  private refreshAmbiguousTerminal(turn: ActiveTurn): void {
    const candidate = turn.deferredAgentEnd;
    if (candidate?.confidence !== "ambiguous") return;
    const resolved = classifyTerminalCandidate(turn, candidate.event, candidate.arrivalSequence);
    if (resolved.confidence !== "ambiguous") {
      this.cancelAmbiguousTerminal(turn);
      turn.deferredAgentEnd = undefined;
      if (turn.terminalizing || this.hasTerminalConflict(turn, false)) {
        turn.deferredAgentEnd = resolved;
      } else {
        this.beginTerminalization(turn, resolved);
      }
      return;
    }
    if (turn.activitySequence > candidate.arrivalSequence) {
      turn.deferredAgentEnd = undefined;
      this.cancelAmbiguousTerminal(turn);
    }
  }

  private deferAmbiguousTerminal(turn: ActiveTurn, candidate: TerminalCandidate): void {
    if (turn.agentInvoked === false && turn.localOnlyEligible) return;
    this.cancelAmbiguousTerminal(turn);
    turn.deferredAgentEnd = candidate;
    turn.ambiguousTerminalTimer = this.scheduler.set(() => {
      turn.ambiguousTerminalTimer = undefined;
      void this.settleAmbiguousTerminal(turn, candidate);
    }, AGENT_END_STATE_TIMEOUT_MS);
  }

  private cancelAmbiguousTerminal(turn: ActiveTurn): void {
    if (turn.ambiguousTerminalTimer === undefined) return;
    this.scheduler.clear(turn.ambiguousTerminalTimer);
    turn.ambiguousTerminalTimer = undefined;
  }

  private async settleAmbiguousTerminal(
    turn: ActiveTurn,
    candidate: TerminalCandidate,
  ): Promise<void> {
    if (
      this.closed ||
      turn.terminal ||
      this.activeTurn !== turn ||
      turn.deferredAgentEnd !== candidate
    ) {
      return;
    }
    await Promise.allSettled(turn.userLookups);
    this.refreshAmbiguousTerminal(turn);
    if (turn.terminal || this.activeTurn !== turn || turn.deferredAgentEnd !== candidate) return;
    const state = await this.usage.boundedTerminalState(turn, FINAL_USAGE_WAIT_MS);
    if (turn.terminal || this.activeTurn !== turn || turn.deferredAgentEnd !== candidate) return;
    if (!state) {
      turn.operationalTerminalStage = "unresolved";
      this.handleRuntimeFailure("OMP agent_end state could not be confirmed");
      return;
    }
    turn.deferredAgentEnd = undefined;
    if (state.isStreaming || state.isCompacting) return;
    turn.operationalTerminalStage = "unresolved";
    await this.finishTurn(turn, "failed", {
      message: "OMP unkeyed agent_end could not be correlated to the current prompt",
    });
  }

  private async completeLocalOnlyTurn(turn: ActiveTurn): Promise<void> {
    await Promise.allSettled(turn.userLookups);
    if (this.closed || turn.terminal || this.activeTurn !== turn) return;
    if (
      turn.terminal ||
      turn.agentInvoked !== false ||
      !turn.localOnlyEligible ||
      turn.awaitingPermissionEvidence ||
      turn.nativeActivity ||
      turn.localOnlyDisabled ||
      turn.steersInFlight > 0 ||
      this.activeTurn !== turn
    ) {
      return;
    }
    this.usage.invalidateBeforeNextSample(turn);
    this.publishPendingUsers(turn);
    await this.finishTurn(turn, "completed", undefined, false, false, true);
  }

  private resetAgentEndProbe(turn: ActiveTurn): void {
    turn.agentEndPending = false;
    turn.terminalizing = false;
    if (turn.agentEndRetryTimer !== undefined) {
      this.scheduler.clear(turn.agentEndRetryTimer);
      turn.agentEndRetryTimer = undefined;
    }
    if (turn.agentEndDeadlineTimer !== undefined) {
      this.scheduler.clear(turn.agentEndDeadlineTimer);
      turn.agentEndDeadlineTimer = undefined;
    }
  }
  private ignoreActiveTerminalCandidate(turn: ActiveTurn, candidate: TerminalCandidate): void {
    const replacement =
      turn.deferredAgentEnd && turn.deferredAgentEnd !== candidate
        ? turn.deferredAgentEnd
        : undefined;
    this.resetAgentEndProbe(turn);
    turn.deferredAgentEnd = replacement;
    if (replacement && replacement.confidence !== "ambiguous") {
      turn.deferredAgentEnd = undefined;
      this.beginTerminalization(turn, replacement);
      return;
    }
    this.usage.poll(turn);
  }

  private beginTerminalization(turn: ActiveTurn, candidate: TerminalCandidate): void {
    if (turn.terminal || turn.terminalizing || turn.agentEndPending || this.activeTurn !== turn) {
      return;
    }
    if (!turn.interrupted && this.deferAgentEndForSubsessions(turn, candidate)) return;
    turn.agentEndPending = true;
    if (turn.deferredAgentEnd?.confidence === "ambiguous") {
      turn.deferredAgentEnd = undefined;
    }
    turn.terminalizing = true;
    this.cancelAmbiguousTerminal(turn);
    this.usage.invalidateBeforeNextSample(turn);
    this.usage.stopPoll(turn);
    turn.agentEndDeadlineTimer = this.scheduler.set(() => {
      turn.agentEndDeadlineTimer = undefined;
      if (!turn.agentEndPending || turn.terminal || this.activeTurn !== turn) return;
      if (
        candidate.confidence === "keyed" ||
        (candidate.confidence === "initial-turn" && !turn.userEchoObserved)
      ) {
        void this.completeAgentEnd(turn, candidate.event);
      } else {
        turn.operationalTerminalStage = "unresolved";
        this.handleRuntimeFailure("OMP agent_end state could not be confirmed");
      }
    }, AGENT_END_SETTLE_MS);
    this.finishFromAgentEnd(turn, candidate);
  }

  private resumeAfterFailedSteer(turn: ActiveTurn): void {
    if (turn.terminal || this.activeTurn !== turn || turn.steersInFlight > 0) return;
    const deferred = turn.deferredAgentEnd;
    if (deferred && deferred.confidence !== "ambiguous" && !this.hasTerminalConflict(turn)) {
      turn.deferredAgentEnd = undefined;
      this.beginTerminalization(turn, deferred);
      return;
    }
    if (turn.localOnlyEligible && !turn.localOnlyDisabled && !turn.nativeActivity) {
      this.scheduleLocalOnlyCompletion(turn);
    }
  }

  private deferAgentEndForSubsessions(turn: ActiveTurn, candidate: TerminalCandidate): boolean {
    if (!this.subsessions?.hasActiveChildren()) return false;
    turn.terminalizing = false;
    turn.deferredAgentEnd = candidate;
    void this.subsessions.reconcile(this.runtime).catch(() => {
      this.recordOperationalFailure({
        category: "tool-projector",
        stage: "subsession-projector",
      });
      if (!turn.terminal && this.activeTurn === turn) {
        this.subsessions?.terminalize("failed");
        this.resumeDeferredAgentEnd();
      }
    });
    return true;
  }

  private resumeDeferredAgentEnd(): void {
    const turn = this.activeTurn;
    if (!turn || turn.terminal || turn.terminalizing || this.hasTerminalConflict(turn)) {
      return;
    }
    const candidate = turn.deferredAgentEnd;
    if (!candidate || candidate.confidence === "ambiguous") return;
    turn.deferredAgentEnd = undefined;
    this.beginTerminalization(turn, candidate);
  }

  private finishFromAgentEnd(turn: ActiveTurn, candidate: TerminalCandidate): void {
    if (!turn.agentEndPending || turn.terminal) return;
    if (turn.agentEndCheck) {
      turn.deferredAgentEnd = candidate;
      return;
    }
    const check = this.checkAgentEndState(turn, candidate);
    turn.agentEndCheck = check;
    void check.finally(() => {
      if (turn.agentEndCheck !== check) return;
      turn.agentEndCheck = undefined;
      const deferred = turn.deferredAgentEnd;
      if (!deferred || !turn.agentEndPending || turn.terminal || this.activeTurn !== turn) return;
      turn.deferredAgentEnd = undefined;
      this.finishFromAgentEnd(turn, deferred);
    });
  }

  private async checkAgentEndState(turn: ActiveTurn, candidate: TerminalCandidate): Promise<void> {
    await Promise.allSettled(turn.userLookups);
    if (!turn.agentEndPending || turn.terminal || this.activeTurn !== turn) return;
    while (turn.userEchoes.length > 0) {
      this.drainUserEchoes(turn);
      if (turn.userLookups.size === 0) break;
      await Promise.allSettled(turn.userLookups);
      if (!turn.agentEndPending || turn.terminal || this.activeTurn !== turn) return;
    }
    if (
      !turn.interrupted &&
      candidate.confidence !== "keyed" &&
      this.hasTerminalConflict(turn, false)
    ) {
      this.resetAgentEndProbe(turn);
      turn.deferredAgentEnd = candidate;
      this.usage.poll(turn);
      return;
    }
    if (turn.interrupted) {
      await this.completeAgentEnd(turn, candidate.event);
      return;
    }
    const state = await this.usage.boundedTerminalState(turn, FINAL_USAGE_WAIT_MS);
    if (!turn.agentEndPending || turn.terminal || this.activeTurn !== turn) return;
    if (!turn.interrupted && this.subsessions?.hasActiveChildren()) {
      this.resetAgentEndProbe(turn);
      if (this.deferAgentEndForSubsessions(turn, candidate)) return;
    }
    if (
      !turn.interrupted &&
      candidate.confidence !== "keyed" &&
      this.hasTerminalConflict(turn, false)
    ) {
      this.resetAgentEndProbe(turn);
      turn.deferredAgentEnd = candidate;
      this.usage.poll(turn);
      return;
    }
    if (state) {
      if (state.isStreaming || state.isCompacting) {
        this.ignoreActiveTerminalCandidate(turn, candidate);
        return;
      }
      await this.completeAgentEnd(turn, candidate.event, true);
      return;
    }
    if (turn.userEchoObserved) {
      turn.operationalTerminalStage = "unresolved";
      this.handleRuntimeFailure("OMP agent_end state could not be confirmed");
      return;
    }
    if (turn.agentEndRetryTimer === undefined) {
      turn.agentEndRetryTimer = this.scheduler.set(() => {
        turn.agentEndRetryTimer = undefined;
        this.finishFromAgentEnd(turn, candidate);
      }, USAGE_POLL_MS);
    }
  }

  private async completeAgentEnd(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
    providerIdle = false,
  ): Promise<void> {
    if (turn.terminal || this.activeTurn !== turn) return;
    let outcome = turn.interrupted ? ("canceled" as const) : terminalOutcome(event, turn);
    if (!outcome && providerIdle && event.messageCount !== undefined) {
      const runtime = this.runtime;
      const history = await this.readRuntimeHistoryWithTimeout(runtime);
      if (
        history &&
        history.length <= MAX_REPLAY_MESSAGES &&
        this.isCurrentRuntime(runtime, turn.generation) &&
        !turn.terminal &&
        !turn.interrupted &&
        this.activeTurn === turn
      ) {
        const state = await this.usage.boundedTerminalState(turn, FINAL_USAGE_WAIT_MS);
        if (
          turn.terminal ||
          this.activeTurn !== turn ||
          !this.isCurrentRuntime(runtime, turn.generation)
        )
          return;
        if (!turn.interrupted && state && (state.isStreaming || state.isCompacting)) {
          this.ignoreActiveTerminalCandidate(turn, {
            event,
            arrivalSequence: turn.activitySequence,
            confidence: event.requestId === undefined ? "ordered-legacy" : "keyed",
          });
          return;
        }
        if (state && !state.isStreaming && !state.isCompacting) {
          outcome = historyTerminalOutcome(history, event.messageCount, turn, event.messages ?? []);
        }
      }
    }
    if (turn.terminal || this.activeTurn !== turn) return;
    if (turn.interrupted || outcome === "canceled") {
      this.subsessions?.terminalize("canceled");
      await this.finishTurn(turn, "canceled");
      return;
    }
    if (outcome === "completed") {
      await this.finishTurn(turn, "completed");
      return;
    }
    turn.operationalTerminalStage = outcome === "failed" ? "failed" : "unresolved";
    const error =
      outcome === "failed" ? "OMP assistant turn failed" : unknownTerminalOutcomeError(event, turn);
    this.subsessions?.terminalize("failed");
    await this.finishTurn(turn, "failed", { message: error });
  }
  private publishPendingUsers(turn: ActiveTurn): void {
    for (const pending of turn.pendingUsers.splice(0)) {
      for (const echo of pending.bufferedEchoes) {
        const entryId = nativeEntryId(echo);
        if (entryId) this.seenEntryIds.add(entryId);
      }
      if (pending.accepted && pending.fallbackOnFinish) {
        this.quarantineBranchEntries();
        this.projector.publishUser(pending.text, pending.clientMessageId);
      }
    }
    for (const echo of turn.userEchoes) {
      const entryId = nativeEntryId(echo);
      if (entryId) this.seenEntryIds.add(entryId);
    }
    turn.userEchoes.length = 0;
  }

  private acceptPendingUser(turn: ActiveTurn, pending: PendingUser): void {
    pending.accepted = true;
    pending.fallbackOnFinish = true;
    if (pending.bufferedEchoes.length > 0) {
      turn.userEchoes.unshift(...pending.bufferedEchoes.splice(0));
    }
    this.drainUserEchoes(turn);
  }

  private removePendingUser(turn: ActiveTurn, pending: PendingUser): void {
    const index = turn.pendingUsers.indexOf(pending);
    if (index >= 0) turn.pendingUsers.splice(index, 1);
    for (const echo of pending.bufferedEchoes) {
      const entryId = nativeEntryId(echo);
      if (entryId) this.seenEntryIds.add(entryId);
    }
    pending.bufferedEchoes.length = 0;
  }

  private settleUnstartedTurn(turn: ActiveTurn): void {
    if (turn.started || turn.terminal) return;
    turn.steerReady.resolve();
    turn.starting = false;
    turn.terminal = true;
    this.usage.stopPoll(turn);
    this.cancelAmbiguousTerminal(turn);
    this.permissions.resolveTurnPermissions(turn.turnId);
    this.projector.finishTurn(turn.turnId);
    if (this.activeTurn === turn) this.activeTurn = null;
  }

  private publishPromptResult(
    turn: ActiveTurn,
    result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  ): void {
    if (turn.promptResultEmitted) return;
    turn.promptResultEmitted = true;
    this.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: turn.clientMessageId,
      result,
    });
  }

  private startTurn(turn: ActiveTurn, pollUsage = true): void {
    if (turn.started || turn.terminal) return;
    turn.started = true;
    turn.starting = false;
    turn.steerReady.resolve();
    this.emit({ type: "session.turn", sessionId: this.id, turnId: turn.turnId, state: "started" });
    if (pollUsage) this.usage.poll(turn);
  }
  private finishTurn(
    turn: ActiveTurn,
    state: "completed" | "failed" | "canceled",
    error?: ProviderError,
    usageSampled = false,
    override = false,
    preserveCompactions = false,
  ): Promise<void> {
    turn.steerReady.resolve();
    if (turn.terminal) return Promise.resolve();
    const current = turn.terminalOutcome;
    if (
      !current ||
      override ||
      state === "failed" ||
      (state === "canceled" && current.state === "completed")
    ) {
      turn.terminalOutcome = { state, ...(error ? { error } : {}), usageSampled };
    }
    if (turn.terminalization) {
      if (override) turn.terminalWake?.resolve();
      return turn.terminalization;
    }
    turn.terminalizing = true;
    turn.manualCompactionPending = false;
    turn.agentEndPending = false;
    this.cancelLocalOnlyCompletion(turn);
    this.cancelAmbiguousTerminal(turn);
    this.usage.stopPoll(turn);
    if (turn.manualCompactionDeadlineTimer !== undefined) {
      this.scheduler.clear(turn.manualCompactionDeadlineTimer);
      turn.manualCompactionDeadlineTimer = undefined;
    }
    if (turn.agentEndRetryTimer !== undefined) {
      this.scheduler.clear(turn.agentEndRetryTimer);
      turn.agentEndRetryTimer = undefined;
    }
    if (turn.agentEndDeadlineTimer !== undefined) {
      this.scheduler.clear(turn.agentEndDeadlineTimer);
      turn.agentEndDeadlineTimer = undefined;
    }
    const wake = Promise.withResolvers<void>();
    turn.terminalWake = wake;
    const generation = turn.generation;
    const terminalization = (async () => {
      if (!turn.terminalOutcome?.usageSampled && !this.closed && !this.runtimeDead) {
        await Promise.race([
          this.usage.boundedSnapshot(turn, FINAL_USAGE_WAIT_MS),
          wake.promise.then(() => undefined),
        ]);
      }
      if (turn.terminal || this.activeTurn !== turn) return;
      let outcome = turn.terminalOutcome;
      if (!outcome) return;
      if (this.closed && outcome.state === "completed") {
        outcome = { state: "canceled", usageSampled: true };
      } else if (
        (this.runtimeDead || generation !== this.generation) &&
        outcome.state === "completed"
      ) {
        outcome = {
          state: "failed",
          error: { message: "OMP runtime failed" },
          usageSampled: true,
        };
      }
      if (outcome.state === "failed") {
        this.recordOperationalFailure({
          category: "terminal-outcome",
          stage: turn.operationalTerminalStage ?? "failed",
        });
      }
      this.imageMaterializer.clear();
      turn.terminal = true;
      this.usage.clearSample(turn);
      if (!preserveCompactions && this.compaction.active) {
        if (outcome.state === "canceled") this.compaction.finish("canceled");
        else {
          this.compaction.finish("failed", {
            message: outcome.error?.message ?? "OMP compaction ended without a terminal result",
          });
        }
      }
      this.publishPendingUsers(turn);
      this.permissions.resolveTurnPermissions(turn.turnId);
      try {
        this.projector.finishTurn(turn.turnId, preserveCompactions);
      } catch (error) {
        this.recordOperationalFailure({
          category: "tool-projector",
          stage: "timeline-projector",
        });
        throw error;
      }
      this.unclaimedBranchEntries.length = 0;
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: turn.turnId,
        state: outcome.state,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      this.runtimeTurnCompleted = true;
      if (this.activeTurn === turn) this.activeTurn = null;
    })();
    turn.terminalization = terminalization;
    return terminalization;
  }

  private invalidateRuntime(
    message: string,
    compactionState: "failed" | "canceled" = "failed",
  ): void {
    this.imageMaterializer.clear();
    if (this.closed || this.runtimeDead) return;
    this.compaction.resetDiscardedEnds();
    this.permissions.resolveAllPermissions();
    this.recoveryUsesNativeConfig ||=
      this.configRefreshInFlight !== null || this.configRefreshDirty || this.configMutationInFlight;
    const turn = this.activeTurn;
    if (turn) this.usage.stopPoll(turn);
    this.usage.reset();
    this.compaction.finish(compactionState, { message });
    this.generation += 1;
    this.projector.resetRuntimeGeneration("OMP runtime ended during compaction");
    this.runtimeDead = message;
    this.configRefreshAttempts = 0;
    this.configRefreshDirty = false;
    const configRefresh = this.configRefreshInFlight;
    this.cancelConfigRefreshRetry();
    this.unsubscribe();
    this.hostTools.detach();
    this.unsubscribe = () => {};
    const runtimeDisposal = this.runtimeDisposal ?? this.runtime.close();
    this.runtimeDisposal = configRefresh
      ? Promise.all([runtimeDisposal, configRefresh]).then(() => undefined)
      : runtimeDisposal;
    void this.runtimeDisposal.catch(() => undefined);
  }

  private handleRuntimeFailure(message = "OMP runtime failed"): void {
    if (this.closed || this.runtimeDead) return;
    this.invalidateRuntime(message);
    this.subsessions?.terminalize("failed");
    const turn = this.activeTurn;
    if (!turn) return;
    this.publishPendingUsers(turn);
    this.publishPromptResult(turn, { type: "failed", error: { message } });
    if (turn.started) void this.finishTurn(turn, "failed", { message }, true, true);
    else {
      this.recordOperationalFailure({ category: "terminal-outcome", stage: "failed" });
      turn.steerReady.resolve();
      turn.terminal = true;
      this.projector.finishTurn(turn.turnId);
      if (this.activeTurn === turn) this.activeTurn = null;
    }
  }
}
