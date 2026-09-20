import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderMcpServerConfig,
  ProviderRegistration,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { expect } from "vitest";
import type { OmpBrowserAuthorizationRegistry } from "../../server/mcp-browser";
import type { OmpOperationalFailureReporter } from "../../server/operational-failure-diagnostics";
import { ompModelId } from "../../server/provider/catalog";
import type {
  OmpAvailableCommand,
  OmpExtensionUiResponse,
  OmpHostToolDefinition,
  OmpHostToolResult,
  OmpHostToolUpdate,
  OmpImage,
  OmpMessage,
  OmpModel,
  OmpPersistedSessionMessages,
  OmpPersistedSubagentMessages,
  OmpRpcEvent,
  OmpRuntime,
  OmpRuntimeSession,
  OmpSubagentMessagesResult,
  OmpSubagentSnapshot,
  OmpToolApprovalResponse,
} from "../../server/provider/omp-rpc";
import type { OmpStartOptions } from "../../server/provider/omp-rpc-environment";
import { createOmpProvider } from "../../server/provider/registration";
import type { OmpTimelineScheduler } from "../../server/provider/timeline-projector";

export type HostLogger = object;
export type PinoFactory = (options: { enabled: boolean }) => HostLogger;
export type HostTerminalEvent = {
  type: "turn_failed" | "turn_completed" | "turn_canceled";
  turnId: string | undefined;
};
export type HostTimelineItem = {
  type: string;
  status?: string;
  trigger?: string;
  message?: string;
  [key: string]: unknown;
};
export type HostStreamEvent = { type: string; turnId?: string; item?: HostTimelineItem };
export type HostSession = {
  readonly id: string | null;
  startTurn(prompt: string, options?: { clientMessageId?: string }): Promise<{ turnId: string }>;
  subscribe(callback: (event: HostStreamEvent) => void): () => void;
  getPendingPermissions(): Array<{ id: string }>;
  respondToPermission(
    requestId: string,
    response: { behavior: "allow" | "deny"; selectedActionId?: string; updatedInput?: object },
  ): Promise<void>;
  close(): Promise<void>;
};
export type HostSessionConfig = {
  provider: string;
  cwd: string;
  systemPrompt?: string;
  mcpServers?: Record<string, unknown>;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
};
export type HostLaunchContext = { env?: Record<string, string> };
export type HostClient = {
  createSession(
    config: HostSessionConfig,
    launchContext?: HostLaunchContext,
    options?: { persistSession?: boolean },
  ): Promise<HostSession>;
};
export type HostRegistry = {
  replace(registrations: readonly ProviderRegistration[]): void;
  definitions(): Record<string, unknown>;
  clients(): Record<string, HostClient>;
  shutdown(): Promise<void>;
};
export type HostRegistryConstructor = new (logger: HostLogger) => HostRegistry;
export type HostAgentManager = {
  createAgent(
    config: HostSessionConfig,
    agentId: string | undefined,
    options: { workspaceId: string; persistSession?: boolean },
  ): Promise<{ id: string }>;
  closeAgent(agentId: string): Promise<void>;
};
export type HostAgentManagerConstructor = new (
  options: Record<string, unknown>,
) => HostAgentManager;

export const pluginProviderModulePath: string =
  "../../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
export const timelineContentModulePath: string =
  "../../node_modules/@getpaseo/server/dist/server/server/agent/agent-timeline-content.js";
export const hostRequire = createRequire(new URL(pluginProviderModulePath, import.meta.url));
export const pino = hostRequire("pino") as PinoFactory;

export const MODEL: OmpModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
  contextWindow: 200_000,
  input: ["text", "image"],
};
export const ALTERNATE_MODEL: OmpModel = {
  provider: "openai",
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  thinking: { efforts: ["low", "high"], defaultLevel: "high" },
  contextWindow: null,
  input: ["text"],
};
export const MODEL_PUBLIC_ID = ompModelId(MODEL);
export const ALTERNATE_MODEL_PUBLIC_ID = ompModelId(ALTERNATE_MODEL);
export const NATIVE_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
export const BRANCHED_NATIVE_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfcc";
export const TEST_RUNTIME_ENV: NodeJS.ProcessEnv = {
  HOME: "/__paseo_omp_test_no_home__",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
  PI_CONFIG_DIR: ".omp-no-config",
};
export const THINKING_LEVELS: Readonly<Record<string, true>> = {
  high: true,
  low: true,
  max: true,
  medium: true,
  minimal: true,
  off: true,
  xhigh: true,
};

