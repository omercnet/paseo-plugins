import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { ompDataDir } from "../paths";
import type { OmpSpawnRequest, OmpStartOptions } from "./omp-rpc-environment";
import { waitMs } from "./omp-rpc-process";
import {
  inspectJsonBounds,
  MAX_IMAGE_DATA_LENGTH,
  MAX_REPLAY_MESSAGES,
  NAME,
  OMP_MESSAGE_PAGE_LIMIT,
  type OmpAvailableCommand,
  OmpAvailableCommandsResultSchema,
  OmpBranchMessagesResultSchema,
  type OmpBranchResult,
  OmpBranchResultSchema,
  type OmpCompactionResult,
  OmpCompactionResultSchema,
  type OmpExtensionUiResponse,
  type OmpHostToolDefinition,
  OmpHostToolDefinitionSchema,
  type OmpHostToolResult,
  type OmpHostToolUpdate,
  type OmpImage,
  type OmpMessage,
  OmpMessageSchema,
  OmpMessagesPageResultSchema,
  OmpMessagesResultSchema,
  type OmpModel,
  OmpModelSchema,
  OmpModelsResultSchema,
  type OmpPersistedSessionMessages,
  type OmpPersistedSubagentMessages,
  OmpPromptAckSchema,
  type OmpProtocolViolationDiagnostic,
  type OmpRpcEvent,
  type OmpSessionState,
  OmpSessionStateSchema,
  type OmpSessionStats,
  OmpSessionStatsSchema,
  type OmpSubagentMessagesResult,
  OmpSubagentMessagesResultSchema,
  type OmpSubagentSnapshot,
  OmpSubagentsResultSchema,
  type OmpToolApprovalResponse,
  OmpToolApprovalResponseSchema,
  ProtocolNegotiationResultSchema,
  sanitizeMessageListMetadata,
} from "./omp-rpc-protocol";
import {
  OmpRpcProcess,
  OmpRpcRequestRejectedError,
  OmpRpcResponseLimitError,
  validateReadyMetadata,
  waitWithTimeout,
} from "./omp-rpc-transport";
import {
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_TEXT_LENGTH,
  OmpThinkingLevelSchema,
  validateBoundedText,
} from "./omp-rpc-values";
import { OmpCleanupFailure, OmpPublicError } from "./security";
import {
  listOmpSessionDescriptors,
  type OmpSessionDescriptor,
  type OmpSessionListOptions,
  readOmpPersistedSessionTranscript,
  readOmpPersistedSubagentTranscript,
} from "./session-descriptors";

const READY_TIMEOUT_MS = 20_000;
const MAX_HOST_TOOLS = 256;
// OMP read metadata can contain one source entry per displayed line. Bound this optional,
// opaque field separately so over-budget metadata can be omitted without losing completion events.
// Tool-intensive OMP turns legitimately exceed 64 blocks; transport byte/node budgets remain the
// primary resource bounds.
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_NODES = 400_000;
const MAX_MESSAGE_PAGES = 512;
const MAX_MESSAGE_PAGE_BUSY_RETRIES = 4;
const MAX_MESSAGE_PAGE_STALE_RESTARTS = 2;
const MESSAGE_PAGE_RETRY_BASE_MS = 50;

export interface OmpRuntimeSession {
  readonly maxHostToolFrameBytes?: number;
  /** Maximum bytes accepted for one unchunked stdin JSONL frame, including its newline. */
  readonly maxInputFrameBytes?: number;
  readonly supportsTypedToolApprovals: boolean;
  onEvent(listener: (event: OmpRpcEvent) => void): () => void;
  getState(): Promise<OmpSessionState>;
  getSessionStats(): Promise<OmpSessionStats>;
  getAvailableModels(): Promise<OmpModel[]>;
  getAvailableCommands(): Promise<OmpAvailableCommand[]>;
  setSubagentSubscription(level: "events"): Promise<void>;
  readonly inheritedRedactionValues?: readonly string[];
  getSubagents(): Promise<OmpSubagentSnapshot[]>;
  getSubagentMessages(selector: {
    subagentId?: string;
    sessionFile?: string;
  }): Promise<OmpSubagentMessagesResult>;
  prompt(
    message: string,
    images?: readonly OmpImage[],
    onAccepted?: () => void,
    onRequested?: (requestId: string) => void,
  ): Promise<{ requestId: string; agentInvoked?: boolean }>;
  compact(customInstructions?: string): Promise<OmpCompactionResult>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: string): Promise<void>;
  steer(message: string, images?: readonly OmpImage[]): Promise<void>;
  followUp(message: string, images?: readonly OmpImage[]): Promise<void>;
  handoff(customInstructions?: string): Promise<void>;
  respondToExtensionUi(response: OmpExtensionUiResponse): Promise<void>;
  respondToToolApproval(response: OmpToolApprovalResponse): Promise<void>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  branch(entryId: string): Promise<OmpBranchResult>;
  readonly canReplayHistory: boolean;
  getMessages(signal?: AbortSignal): Promise<OmpMessage[]>;
  abort(): Promise<void>;
  setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpHostToolResult): void;
  sendHostToolUpdate(update: OmpHostToolUpdate): void;
  close(): Promise<void>;
}

