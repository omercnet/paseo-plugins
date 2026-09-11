import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  ProviderCapability,
  ProviderConnection,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { GAS_CITY_LIMITS } from "../shared/limits";
import {
  FetchGasCityTransport,
  GAS_CITY_DEFAULT_ENDPOINT_URL,
  type GasCityInboundAck,
  type GasCitySseFrame,
  type GasCitySubscription,
  type GasCityTransport,
  GasCityTransportError,
  validateGasCityEndpointUrl,
} from "./provider-transport";

export const GAS_CITY_SESSION_PROVIDER_ID = "gas-city-session";
export const GAS_CITY_SESSION_PROVIDER_CAPABILITIES = [
  "prompt.message",
  "session.persistence",
] as const satisfies readonly ProviderCapability[];

const PERSISTENCE_VERSION = 1;
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAYS_MS = [100, 250, 500, 1_000] as const;
const JsonObjectSchema = z.record(z.string(), z.unknown());

type GasCitySelection = {
  cityName: string;
  sessionName: string;
  endpointUrl: string;
};

type GasCityConversationState = {
  version: typeof PERSISTENCE_VERSION;
  selection: GasCitySelection;
  connection: {
    clientId: string;
    conversationId: string | null;
  };
  cursor: string | null;
};

type PendingTurn = {
  clientMessageId: string;
  turnId: string;
  externalTurnId: string | null;
  controller: AbortController;
  started: boolean;
  terminal: boolean;
  promptResultSent: boolean;
};
export type GasCityTimer = Parameters<typeof globalThis.clearTimeout>[0];
export type GasCitySchedule = (callback: () => void, delayMs: number) => GasCityTimer;
export type GasCityCancelSchedule = (timer: GasCityTimer) => void;

export type GasCityProviderDependencies = {
  transport?: GasCityTransport;
  setTimeout?: GasCitySchedule;
  clearTimeout?: GasCityCancelSchedule;
};

export function createGasCitySessionProvider(
  dependencies: GasCityProviderDependencies = {},
): ProviderRegistration {
  const transport = dependencies.transport ?? new FetchGasCityTransport();
  const schedule =
    dependencies.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancelSchedule = dependencies.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));

  return {
    id: GAS_CITY_SESSION_PROVIDER_ID,
    label: "Gas City session",
    description: "Connect an existing Gas City session through external messaging.",
    async connect(request) {
      return new GasCityProviderConnection({
        transport,
        capabilities: negotiateCapabilities(request),
        schedule,
        cancelSchedule,
      });
    },
  };
}
export function registerGasCitySessionProvider(
  server: Pick<PluginServerContext, "registerProvider">,
  dependencies: GasCityProviderDependencies = {},
): void {
  server.registerProvider(createGasCitySessionProvider(dependencies));
}

export const gasCitySessionProvider = createGasCitySessionProvider();

class GasCityProviderConnection implements ProviderConnection {
  readonly version = 1;
  readonly capabilities: readonly string[];
  private readonly transport: GasCityTransport;
  private readonly schedule: GasCitySchedule;
  private readonly cancelSchedule: GasCityCancelSchedule;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, GasCityProviderSession>();
  private closed = false;

  constructor(input: {
    transport: GasCityTransport;
    capabilities: readonly ProviderCapability[];
    schedule: GasCitySchedule;
    cancelSchedule: GasCityCancelSchedule;
  }) {
    this.transport = input.transport;
    this.capabilities = input.capabilities;
    this.schedule = input.schedule;
    this.cancelSchedule = input.cancelSchedule;
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(input: ProviderInput): Promise<void> {
    if (this.closed) {
      throw new Error("Gas City provider connection is closed");
    }

    switch (input.type) {
      case "catalog":
        this.emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: { models: [], modes: [] },
        });
        return;
      case "session.open":
        await this.openSession(input);
        return;
      case "session.prompt":
        await this.requireSession(input.sessionId).prompt(input.prompt);
        return;
      case "session.interrupt":
        this.requireSession(input.sessionId).interrupt();
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      case "session.close":
        await this.closeSession(input.sessionId);
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      default:
        this.rejectUnsupportedRequest(input);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.listeners.clear();
  }

