import { randomUUID } from "node:crypto";
import type { ProviderError } from "@getpaseo/plugin/server/provider";
import type { OmpMessage, OmpRpcEvent } from "./omp-rpc-protocol";

export type PendingUser = {
  clientMessageId: string;
  text: string;
  accepted: boolean;
  fallbackOnFinish: boolean;
  bufferedEchoes: OmpMessage[];
};
type TerminalCorrelationEvidence = "fresh-native-user" | "current-assistant";

type TerminalCorrelation = {
  policy: "initial-turn" | "ordered-legacy" | "native-command";
  evidence: Map<TerminalCorrelationEvidence, number>;
};

export type TerminalCandidate = {
  event: Extract<OmpRpcEvent, { type: "agent_end" }>;
  arrivalSequence: number;
  confidence:
    | "keyed"
    | "initial-turn"
    | "ordered-legacy"
    | "native-command"
    | "interrupted"
    | "ambiguous";
};

export type ActiveTurn = {
  turnId: string;
  clientMessageId: string;
  generation: number;
  promptResultEmitted: boolean;
  started: boolean;
  terminal: boolean;
  interrupted: boolean;
  starting: boolean;
  nativeActivity: boolean;
  userEchoObserved: boolean;
  localOnlyDisabled: boolean;
  localOnlyEligible: boolean;
  awaitingPermissionEvidence: boolean;
  activitySequence: number;
  acknowledged: boolean;
  terminalCorrelation: TerminalCorrelation;
  replayingBufferedEvents: boolean;
  agentInvoked?: boolean;
  nativeRequestId?: string;
  promptAcceptedEventIndex?: number;
  localOnlyTimer?: unknown;
  usagePollTimer?: unknown;
  usagePoll?: Promise<void>;
  usageSampleFloor: number;
  manualCompaction: boolean;
  manualCompactionPending: boolean;
  manualCompactionDeadlineTimer?: unknown;
  agentEndPending: boolean;
  agentEndRetryTimer?: unknown;
  agentEndDeadlineTimer?: unknown;
  agentEndCheck?: Promise<void>;
  ambiguousTerminalTimer?: unknown;
  terminalizing: boolean;
  terminalization?: Promise<void>;
  terminalOutcome?: TurnOutcome;
  operationalTerminalStage?: "failed" | "unresolved";
  terminalWake?: VoidDeferred;
  steerReady: VoidDeferred;
  steersInFlight: number;
  deferredAgentEnd?: TerminalCandidate;
  activeToolCallIds: Set<string>;
  bufferedEvents: OmpRpcEvent[];
  pendingUsers: PendingUser[];
  userEchoes: OmpMessage[];
  userCorrelationActive: boolean;
  userLookups: Set<Promise<void>>;
  completedMessageCount: number;
  streamedMessageEntryIds: string[];
  streamedMessageIdentityComplete: boolean;
  lastCompletedAssistantOutcome?: AgentEndOutcome;
  lastCompletedAssistantEntryId?: string;
};

export type VoidDeferred = {
  promise: Promise<void>;
  resolve(value?: void | PromiseLike<void>): void;
  reject(reason?: unknown): void;
};

export type TurnOutcome = {
  state: "completed" | "failed" | "canceled";
  error?: ProviderError;
  usageSampled: boolean;
};

export function nativeEntryId(message: OmpMessage): string | undefined {
  return message.entryId;
}

export type AgentEndOutcome = "completed" | "failed" | "canceled";
type AssistantTerminalStatus = AgentEndOutcome | "unavailable";

export function assistantTerminalOutcome(
  message: Extract<OmpMessage, { role: "assistant" }>,
): AgentEndOutcome {
  const stopReason = message.stopReason?.toLowerCase();
  if (stopReason === "aborted" || stopReason === "canceled" || stopReason === "cancelled") {
    return "canceled";
  }
  return stopReason === "error" || message.errorMessage ? "failed" : "completed";
}

function lastAssistantStatus(
  messages: readonly OmpMessage[],
  startIndex = 0,
): AssistantTerminalStatus {
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return assistantTerminalOutcome(message);
  }
  return "unavailable";
}

export function terminalOutcome(
  event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  turn: Pick<ActiveTurn, "completedMessageCount" | "lastCompletedAssistantOutcome">,
): AgentEndOutcome | undefined {
  const messages = event.messages;
  if (
    messages !== undefined &&
    (event.messageCount === undefined || messages.length >= event.messageCount)
  ) {
    const status = lastAssistantStatus(messages);
    return status === "unavailable" ? "completed" : status;
  }
  if (event.messageCount === 0) return "completed";
  if (
    turn.lastCompletedAssistantOutcome !== undefined &&
    (event.messageCount === undefined || turn.completedMessageCount >= event.messageCount)
  ) {
    return turn.lastCompletedAssistantOutcome;
  }
  return undefined;
}