export interface OmpRuntime {
  readonly supportsPersistence: boolean;
  startSession(options: OmpStartOptions): Promise<OmpRuntimeSession>;
  listSessions(options: OmpSessionListOptions): Promise<OmpSessionDescriptor[]>;
  readPersistedSessionTranscript?(options: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSessionMessages>;
  readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    sessionFile?: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSubagentMessages>;
}

export interface OmpRpcRuntimeOptions {
  spawnProcess?: (request: OmpSpawnRequest) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: (pid: number) => Promise<boolean | "uncertain">;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  reportProtocolViolation?: (diagnostic: OmpProtocolViolationDiagnostic) => void | Promise<void>;
  listSessions?: (
    options: OmpSessionListOptions,
  ) => OmpSessionDescriptor[] | Promise<OmpSessionDescriptor[]>;
}

class OmpRpcSession implements OmpRuntimeSession {
  get maxHostToolFrameBytes(): number {
    return this.process.outboundFrameLimit;
  }
  get maxInputFrameBytes(): number {
    return this.process.outboundFrameLimit;
  }

  constructor(
    private readonly process: OmpRpcProcess,
    private readonly removeAbortListener: () => void,
    readonly canReplayHistory: boolean,
    readonly inheritedRedactionValues: readonly string[],
    readonly supportsTypedToolApprovals: boolean,
  ) {}
  private messagePagingSupport: "unknown" | "supported" | "unsupported" = "unknown";

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    return this.process.onEvent(listener);
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.process.request({ type: "get_state" }));
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    return OmpSessionStatsSchema.parse(await this.process.request({ type: "get_session_stats" }));
  }

  async getMessages(signal?: AbortSignal): Promise<OmpMessage[]> {
    if (!this.canReplayHistory) {
      throw new Error("OMP history replay requires negotiated RPC protocol v2");
    }
    if (this.messagePagingSupport === "unsupported") {
      const legacy = OmpMessagesResultSchema.parse(
        await this.requestWithSignal({ type: "get_messages" }, signal),
      );
      return legacy.messages;
    }
    let staleRestarts = 0;
    let busyRetries = 0;
    while (true) {
      const messages: OmpMessage[] = [];
      const seenCursors = new Set<string>();
      const seenMessageIdentities = new Set<string>();
      let pageCount = 0;
      let cursor: string | undefined;
      let totalMessages: number | undefined;
      let aggregateBytes = 0;
      let aggregateNodes = 0;
      try {
        while (true) {
          signal?.throwIfAborted();
          let rawPage: unknown;
          try {
            rawPage = await this.requestWithSignal(
              {
                type: "get_messages_page",
                ...(cursor ? { cursor } : {}),
                limit: OMP_MESSAGE_PAGE_LIMIT,
              },
              signal,
            );
          } catch (error) {
            if (
              error instanceof OmpRpcRequestRejectedError &&
              error.code === "unsupported_command"
            ) {
              this.messagePagingSupport = "unsupported";
              const legacy = OmpMessagesResultSchema.parse(
                await this.requestWithSignal({ type: "get_messages" }, signal),
              );
              return legacy.messages;
            }
            if (
              error instanceof OmpRpcRequestRejectedError &&
              error.code === "session_busy" &&
              busyRetries < MAX_MESSAGE_PAGE_BUSY_RETRIES
            ) {
              const delayMs = MESSAGE_PAGE_RETRY_BASE_MS * 2 ** busyRetries;
              busyRetries += 1;
              await this.waitForReplayRetry(delayMs, signal);
              continue;
            }
            throw error;
          }
          pageCount += 1;
          if (pageCount > MAX_MESSAGE_PAGES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "items",
              pageCount,
              MAX_MESSAGE_PAGES,
            );
          }
          const page = OmpMessagesPageResultSchema.parse(rawPage);
          this.messagePagingSupport = "supported";
          if (totalMessages !== undefined && page.totalMessages !== totalMessages) {
            throw new Error("OMP message pagination returned an inconsistent total");
          }
          totalMessages ??= page.totalMessages;
          const nextMessageCount = messages.length + page.messages.length;
          if (nextMessageCount > totalMessages || nextMessageCount > MAX_REPLAY_MESSAGES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "items",
              nextMessageCount,
              Math.min(totalMessages, MAX_REPLAY_MESSAGES),
            );
          }
          const pageIdentities = new Set<string>();
          for (const message of page.messages) {
            const identity = message.entryId ?? message.id ?? message.responseId;
            if (!identity) continue;
            if (seenMessageIdentities.has(identity)) {
              throw new Error("OMP message pagination repeated a message identity");
            }
            pageIdentities.add(identity);
          }
          const inspection = inspectJsonBounds(
            page.messages,
            MAX_REPLAY_BYTES,
            MAX_REPLAY_MESSAGES,
            MAX_IMAGE_DATA_LENGTH,
            MAX_REPLAY_NODES,
          );
          if (inspection.violation) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              inspection.violation.dimension,
              inspection.violation.actual,
              inspection.violation.limit,
            );
          }
          aggregateBytes += inspection.bytes;
          aggregateNodes += inspection.nodes;
          if (aggregateBytes > MAX_REPLAY_BYTES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "bytes",
              aggregateBytes,
              MAX_REPLAY_BYTES,
            );
          }
          if (aggregateNodes > MAX_REPLAY_NODES) {
            throw new OmpRpcResponseLimitError(
              "get_messages_page",
              "nodes",
              aggregateNodes,
              MAX_REPLAY_NODES,
            );
          }
          for (const identity of pageIdentities) seenMessageIdentities.add(identity);
          messages.push(...page.messages);
          const nextCursor = page.nextCursor;
          if (!nextCursor) {
            if (messages.length !== totalMessages) {
              throw new Error("OMP message pagination ended before the advertised total");
            }
            return messages;
          }
          if (page.messages.length === 0 || messages.length >= totalMessages) {
            throw new Error("OMP message pagination did not make progress");
          }
          if (seenCursors.has(nextCursor)) {
            throw new Error("OMP message pagination repeated a cursor");
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } catch (error) {
        if (
          error instanceof OmpRpcRequestRejectedError &&
          error.code === "stale_cursor" &&
          staleRestarts < MAX_MESSAGE_PAGE_STALE_RESTARTS
        ) {
          staleRestarts += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private async requestWithSignal(
    command: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const request = this.process.request(command);
    if (!signal) return request;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([request, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      void request.catch(() => undefined);
    }
  }

  private async waitForReplayRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) {
      await waitMs(delayMs);
      return;
    }
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([waitMs(delayMs), aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async compact(customInstructions?: string): Promise<OmpCompactionResult> {
    const instructions =
      customInstructions === undefined
        ? undefined
        : validateBoundedText(customInstructions, "compaction instructions", MAX_TEXT_LENGTH);
    return OmpCompactionResultSchema.parse(
      await this.process.request(
        {
          type: "compact",
          ...(instructions ? { customInstructions: instructions } : {}),
        },
        null,
      ),
    );
  }
  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.process.request({ type: "set_auto_compaction", enabled });
  }

  async getAvailableModels(): Promise<OmpModel[]> {
    const result = OmpModelsResultSchema.parse(
      await this.process.request({ type: "get_available_models" }),
    );
    if (result.models.length === 0) throw new Error("OMP reported no available models");
    return result.models;
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    const safeProvider = validateBoundedText(provider, "model provider", MAX_NAME_LENGTH);
    const safeModelId = validateBoundedText(modelId, "model identifier", MAX_NAME_LENGTH);
    return OmpModelSchema.parse(
      await this.process.request({
        type: "set_model",
        provider: safeProvider,
        modelId: safeModelId,
      }),
    );
  }

  async setThinkingLevel(level: string): Promise<void> {
    const parsed = OmpThinkingLevelSchema.parse(level);
    await this.process.request({ type: "set_thinking_level", level: parsed });
  }

  async getAvailableCommands(): Promise<OmpAvailableCommand[]> {
    const result = OmpAvailableCommandsResultSchema.parse(
      await this.process.request({ type: "get_available_commands" }),
    );
    return result.commands;
  }
  async setSubagentSubscription(level: "events"): Promise<void> {
    await this.process.request({ type: "set_subagent_subscription", level });
  }

  async getSubagents(): Promise<OmpSubagentSnapshot[]> {
    return OmpSubagentsResultSchema.parse(await this.process.request({ type: "get_subagents" }))
      .subagents;
  }

  async getSubagentMessages(selector: {
    subagentId?: string;
    sessionFile?: string;
  }): Promise<OmpSubagentMessagesResult> {
    const subagentId = selector.subagentId
      ? validateBoundedText(selector.subagentId, "subagent identifier", MAX_ID_LENGTH)
      : undefined;
    const sessionFile = selector.sessionFile
      ? validateBoundedText(selector.sessionFile, "subagent transcript", MAX_PATH_LENGTH)
      : undefined;
    if ((subagentId ? 1 : 0) + (sessionFile ? 1 : 0) !== 1) {
      throw new OmpPublicError("OMP subagent history requires one transcript selector");
    }
    return OmpSubagentMessagesResultSchema.parse(
      await this.process.request({
        type: "get_subagent_messages",
        ...(subagentId ? { subagentId } : { sessionFile }),
      }),
    );
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const result = OmpBranchMessagesResultSchema.parse(
      await this.process.request({ type: "get_branch_messages" }),
    );
    return result.messages;
  }
  async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const safeEntryId = validateBoundedText(entryId, "branch entry identifier", MAX_ID_LENGTH);
    const result = OmpBranchResultSchema.safeParse(
      await this.process.request({ type: "branch", entryId: safeEntryId }),
    );
    if (!result.success) throw new Error("OMP RPC response is invalid");
    return result.data;
  }

  async setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]> {
    const safeTools = z.array(OmpHostToolDefinitionSchema).max(MAX_HOST_TOOLS).parse(tools);
    if (safeTools.length === 0) return [];
    const result = z
      .object({ toolNames: z.array(NAME).max(MAX_HOST_TOOLS).optional() })
      .parse(await this.process.request({ type: "set_host_tools", tools: safeTools }));
    return result.toolNames ?? [];
  }

  sendHostToolResult(result: OmpHostToolResult): void {
    this.process.send(result);
  }

  sendHostToolUpdate(update: OmpHostToolUpdate): void {
    this.process.send(update);
  }

  async prompt(
    message: string,
    images: readonly OmpImage[] = [],
    onAccepted?: () => void,
    onRequested?: (requestId: string) => void,
  ): Promise<{ requestId: string; agentInvoked?: boolean }> {
    const safeMessage = validateBoundedText(message, "prompt", MAX_TEXT_LENGTH);
    let acknowledgement: z.infer<typeof OmpPromptAckSchema> | undefined;
    const request = this.process.startRequest(
      { type: "prompt", message: safeMessage, ...(images.length > 0 ? { images } : {}) },
      undefined,
      (value) => {
        acknowledgement = OmpPromptAckSchema.parse(value) ?? {};
        onAccepted?.();
      },
    );
    onRequested?.(request.id);
    await request.promise;
    return { requestId: request.id, ...acknowledgement };
  }

  async steer(message: string, images: readonly OmpImage[] = []): Promise<void> {
    const safeMessage = validateBoundedText(message, "steer", MAX_TEXT_LENGTH);
    await this.process.sendFrame({
      type: "steer",
      message: safeMessage,
      ...(images.length > 0 ? { images } : {}),
    });
  }
  async followUp(message: string, images: readonly OmpImage[] = []): Promise<void> {
    const safeMessage = validateBoundedText(message, "follow-up", MAX_TEXT_LENGTH);
    await this.process.sendFrame({
      type: "follow_up",
      message: safeMessage,
      ...(images.length > 0 ? { images } : {}),
    });
  }

  async handoff(customInstructions?: string): Promise<void> {
    const instructions =
      customInstructions === undefined
        ? undefined
        : validateBoundedText(customInstructions, "handoff instructions", MAX_TEXT_LENGTH);
    await this.process.request({
      type: "handoff",
      ...(instructions ? { customInstructions: instructions } : {}),
    });
  }

  respondToExtensionUi(response: OmpExtensionUiResponse): Promise<void> {
    return this.process.sendFrame(response);
  }
  respondToToolApproval(response: OmpToolApprovalResponse): Promise<void> {
    return this.process.sendFrame(OmpToolApprovalResponseSchema.parse(response));
  }

  async abort(): Promise<void> {
    await this.process.request({ type: "abort", clearQueue: true, reason: "Interrupted in Paseo" });
  }

  async close(): Promise<void> {
    this.removeAbortListener();
    await this.process.close();
  }
}

