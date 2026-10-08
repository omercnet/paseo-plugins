import type {
  ProviderConfigState,
  ProviderEvent,
  ProviderInput,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { normalizeOmpSessionConfig } from "./config-normalization";
import type { OmpRuntime } from "./omp-rpc";
import { buildOmpSpawnRequest } from "./omp-rpc-environment";
import {
  configuredOutputRedactionValues,
  OmpPublicDataSerializer,
  OmpPublicError,
  utf8Bytes,
} from "./security";
import {
  authorizeNativeSession,
  fixedSessionMode,
  type OmpOpenedSession,
  ompPersistenceSessionId,
  REPLAY_TIMEOUT_MS,
  waitForReplay,
} from "./session";
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
type SessionPermissionInput = Extract<ProviderInput, { type: "session.permission" }>;
type Emit = (event: ProviderEvent) => void;

// A history session replays a persisted journal and runs nothing. It advertises no prompt,
// permission, configuration, or rewind capability, so the host rejects those requests itself.
const HISTORY_CAPABILITIES: readonly string[] = [
  "session.persistence",
  "session.subsession",
  "timeline.plugin",
];
const READ_ONLY_MESSAGE = "OMP history sessions are read-only";

/**
 * Serves a persisted OMP session from its authorized transcript alone. It exists for sessions
 * whose recorded working directory is gone: no runtime process is spawned, no MCP server is
 * connected, and the working directory is never touched. The native session identity, workspace
 * authorization, and transcript ownership checks are the same ones a live resume performs.
 */
export class OmpHistorySession implements OmpOpenedSession {
  readonly id: string;
  readonly cwd: string;

  private readonly lifetime = new AbortController();
  private readonly dataFilter: OmpPublicDataSerializer;
  private readonly projector: OmpTimelineProjector;
  private readonly subsessions: OmpSubsessionProjector | null;
  private disposed = false;
  private sessionClosedPublished = false;

  private constructor(
    id: string,
    private readonly config: ProviderSessionConfig,
    private readonly runtime: OmpRuntime,
    private readonly readTranscript: NonNullable<OmpRuntime["readPersistedSessionTranscript"]>,
    private readonly nativeSessionId: string,
    private readonly transcriptFile: string,
    private readonly configState: ProviderConfigState,
    redactionValues: readonly string[],
    private readonly capabilities: readonly string[],
    private readonly emit: Emit,
    private readonly replayTimeoutMs: number,
    scheduler: OmpTimelineScheduler,
  ) {
    this.id = id;
    this.cwd = config.cwd;
    this.dataFilter = new OmpPublicDataSerializer(redactionValues);
    const pluginTimeline = capabilities.includes("timeline.plugin");
    this.projector = new OmpTimelineProjector(
      id,
      emit,
      scheduler,
      redactionValues,
      false,
      pluginTimeline,
    );
    // Same identity key as a live persisted session, so child session ids stay stable across
    // a history load and a later interactive resume of the same native session.
    this.subsessions = capabilities.includes("session.subsession")
      ? new OmpSubsessionProjector(
          id,
          `persisted:${nativeSessionId}`,
          transcriptFile,
          config.cwd,
          emit,
          scheduler,
          () => {},
          redactionValues,
          pluginTimeline,
        )
      : null;
  }

  get persistenceSessionId(): string {
    return this.nativeSessionId;
  }

  static async open(
    input: SessionOpenInput,
    runtime: OmpRuntime,
    capabilities: readonly string[],
    emit: Emit,
    replayTimeoutMs = REPLAY_TIMEOUT_MS,
    environment?: NodeJS.ProcessEnv,
    hostInheritEnv: readonly string[] = [],
    scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
  ): Promise<OmpHistorySession> {
    const nativeSessionId = ompPersistenceSessionId(input);
    if (!nativeSessionId || input.history !== "replay" || !input.config.persist) {
      throw new OmpPublicError("OMP history purpose requires a persisted session replay");
    }
    const normalized = normalizeOmpSessionConfig(
      input.config,
      capabilities.includes("permission"),
      hostInheritEnv,
    );
    if (input.config.title && utf8Bytes(input.config.title) > 256) {
      throw new OmpPublicError("OMP session title is too large");
    }
    const readTranscript = runtime.readPersistedSessionTranscript?.bind(runtime);
    if (!readTranscript) throw new OmpPublicError("OMP session history cannot be replayed safely");
    // The same workspace and native-identity authorization as a live resume; only the spawn is
    // skipped. The recorded cwd is compared, never opened.
    const descriptor = await authorizeNativeSession(
      runtime,
      nativeSessionId,
      input.config.cwd,
      normalized.sessionDir,
    );
    if (!descriptor.transcriptFile) {
      throw new OmpPublicError("OMP session transcript could not be resolved in this workspace");
    }
    const configuredValues = configuredOutputRedactionValues(
      normalized.outputRedaction ?? "none",
      normalized.env,
      input.config.mcpServers,
    );
    // Inherited values are redacted exactly as a live session would: they come from the same
    // spawn-request builder, which only reads the server environment.
    const redactionValues =
      normalized.outputRedaction === "configured-values"
        ? [
            ...configuredValues,
            ...buildOmpSpawnRequest({
              ...normalized,
              environment,
              // A resume never reapplies the system prompt or thinking selection.
              systemPrompt: undefined,
              thinkingOption: undefined,
              resumeSessionId: nativeSessionId,
              resumeSessionFile: descriptor.transcriptFile,
            }).inheritedRedactionValues,
          ]
        : configuredValues;
    const configState: ProviderConfigState = {
      ...(input.config.model ? { model: input.config.model } : {}),
      mode: normalized.mode ?? "full",
      ...(input.config.thinkingOption ? { thinkingOption: input.config.thinkingOption } : {}),
      models: [],
      modes: [fixedSessionMode(normalized.mode)],
      thinkingOptions: [],
      settings: [],
    };
    return new OmpHistorySession(
      input.sessionId,
      input.config,
      runtime,
      readTranscript,
      nativeSessionId,
      descriptor.transcriptFile,
      configState,
      redactionValues,
      capabilities.filter((capability) => HISTORY_CAPABILITIES.includes(capability)),
      emit,
      replayTimeoutMs,
      scheduler,
    );
  }

  async publishOpened(requestId: string): Promise<void> {
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities: this.capabilities,
      restoration: "core",
      cwd: this.cwd,
      persistence: { version: 1, data: { sessionId: this.nativeSessionId } },
      ...(this.config.title ? { title: this.dataFilter.text(this.config.title, 256) } : {}),
    });
    this.emit({ type: "session.config", sessionId: this.id, config: this.configState });
    await this.replayHistory();
    this.emit({ type: "session.ready", requestId, sessionId: this.id });
  }

  private async replayHistory(): Promise<void> {
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
      const transcript = await waitForReplay(
        this.readTranscript({
          sessionFile: this.transcriptFile,
          sessionId: this.nativeSessionId,
          cwd: this.cwd,
          signal: replay.signal,
        }),
        replay.signal,
      );
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
      for (const message of transcript.messages) {
        replay.signal.throwIfAborted();
        this.projector.projectReplayMessage(message);
      }
      this.projector.finishReplay();
      await this.subsessions?.replay(transcript.messages, undefined, this.runtime, replay.signal);
      replay.signal.throwIfAborted();
    } catch (error) {
      if (replay.signal.aborted) throw replay.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      this.lifetime.signal.removeEventListener("abort", onAbort);
    }
  }

  openPaseoBrowser(): Promise<void> {
    return Promise.reject(new OmpPublicError(READ_ONLY_MESSAGE));
  }

  setBrowserAuthorizationIssuer(issue: ((url: string) => string | undefined) | null): void {
    this.projector.setBrowserAuthorizationIssuer(issue);
  }

  prompt(input: SessionPromptInput): Promise<void> {
    this.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: READ_ONLY_MESSAGE } },
    });
    return Promise.resolve();
  }

  permission(_input: SessionPermissionInput): Promise<void> {
    return Promise.reject(new OmpPublicError("OMP history sessions have no pending permissions"));
  }

  configure(input: SessionConfigureInput): Promise<void> {
    this.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: READ_ONLY_MESSAGE },
    });
    return Promise.resolve();
  }

  revert(input: SessionRevertInput): Promise<void> {
    this.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: READ_ONLY_MESSAGE },
    });
    return Promise.resolve();
  }

  interrupt(input: SessionInterruptInput): Promise<void> {
    this.emit({ type: "request.completed", requestId: input.requestId });
    return Promise.resolve();
  }

  beginConnectionShutdown(): void {
    this.lifetime.abort(new Error("OMP provider connection closed"));
  }

  abortOpen(): Promise<void> {
    this.dispose();
    return Promise.resolve();
  }

  close(input?: SessionCloseInput): Promise<void> {
    this.dispose();
    if (!this.sessionClosedPublished) {
      this.sessionClosedPublished = true;
      this.emit({ type: "session.closed", sessionId: this.id });
    }
    if (input) this.emit({ type: "request.completed", requestId: input.requestId });
    return Promise.resolve();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new Error("OMP provider session closed"));
    this.subsessions?.close();
    this.projector.close();
  }
}