export function historyTerminalOutcome(
  messages: readonly OmpMessage[],
  declaredCount: number,
  turn: Pick<
    ActiveTurn,
    | "streamedMessageEntryIds"
    | "streamedMessageIdentityComplete"
    | "lastCompletedAssistantOutcome"
    | "lastCompletedAssistantEntryId"
  >,
  retainedMessages: readonly OmpMessage[],
): AgentEndOutcome | undefined {
  if (
    messages.length < declaredCount ||
    !turn.streamedMessageIdentityComplete ||
    turn.streamedMessageEntryIds.length === 0
  ) {
    return undefined;
  }
  const startIndex = messages.length - declaredCount;
  let historyIndex = startIndex;
  for (const entryId of turn.streamedMessageEntryIds) {
    while (historyIndex < messages.length) {
      const historyMessage = messages[historyIndex];
      if (historyMessage && nativeEntryId(historyMessage) === entryId) break;
      historyIndex += 1;
    }
    if (historyIndex >= messages.length) return undefined;
    const correlated = messages[historyIndex];
    if (
      entryId === turn.lastCompletedAssistantEntryId &&
      (correlated?.role !== "assistant" ||
        assistantTerminalOutcome(correlated) !== turn.lastCompletedAssistantOutcome)
    )
      return undefined;
    historyIndex += 1;
  }
  historyIndex = startIndex;
  for (const retained of retainedMessages) {
    const entryId = nativeEntryId(retained);
    if (!entryId) return undefined;
    while (historyIndex < messages.length) {
      const historyMessage = messages[historyIndex];
      if (historyMessage && nativeEntryId(historyMessage) === entryId) break;
      historyIndex += 1;
    }
    if (historyIndex >= messages.length) return undefined;
    const correlated = messages[historyIndex];
    if (!correlated || correlated.role !== retained.role) return undefined;
    if (
      retained.role === "assistant" &&
      correlated.role === "assistant" &&
      assistantTerminalOutcome(retained) !== assistantTerminalOutcome(correlated)
    )
      return undefined;
    historyIndex += 1;
  }
  const status = lastAssistantStatus(messages, startIndex);
  return status === "unavailable" ? undefined : status;
}

export function unknownTerminalOutcomeError(
  event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  turn: Pick<ActiveTurn, "completedMessageCount" | "lastCompletedAssistantOutcome">,
): string {
  const retainedMessages = event.messages?.length ?? 0;
  const retainedStatus = event.messages ? lastAssistantStatus(event.messages) : "unavailable";
  const lastStatus =
    retainedStatus === "unavailable"
      ? (turn.lastCompletedAssistantOutcome ?? "unavailable")
      : retainedStatus;
  return (
    "OMP agent_end omitted terminal messages; outcome is unknown " +
    `(declaredCount=${event.messageCount ?? "unavailable"}, ` +
    `observedCount=${turn.completedMessageCount}, ` +
    `retainedTerminalMessages=${retainedMessages}, lastAssistantStatus=${lastStatus})`
  );
}

export function createActiveTurn(
  clientMessageId: string,
  text: string,
  generation: number,
  terminalPolicy: TerminalCorrelation["policy"],
  manualCompaction = false,
): ActiveTurn {
  return {
    turnId: randomUUID(),
    clientMessageId,
    agentInvoked: undefined,
    generation,
    promptResultEmitted: false,
    started: false,
    terminal: false,
    awaitingPermissionEvidence: false,
    interrupted: false,
    starting: true,
    nativeActivity: false,
    userEchoObserved: false,
    localOnlyDisabled: false,
    localOnlyEligible: false,
    usageSampleFloor: 0,
    agentEndPending: false,
    terminalizing: false,
    manualCompactionPending: manualCompaction,
    manualCompaction,
    activitySequence: 0,
    acknowledged: false,
    terminalCorrelation: { policy: terminalPolicy, evidence: new Map() },
    replayingBufferedEvents: false,
    steersInFlight: 0,
    activeToolCallIds: new Set(),
    steerReady: Promise.withResolvers<void>(),
    userCorrelationActive: false,
    userLookups: new Set(),
    userEchoes: [],
    completedMessageCount: 0,
    bufferedEvents: [],
    streamedMessageEntryIds: [],
    streamedMessageIdentityComplete: true,
    pendingUsers: [
      {
        clientMessageId,
        text,
        accepted: true,
        fallbackOnFinish: true,
        bufferedEchoes: [],
      },
    ],
  };
}
export function classifyTerminalCandidate(
  turn: ActiveTurn,
  event: Extract<OmpRpcEvent, { type: "agent_end" }>,
  arrivalSequence = turn.activitySequence,
): TerminalCandidate {
  if (event.requestId !== undefined) return { event, confidence: "keyed", arrivalSequence };
  if (turn.agentInvoked === false) return { event, confidence: "ambiguous", arrivalSequence };
  if (turn.terminalCorrelation.policy === "initial-turn") {
    return { event, confidence: "initial-turn", arrivalSequence };
  }
  const assistantSequence = turn.terminalCorrelation.evidence.get("current-assistant");
  if (
    turn.terminalCorrelation.policy === "native-command" &&
    assistantSequence !== undefined &&
    assistantSequence <= arrivalSequence
  ) {
    return { event, confidence: "native-command", arrivalSequence };
  }
  const userSequence = turn.terminalCorrelation.evidence.get("fresh-native-user");
  if (
    userSequence !== undefined &&
    assistantSequence !== undefined &&
    userSequence < assistantSequence &&
    assistantSequence <= arrivalSequence
  ) {
    return { event, confidence: "ordered-legacy", arrivalSequence };
  }
  return { event, confidence: "ambiguous", arrivalSequence };
}
