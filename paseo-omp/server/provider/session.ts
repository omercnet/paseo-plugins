import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ProviderConfigState,
  ProviderEvent,
  ProviderInput,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { mapOmpModels, OMP_MODES, ompModelId, parseOmpModelId, thinkingForModel } from "./catalog";
import type {
  OmpMessage,
  OmpRpcEvent,
  OmpRuntime,
  OmpRuntimeSession,
  OmpSessionState,
} from "./omp-rpc";
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
type Emit = (event: ProviderEvent) => void;
const LOCAL_ONLY_SETTLE_MS = 5_000;

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
  promptResultEmitted: boolean;
  started: boolean;
  terminal: boolean;
  interrupted: boolean;
  starting: boolean;
  nativeActivity: boolean;
  localOnlyDisabled: boolean;
  localOnlyEligible: boolean;
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

function providerError(error: unknown, prefix?: string): { message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { message: prefix ? `${prefix}: ${message}` : message };
}

function textPrompt(input: SessionPromptInput): string {
  if (input.prompt.input.type !== "message") {
    throw new Error("OMP Plugin Preview supports text messages only");
  }
  const parts: string[] = [];
  for (const part of input.prompt.input.content) {
    if (part.type !== "text") {
      throw new Error(`OMP Plugin Preview does not support prompt content type '${part.type}'`);
    }
    parts.push(part.text);
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("OMP prompt text cannot be empty");
  return text;
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

function isExistingAbsolutePathProse(text: string): boolean {
  const firstWhitespace = text.search(/\s/);
  if (firstWhitespace <= 1) return false;
  const candidate = text.slice(0, firstWhitespace);
  return !candidate.includes(":") && existsSync(candidate);
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
      return message.errorMessage ?? "OMP assistant turn failed";
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
  private readonly unsubscribe: () => void;
  private activeTurn: ActiveTurn | null = null;
  private closed = false;
  private failurePublished = false;
  private disposalPromise: Promise<void> | null = null;
  private sessionClosedPublished = false;
  private readonly emittedEntryIds = new Set<string>();
  private readonly seenEntryIds = new Set<string>();
  private branchWatermarkValid = true;
  private readonly unclaimedBranchEntries: Array<{ entryId: string; text: string }> = [];
  private readonly scheduler: OmpTimelineScheduler;

  private constructor(
    id: string,
    private readonly runtime: OmpRuntimeSession,
    private readonly config: ProviderSessionConfig,
    private configState: ProviderConfigState,
    private readonly capabilities: readonly string[],
    private readonly slashCommands: Set<string>,
    private commandDiscoveryAvailable: boolean,
    private readonly emit: Emit,
    scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
  ) {
    this.id = id;
    this.cwd = config.cwd;
    this.scheduler = scheduler;
    this.projector = new OmpTimelineProjector(id, emit, scheduler);
    this.unsubscribe = runtime.onEvent((event) => this.handleRuntimeEvent(event));
  }

  static async open(
    input: SessionOpenInput,
    runtime: OmpRuntime,
    capabilities: readonly string[],
    emit: Emit,
    scheduler?: OmpTimelineScheduler,
    signal?: AbortSignal,
  ): Promise<OmpProviderSession> {
    if (input.persistence) {
      throw new Error("OMP Plugin Preview does not support session persistence");
    }
    if (input.config.mode && input.config.mode !== "full") {
      throw new Error(`Unsupported OMP Plugin Preview mode '${input.config.mode}'`);
    }
    const native = await runtime.startSession({
      cwd: input.config.cwd,
      env: input.config.env,
      model: input.config.model,
      mode: "full",
      thinkingOption: input.config.thinkingOption,
      systemPrompt: input.config.systemPrompt,
      signal,
    });
    try {
      const [state, nativeModels, commandDiscovery] = await Promise.all([
        native.getState(),
        native.getAvailableModels(),
        native.getAvailableCommands().then(
          (commands) => ({ available: true, commands }),
          () => ({ available: false, commands: [] }),
        ),
      ]);
      const models = mapOmpModels(nativeModels);
      const currentModel = state.model
        ? nativeModels.find(
            (model) => model.provider === state.model?.provider && model.id === state.model.id,
          )
        : undefined;
      const configState: ProviderConfigState = {
        ...(state.model ? { model: ompModelId(state.model) } : {}),
        mode: "full",
        ...(state.thinkingLevel ? { thinkingOption: state.thinkingLevel } : {}),
        models,
        modes: OMP_MODES,
        thinkingOptions: thinkingForModel(currentModel),
        settings: [],
      };
      return new OmpProviderSession(
        input.sessionId,
        native,
        input.config,
        configState,
        capabilities,
        new Set(
          commandDiscovery.commands.flatMap((command) => [
            command.name,
            ...(command.aliases ?? []),
          ]),
        ),
        commandDiscovery.available,
        emit,
        scheduler,
      );
    } catch (error) {
      await native.close().catch(() => undefined);
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
      cwd: this.cwd,
      ...(this.config.title ? { title: this.config.title } : {}),
    });
    this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
    this.emit({ type: "session.ready", requestId, sessionId: this.id });
  }

  async prompt(input: SessionPromptInput): Promise<void> {
    let text: string;
    try {
      text = textPrompt(input);
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: providerError(error) },
      });
      return;
    }

    if (input.prompt.delivery === "steer") {
      await this.steer(input.prompt.clientMessageId, text);
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

    const turn: ActiveTurn = {
      turnId: randomUUID(),
      clientMessageId: input.prompt.clientMessageId,
      promptResultEmitted: false,
      started: false,
      terminal: false,
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
          text,
          accepted: true,
          fallbackOnFinish: true,
          bufferedEchoes: [],
        },
      ],
    };
    this.activeTurn = turn;
    try {
      const acknowledgement = await this.runtime.prompt(text);
      if (this.closed || turn.terminal) return;
      turn.nativeRequestId = acknowledgement.requestId;
      this.publishPromptResult(turn, { type: "turn", turnId: turn.turnId });
      this.startTurn(turn);
      turn.starting = false;
      if (acknowledgement.agentInvoked !== true) {
        turn.localOnlyEligible = true;
        this.scheduleLocalOnlyCompletion(turn);
      }
      const bufferedEvents = turn.bufferedEvents.splice(0);
      for (const event of bufferedEvents) this.handleTurnEvent(turn, event);
    } catch (error) {
      this.publishPendingUsers(turn);
      this.publishPromptResult(turn, { type: "failed", error: providerError(error) });
      if (turn.started) this.finishTurn(turn, "failed", providerError(error));
      else {
        turn.terminal = true;
        this.projector.finishTurn(turn.turnId);
        if (this.activeTurn === turn) this.activeTurn = null;
      }
    }
  }

  async interrupt(input: SessionInterruptInput): Promise<void> {
    const turn = this.activeTurn;
    if (turn) turn.interrupted = true;
    try {
      await this.runtime.abort();
      this.emit({ type: "request.completed", requestId: input.requestId });
    } catch (error) {
      if (turn) turn.interrupted = false;
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: providerError(error, "OMP interrupt failed"),
      });
    }
  }

  async configure(input: SessionConfigureInput): Promise<void> {
    try {
      if (input.changes.mode !== undefined && input.changes.mode !== this.configState.mode) {
        throw new Error("OMP approval mode cannot change live; create a new session instead");
      }
      if (input.changes.settings && Object.keys(input.changes.settings).length > 0) {
        throw new Error("OMP Plugin Preview does not expose live provider settings");
      }
      if (input.changes.model === null || input.changes.thinkingOption === null) {
        throw new Error("OMP model and thinking selections cannot be cleared");
      }
      if (input.changes.model) {
        const model = parseOmpModelId(input.changes.model);
        await this.runtime.setModel(model.provider, model.modelId);
      }
      if (input.changes.thinkingOption) {
        await this.runtime.setThinkingLevel(input.changes.thinkingOption);
      }
      this.publishCommittedConfig(await this.runtime.getState());
      this.emit({ type: "request.completed", requestId: input.requestId });
    } catch (error) {
      await this.runtime
        .getState()
        .then((state) => this.publishCommittedConfig(state))
        .catch(() => undefined);
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: providerError(error, "OMP configuration failed"),
      });
    }
  }

  private publishCommittedConfig(state: OmpSessionState): void {
    this.configState = {
      ...this.configState,
      ...(state.model ? { model: ompModelId(state.model) } : { model: undefined }),
      ...(state.thinkingLevel
        ? { thinkingOption: state.thinkingLevel }
        : { thinkingOption: undefined }),
      thinkingOptions: thinkingForModel(state.model),
    };
    this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
  }

  close(input?: SessionCloseInput): Promise<void> {
    this.disposalPromise ??= this.disposeSession();
    return this.disposalPromise.then(
      () => {
        if (!this.failurePublished) this.publishSessionClosed();
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
    this.closed = true;
    this.projector.close();
    this.unsubscribe();
    await this.runtime.close();
  }

  private publishSessionClosed(error?: { message: string }): void {
    if (this.sessionClosedPublished) return;
    this.sessionClosedPublished = true;
    this.emit({ type: "session.closed", sessionId: this.id, ...(error ? { error } : {}) });
  }

  private async steer(clientMessageId: string, text: string): Promise<void> {
    const turn = this.activeTurn;
    if (!this.isSteerableTurn(turn)) {
      this.publishSteerFailure(clientMessageId, "There is no active OMP turn to steer");
      return;
    }
    const commandName = slashCommandName(text);
    const slashCommandUnavailable = commandName
      ? await this.slashSteerUnavailable(commandName, text)
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
    turn.pendingUsers.push(pending);
    turn.steersInFlight += 1;
    this.cancelLocalOnlyCompletion(turn);
    try {
      await this.runtime.steer(text);
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
      return;
    }
    if (event.type === "extension_ui_request") {
      if (isPassiveUiMethod(event.method)) {
        this.projector.projectPassive(event);
        return;
      }
      const detail = event.title ?? event.message ?? event.method;
      this.handleRuntimeFailure(
        `OMP requested unsupported interactive UI (${detail}); use Full Access mode`,
      );
      return;
    }
    if (event.type === "notice" || event.type === "todo_reminder") {
      this.projector.projectPassive(event);
      return;
    }
    if (event.type === "process_exit") {
      this.handleRuntimeFailure(event.error);
      return;
    }
    const turn = this.activeTurn;
    if (!turn) return;
    if (turn.starting) {
      turn.bufferedEvents.push(event);
      return;
    }
    this.handleTurnEvent(turn, event);
  }

  private handleTurnEvent(turn: ActiveTurn, event: OmpRpcEvent): void {
    if (turn.terminal || this.activeTurn !== turn) return;
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
        turn.localOnlyEligible = false;
        this.cancelLocalOnlyCompletion(turn);
      } else if (!turn.nativeActivity) {
        turn.localOnlyEligible = true;
        this.scheduleLocalOnlyCompletion(turn);
      }
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
    if (event.type === "agent_end") {
      if (event.isTerminal === false || turn.terminalizing) return;
      if (turn.steersInFlight > 0) {
        turn.deferredAgentEnd = event;
        return;
      }
      this.beginTerminalization(turn, event);
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
          const unseen = messages.filter(
            (branchMessage) => !this.seenEntryIds.has(branchMessage.entryId),
          );
          if (!this.branchWatermarkValid) {
            this.unclaimedBranchEntries.length = 0;
            this.branchWatermarkValid = true;
          } else {
            this.unclaimedBranchEntries.push(...unseen);
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

  private replaceSlashCommands(commands: Array<{ name: string; aliases?: string[] }>): void {
    this.slashCommands.clear();
    for (const command of commands) {
      this.slashCommands.add(command.name);
      for (const alias of command.aliases ?? []) this.slashCommands.add(alias);
    }
    this.commandDiscoveryAvailable = true;
  }

  private async slashSteerUnavailable(commandName: string, text: string): Promise<boolean> {
    if (!this.commandDiscoveryAvailable || !this.slashCommands.has(commandName)) {
      try {
        this.replaceSlashCommands(await this.runtime.getAvailableCommands());
      } catch {
        this.commandDiscoveryAvailable = false;
        return true;
      }
    }
    return this.slashCommands.has(commandName) || !isExistingAbsolutePathProse(text);
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
    this.finishTurn(turn, "completed");
  }

  private beginTerminalization(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  ): void {
    if (turn.terminal || turn.terminalizing || this.activeTurn !== turn) return;
    turn.terminalizing = true;
    if (turn.userLookups.size === 0 && turn.userEchoes.length === 0) {
      this.completeAgentEnd(turn, event);
    } else {
      void this.finishFromAgentEnd(turn, event);
    }
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
    this.completeAgentEnd(turn, event);
  }

  private completeAgentEnd(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  ): void {
    if (turn.terminal || this.activeTurn !== turn) return;
    this.publishPendingUsers(turn);
    const error = terminalError(event);
    if (turn.interrupted) this.finishTurn(turn, "canceled");
    else if (error) this.finishTurn(turn, "failed", { message: error });
    else this.finishTurn(turn, "completed");
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
  ): void {
    if (turn.terminal) return;
    turn.terminal = true;
    this.cancelLocalOnlyCompletion(turn);
    this.projector.finishTurn(turn.turnId);
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

  private handleRuntimeFailure(message: string): void {
    if (this.failurePublished) return;
    this.failurePublished = true;
    const turn = this.activeTurn;
    if (turn) {
      this.publishPendingUsers(turn);
      this.publishPromptResult(turn, { type: "failed", error: { message } });
      if (turn.started) this.finishTurn(turn, "failed", { message });
      else turn.terminal = true;
    }
    this.projector.close();
    this.closed = true;
    this.unsubscribe();
    this.emit({ type: "session.runtime_failed", sessionId: this.id, error: { message } });
    this.disposalPromise ??= this.runtime.close();
    void this.disposalPromise.catch(() => undefined);
  }
}