export class EventLog extends Array<ProviderEvent> {
  readonly #waiters: Array<{
    predicate: (event: ProviderEvent) => boolean;
    resolve: (event: ProviderEvent) => void;
  }> = [];

  override push(...items: ProviderEvent[]): number {
    const length = super.push(...items);
    for (const event of items) {
      for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.#waiters[index];
        if (!waiter?.predicate(event)) continue;
        this.#waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
    return length;
  }

  waitFor(predicate: (event: ProviderEvent) => boolean): Promise<ProviderEvent> {
    const existing = this.find(predicate);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<ProviderEvent>();
    this.#waiters.push({ predicate, resolve });
    return promise;
  }
}
export class ProviderRpcChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 515_151;
  private didClose = false;

  constructor(handler: (command: Record<string, unknown>) => void) {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer | string) => {
      buffered += String(chunk);
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handler(JSON.parse(line) as Record<string, unknown>);
      }
    });
    this.stdin.once("finish", () => this.close());
  }

  write(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  writeChunked(frame: Record<string, unknown>, chunkId: string): void {
    const payload = Buffer.from(JSON.stringify(frame));
    const count = Math.ceil(payload.byteLength / (256 * 1024));
    for (let index = 0; index < count; index += 1) {
      const part = payload.subarray(index * 256 * 1024, (index + 1) * 256 * 1024);
      this.write({
        type: "rpc_chunk",
        chunkId,
        index,
        count,
        byteLength: payload.byteLength,
        data: part.toString("base64"),
      });
    }
  }

  close(): void {
    if (this.didClose) return;
    this.didClose = true;
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }

  kill(): boolean {
    this.close();
    return true;
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

export class ManualScheduler implements OmpTimelineScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<
    number,
    { callback: () => void | Promise<void>; delayMs: number }
  >();
  readonly delays: number[] = [];
  onSchedule: ((delayMs: number) => void) | null = null;
  clearError: Error | null = null;
  get pendingCount(): number {
    return this.callbacks.size;
  }

  set(callback: () => void | Promise<void>, delayMs: number): number {
    const id = this.nextId;
    this.delays.push(delayMs);
    this.nextId += 1;
    this.callbacks.set(id, { callback, delayMs });
    this.onSchedule?.(delayMs);
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
    if (this.clearError) {
      const error = this.clearError;
      this.clearError = null;
      throw error;
    }
  }

  runPending(delayMs?: number): Promise<void>[] {
    const callbacks = [...this.callbacks.entries()].filter(
      ([, pending]) => delayMs === undefined || pending.delayMs === delayMs,
    );
    for (const [id] of callbacks) this.callbacks.delete(id);
    return callbacks.map(([, pending]) => {
      try {
        return Promise.resolve(pending.callback());
      } catch (error) {
        return Promise.reject(error);
      }
    });
  }

  async flush(delayMs?: number): Promise<void> {
    await Promise.all(this.runPending(delayMs));
    await Promise.resolve();
    await Promise.resolve();
  }
}

export class FakeOmpSession implements OmpRuntimeSession {
  canReplayHistory = true;
  supportsTypedToolApprovals = true;
  inheritedRedactionValues: readonly string[] = [];
  maxInputFrameBytes: number | undefined;
  readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  readonly prompts: string[] = [];
  readonly promptImages: OmpImage[][] = [];
  readonly steers: string[] = [];
  readonly steerImages: OmpImage[][] = [];
  readonly extensionUiResponses: OmpExtensionUiResponse[] = [];
  readonly toolApprovalResponses: OmpToolApprovalResponse[] = [];
  extensionUiResponseGate: Promise<void> | null = null;
  extensionUiResponseObserved: (() => void) | null = null;
  extensionUiResponseError: Error | null = null;
  promptGate: Promise<void> | null = null;
  promptObserved: (() => void) | null = null;
  compactGate: Promise<void> | null = null;
  compactObserved: (() => void) | null = null;
  compactError: Error | null = null;
  compactTokensBefore = 1_000;
  readonly compactions: Array<string | undefined> = [];
  readonly autoCompactionChanges: boolean[] = [];
  readonly handoffs: Array<string | undefined> = [];
  readonly followUps: string[] = [];
  handoffGate: Promise<void> | null = null;
  handoffObserved: (() => void) | null = null;
  autoCompactionEnabled = true;
  steerGate: Promise<void> | null = null;
  steerObserved: (() => void) | null = null;
  branchMessagesGate: Promise<void> | null = null;
  branchMessagesError: Error | null = null;
  branchMessageLookups = 0;
  branchMessagesObserved: (() => void) | null = null;
  branchGate: Promise<void> | null = null;
  branchObserved: (() => void) | null = null;
  branchError: Error | null = null;
  branchResultError: Error | null = null;
  branchCancelled = false;
  branchHistoryAfter: OmpMessage[] | null = null;
  branchModelAfter: OmpModel | null = null;
  branchThinkingAfter: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null =
    null;
  readonly branches: string[] = [];
  closeGate: Promise<void> | null = null;
  closeObserved: (() => void) | null = null;
  abortGate: Promise<void> | null = null;
  abortObserved: (() => void) | null = null;
  abortError: Error | null = null;
  availableCommands: OmpAvailableCommand[] = [
    { name: "help", description: "Show help", source: "builtin" },
  ];
  branchSessionIdAfter: string | null = null;
  branchStateErrorAfter: Error | null = null;
  branchHistoryErrorAfter: Error | null = null;
  availableCommandsError: Error | null = null;
  availableCommandLookups = 0;
  availableCommandsGate: Promise<void> | null = null;
  subagentSubscriptionError: Error | null = null;
  readonly subagentSubscriptions: string[] = [];
  subagents: OmpSubagentSnapshot[] = [];
  subagentsError: Error | null = null;
  subagentsGate: Promise<void> | null = null;
  subagentsObserved: (() => void) | null = null;
  readonly subagentMessages = new Map<string, OmpSubagentMessagesResult>();
  readonly subagentMessageRequests: Array<{ subagentId?: string; sessionFile?: string }> = [];
  availableCommandsObserved: (() => void) | null = null;
  readonly modelChanges: Array<{ provider: string; modelId: string }> = [];
  modelResponseGate: Promise<void> | null = null;
  modelResponseObserved: (() => void) | null = null;
  readonly thinkingChanges: string[] = [];
  applyModelChanges = true;
  applyThinkingChanges = true;
  modelChangeGate: Promise<void> | null = null;
  modelChangeObserved: (() => void) | null = null;
  modelChangeError: Error | null = null;
  branchMessages: Array<{ entryId: string; text: string }> = [];
  historyMessages: OmpMessage[] = [];
  historyRequests = 0;
  historyGate: Promise<void> | null = null;
  historyError: Error | null = null;
  historyObserved: (() => void) | null = null;
  currentModel = MODEL;
  stateObserved: (() => void) | null = null;
  activeStateLookups = 0;
  maxActiveStateLookups = 0;
  activeStatsLookups = 0;
  maxActiveStatsLookups = 0;
  nativeSessionFile: string | undefined = "/sessions/root.jsonl";
  availableModels: OmpModel[] = [MODEL, ALTERNATE_MODEL];
  nativeSessionId = NATIVE_SESSION_ID;
  stateGate: Promise<void> | null = null;
  stateModelOverride: OmpModel | null | undefined;
  stateLookups = 0;
  stateError: Error | null = null;
  usageAvailable = false;
  stateContextNull = false;
  captureUsageOnRequest = false;
  statsGate: Promise<void> | null = null;
  statsError: Error | null = null;
  statsLookups = 0;
  contextTokens = 1_000;
  contextWindow = 200_000;
  inputTokens = 800;
  cachedInputTokens = 200;
  outputTokens = 100;
  totalCostUsd = 0.25;
  isStreaming = false;
  isCompacting = false;
  thinkingLevel: string | undefined = "medium";
  promptAgentInvoked: boolean | undefined = true;
  promptEvents: OmpRpcEvent[] = [];
  promptError: Error | null = null;
  steerError: Error | null = null;
  closeError: Error | null = null;
  hostToolResultError: Error | null = null;
  hostToolResultAttempted: (() => void) | null = null;
  aborts = 0;
  promptCount = 0;
  closes = 0;
  readonly hostToolCatalogs: OmpHostToolDefinition[][] = [];
  readonly hostToolResults: OmpHostToolResult[] = [];
  readonly hostToolUpdates: OmpHostToolUpdate[] = [];
  hostToolResultObserved: (() => void) | null = null;
  hostToolBindGate: Promise<void> | null = null;
  hostToolBindObserved: (() => void) | null = null;
  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: OmpRpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async getState() {
    this.stateLookups += 1;
    this.activeStateLookups += 1;
    this.maxActiveStateLookups = Math.max(this.maxActiveStateLookups, this.activeStateLookups);
    this.stateObserved?.();
    const requested = {
      model: this.stateModelOverride !== undefined ? this.stateModelOverride : this.currentModel,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      autoCompactionEnabled: this.autoCompactionEnabled,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      usageAvailable: this.usageAvailable,
      stateContextNull: this.stateContextNull,
      sessionFile: this.nativeSessionFile,
      sessionId: this.nativeSessionId,
    };
    try {
      if (this.stateGate) await this.stateGate;
      if (this.stateError) throw this.stateError;
      const value = this.captureUsageOnRequest
        ? requested
        : {
            model:
              this.stateModelOverride !== undefined ? this.stateModelOverride : this.currentModel,
            thinkingLevel: this.thinkingLevel,
            isStreaming: this.isStreaming,
            isCompacting: this.isCompacting,
            autoCompactionEnabled: this.autoCompactionEnabled,
            contextTokens: this.contextTokens,
            contextWindow: this.contextWindow,
            usageAvailable: this.usageAvailable,
            stateContextNull: this.stateContextNull,
          };
      return {
        model: requested.model,
        thinkingLevel: requested.thinkingLevel,
        isStreaming: value.isStreaming,
        isCompacting: value.isCompacting,
        autoCompactionEnabled: value.autoCompactionEnabled,
        sessionId: this.nativeSessionId,
        ...(value.usageAvailable
          ? {
              contextUsage: value.stateContextNull
                ? { tokens: null, contextWindow: null, percent: null }
                : {
                    tokens: value.contextTokens,
                    contextWindow: value.contextWindow,
                    percent: (value.contextTokens / value.contextWindow) * 100,
                  },
            }
          : {}),
      };
    } finally {
      this.activeStateLookups -= 1;
    }
  }

  async getSessionStats() {
    this.statsLookups += 1;
    this.activeStatsLookups += 1;
    this.maxActiveStatsLookups = Math.max(this.maxActiveStatsLookups, this.activeStatsLookups);
    const requested = {
      usageAvailable: this.usageAvailable,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      totalCostUsd: this.totalCostUsd,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
    };
    try {
      if (this.statsGate) await this.statsGate;
      const value = this.captureUsageOnRequest
        ? requested
        : {
            usageAvailable: this.usageAvailable,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cachedInputTokens: this.cachedInputTokens,
            totalCostUsd: this.totalCostUsd,
            contextTokens: this.contextTokens,
            contextWindow: this.contextWindow,
          };
      if (!value.usageAvailable) throw new Error("usage unavailable");
      if (this.statsError) throw this.statsError;
      return {
        tokens: {
          input: value.inputTokens,
          output: value.outputTokens,
          cacheRead: value.cachedInputTokens,
        },
        cost: value.totalCostUsd,
        contextUsage: {
          tokens: value.contextTokens,
          contextWindow: value.contextWindow,
          percent: 0,
        },
      };
    } finally {
      this.activeStatsLookups -= 1;
    }
  }

  getAvailableModels() {
    return Promise.resolve(this.availableModels);
  }

  async getAvailableCommands() {
    this.availableCommandLookups += 1;
    this.availableCommandsObserved?.();
    if (this.availableCommandsGate) await this.availableCommandsGate;
    if (this.availableCommandsError) throw this.availableCommandsError;
    return this.availableCommands;
  }
  async setSubagentSubscription(level: "events") {
    if (this.subagentSubscriptionError) throw this.subagentSubscriptionError;
    this.subagentSubscriptions.push(level);
  }

  async getSubagents() {
    this.subagentsObserved?.();
    if (this.subagentsGate) await this.subagentsGate;
    if (this.subagentsError) throw this.subagentsError;
    return this.subagents;
  }

  getSubagentMessages(selector: { subagentId?: string; sessionFile?: string }) {
    this.subagentMessageRequests.push(selector);
    const key = selector.subagentId ?? selector.sessionFile;
    const result = key ? this.subagentMessages.get(key) : undefined;
    if (!result) return Promise.reject(new Error("missing fake subagent transcript"));
    return Promise.resolve(result);
  }
  async prompt(
    message: string,
    images: readonly OmpImage[] = [],
    onAccepted?: () => void,
    onRequested?: (requestId: string) => void,
  ) {
    this.prompts.push(message);
    this.promptImages.push([...images]);
    this.promptCount += 1;
    const requestId = `rpc-prompt-${this.promptCount}`;
    onRequested?.(requestId);
    this.promptObserved?.();
    if (this.promptGate) await this.promptGate;
    for (const event of this.promptEvents) this.emit(event);
    if (this.promptError) throw this.promptError;
    onAccepted?.();
    return { requestId, agentInvoked: this.promptAgentInvoked };
  }

  async compact(customInstructions?: string) {
    this.compactions.push(customInstructions);
    this.compactObserved?.();
    if (this.compactGate) await this.compactGate;
    if (this.compactError) throw this.compactError;
    return { tokensBefore: this.compactTokensBefore };
  }
  async setAutoCompaction(enabled: boolean) {
    this.autoCompactionChanges.push(enabled);
    this.autoCompactionEnabled = enabled;
  }

  async setModel(provider: string, modelId: string) {
    this.modelChanges.push({ provider, modelId });
    const model = this.availableModels.find(
      (candidate) => candidate.provider === provider && candidate.id === modelId,
    );
    if (!model) throw new Error("unknown model");
    this.modelChangeObserved?.();
    if (this.modelChangeGate) await this.modelChangeGate;
    if (this.modelChangeError) throw this.modelChangeError;
    if (this.applyModelChanges) {
      this.currentModel = model;
      const efforts = model.thinking?.efforts ?? [];
      if (!this.thinkingLevel || !efforts.includes(this.thinkingLevel)) {
        const defaultLevel = model.thinking?.defaultLevel ?? "";
        this.thinkingLevel = isThinkingLevel(defaultLevel) ? defaultLevel : undefined;
      }
    }
    this.modelResponseObserved?.();
    if (this.modelResponseGate) await this.modelResponseGate;
    return model;
  }

  setThinkingLevel(level: string) {
    this.thinkingChanges.push(level);
    if (!isThinkingLevel(level)) return Promise.reject(new Error("invalid thinking level"));
    if (this.applyThinkingChanges) this.thinkingLevel = level;
    return Promise.resolve();
  }

  async setHostTools(tools: readonly OmpHostToolDefinition[]) {
    this.hostToolCatalogs.push(tools.map((tool) => structuredClone(tool)));
    this.hostToolBindObserved?.();
    if (this.hostToolBindGate) await this.hostToolBindGate;
    return tools.map(({ name }) => name);
  }

  sendHostToolResult(result: OmpHostToolResult) {
    this.hostToolResultAttempted?.();
    if (this.hostToolResultError) throw this.hostToolResultError;
    this.hostToolResults.push(structuredClone(result));
    this.hostToolResultObserved?.();
  }

  sendHostToolUpdate(update: OmpHostToolUpdate) {
    this.hostToolUpdates.push(structuredClone(update));
  }

  async steer(message: string, images: readonly OmpImage[] = []) {
    this.steerObserved?.();
    if (this.steerGate) await this.steerGate;
    if (this.steerError) throw this.steerError;
    this.steers.push(message);
    this.steerImages.push([...images]);
  }
  async followUp(message: string) {
    this.followUps.push(message);
  }

  async handoff(customInstructions?: string) {
    this.handoffObserved?.();
    if (this.handoffGate) await this.handoffGate;
    this.handoffs.push(customInstructions);
  }

  async respondToExtensionUi(response: OmpExtensionUiResponse) {
    this.extensionUiResponseObserved?.();
    if (this.extensionUiResponseGate) await this.extensionUiResponseGate;
    if (this.extensionUiResponseError) throw this.extensionUiResponseError;
    this.extensionUiResponses.push(response);
  }
  async respondToToolApproval(response: OmpToolApprovalResponse) {
    this.toolApprovalResponses.push(response);
  }

  async branch(entryId: string) {
    this.branches.push(entryId);
    this.branchObserved?.();
    if (this.branchGate) await this.branchGate;
    if (this.branchError) throw this.branchError;
    if (!this.branchCancelled && this.branchHistoryAfter) {
      this.historyMessages = this.branchHistoryAfter;
    }
    if (!this.branchCancelled && this.branchModelAfter) {
      this.currentModel = this.branchModelAfter;
    }
    if (!this.branchCancelled && this.branchThinkingAfter) {
      this.thinkingLevel = this.branchThinkingAfter;
    }
    if (!this.branchCancelled && this.branchSessionIdAfter) {
      this.nativeSessionId = this.branchSessionIdAfter;
    }
    if (!this.branchCancelled && this.branchStateErrorAfter) {
      this.stateError = this.branchStateErrorAfter;
    }
    if (!this.branchCancelled && this.branchHistoryErrorAfter) {
      this.historyError = this.branchHistoryErrorAfter;
    }
    if (this.branchResultError) throw this.branchResultError;
    return {
      text: this.branchMessages.find((message) => message.entryId === entryId)?.text ?? "",
      cancelled: this.branchCancelled,
    };
  }

  async getBranchMessages() {
    if (this.branchMessagesError) throw this.branchMessagesError;
    this.branchMessageLookups += 1;
    this.branchMessagesObserved?.();
    if (this.branchMessagesGate) await this.branchMessagesGate;
    return this.branchMessages;
  }
  async getMessages() {
    this.historyRequests += 1;
    this.historyObserved?.();
    if (this.historyGate) await this.historyGate;
    if (this.historyError) throw this.historyError;
    return this.historyMessages;
  }

  async abort() {
    this.aborts += 1;
    this.abortObserved?.();
    if (this.abortGate) await this.abortGate;
    if (this.abortError) throw this.abortError;
  }

  async close() {
    this.closes += 1;
    this.closeObserved?.();
    if (this.closeGate) await this.closeGate;
    if (this.closeError) throw this.closeError;
  }
}

export class FakeOmpRuntime implements OmpRuntime {
  readonly sessions: FakeOmpSession[] = [];
  supportsPersistence = true;
  readonly starts: OmpStartOptions[] = [];
  readonly sessionIds: string[] = [];
  nextModel: OmpModel | null = null;
  nextThinkingLevel: string | null = null;
  nextInheritedRedactionValues: readonly string[] = [];
  omitNextThinkingLevel = false;
  nextCloseError: Error | null = null;
  nextStartError: Error | null = null;
  startGate: Promise<void> | null = null;
  startObserved: (() => void) | null = null;
  commandDiscoveryError: Error | null = null;
  availableCommands: OmpAvailableCommand[] = [
    { name: "help", description: "Show help", source: "builtin" },
  ];
  availableModels: OmpModel[] = [MODEL, ALTERNATE_MODEL];
  nextAvailableModels: OmpModel[] | null = null;
  readonly descriptors: Array<{
    id: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
    transcriptFile?: string;
  }> = [];
  resolveSessions = true;
  nextCanReplayHistory = true;
  nextHistoryGate: Promise<void> | null = null;
  nextHistoryObserved: (() => void) | null = null;
  nextHistoryError: Error | null = null;
  nextHistoryMessages: OmpMessage[] = [];
  nextBranchMessages: Array<{ entryId: string; text: string }> = [];
  nextSubagents: OmpSubagentSnapshot[] = [];
  readonly nextSubagentMessages = new Map<string, OmpSubagentMessagesResult>();
  nextSubagentSubscriptionError: Error | null = null;
  readonly persistedSubagentMessages = new Map<string, OmpPersistedSubagentMessages>();
  persistedSessionMessages: OmpPersistedSessionMessages | null = null;
  persistedSessionError: Error | null = null;
  readonly persistedSessionRequests: Array<{
    sessionFile: string;
    sessionId: string;
    cwd: string;
  }> = [];
  readonly persistedSubagentGates = new Map<string, Promise<void>>();
  persistedSubagentObserved: ((key: string) => void) | null = null;
  readonly persistedSubagentRequests: Array<{
    parentSessionFile: string;
    childTranscriptId: string;
    sessionFile?: string;
  }> = [];
  readonly sessionListRequests: Array<{
    cwd?: string;
    query?: string;
    limit?: number;
    sessionId?: string;
    sessionDir?: string;
  }> = [];
  listSessions(options: {
    cwd?: string;
    query?: string;
    limit?: number;
    sessionId?: string;
    sessionDir?: string;
  }) {
    this.sessionListRequests.push(options);
    const source =
      this.descriptors.length > 0
        ? this.descriptors
        : this.resolveSessions && options.sessionId && options.cwd
          ? [{ id: options.sessionId, cwd: options.cwd }]
          : [];
    return Promise.resolve(
      source.filter(
        (descriptor) =>
          (!options.sessionId || descriptor.id === options.sessionId) &&
          (options.cwd === undefined || descriptor.cwd === options.cwd),
      ),
    );
  }
  sessionCreated: ((session: FakeOmpSession) => void) | null = null;
  async readPersistedSessionTranscript(options: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
  }) {
    this.persistedSessionRequests.push({
      sessionFile: options.sessionFile,
      sessionId: options.sessionId,
      cwd: options.cwd,
    });
    options.signal?.throwIfAborted();
    if (this.persistedSessionError) throw this.persistedSessionError;
    return (
      this.persistedSessionMessages ?? {
        sessionFile: options.sessionFile,
        nativeSessionId: options.sessionId,
        byteLength: 0,
        messages: this.sessions.at(-1)?.historyMessages ?? [],
      }
    );
  }

  async readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    sessionFile?: string;
    cwd: string;
    signal?: AbortSignal;
  }) {
    this.persistedSubagentRequests.push({
      parentSessionFile: options.parentSessionFile,
      childTranscriptId: options.childTranscriptId,
      ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
    });
    const key = `${options.parentSessionFile}\0${options.childTranscriptId}`;
    this.persistedSubagentObserved?.(key);
    const gate = this.persistedSubagentGates.get(key);
    if (gate) await gate;
    options.signal?.throwIfAborted();
    const result = this.persistedSubagentMessages.get(key);
    if (!result) throw new Error("missing fake persisted subagent transcript");
    return result;
  }
  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    this.starts.push(options);
    this.startObserved?.();
    if (this.startGate) await this.startGate;
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = null;
      throw error;
    }
    const session = new FakeOmpSession();
    session.inheritedRedactionValues = this.nextInheritedRedactionValues;
    this.nextInheritedRedactionValues = [];
    session.availableCommandsError = this.commandDiscoveryError;
    session.availableCommands = this.availableCommands.map((command) => ({
      ...command,
      ...(command.aliases ? { aliases: [...command.aliases] } : {}),
    }));
    session.nativeSessionId =
      this.sessionIds.shift() ?? options.resumeSessionId ?? session.nativeSessionId;
    session.canReplayHistory = this.nextCanReplayHistory;
    session.availableModels = (this.nextAvailableModels ?? this.availableModels).map((model) => ({
      ...model,
    }));
    this.nextAvailableModels = null;
    session.historyGate = this.nextHistoryGate;
    session.historyObserved = this.nextHistoryObserved;
    session.historyError = this.nextHistoryError;
    session.historyMessages = this.nextHistoryMessages;
    session.branchMessages = this.nextBranchMessages;
    session.subagents = this.nextSubagents;
    session.subagentSubscriptionError = this.nextSubagentSubscriptionError;
    for (const [key, history] of this.nextSubagentMessages) {
      session.subagentMessages.set(key, history);
    }
    this.nextCanReplayHistory = true;
    this.nextHistoryGate = null;
    this.nextHistoryObserved = null;
    this.nextHistoryError = null;
    this.nextHistoryMessages = [];
    this.nextBranchMessages = [];
    this.nextSubagents = [];
    this.nextSubagentMessages.clear();
    this.nextSubagentSubscriptionError = null;
    if (this.nextModel) {
      session.currentModel = this.nextModel;
      this.nextModel = null;
    }
    if (this.nextThinkingLevel) {
      session.thinkingLevel = this.nextThinkingLevel;
      this.nextThinkingLevel = null;
    }
    if (this.omitNextThinkingLevel) {
      session.thinkingLevel = undefined;
      this.omitNextThinkingLevel = false;
    }
    if (this.nextCloseError) {
      session.closeError = this.nextCloseError;
      this.nextCloseError = null;
    }
    this.sessions.push(session);
    this.sessionCreated?.(session);
    return session;
  }
}