export class OmpRpcRuntime implements OmpRuntime {
  readonly supportsPersistence = true;
  constructor(private readonly options: OmpRpcRuntimeOptions = {}) {}
  listSessions(options: OmpSessionListOptions): Promise<OmpSessionDescriptor[]> {
    return Promise.resolve(
      this.options.listSessions?.(options) ??
        listOmpSessionDescriptors(options, this.options.environment ?? process.env),
    );
  }
  async readPersistedSessionTranscript(options: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSessionMessages> {
    const transcript = await readOmpPersistedSessionTranscript(
      options.sessionFile,
      options.sessionId,
      options.cwd,
      options.signal,
      join(ompDataDir(this.options.environment ?? process.env), "blobs"),
    );
    return {
      ...transcript,
      messages: z
        .array(OmpMessageSchema)
        .max(MAX_REPLAY_MESSAGES)
        .parse(sanitizeMessageListMetadata(transcript.messages)),
    };
  }
  async readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    sessionFile?: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSubagentMessages> {
    const transcript = await readOmpPersistedSubagentTranscript(
      options.parentSessionFile,
      options.childTranscriptId,
      options.cwd,
      options.signal,
      options.sessionFile,
    );
    return {
      ...transcript,
      messages: z
        .array(OmpMessageSchema)
        .max(MAX_REPLAY_MESSAGES)
        .parse(sanitizeMessageListMetadata(transcript.messages)),
    };
  }

  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    options.signal?.throwIfAborted();
    const effectiveOptions = {
      ...options,
      environment: options.environment ?? this.options.environment,
    };
    const process = new OmpRpcProcess(
      effectiveOptions,
      this.options.spawnProcess,
      this.options.terminateProcessTree,
      options.requestTimeoutMs ?? this.options.requestTimeoutMs,
      this.options.reportProtocolViolation,
    );
    const abort = () => void process.close().catch(() => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    const removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    try {
      const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const ready = await waitWithTimeout(
        process.ready,
        readyTimeoutMs,
        `OMP RPC did not become ready within ${readyTimeoutMs}ms`,
      );
      validateReadyMetadata(ready);
      process.applyReadyLimits(ready);
      options.signal?.throwIfAborted();
      const advertiseTypedToolApprovals = ready.features?.typedToolApprovals === 1;
      const negotiation = ProtocolNegotiationResultSchema.parse(
        await process.request({
          type: "negotiate_protocol",
          protocolVersion: 2,
          ...(advertiseTypedToolApprovals
            ? { clientCapabilities: { typedToolApprovals: 1 as const } }
            : {}),
        }),
      );
      options.signal?.throwIfAborted();
      return new OmpRpcSession(
        process,
        removeAbortListener,
        true,
        process.inheritedRedactionValues,
        advertiseTypedToolApprovals && negotiation.clientCapabilities?.typedToolApprovals === 1,
      );
    } catch (error) {
      removeAbortListener();
      const cleanup = process.close();
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure("OMP runtime startup cleanup failed", cleanup);
      }
      throw error;
    }
  }
}
