import { randomUUID } from "node:crypto";
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
  nativeRequestId?: string;
  localOnlyTimer?: unknown;
  terminalizing: boolean;
  bufferedEvents: OmpRpcEvent[];
  pendingUsers: PendingUser[];
  userLookups: Set<Promise<void>>;
  unresolvedUsers: Set<PendingUser>;
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
  if (event.type === "agent_start" || event.type === "turn_start" || event.type === "agent_end") {
    return true;
  }
  if (event.type === "message_start" || event.type === "message_update") {
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
  private readonly scheduler: OmpTimelineScheduler;

  private constructor(
    id: string,
    private readonly runtime: OmpRuntimeSession,
    private readonly config: ProviderSessionConfig,
    private configState: ProviderConfigState,
    private readonly capabilities: readonly string[],
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
      const [state, nativeModels] = await Promise.all([
        native.getState(),
        native.getAvailableModels(),
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
      terminalizing: false,
      unresolvedUsers: new Set(),
      userLookups: new Set(),
      bufferedEvents: [],
      pendingUsers: [{ clientMessageId: input.prompt.clientMessageId, text }],
    };
    this.activeTurn = turn;
    try {
      const acknowledgement = await this.runtime.prompt(text);
      if (this.closed || turn.terminal) return;
      turn.nativeRequestId = acknowledgement.requestId;
      this.publishPromptResult(turn, { type: "turn", turnId: turn.turnId });
      this.startTurn(turn);
      turn.starting = false;
      if (acknowledgement.agentInvoked !== true) this.scheduleLocalOnlyCompletion(turn);
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
    if (!turn || turn.terminal || !turn.started) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "failed", error: { message: "There is no active OMP turn to steer" } },
      });
      return;
    }
    try {
      await this.runtime.steer(text);
      if (turn.terminal || this.activeTurn !== turn) {
        this.projector.publishUser(text, clientMessageId);
      } else {
        turn.pendingUsers.push({ clientMessageId, text });
      }
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "steer", turnId: turn.turnId },
      });
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "failed", error: providerError(error, "OMP steer failed") },
      });
    }
  }

  private handleRuntimeEvent(event: OmpRpcEvent): void {
    if (this.closed) return;
    if (event.type === "extension_ui_request") {
      if (isPassiveUiMethod(event.method)) return;
      const detail = event.title ?? event.message ?? event.method;
      this.handleRuntimeFailure(
        `OMP requested unsupported interactive UI (${detail}); use Full Access mode`,
      );
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
      if (!event.id || event.id !== turn.nativeRequestId) return;
      if (event.agentInvoked) this.cancelLocalOnlyCompletion(turn);
      else if (!turn.nativeActivity) this.scheduleLocalOnlyCompletion(turn);
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
      turn.terminalizing = true;
      if (turn.userLookups.size === 0) this.completeAgentEnd(turn, event);
      else void this.finishFromAgentEnd(turn, event);
      return;
    }
    this.projector.project(event, turn.turnId);
  }

  private projectUserEcho(turn: ActiveTurn, message: OmpMessage): void {
    const entryId = nativeEntryId(message);
    if (entryId && this.emittedEntryIds.has(entryId)) return;
    const pending = turn.pendingUsers.shift();
    if (!pending) return;
    if (entryId) {
      this.publishCorrelatedUser(pending, entryId);
      return;
    }
    turn.unresolvedUsers.add(pending);
    const publish = (resolvedId?: string) => {
      if (!turn.unresolvedUsers.delete(pending)) return;
      this.publishCorrelatedUser(pending, resolvedId);
    };
    const lookup = this.runtime
      .getBranchMessages()
      .then((messages) => {
        let resolvedId: string | undefined;
        for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
          if (messages[candidate]?.text === pending.text) {
            resolvedId = messages[candidate]?.entryId;
            break;
          }
        }
        publish(resolvedId);
      })
      .catch(() => publish());
    turn.userLookups.add(lookup);
    void lookup.finally(() => turn.userLookups.delete(lookup));
  }

  private publishCorrelatedUser(pending: PendingUser, entryId?: string): void {
    if (entryId) {
      if (this.emittedEntryIds.has(entryId)) return;
      this.emittedEntryIds.add(entryId);
    }
    this.projector.publishUser(pending.text, pending.clientMessageId, entryId);
  }

  private scheduleLocalOnlyCompletion(turn: ActiveTurn): void {
    this.cancelLocalOnlyCompletion(turn);
    turn.localOnlyTimer = this.scheduler.set(() => {
      turn.localOnlyTimer = undefined;
      void this.completeLocalOnlyTurn(turn);
    }, LOCAL_ONLY_SETTLE_MS);
  }

  private cancelLocalOnlyCompletion(turn: ActiveTurn): void {
    if (turn.localOnlyTimer === undefined) return;
    this.scheduler.clear(turn.localOnlyTimer);
    turn.localOnlyTimer = undefined;
  }

  private async completeLocalOnlyTurn(turn: ActiveTurn): Promise<void> {
    await Promise.allSettled(turn.userLookups);
    if (turn.terminal || turn.nativeActivity || this.activeTurn !== turn) return;
    this.publishPendingUsers(turn);
    this.finishTurn(turn, "completed");
  }

  private async finishFromAgentEnd(
    turn: ActiveTurn,
    event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  ): Promise<void> {
    await Promise.allSettled(turn.userLookups);
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
    for (const pending of [...turn.pendingUsers.splice(0), ...turn.unresolvedUsers]) {
      turn.unresolvedUsers.delete(pending);
      this.projector.publishUser(pending.text, pending.clientMessageId);
    }
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