export function isThinkingLevel(
  level: string,
): level is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return THINKING_LEVELS[level] === true;
}

export function sessionAt(runtime: FakeOmpRuntime, index = 0): FakeOmpSession {
  const session = runtime.sessions[index];
  if (!session) throw new Error(`Missing fake OMP session ${index}`);
  return session;
}

export async function createHarness(
  runtime = new FakeOmpRuntime(),
  scheduler = new ManualScheduler(),
  capabilities: readonly string[] = [
    "prompt.message",
    "prompt.command",
    "prompt.image",
    "prompt.steer",
    "session.configure",
    "permission",
  ],
  replayTimeoutMs?: number,
  reportOperationalFailure?: OmpOperationalFailureReporter,
) {
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: scheduler,
    environment: TEST_RUNTIME_ENV,
    replayTimeoutMs,
    reportOperationalFailure,
  }).connect({ versions: [1], capabilities });
  const events = new EventLog();
  connection.onEvent((event) => events.push(event));
  return { connection, events, runtime, scheduler };
}

export async function createHostToolHarness(
  runtime = new FakeOmpRuntime(),
  browserAuthorizationRegistry?: OmpBrowserAuthorizationRegistry,
) {
  const scheduler = new ManualScheduler();
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: scheduler,
    environment: TEST_RUNTIME_ENV,
    mcpConnector: async () => ({
      listTools: async () => ({
        tools: [{ name: "read", title: "Repository file lookup", inputSchema: { type: "object" } }],
      }),
      callTool: async () => ({ content: [{ type: "text", text: "bootstrap result" }] }),
      close: async () => {},
    }),
    browserAuthorizationRegistry,
  }).connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "prompt.steer",
      "session.configure",
      "permission",
      "session.persistence",
      "timeline.plugin",
    ],
  });
  const events = new EventLog();
  connection.onEvent((event) => events.push(event));
  return { connection, events, runtime, scheduler };
}