  private async openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    if (this.sessions.has(input.sessionId)) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { code: "duplicate_session", message: "Gas City session is already open" },
      });
      return;
    }

    let session: GasCityProviderSession;
    try {
      session = await GasCityProviderSession.open({
        sessionId: input.sessionId,
        config: input.config,
        persistence: input.persistence,
        history: input.history,
        capabilities: this.capabilities,
        transport: this.transport,
        schedule: this.schedule,
        cancelSchedule: this.cancelSchedule,
        emit: (event) => this.emit(event),
      });
    } catch (error) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: providerError(error),
      });
      return;
    }

    this.sessions.set(input.sessionId, session);
    this.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: input.sessionId,
      capabilities: this.capabilities,
      restoration: "core",
      persistence: session.persistence(),
      title: input.config.title,
      cwd: input.config.cwd,
    });
    this.emit({ type: "session.ready", sessionId: input.sessionId });
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    await session.close();
    this.emit({ type: "session.closed", sessionId });
  }

  private requireSession(sessionId: string): GasCityProviderSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Gas City provider session '${sessionId}' is not open`);
    }
    return session;
  }

  private rejectUnsupportedRequest(
    input: Exclude<
      ProviderInput,
      {
        type: "catalog" | "session.open" | "session.prompt" | "session.interrupt" | "session.close";
      }
    >,
  ): never {
    if ("requestId" in input) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { code: "unsupported", message: `Gas City provider does not support ${input.type}` },
      });
    } else if (input.type === "session.permission") {
      this.emit({
        type: "session.runtime_failed",
        sessionId: input.sessionId,
        error: { code: "unsupported", message: "Gas City provider does not support permissions" },
      });
    }
    throw new Error(`Gas City provider does not support ${input.type}`);
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class GasCityProviderSession {
  private readonly sessionId: string;
  private readonly capabilities: readonly string[];
  private readonly transport: GasCityTransport;
  private readonly schedule: GasCitySchedule;
  private readonly cancelSchedule: GasCityCancelSchedule;
  private readonly emit: (event: ProviderEvent) => void;
  private readonly state: GasCityConversationState;
  private readonly turns = new Map<string, PendingTurn>();
  private subscription: GasCitySubscription | null = null;
  private reconnectTimer: GasCityTimer | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private failed = false;

  private constructor(input: {
    sessionId: string;
    capabilities: readonly string[];
    transport: GasCityTransport;
    schedule: GasCitySchedule;
    cancelSchedule: GasCityCancelSchedule;
    emit: (event: ProviderEvent) => void;
    state: GasCityConversationState;
  }) {
    this.sessionId = input.sessionId;
    this.capabilities = input.capabilities;
    this.transport = input.transport;
    this.schedule = input.schedule;
    this.cancelSchedule = input.cancelSchedule;
    this.emit = input.emit;
    this.state = input.state;
  }

  static async open(input: {
    sessionId: string;
    config: Extract<ProviderInput, { type: "session.open" }>["config"];
    persistence: ProviderPersistence | undefined;
    history: "replay" | "skip";
    capabilities: readonly string[];
    transport: GasCityTransport;
    schedule: GasCitySchedule;
    cancelSchedule: GasCityCancelSchedule;
    emit: (event: ProviderEvent) => void;
  }): Promise<GasCityProviderSession> {
    const persisted = input.persistence === undefined ? null : parsePersistence(input.persistence);
    const selection = persisted?.selection ?? parseSelection(input.config.providerOptions);
    const registration = persisted?.connection ?? (await input.transport.register(selection));
    const state: GasCityConversationState = {
      version: PERSISTENCE_VERSION,
      selection,
      connection: registration,
      cursor: persisted?.cursor ?? null,
    };
    const session = new GasCityProviderSession({ ...input, state });
    await session.subscribe();
    return session;
  }

  persistence(): ProviderPersistence {
    return { version: PERSISTENCE_VERSION, data: structuredClone(this.state) };
  }

  async prompt(
    prompt: Extract<ProviderInput, { type: "session.prompt" }>["prompt"],
  ): Promise<void> {
    if (this.closed || this.failed) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "failed",
          error: { code: "unavailable", message: "Gas City session is unavailable" },
        },
      });
      return;
    }
    if (this.turns.has(prompt.clientMessageId)) {
      return;
    }

    let text: string;
    try {
      text = promptText(prompt);
    } catch (error) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: providerError(error) },
      });
      return;
    }

    const turn: PendingTurn = {
      clientMessageId: prompt.clientMessageId,
      turnId: `gas-city:${prompt.clientMessageId}`,
      externalTurnId: null,
      controller: new AbortController(),
      started: false,
      terminal: false,
      promptResultSent: false,
    };
    this.turns.set(turn.clientMessageId, turn);
    this.startTurn(turn);

    try {
      const acknowledgement = await this.transport.sendInbound({
        endpointUrl: this.state.selection.endpointUrl,
        clientId: this.state.connection.clientId,
        text,
        clientMessageId: turn.clientMessageId,
        signal: turn.controller.signal,
      });
      this.acceptInboundAcknowledgement(turn, acknowledgement);
      this.emitPromptResult(turn, {
        type: prompt.delivery === "steer" ? "steer" : "turn",
        turnId: turn.turnId,
      });
    } catch (error) {
      const providerFailure = providerError(error);
      this.emitPromptResult(turn, { type: "failed", error: providerFailure });
      this.finishTurn(turn, "failed", providerFailure);
    }
  }

  interrupt(): void {
    for (const turn of this.turns.values()) {
      if (turn.terminal) {
        continue;
      }
      turn.controller.abort();
      this.finishTurn(turn, "canceled", { code: "canceled", message: "Canceled by Paseo" });
    }
  }
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.reconnectTimer) {
      this.cancelSchedule(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.subscription?.close();
    this.subscription = null;
    for (const turn of this.turns.values()) {
      if (!turn.terminal) {
        turn.controller.abort();
        this.finishTurn(turn, "canceled", { code: "closed", message: "Paseo connection closed" });
      }
    }
    this.turns.clear();
  }

  private async subscribe(): Promise<void> {
    if (this.closed || this.failed || this.subscription) {
      return;
    }
    try {
      this.subscription = await this.transport.subscribe({
        endpointUrl: this.state.selection.endpointUrl,
        clientId: this.state.connection.clientId,
        lastEventId: this.state.cursor,
        callbacks: {
          onFrame: (frame) => this.acceptFrame(frame),
          onDisconnect: (error) => this.handleDisconnect(error),
        },
      });
    } catch (error) {
      this.handleDisconnect(error);
      if (this.failed) {
        throw error;
      }
    }
  }

  private acceptFrame(frame: GasCitySseFrame): void {
    if (this.closed || this.failed) {
      return;
    }
    this.reconnectAttempt = 0;
    try {
      if (frame.id !== null) {
        this.state.cursor = cursor(frame.id);
        this.emitPersistence();
      }
      if (frame.event === "heartbeat") {
        if (frame.data.length > 0) {
          parseHeartbeat(frame.data);
        }
        return;
      }
      if (frame.event === "message") {
        this.acceptMessage(parseMessage(frame.data));
        return;
      }
      this.acceptStreamError(parseError(frame.data));
    } catch (error) {
      this.failClosed(providerError(error));
    }
  }

  private acceptMessage(message: GasCityMessage): void {
    const turn = this.resolveTurn(message.clientMessageId, message.turnId);
    if (turn && message.turnId) {
      turn.externalTurnId = message.turnId;
    }
    if (message.text !== null) {
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          id:
            message.messageId ??
            `${message.turnId ?? "message"}:${this.state.cursor ?? crypto.randomUUID()}`,
          type: "assistant_message",
          text: message.text,
          messageId: message.messageId ?? undefined,
        },
      });
    }
    if (turn && message.state) {
      this.finishTurn(turn, message.state, message.error);
    }
  }

  private acceptStreamError(error: {
    code: string;
    message: string;
    clientMessageId: string | null;
    turnId: string | null;
  }): void {
    const failure = { code: error.code, message: error.message };
    const turn = this.resolveTurn(error.clientMessageId, error.turnId);
    if (turn) {
      this.finishTurn(turn, "failed", failure);
    }
    if (error.code === "authorization_revoked") {
      this.failClosed(failure);
    } else {
      this.emit({
        type: "timeline.item",
        sessionId: this.sessionId,
        item: {
          id: `gas-city-error:${this.state.cursor ?? crypto.randomUUID()}`,
          type: "error",
          message: error.message,
        },
      });
    }
  }

  private handleDisconnect(error: unknown): void {
    if (this.closed || this.failed) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.subscription = null;
    const failure = providerError(error);
    if (
      failure.code === "authorization_revoked" ||
      failure.code === "malformed_stream" ||
      failure.code === "invalid_stream"
    ) {
      this.failClosed(failure);
      return;
    }
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.failClosed({
        code: "reconnect_exhausted",
        message: "Gas City event stream could not be restored",
      });
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt] ?? RECONNECT_DELAYS_MS.at(-1) ?? 1_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      void this.subscribe();
    }, delay);
  }

  private failClosed(error: { code?: string; message: string; diagnostic?: string }): void {
    if (this.failed || this.closed) {
      return;
    }
    this.failed = true;
    if (this.reconnectTimer) {
      this.cancelSchedule(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.subscription?.close();
    this.subscription = null;
    for (const turn of this.turns.values()) {
      this.emitPromptResult(turn, { type: "failed", error });
      this.finishTurn(turn, "failed", error);
    }
    this.emit({ type: "session.runtime_failed", sessionId: this.sessionId, error });
  }

  private acceptInboundAcknowledgement(
    turn: PendingTurn,
    acknowledgement: GasCityInboundAck,
  ): void {
    if (acknowledgement.turnId) {
      turn.externalTurnId = acknowledgement.turnId;
    }
  }

  private startTurn(turn: PendingTurn): void {
    if (turn.started) {
      return;
    }
    turn.started = true;
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId: turn.turnId,
      state: "started",
    });
  }

  private finishTurn(
    turn: PendingTurn,
    state: "completed" | "failed" | "canceled",
    error?: { code?: string; message: string; diagnostic?: string } | null,
  ): void {
    if (turn.terminal) {
      return;
    }
    turn.terminal = true;
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId: turn.turnId,
      state,
      ...(state === "completed" || !error ? {} : { error }),
    });
    this.turns.delete(turn.clientMessageId);
  }

  private emitPromptResult(
    turn: PendingTurn,
    result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  ): void {
    if (turn.promptResultSent) {
      return;
    }
    turn.promptResultSent = true;
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId: turn.clientMessageId,
      result,
    });
  }

  private emitPersistence(): void {
    this.emit({
      type: "session.persistence",
      sessionId: this.sessionId,
      persistence: this.persistence(),
    });
  }

  private resolveTurn(clientMessageId: string | null, turnId: string | null): PendingTurn | null {
    if (clientMessageId) {
      return this.turns.get(clientMessageId) ?? null;
    }
    if (turnId) {
      for (const turn of this.turns.values()) {
        if (turn.turnId === turnId || turn.externalTurnId === turnId) {
          return turn;
        }
      }
    }
    return this.turns.size === 1 ? (this.turns.values().next().value ?? null) : null;
  }
}

type GasCityMessage = {
  clientMessageId: string | null;
  turnId: string | null;
  messageId: string | null;
  text: string | null;
  state: "completed" | "failed" | "canceled" | null;
  error: { code?: string; message: string } | null;
};

function negotiateCapabilities(request: ProviderConnectRequest): readonly ProviderCapability[] {
  if (!request.versions.includes(1)) {
    throw new Error("Gas City provider requires protocol version 1");
  }
  return GAS_CITY_SESSION_PROVIDER_CAPABILITIES.filter((capability) =>
    request.capabilities.includes(capability),
  );
}

function parseSelection(value: unknown): GasCitySelection {
  const options = object(
    value,
    "Gas City provider requires providerOptions with cityName and sessionName",
  );
  const cityName = name(options.cityName, "cityName");
  const sessionName = name(options.sessionName, "sessionName");
  const endpointUrl = validateGasCityEndpointUrl(
    options.endpointUrl === undefined
      ? GAS_CITY_DEFAULT_ENDPOINT_URL
      : endpoint(options.endpointUrl),
  );
  return { cityName, sessionName, endpointUrl };
}

function parsePersistence(persistence: ProviderPersistence): GasCityConversationState {
  if (persistence.version !== PERSISTENCE_VERSION) {
    throw new Error("Gas City provider persistence is invalid");
  }
  const data = object(persistence.data, "Gas City provider persistence is invalid");
  const selection = object(data.selection, "Gas City provider persistence is invalid");
  const connection = object(data.connection, "Gas City provider persistence is invalid");
  if (data.version !== PERSISTENCE_VERSION) {
    throw new Error("Gas City provider persistence is invalid");
  }
  return {
    version: PERSISTENCE_VERSION,
    selection: parseSelection(selection),
    connection: {
      clientId: identifier(connection.clientId, "clientId"),
      conversationId: optionalIdentifier(connection.conversationId, "conversationId"),
    },
    cursor: data.cursor === null || data.cursor === undefined ? null : cursor(data.cursor),
  };
}

function parseMessage(data: string): GasCityMessage {
  const payload = jsonObject(data, "message");
  requireExactKeys(payload, [
    "type",
    "clientMessageId",
    "turnId",
    "messageId",
    "text",
    "state",
    "error",
  ]);
  if (payload.type !== "message") {
    throw new Error("Gas City message frame has an invalid type");
  }
  const text = payload.text === undefined ? null : boundedText(payload.text);
  const state = optionalTerminalState(payload.state);
  const error = payload.error === undefined ? null : parseErrorObject(payload.error);
  if (state === "failed" && !error) {
    throw new Error("Gas City failed message frame is missing an error");
  }
  if (text === null && state === null) {
    throw new Error("Gas City message frame has no output or terminal state");
  }
  return {
    clientMessageId: optionalIdentifier(payload.clientMessageId, "clientMessageId"),
    turnId: optionalIdentifier(payload.turnId, "turnId"),
    messageId: optionalIdentifier(payload.messageId, "messageId"),
    text,
    state,
    error,
  };
}

function parseError(data: string): {
  code: string;
  message: string;
  clientMessageId: string | null;
  turnId: string | null;
} {
  const payload = jsonObject(data, "error");
  requireExactKeys(payload, ["type", "code", "message", "clientMessageId", "turnId"]);
  if (payload.type !== "error") {
    throw new Error("Gas City error frame has an invalid type");
  }
  return {
    code: errorCode(payload.code),
    message: errorMessage(payload.message),
    clientMessageId: optionalIdentifier(payload.clientMessageId, "clientMessageId"),
    turnId: optionalIdentifier(payload.turnId, "turnId"),
  };
}

function parseHeartbeat(data: string): void {
  const payload = jsonObject(data, "heartbeat");
  requireExactKeys(payload, ["type"]);
  if (payload.type !== "heartbeat") {
    throw new Error("Gas City heartbeat frame has an invalid type");
  }
}

function promptText(prompt: Extract<ProviderInput, { type: "session.prompt" }>["prompt"]): string {
  if (prompt.input.type !== "message") {
    throw new Error("Gas City provider supports message prompts only");
  }
  if (prompt.outputSchema !== undefined) {
    throw new Error("Gas City provider does not support structured output");
  }
  if (prompt.input.content.length !== 1 || prompt.input.content[0]?.type !== "text") {
    throw new Error("Gas City provider accepts exactly one text prompt");
  }
  return boundedText(prompt.input.content[0].text, GAS_CITY_LIMITS.prompt);
}

function jsonObject(data: string, label: string): Record<string, unknown> {
  if (data.length === 0 || data.length > GAS_CITY_LIMITS.message) {
    throw new Error(`Gas City ${label} frame exceeds its size limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`Gas City ${label} frame is not valid JSON`);
  }
  return object(parsed, `Gas City ${label} frame is not a JSON object`);
}

