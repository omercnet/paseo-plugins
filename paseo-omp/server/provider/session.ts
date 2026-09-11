import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderConfigState,
  ProviderEvent,
  ProviderInput,
  ProviderPermissionResponse,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { mapOmpModels, nativeOmpModelId, OMP_MODES, ompModelId, thinkingForModel } from "./catalog";
import type {
  OmpAvailableCommand,
  OmpExtensionUiResponse,
  OmpImage,
  OmpMessage,
  OmpModel,
  OmpRpcEvent,
  OmpRuntime,
  OmpRuntimeSession,
  OmpSessionState,
  OmpStartOptions,
} from "./omp-rpc";
import { buildOmpSpawnRequest } from "./omp-rpc";
import {
  BoundedStringSet,
  boundedJsonBytes,
  OmpCleanupFailure,
  OmpPublicDataFilter,
  OmpPublicError,
  utf8Bytes,
} from "./security";
import {
  defaultOmpTimelineScheduler,
  OmpTimelineProjector,
  type OmpTimelineScheduler,
} from "./timeline-projector";

type SessionOpenInput = Extract<ProviderInput, { type: "session.open" }>;
type SessionPromptInput = Extract<ProviderInput, { type: "session.prompt" }>;
type SessionInterruptInput = Extract<ProviderInput, { type: "session.interrupt" }>;
type SessionConfigureInput = Extract<ProviderInput, { type: "session.configure" }>;
type SessionCloseInput = Extract<ProviderInput, { type: "session.close" }>;
type SessionPermissionInput = Extract<ProviderInput, { type: "session.permission" }>;
type Emit = (event: ProviderEvent) => void;
const LOCAL_ONLY_SETTLE_MS = 5_000;
const AGENT_END_STATE_TIMEOUT_MS = 2_000;
const CONFIG_REFRESH_RETRY_BASE_MS = 250;
const CONFIG_REFRESH_MAX_ATTEMPTS = 3;
const MAX_PROMPT_PARTS = 64;
const MAX_PROMPT_TEXT_LENGTH = 1024 * 1024;
const MAX_TRACKED_ENTRY_IDS = 1_024;
const MAX_UNCLAIMED_BRANCH_ENTRIES = 1_024;
const MAX_PENDING_USERS = 256;
const MAX_PENDING_PERMISSIONS = 32;
const MAX_USER_ECHOES = 512;
const MAX_BUFFERED_TURN_EVENTS = 512;
const MAX_BUFFERED_VALUE_ITEMS = 1_024;
const MAX_BUFFERED_VALUE_NODES = 4_096;
const MAX_BUFFERED_TURN_BYTES = 4 * 1024 * 1024;
const MAX_USER_ECHO_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_USER_BYTES = 2 * 1024 * 1024;
const MAX_UNCLAIMED_BRANCH_BYTES = 4 * 1024 * 1024;
class OmpCatalogEscape extends OmpPublicError {}

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

type PendingUser = {
  clientMessageId: string;
  text: string;
  accepted: boolean;
  fallbackOnFinish: boolean;
  bufferedEchoes: OmpMessage[];
};

type ActiveTurn = {
  turnId: string;
  clientMessageId: string;
  generation: number;
  promptResultEmitted: boolean;
  started: boolean;
  terminal: boolean;
  interrupted: boolean;
  starting: boolean;
  nativeActivity: boolean;
  localOnlyDisabled: boolean;
  localOnlyEligible: boolean;
  awaitingPermissionEvidence: boolean;
  agentInvoked?: boolean;
  nativeRequestId?: string;
  localOnlyTimer?: unknown;
  terminalizing: boolean;
  steersInFlight: number;
  deferredAgentEnd?: Extract<OmpRpcEvent, { type: "agent_end" }>;
  bufferedEvents: OmpRpcEvent[];
  pendingUsers: PendingUser[];
  userEchoes: OmpMessage[];
  userCorrelationActive: boolean;
  userLookups: Set<Promise<void>>;
};

type PendingAbort = {
  turn: ActiveTurn;
  generation: number;
  runtime: OmpRuntimeSession;
  promise: Promise<void>;
};
type PendingPermission = {
  nativeId: string;
  header: string;
  optionValues: ReadonlyMap<string, string>;
  displayValues: ReadonlyMap<string, readonly string[]>;
  expiresAt?: number;
  timer?: unknown;
  turnId?: string;
  request: Extract<OmpRpcEvent, { type: "extension_ui_request" }>;
};

function providerError(error: unknown, fallback: string): { message: string } {
  return { message: error instanceof OmpPublicError ? error.message : fallback };
}

type OmpPromptPayload = { text: string; images: OmpImage[]; commandName?: string };

function promptPayload(input: SessionPromptInput): OmpPromptPayload {
  if (input.prompt.outputSchema !== undefined || input.prompt.clearPendingPermissions) {
    throw new OmpPublicError("OMP does not support structured output or permission controls");
  }
  if (input.prompt.input.type === "command") {
    const name = input.prompt.input.name.trim();
    if (!name || /[\s/:]/u.test(name)) throw new OmpPublicError("Invalid OMP command name");
    const argumentsText = input.prompt.input.arguments.trim();
    const text = `/${name}${argumentsText ? ` ${argumentsText}` : ""}`;
    if (utf8Bytes(text) > MAX_PROMPT_TEXT_LENGTH)
      throw new OmpPublicError("OMP command is too large");
    return { text, images: [], commandName: name };
  }
  if (input.prompt.input.content.length > MAX_PROMPT_PARTS) {
    throw new OmpPublicError("OMP prompt has too many content parts");
  }
  const parts: string[] = [];
  const images: OmpImage[] = [];
  let length = 0;
  for (const part of input.prompt.input.content) {
    if (part.type === "text") {
      length += utf8Bytes(part.text) + (parts.length > 0 ? 2 : 0);
      if (length > MAX_PROMPT_TEXT_LENGTH) throw new OmpPublicError("OMP prompt is too large");
      parts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      images.push({ type: "image", data: part.data, mimeType: part.mimeType });
      continue;
    }
    throw new OmpPublicError("OMP supports text messages only");
  }
  const text = parts.join("\n\n").trim();
  if (!text && images.length === 0) throw new OmpPublicError("OMP prompt cannot be empty");
  return { text, images };
}

function slashCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const body = text.slice(1);
  if (!body) return undefined;
  const firstWhitespace = body.search(/\s/);
  const firstColon = body.indexOf(":");
  const separator =
    firstWhitespace === -1
      ? firstColon
      : firstColon === -1
        ? firstWhitespace
        : Math.min(firstWhitespace, firstColon);
  const name = separator === -1 ? body : body.slice(0, separator);
  return name || undefined;
}

function nativeEntryId(message: OmpMessage): string | undefined {
  return message.entryId;
}

function terminalError(event: Extract<OmpRpcEvent, { type: "agent_end" }>): string | undefined {
  const messages = event.messages;
  if (!messages) {
    return event.messageCount === 0
      ? undefined
      : "OMP agent_end omitted terminal messages; outcome is unknown";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.errorMessage) {
      return "OMP assistant turn failed";
    }
  }
  return undefined;
}

function isNativeTurnActivity(event: OmpRpcEvent): boolean {
  if (
    event.type === "agent_start" ||
    event.type === "turn_start" ||
    event.type === "turn_end" ||
    event.type === "agent_end"
  ) {
    return true;
  }
  if (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  ) {
    return event.message.role === "assistant";
  }
  return event.type.startsWith("tool_execution_");
}

function isPassiveUiMethod(method: string): boolean {
  return (
    method === "cancel" ||
    method === "notify" ||
    method === "open_url" ||
    method === "setStatus" ||
    method === "setWidget" ||
    method === "setTitle" ||
    method === "set_editor_text"
  );
}

export class OmpProviderSession {
  readonly id: string;
  readonly cwd: string;

  private readonly projector: OmpTimelineProjector;
  private unsubscribe: () => void = () => {};
  private activeTurn: ActiveTurn | null = null;
  private closed = false;
  private disposalPromise: Promise<void> | null = null;
  private sessionClosedPublished = false;
  private readonly emittedEntryIds = new BoundedStringSet(MAX_TRACKED_ENTRY_IDS);
  private readonly seenEntryIds = new BoundedStringSet(MAX_TRACKED_ENTRY_IDS);
  private branchWatermarkValid = true;
  private readonly unclaimedBranchEntries: Array<{ entryId: string; text: string }> = [];
  private readonly scheduler: OmpTimelineScheduler;
  private readonly dataFilter: OmpPublicDataFilter;
  private readonly nativeModelsByPublicId: ReadonlyMap<string, OmpModel>;
  private readonly lifetime = new AbortController();
  private generation = 0;
  private runtimeDead: string | null = null;
  private runtimeDisposal: Promise<void> | null = null;
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
  private commandCatalog: OmpAvailableCommand[];
  private permissionSequence = 0;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly inFlightPermissions = new Map<string, PendingPermission>();

  private constructor(
    id: string,
    private runtime: OmpRuntimeSession,
    private readonly runtimeFactory: OmpRuntime,
    private recoveryOptions: Omit<OmpStartOptions, "resumeSessionId" | "signal">,
    private nativeSessionId: string,
    private readonly config: ProviderSessionConfig,
    private configState: ProviderConfigState,
    nativeModelsByPublicId: ReadonlyMap<string, OmpModel>,
    private readonly capabilities: readonly string[],
    private readonly slashCommands: Set<string>,
    commandCatalog: OmpAvailableCommand[],
    private commandDiscoveryAvailable: boolean,
    private readonly emit: Emit,
    scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
  ) {
    this.id = id;
    this.cwd = config.cwd;
    this.scheduler = scheduler;
    const sensitiveValues = [
      ...Object.values(config.env ?? {}),
      ...(runtime.redactionValues ?? []),
    ];
    this.dataFilter = new OmpPublicDataFilter(sensitiveValues);
    this.nativeModelsByPublicId = nativeModelsByPublicId;
    this.commandCatalog = commandCatalog;
    this.projector = new OmpTimelineProjector(id, emit, scheduler, sensitiveValues);
    this.bindRuntime(runtime);
  }