export async function openHostToolSession(
  connection: ProviderConnection,
  events: EventLog,
  requestId = "host-tool-open",
  persist = false,
): Promise<void> {
  await connection.send({
    type: "session.open",
    requestId,
    sessionId: "session-1",
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: { repo: { type: "stdio", command: "repo" } },
      model: MODEL_PUBLIC_ID,
      mode: "full",
      thinkingOption: "medium",
      settings: {},
      persist,
    },
    history: "skip",
  });
  const outcome = await events.waitFor(
    (event) =>
      (event.type === "session.ready" && event.requestId === requestId) ||
      (event.type === "request.failed" && event.requestId === requestId),
  );
  if (outcome.type === "request.failed") throw new Error(outcome.error.message);
}

export async function expectBootstrapHostToolTerminal(
  session: FakeOmpSession,
  id: string,
): Promise<void> {
  const observed = Promise.withResolvers<void>();
  session.hostToolResultObserved = observed.resolve;
  session.emit({
    type: "host_tool_call",
    id,
    toolCallId: `${id}-tool-call`,
    toolName: "mcp__repo_read",
    arguments: { phase: id },
  });
  await observed.promise;
  expect(session.hostToolResults.filter((result) => result.id === id)).toEqual([
    expect.objectContaining({
      type: "host_tool_result",
      id,
      result: expect.objectContaining({
        content: [{ type: "text", text: "bootstrap result" }],
      }),
    }),
  ]);
}