function object(value: unknown, errorMessage: string): Record<string, unknown> {
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(errorMessage);
  }
  return parsed.data;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error("Gas City stream frame contains unsupported data");
    }
  }
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > GAS_CITY_LIMITS.name) {
    throw new Error(`Gas City ${label} is invalid`);
  }
  return value;
}

function endpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Gas City endpointUrl is invalid");
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > GAS_CITY_LIMITS.identifier
  ) {
    throw new Error(`Gas City ${label} is invalid`);
  }
  return value;
}

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return identifier(value, label);
}

function cursor(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > GAS_CITY_LIMITS.cursor) {
    throw new Error("Gas City cursor is invalid");
  }
  return value;
}

function boundedText(value: unknown, maximum: number = GAS_CITY_LIMITS.message): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("Gas City text is invalid");
  }
  return value;
}

function optionalTerminalState(value: unknown): "completed" | "failed" | "canceled" | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === "completed" || value === "failed" || value === "canceled") {
    return value;
  }
  throw new Error("Gas City terminal state is invalid");
}

function parseErrorObject(value: unknown): { code?: string; message: string } {
  const error = object(value, "Gas City error is invalid");
  requireExactKeys(error, ["code", "message"]);
  return { code: errorCode(error.code), message: errorMessage(error.message) };
}

function errorCode(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > GAS_CITY_LIMITS.status) {
    throw new Error("Gas City error code is invalid");
  }
  return value;
}

function errorMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > GAS_CITY_LIMITS.errorMessage
  ) {
    throw new Error("Gas City error message is invalid");
  }
  return value;
}

function providerError(error: unknown): { code?: string; message: string; diagnostic?: string } {
  if (error instanceof GasCityTransportError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return {
      code: "gas_city_error",
      message: error.message.slice(0, GAS_CITY_LIMITS.errorMessage),
    };
  }
  return { code: "gas_city_error", message: "Gas City external messaging failed" };
}