  static async open(
    input: SessionOpenInput,
    runtime: OmpRuntime,
    capabilities: readonly string[],
    emit: Emit,
    scheduler?: OmpTimelineScheduler,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ): Promise<OmpProviderSession> {
    if (input.persistence) {
      throw new OmpPublicError("OMP Plugin Preview does not support session persistence");
    }
    if (input.history !== "skip") {
      throw new OmpPublicError("OMP Plugin Preview does not support history replay");
    }
    if (input.config.mode && input.config.mode !== "full") {
      throw new OmpPublicError("OMP Plugin Preview supports Full Access mode only");
    }
    if (Object.keys(input.config.mcpServers ?? {}).length > 0) {
      throw new OmpPublicError("OMP Plugin Preview does not support host MCP servers");
    }
    if (input.config.toolPolicy) {
      throw new OmpPublicError("OMP Plugin Preview does not support host tool policies");
    }
    if (input.config.providerOptions && Object.keys(input.config.providerOptions).length > 0) {
      throw new OmpPublicError("OMP Plugin Preview does not support provider options");
    }
    if (Object.keys(input.config.settings ?? {}).length > 0) {
      throw new OmpPublicError("OMP Plugin Preview does not support provider settings");
    }
    if (input.config.title && utf8Bytes(input.config.title) > 256) {
      throw new OmpPublicError("OMP session title is too large");
    }
    const startOptions: OmpStartOptions = {
      cwd: input.config.cwd,
      env: input.config.env,
      // Model selection is authorized only after this runtime reports its exact catalog.
      mode: "full",
      thinkingOption: input.config.thinkingOption,
      systemPrompt: input.config.systemPrompt,
      signal,
      environment,
    };
    buildOmpSpawnRequest(startOptions);
    const native = await runtime.startSession(startOptions);
    try {
      const [initialState, nativeModels, commandDiscovery] = await Promise.all([
        native.getState(),
        native.getAvailableModels(),
        native.getAvailableCommands().then(
          (commands) => ({ available: true, commands }),
          () => ({ available: false, commands: [] }),
        ),
      ]);
      let state = initialState;
      const filter = new OmpPublicDataFilter([
        ...Object.values(input.config.env ?? {}),
        ...(native.redactionValues ?? []),
      ]);
      const models = mapOmpModels(nativeModels, filter);
      const nativeModelsByPublicId = new Map(
        nativeModels.map((model) => [ompModelId(model), model] as const),
      );
      if (input.config.model) {
        const selected = nativeModelsByPublicId.get(input.config.model);
        if (!selected) throw new OmpPublicError("OMP model selection is unavailable");
        if (state.model?.provider !== selected.provider || state.model.id !== selected.id) {
          await native.setModel(selected.provider, selected.id);
          state = await native.getState();
        }
      }
      const currentModel = state.model
        ? nativeModels.find(
            (model) => model.provider === state.model?.provider && model.id === state.model.id,
          )
        : undefined;
      if (state.model && !currentModel) {
        throw new OmpPublicError("OMP runtime selected an unadvertised model");
      }
      const thinkingOptions = thinkingForModel(currentModel);
      if (
        input.config.thinkingOption !== undefined &&
        !thinkingOptions.some((option) => option.id === input.config.thinkingOption)
      ) {
        throw new OmpPublicError("OMP thinking level is unavailable for the selected model");
      }
      if (
        state.thinkingLevel &&
        !thinkingOptions.some((option) => option.id === state.thinkingLevel)
      ) {
        throw new OmpPublicError("OMP runtime selected an unsupported thinking level");
      }
      const configState: ProviderConfigState = {
        ...(state.model ? { model: ompModelId(state.model) } : {}),
        mode: "full",
        ...(state.thinkingLevel ? { thinkingOption: state.thinkingLevel } : {}),
        models,
        modes: OMP_MODES,
        thinkingOptions,
        settings: [],
      };
      const recoveryOptions: Omit<OmpStartOptions, "resumeSessionId" | "signal"> = {
        cwd: input.config.cwd,
        env: input.config.env,
        mode: "full",
        systemPrompt: input.config.systemPrompt,
        ...(state.model ? { model: nativeOmpModelId(state.model) } : {}),
        environment,
        ...(state.thinkingLevel ? { thinkingOption: state.thinkingLevel } : {}),
      };
      return new OmpProviderSession(
        input.sessionId,
        native,
        runtime,
        recoveryOptions,
        state.sessionId,
        input.config,
        configState,
        nativeModelsByPublicId,
        capabilities,
        new Set(
          commandDiscovery.commands.flatMap((command) => [
            command.name,
            ...(command.aliases ?? []),
          ]),
        ),
        commandDiscovery.commands,
        commandDiscovery.available,
        emit,
        scheduler,
      );
    } catch (error) {
      const cleanup = native.close();
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure(
          "OMP session initialization cleanup failed",
          cleanup.catch(() => undefined),
        );
      }
      throw error;
    }
  }

  publishOpened(requestId: string): void {
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities: this.capabilities,
      restoration: "core",
      cwd: "<workspace>",
      ...(this.config.title ? { title: this.dataFilter.text(this.config.title, 256) } : {}),
    });
    this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
    this.publishCommands(this.commandCatalog);
    this.emit({ type: "session.ready", requestId, sessionId: this.id });
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

    if (input.prompt.delivery === "steer") {
      await this.steer(input.prompt.clientMessageId, payload.text, payload.images);
      return;
    }
    if (this.activeTurn) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: {
          type: "failed",
          error: { message: "OMP already has an active turn; send this message as a steer" },
        },
      });
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
    if (this.activeTurn) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: {
          type: "failed",
          error: { message: "OMP already has an active turn; send this message as a steer" },
        },
      });
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
    const turn: ActiveTurn = {
      turnId: randomUUID(),
      clientMessageId: input.prompt.clientMessageId,
      agentInvoked: undefined,
      generation: this.generation,
      promptResultEmitted: false,
      started: false,
      terminal: false,
      awaitingPermissionEvidence: false,
      interrupted: false,
      starting: true,
      nativeActivity: false,
      localOnlyDisabled: false,
      localOnlyEligible: false,
      terminalizing: false,
      steersInFlight: 0,
      userCorrelationActive: false,
      userLookups: new Set(),
      userEchoes: [],
      bufferedEvents: [],
      pendingUsers: [
        {
          clientMessageId: input.prompt.clientMessageId,
          text: payload.text,
          accepted: true,
          fallbackOnFinish: true,
          bufferedEchoes: [],
        },
      ],
    };
    this.activeTurn = turn;
    try {
      const acknowledgement = await this.runtime.prompt(payload.text, payload.images);
      if (this.closed || turn.terminal) return;
      turn.nativeRequestId = acknowledgement.requestId;
      this.publishPromptResult(turn, { type: "turn", turnId: turn.turnId });
      this.startTurn(turn);
      turn.starting = false;
      const bufferedEvents = turn.bufferedEvents.splice(0);
      for (const event of bufferedEvents) this.handleTurnEvent(turn, event);
      if (acknowledgement.agentInvoked === true) turn.agentInvoked = true;
      if (acknowledgement.agentInvoked === false && turn.agentInvoked !== true) {
        turn.agentInvoked = false;
        turn.localOnlyEligible = true;
        this.scheduleLocalOnlyCompletion(turn);
      }
    } catch (error) {
      this.publishPendingUsers(turn);
      const failure = providerError(error, "OMP prompt failed");
      this.publishPromptResult(turn, { type: "failed", error: failure });
      if (turn.started) this.finishTurn(turn, "failed", failure);
      else {
        turn.terminal = true;
        this.projector.finishTurn(turn.turnId);
        if (this.activeTurn === turn) this.activeTurn = null;
      }
    }
  }

  async interrupt(input: SessionInterruptInput): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      this.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    turn.awaitingPermissionEvidence = false;
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
      promise: runtime.abort(),
    };
    this.activeAbort = abort;
    await this.settleInterrupt(input.requestId, abort);
  }

  private async settleInterrupt(requestId: string, abort: PendingAbort): Promise<void> {
    try {
      await abort.promise;
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

  async configure(input: SessionConfigureInput): Promise<void> {
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
        throw new OmpPublicError("OMP Plugin Preview does not expose live provider settings");
      }
      if (input.changes.model === null || input.changes.thinkingOption === null) {
        throw new OmpPublicError("OMP model and thinking selections cannot be cleared");
      }
      const targetModelId = input.changes.model ?? this.configState.model;
      const targetModel = targetModelId
        ? this.nativeModelsByPublicId.get(targetModelId)
        : undefined;
      if (input.changes.model !== undefined && !targetModel) {
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
    if (
      this.configRefreshInFlight ||
      this.configRefreshRetryResolve ||
      this.configMutationInFlight
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
    if (
      state.thinkingLevel &&
      !thinkingOptions.some((option) => option.id === state.thinkingLevel)
    ) {
      throw new OmpCatalogEscape("OMP runtime selected an unsupported thinking level");
    }
    this.configRefreshAttempts = 0;
    this.cancelConfigRefreshRetry();
    const nextConfig: ProviderConfigState = {
      ...this.configState,
      ...(publicModelId ? { model: publicModelId } : { model: undefined }),
      ...(state.thinkingLevel
        ? { thinkingOption: state.thinkingLevel }
        : { thinkingOption: undefined }),
      thinkingOptions,
    };
    const changed =
      force ||
      nextConfig.model !== this.configState.model ||
      nextConfig.thinkingOption !== this.configState.thinkingOption ||
      nextConfig.thinkingOptions.length !== this.configState.thinkingOptions.length ||
      nextConfig.thinkingOptions.some(
        (option, index) =>
          option.id !== this.configState.thinkingOptions[index]?.id ||
          option.isDefault !== this.configState.thinkingOptions[index]?.isDefault,
      );
    this.configState = nextConfig;
    this.recoveryOptions = {
      cwd: this.recoveryOptions.cwd,
      env: this.recoveryOptions.env,
      mode: "full",
      systemPrompt: this.recoveryOptions.systemPrompt,
      environment: this.recoveryOptions.environment,
      ...(state.model ? { model: nativeOmpModelId(state.model) } : {}),
      ...(this.configState.thinkingOption
        ? { thinkingOption: this.configState.thinkingOption }
        : {}),
    };
    if (changed) {
      this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
    }
    return true;
  }

  async permission(input: SessionPermissionInput): Promise<void> {
    const pending = this.pendingPermissions.get(input.permissionId);
    if (!pending) throw new OmpPublicError("Unknown OMP permission request");
    const generation = this.generation;
    const runtime = this.runtime;
    this.pendingPermissions.delete(input.permissionId);
    this.inFlightPermissions.set(input.permissionId, pending);
    if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
    try {
      const response = this.extensionUiResponse(pending, input.response);
      await runtime.respondToExtensionUi(response);
    } catch (error) {
      if (this.inFlightPermissions.get(input.permissionId) !== pending) return;
      this.inFlightPermissions.delete(input.permissionId);
      if (
        !this.closed &&
        !this.runtimeDead &&
        !this.activeTurn?.terminal &&
        generation === this.generation &&
        runtime === this.runtime
      ) {
        this.pendingPermissions.set(input.permissionId, pending);
        this.armPermissionTimeout(input.permissionId, pending);
        throw error;
      }
      return;
    }
    if (this.inFlightPermissions.get(input.permissionId) !== pending) return;
    this.inFlightPermissions.delete(input.permissionId);
    this.clearPermissionEvidenceIfSettled();
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.id,
      permissionId: input.permissionId,
    });
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
    const turn = this.activeTurn;
    if (turn) {
      this.publishPendingUsers(turn);
      this.publishPromptResult(turn, {
        type: "failed",
        error: { message: "OMP session closed before the prompt was accepted" },
      });
      if (turn.started) this.finishTurn(turn, "canceled");
      else {
        turn.terminal = true;
        this.projector.finishTurn(turn.turnId);
      }
    }
    this.resolveAllPermissions(true);
    this.closed = true;
    this.configRefreshAttempts = 0;
    this.configRefreshDirty = false;
    const configRefresh = this.configRefreshInFlight;
    this.cancelConfigRefreshRetry();
    this.lifetime.abort(new Error("OMP provider session closed"));
    this.projector.close();
    this.unsubscribe();
    this.runtimeDisposal ??= this.runtime.close();
    await Promise.allSettled([
      this.runtimeDisposal,
      this.recoveryPromise,
      ...(configRefresh ? [configRefresh] : []),
    ]);
    await this.runtimeDisposal;
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
    const generation = this.generation;
    this.unsubscribe = runtime.onEvent((event) => {
      if (generation !== this.generation) return;
      this.handleRuntimeEvent(event);
    });
  }

  private async recoverRuntime(): Promise<void> {
    if (!this.runtimeDead) return;
    this.recoveryPromise ??= this.startRecovery();
    try {
      await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  private async startRecovery(): Promise<void> {
    const expectedSessionId = this.nativeSessionId;
    if (!expectedSessionId) {
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
        resumeSessionId: expectedSessionId,
        signal: this.lifetime.signal,
      });
    } catch (error) {
      if (error instanceof OmpCleanupFailure) {
        this.runtimeDisposal = error.cleanup.then(
          () => {
            throw new Error("OMP recovery cleanup failed");
          },
          () => {
            throw new Error("OMP recovery cleanup failed");
          },
        );
        void this.runtimeDisposal.catch(() => undefined);
      }
      throw error;
    }
    try {
      const state = await recovered.getState();
      if (state.sessionId !== expectedSessionId) {
        throw new Error(
          `OMP resumed native session '${state.sessionId}' instead of '${expectedSessionId}'`,
        );
      }
      const recoveredModel = state.model ? nativeOmpModelId(state.model) : undefined;
      if (!recoverFromNativeConfig && recoveredModel !== this.recoveryOptions.model) {
        throw new Error("OMP recovered with a different model");
      }
      const advertisedModel = state.model
        ? this.nativeModelsByPublicId.get(ompModelId(state.model))
        : undefined;
      if (state.model && !advertisedModel) {
        throw new Error("OMP recovered with an unadvertised model");
      }
      if (
        state.thinkingLevel &&
        !thinkingForModel(advertisedModel).some((option) => option.id === state.thinkingLevel)
      ) {
        throw new Error("OMP recovered with an unsupported thinking level");
      }
      if (this.closed) throw new Error("OMP session closed while runtime recovery was pending");
      this.dataFilter.addSensitiveValues(recovered.redactionValues ?? []);
      this.projector.addSensitiveValues(recovered.redactionValues ?? []);
      this.generation += 1;
      this.runtimeDead = null;
      this.runtimeDisposal = null;
      this.bindRuntime(recovered);
      if (!this.publishCommittedConfig(state, recovered, this.generation, true)) {
        throw new Error("OMP session changed while recovery configuration was pending");
      }
      this.recoveryUsesNativeConfig = false;
    } catch (error) {
      this.runtimeDisposal = recovered.close();
      void this.runtimeDisposal.catch(() => undefined);
      throw error;
    }
  }
  private async steer(
    clientMessageId: string,
    text: string,
    images: readonly OmpImage[],
  ): Promise<void> {
    const turn = this.activeTurn;
    if (!this.isSteerableTurn(turn)) {
      this.publishSteerFailure(clientMessageId, "There is no active OMP turn to steer");
      return;
    }
    const commandName = slashCommandName(text);
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

    const pending: PendingUser = {
      clientMessageId,
      text,
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
      this.publishSteerFailure(clientMessageId, "OMP has too many pending steer messages");
      return;
    }
    turn.pendingUsers.push(pending);
    turn.steersInFlight += 1;
    this.cancelLocalOnlyCompletion(turn);
    try {
      await this.runtime.steer(text, images);
      turn.steersInFlight -= 1;
      if (turn.terminal || turn.terminalizing || this.activeTurn !== turn) {
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
      turn.deferredAgentEnd = undefined;
      this.acceptPendingUser(turn, pending);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "steer", turnId: turn.turnId },
      });
    } catch (error) {
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
    if (event.type === "available_commands_update") {
      this.replaceSlashCommands(event.commands);
      this.commandCatalog = event.commands;
      this.publishCommands(event.commands);
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "cancel") {
        this.resolvePermissionByNativeId(event.targetId ?? "");
        return;
      }
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
        this.publishPermission(event);
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
      event.type === "notice" ||
      event.type === "todo_reminder" ||
      event.type === "todo_auto_clear" ||
      event.type === "auto_compaction_start" ||
      event.type === "auto_compaction_end" ||
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
    if (
      event.type === "model_changed" ||
      event.type === "thinking_level_changed" ||
      event.type === "retry_fallback_applied" ||
      event.type === "retry_fallback_succeeded"
    ) {
      this.scheduleCommittedConfigRefresh();
      return;
    }
    const turn = this.activeTurn;
    if (!turn) return;
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

  private handleTurnEvent(turn: ActiveTurn, event: OmpRpcEvent): void {
    if (turn.generation !== this.generation || turn.terminal || this.activeTurn !== turn) return;
    if (event.type === "prompt_result") {
      if (
        !event.id ||
        event.id !== turn.nativeRequestId ||
        turn.localOnlyDisabled ||
        turn.steersInFlight > 0
      ) {
        return;
      }
      if (event.agentInvoked) {
        turn.agentInvoked = true;
        turn.localOnlyEligible = false;
        this.cancelLocalOnlyCompletion(turn);
      } else if (!turn.nativeActivity) {
        turn.agentInvoked = false;
        turn.localOnlyEligible = true;
        this.scheduleLocalOnlyCompletion(turn);
      }
      return;
    }
    if (
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      turn.awaitingPermissionEvidence = false;
    }
    if (event.type === "agent_end") {
      const hasAssistantEvidence =
        event.messages?.some((message) => message.role === "assistant") ?? false;
      if (turn.awaitingPermissionEvidence && !hasAssistantEvidence) return;
      if (hasAssistantEvidence) turn.awaitingPermissionEvidence = false;
      if (event.isTerminal === false || turn.terminalizing) return;
      if (turn.steersInFlight > 0) {
        turn.deferredAgentEnd = event;
        return;
      }
      this.beginTerminalization(turn, event);
      return;
    }
    if (isNativeTurnActivity(event)) {
      turn.nativeActivity = true;
      this.cancelLocalOnlyCompletion(turn);
    }
    if (event.type === "message_end" && event.message.role === "user") {
      this.projectUserEcho(turn, event.message);
      return;
    }
    this.projector.project(event, turn.turnId);
  }

  private projectUserEcho(turn: ActiveTurn, message: OmpMessage): void {
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
      let resolvedId = entryId ?? this.claimUnclaimedBranchEntry(pending.text);
      if (!resolvedId) {
        try {
          const messages = await this.runtime.getBranchMessages();
          if (
            this.closed ||
            turn.terminal ||
            this.activeTurn !== turn ||
            turn.pendingUsers[0] !== pending
          ) {
            return;
          }
          if (retainedBytes(messages, MAX_UNCLAIMED_BRANCH_BYTES) === Number.POSITIVE_INFINITY) {
            this.quarantineBranchEntries();
            return;
          }
          const unseen: Array<{ entryId: string; text: string }> = [];
          for (const branchMessage of messages) {
            if (!this.seenEntryIds.has(branchMessage.entryId)) unseen.push(branchMessage);
          }
          if (!this.branchWatermarkValid) {
            this.unclaimedBranchEntries.length = 0;
            this.branchWatermarkValid = true;
          } else if (
            unseen.length <= MAX_UNCLAIMED_BRANCH_ENTRIES - this.unclaimedBranchEntries.length &&
            retainedBytes(this.unclaimedBranchEntries, MAX_UNCLAIMED_BRANCH_BYTES) +
              retainedBytes(unseen, MAX_UNCLAIMED_BRANCH_BYTES) <=
              MAX_UNCLAIMED_BRANCH_BYTES
          ) {
            this.unclaimedBranchEntries.push(...unseen);
          } else {
            this.quarantineBranchEntries();
          }
          for (const branchMessage of messages) this.seenEntryIds.add(branchMessage.entryId);
          resolvedId = this.claimUnclaimedBranchEntry(pending.text);
        } catch {
          if (
            this.closed ||
            turn.terminal ||
            this.activeTurn !== turn ||
            turn.pendingUsers[0] !== pending
          ) {
            return;
          }
          this.quarantineBranchEntries();
        }
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
      this.publishCorrelatedUser(pending, resolvedId);
    }
  }

  private claimUnclaimedBranchEntry(text: string): string | undefined {
    const index = this.unclaimedBranchEntries.findIndex((entry) => entry.text === text);
    if (index < 0) return undefined;
    return this.unclaimedBranchEntries.splice(index, 1)[0]?.entryId;
  }

  private quarantineBranchEntries(): void {
    this.unclaimedBranchEntries.length = 0;
    this.branchWatermarkValid = false;
  }

  private isSteerableTurn(turn: ActiveTurn | null): turn is ActiveTurn {
    return (
      turn !== null &&
      this.activeTurn === turn &&
      !turn.terminal &&
      !turn.terminalizing &&
      !turn.deferredAgentEnd &&
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
    for (const command of commands) {
      this.slashCommands.add(command.name);
      for (const alias of command.aliases ?? []) this.slashCommands.add(alias);
    }
    this.commandDiscoveryAvailable = true;
  }

  private publishCommands(commands: OmpAvailableCommand[]): void {
    this.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: commands.map((command) => {
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
  private publishPermission(request: Extract<OmpRpcEvent, { type: "extension_ui_request" }>): void {
    if (request.method === "select" && !request.options?.length) {
      this.handleRuntimeFailure();
      return;
    }
    let existingId: string | undefined;
    let existingPending: PendingPermission | undefined;
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.nativeId !== request.id) continue;
      existingId = permissionId;
      existingPending = pending;
      break;
    }
    if (!existingId) {
      for (const pending of this.inFlightPermissions.values()) {
        if (pending.nativeId === request.id) return;
      }
    }
    if (
      !existingId &&
      this.pendingPermissions.size + this.inFlightPermissions.size >= MAX_PENDING_PERMISSIONS
    ) {
      this.emit({
        type: "session.notice",
        sessionId: this.id,
        notice: {
          id: `omp:permission-saturated:${this.permissionSequence + 1}`,
          severity: "warning",
          title: "OMP question canceled",
          description: "Too many OMP questions are already pending",
        },
      });
      void this.runtime
        .respondToExtensionUi({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        })
        .catch(() => this.handleRuntimeFailure());
      return;
    }
    if (existingPending?.timer !== undefined) this.scheduler.clear(existingPending.timer);
    if (!existingId) this.permissionSequence += 1;
    const id = existingId ?? `omp:permission:${this.permissionSequence}`;
    const header = this.dataFilter.text(request.title ?? "OMP question", 4_096);
    const optionValues = new Map<string, string>();
    const displayValues = new Map<string, string[]>();
    const options = request.options?.map((nativeValue, index) => {
      const label = this.dataFilter.text(nativeValue, 4_096);
      const digest = createHash("sha256").update(nativeValue).digest("base64url").slice(0, 8);
      const value = `option:${index}:${digest}`;
      optionValues.set(value, nativeValue);
      displayValues.set(label, [...(displayValues.get(label) ?? []), nativeValue]);
      return {
        label,
        value,
        ...(request.optionDetails?.[index]?.description
          ? {
              description: this.dataFilter.text(
                request.optionDetails[index]?.description ?? "",
                16_384,
              ),
            }
          : {}),
      };
    });
    // OMP passes rpc-ui dialog timeouts directly to setTimeout, so the wire unit is milliseconds.
    const pending: PendingPermission = {
      nativeId: request.id,
      header,
      optionValues,
      displayValues,
      request,
      ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
      ...(request.timeout !== undefined ? { expiresAt: Date.now() + request.timeout } : {}),
    };
    this.pendingPermissions.set(id, pending);
    this.armPermissionTimeout(id, pending);
    this.projector.markAskPermissionRendered();
    if (this.activeTurn) this.activeTurn.awaitingPermissionEvidence = true;
    const actions =
      request.method === "select"
        ? [
            ...(options ?? []).map((option) => ({
              id: option.value,
              label: option.label,
              behavior: "allow" as const,
              variant: "secondary" as const,
            })),
            {
              id: "cancel",
              label: "Cancel",
              behavior: "deny" as const,
              variant: "secondary" as const,
            },
          ]
        : [
            {
              id: "submit",
              label: request.method === "confirm" ? "Confirm" : "Submit",
              behavior: "allow" as const,
              variant: "primary" as const,
            },
            {
              id: "cancel",
              label: "Cancel",
              behavior: "deny" as const,
              variant: "secondary" as const,
            },
          ];
    this.emit({
      type: "session.permission",
      sessionId: this.id,
      request: {
        id,
        name: `omp.${request.method}`,
        kind: "question",
        title: header,
        ...(request.message
          ? { description: this.dataFilter.text(request.message, 64 * 1024) }
          : {}),
        input: {
          questions: [
            {
              header,
              question: this.dataFilter.text(
                request.message ?? request.title ?? "OMP input",
                64 * 1024,
              ),
              ...(options ? { options } : {}),
              ...(request.placeholder
                ? { placeholder: this.dataFilter.text(request.placeholder, 4_096) }
                : {}),
              ...(request.prefill ? { prefill: this.dataFilter.text(request.prefill) } : {}),
            },
          ],
          ...(request.url
            ? { url: this.dataFilter.text(request.launchUrl ?? request.url, 16_384) }
            : {}),
          ...(request.instructions
            ? { instructions: this.dataFilter.text(request.instructions, 64 * 1024) }
            : {}),
        },
        actions,
      },
    });
  }

  private extensionUiResponse(
    pending: PendingPermission,
    response: ProviderPermissionResponse,
  ): OmpExtensionUiResponse {
    const { nativeId, request, header } = pending;
    if (request.method === "confirm") {
      return {
        type: "extension_ui_response",
        id: nativeId,
        confirmed: response.behavior === "allow",
      };
    }
    if (response.behavior === "deny") {
      return { type: "extension_ui_response", id: nativeId, cancelled: true };
    }
    if (request.method === "open_url") {
      return {
        type: "extension_ui_response",
        id: nativeId,
        value: request.launchUrl ?? request.url ?? "",
      };
    }
    const selectedValue = response.selectedActionId
      ? pending.optionValues.get(response.selectedActionId)
      : undefined;
    if (selectedValue !== undefined) {
      return { type: "extension_ui_response", id: nativeId, value: selectedValue };
    }
    const answers = response.updatedInput?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new OmpPublicError("OMP question response requires answers");
    }
    const answer = answers[header];
    const publicValue = Array.isArray(answer) ? answer[0] : answer;
    if (typeof publicValue !== "string")
      throw new OmpPublicError("OMP question response is invalid");
    if (request.method === "select") {
      const mapped = pending.optionValues.get(publicValue);
      if (mapped !== undefined) {
        return { type: "extension_ui_response", id: nativeId, value: mapped };
      }
      const displayMatches = pending.displayValues.get(publicValue) ?? [];
      if (displayMatches.length !== 1 || displayMatches[0] === undefined) {
        throw new OmpPublicError("OMP selection response is ambiguous");
      }
      return { type: "extension_ui_response", id: nativeId, value: displayMatches[0] };
    }
    return { type: "extension_ui_response", id: nativeId, value: publicValue };
  }

  private resolvePermissionByNativeId(nativeId: string): void {
    for (const permissions of [this.pendingPermissions, this.inFlightPermissions]) {
      for (const [permissionId, pending] of permissions) {
        if (pending.nativeId !== nativeId) continue;
        permissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        this.clearPermissionEvidenceIfSettled();
        this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
        return;
      }
    }
  }

  private resolveTurnPermissions(turnId: string): void {
    this.resolvePermissions((pending) => pending.turnId === turnId, true);
  }

  private resolveAllPermissions(cancelNative = false): void {
    this.resolvePermissions(() => true, cancelNative);
  }

  private resolvePermissions(
    matches: (pending: PendingPermission) => boolean,
    cancelNative: boolean,
  ): void {
    const permissionIds = new Set<string>();
    for (const permissions of [this.pendingPermissions, this.inFlightPermissions]) {
      for (const [permissionId, pending] of permissions) {
        if (!matches(pending)) continue;
        permissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        permissionIds.add(permissionId);
        if (cancelNative && permissions === this.pendingPermissions) {
          void this.runtime
            .respondToExtensionUi({
              type: "extension_ui_response",
              id: pending.nativeId,
              cancelled: true,
            })
            .catch(() => {
              if (!this.closed && !this.runtimeDead) {
                this.invalidateRuntime("OMP permission cancellation failed");
              }
            });
        }
      }
    }
    for (const permissionId of permissionIds) {
      this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
    }
    this.clearPermissionEvidenceIfSettled();
  }

  private armPermissionTimeout(permissionId: string, pending: PendingPermission): void {
    if (pending.expiresAt === undefined) return;
    const remainingMs = Math.max(0, pending.expiresAt - Date.now());
    pending.timer = this.scheduler.set(() => {
      if (this.pendingPermissions.get(permissionId) !== pending) return;
      this.pendingPermissions.delete(permissionId);
      this.inFlightPermissions.set(permissionId, pending);
      void this.runtime
        .respondToExtensionUi({
          type: "extension_ui_response",
          id: pending.nativeId,
          cancelled: true,
          timedOut: true,
        })
        .then(
          () => {
            if (this.inFlightPermissions.get(permissionId) !== pending) return;
            this.inFlightPermissions.delete(permissionId);
            this.clearPermissionEvidenceIfSettled();
            this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
          },
          () => this.handleRuntimeFailure(),
        );
    }, remainingMs);
  }

  private clearPermissionEvidenceIfSettled(): void {
    if (
      this.pendingPermissions.size === 0 &&
      this.inFlightPermissions.size === 0 &&
      this.activeTurn
    ) {
      this.activeTurn.awaitingPermissionEvidence = false;
    }
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

  private publishCorrelatedUser(pending: PendingUser, entryId?: string): void {
    if (entryId) {
      if (this.emittedEntryIds.has(entryId)) return;
      this.seenEntryIds.add(entryId);
      this.emittedEntryIds.add(entryId);
      const unclaimedIndex = this.unclaimedBranchEntries.findIndex(
        (entry) => entry.entryId === entryId,
      );
      if (unclaimedIndex >= 0) this.unclaimedBranchEntries.splice(unclaimedIndex, 1);
    }
    this.projector.publishUser(pending.text, pending.clientMessageId, entryId);
  }

  private scheduleLocalOnlyCompletion(turn: ActiveTurn): void {
    if (turn.localOnlyDisabled || turn.steersInFlight > 0) return;
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

  private async completeLocalOnlyTurn(turn: ActiveTurn): Promise<void> {
    await Promise.allSettled(turn.userLookups);
    if (this.closed || turn.terminal || this.activeTurn !== turn) return;
    if (
      turn.terminal ||
      turn.nativeActivity ||
      turn.localOnlyDisabled ||
      turn.steersInFlight > 0 ||
      this.activeTurn !== turn
    ) {
      return;
    }
    this.publishPendingUsers(turn);
    this.finishTurn(turn, "completed", undefined, true);
  }

  private beginTerminalization(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  ): void {
    if (turn.terminal || turn.terminalizing || this.activeTurn !== turn) return;
    turn.terminalizing = true;
    if (turn.userLookups.size === 0 && turn.userEchoes.length === 0) {
      this.completeAgentEnd(turn, event);
      return;
    }
    void this.finishFromAgentEnd(turn, event);
  }

  private resumeAfterFailedSteer(turn: ActiveTurn): void {
    if (turn.terminal || this.activeTurn !== turn || turn.steersInFlight > 0) return;
    const deferred = turn.deferredAgentEnd;
    if (deferred) {
      turn.deferredAgentEnd = undefined;
      this.beginTerminalization(turn, deferred);
      return;
    }
    if (turn.localOnlyEligible && !turn.localOnlyDisabled && !turn.nativeActivity) {
      this.scheduleLocalOnlyCompletion(turn);
    }
  }

  private async finishFromAgentEnd(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  ): Promise<void> {
    while (true) {
      await Promise.allSettled(turn.userLookups);
      if (this.closed || turn.terminal || this.activeTurn !== turn) return;
      if (turn.userEchoes.length === 0) break;
      this.drainUserEchoes(turn);
      if (turn.userLookups.size === 0) break;
    }
    if (this.closed || turn.terminal || this.activeTurn !== turn) return;
    if (turn.interrupted) {
      this.completeAgentEnd(turn, event);
      return;
    }
    const state = await this.confirmAgentEndState(turn);
    if (this.closed || turn.terminal || this.activeTurn !== turn) return;
    if (!state) {
      const message = "OMP agent_end state could not be confirmed";
      this.completeAgentEnd(turn, event);
      this.invalidateRuntime(message);
      return;
    }
    if (state.isStreaming || state.isCompacting) {
      const message = "OMP agent_end arrived while the native runtime remained active";
      this.publishPendingUsers(turn);
      this.invalidateRuntime(message);
      this.finishTurn(turn, "failed", { message });
      return;
    }
    this.completeAgentEnd(turn, event);
  }

  private completeAgentEnd(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  ): void {
    if (turn.generation !== this.generation || turn.terminal || this.activeTurn !== turn) return;
    this.publishPendingUsers(turn);
    const error = terminalError(event);
    if (turn.interrupted) this.finishTurn(turn, "canceled");
    else if (error) this.finishTurn(turn, "failed", { message: error });
    else this.finishTurn(turn, "completed");
  }

  private async confirmAgentEndState(turn: ActiveTurn): Promise<OmpSessionState | undefined> {
    const generation = turn.generation;
    const runtime = this.runtime;
    const state = await this.readRuntimeStateWithTimeout(runtime);
    if (!this.isCurrentRuntime(runtime, generation)) return undefined;
    return state;
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

  private startTurn(turn: ActiveTurn): void {
    if (turn.started || turn.terminal) return;
    turn.started = true;
    this.emit({ type: "session.turn", sessionId: this.id, turnId: turn.turnId, state: "started" });
  }
  private finishTurn(
    turn: ActiveTurn,
    state: "completed" | "failed" | "canceled",
    error?: { message: string },
    preserveCompactions = false,
  ): void {
    if (turn.terminal) return;
    turn.terminal = true;
    this.cancelLocalOnlyCompletion(turn);
    this.resolveTurnPermissions(turn.turnId);
    this.projector.finishTurn(turn.turnId, preserveCompactions);
    this.unclaimedBranchEntries.length = 0;
    this.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId: turn.turnId,
      state,
      ...(error ? { error } : {}),
    });
    if (this.activeTurn === turn) this.activeTurn = null;
  }

  private invalidateRuntime(message: string): void {
    if (this.closed || this.runtimeDead) return;
    this.recoveryUsesNativeConfig ||=
      this.configRefreshInFlight !== null || this.configRefreshDirty || this.configMutationInFlight;
    this.generation += 1;
    this.projector.retireCompactions("OMP runtime ended during compaction");
    this.runtimeDead = message;
    this.configRefreshAttempts = 0;
    this.configRefreshDirty = false;
    const configRefresh = this.configRefreshInFlight;
    this.cancelConfigRefreshRetry();
    this.unsubscribe();
    this.unsubscribe = () => {};
    const runtimeDisposal = this.runtimeDisposal ?? this.runtime.close();
    this.runtimeDisposal = configRefresh
      ? Promise.all([runtimeDisposal, configRefresh]).then(() => undefined)
      : runtimeDisposal;
    void this.runtimeDisposal.catch(() => undefined);
  }

  private handleRuntimeFailure(message = "OMP runtime failed"): void {
    if (this.closed || this.runtimeDead) return;
    this.resolveAllPermissions();
    this.invalidateRuntime(message);
    const turn = this.activeTurn;
    if (!turn) return;
    this.publishPendingUsers(turn);
    this.publishPromptResult(turn, { type: "failed", error: { message } });
    if (turn.started) this.finishTurn(turn, "failed", { message });
    else {
      turn.terminal = true;
      this.projector.finishTurn(turn.turnId);
      if (this.activeTurn === turn) this.activeTurn = null;
    }
  }
}