export async function openSession(
  connection: ProviderConnection,
  events: EventLog,
  requestId = "open-1",
  sessionId = "session-1",
  env: Record<string, string> = { TEST_ENV: "test-value" },
  model = MODEL_PUBLIC_ID,
  thinkingOption: string | null = "medium",
  persist = true,
  extra: {
    providerOptions?: ProviderSessionConfig["providerOptions"];
    mcpServers?: Readonly<Record<string, ProviderMcpServerConfig>>;
  } = {},
) {
  await connection.send({
    type: "session.open",
    requestId,
    sessionId,
    config: {
      cwd: "/repo",
      env,
      systemPrompt: "Be precise",
      mcpServers: extra.mcpServers ?? {},
      model,
      persist,
      mode: "full",
      ...(thinkingOption ? { thinkingOption } : {}),
      settings: {},
      ...(extra.providerOptions ? { providerOptions: extra.providerOptions } : {}),
    },
    history: "skip",
  });
  const outcome = await events.waitFor(
    (event) =>
      (event.type === "session.ready" && event.requestId === requestId) ||
      (event.type === "request.failed" && event.requestId === requestId),
  );
  if (outcome.type === "request.failed") throw new Error(outcome.error.message);
}
export async function sendPersistentOpen(
  connection: ProviderConnection,
  requestId: string,
  sessionId: string,
  history: "skip" | "replay" = "skip",
): Promise<void> {
  await connection.send({
    type: "session.open",
    requestId,
    sessionId,
    config: {
      cwd: "/repo",
      env: {},
      mcpServers: {},
      model: MODEL_PUBLIC_ID,
      mode: "full",
      thinkingOption: "medium",
      settings: {},
      persist: true,
    },
    history,
  });
}

export async function startPrompt(
  connection: ProviderConnection,
  events: EventLog,
  clientMessageId = "client-1",
  text = "hello",
  sessionId = "session-1",
) {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  });
  return events.waitFor(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
  );
}

export function turnIdFrom(result: ProviderEvent): string {
  if (result.type !== "session.prompt_result" || result.result.type !== "turn") {
    throw new Error("Expected turn prompt result");
  }
  return result.result.turnId;
}

export function establishTerminalOwnership(session: FakeOmpSession): void {
  session.emit({
    type: "prompt_result",
    id: `rpc-prompt-${session.promptCount}`,
    agentInvoked: true,
  });
}

export function finishTurn(events: EventLog, session: FakeOmpSession, turnId: string) {
  establishTerminalOwnership(session);
  session.emit({
    type: "agent_end",
    requestId: `rpc-prompt-${session.promptCount}`,
    messages: [],
    isTerminal: true,
  });
  return events.waitFor(
    (event) =>
      event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
  );
}

export async function finishLegacyTurn(
  events: EventLog,
  session: FakeOmpSession,
  turnId: string,
  clientMessageId: string,
  text: string,
  sequence: number,
) {
  const userEntryId = `legacy-user-${sequence}`;
  const assistant = {
    role: "assistant" as const,
    content: `legacy response ${sequence}`,
    entryId: `legacy-assistant-${sequence}`,
    stopReason: "stop",
  };
  session.branchMessages.push({ entryId: userEntryId, text });
  session.emit({ type: "message_end", message: { role: "user", content: text } });
  await events.waitFor(
    (event) =>
      event.type === "timeline.item" &&
      event.item.type === "user_message" &&
      event.item.clientMessageId === clientMessageId,
  );
  session.emit({ type: "message_end", message: assistant });
  session.emit({ type: "agent_end", messages: [assistant], isTerminal: true });
  return events.waitFor(
    (event) =>
      event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
  );
}
