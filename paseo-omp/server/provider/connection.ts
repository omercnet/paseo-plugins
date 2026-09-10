import {
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  ProviderInputSchema,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { discoverOmpCatalog } from "./catalog";
import type { OmpRuntime } from "./omp-rpc";
import { boundedJsonBytes, OmpPublicError, utf8Bytes } from "./security";
import { OmpProviderSession } from "./session";
import type { OmpTimelineScheduler } from "./timeline-projector";

const SUPPORTED_CAPABILITIES: Readonly<Record<string, true>> = {
  "prompt.message": true,
  "prompt.steer": true,
  "session.configure": true,
};
const SUPPORTED_INPUTS: Readonly<Record<string, true>> = {
  catalog: true,
  "session.open": true,
  "session.prompt": true,
  "session.configure": true,
  "session.permission": true,
  "session.interrupt": true,
  "session.close": true,
};
const MAX_CONNECTION_SESSIONS = 32;
const MAX_ACTIVE_OPERATIONS = 128;
const MAX_PROVIDER_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_NESTED_OPTION_BYTES = 256 * 1024;

function hasOwnEntries(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const key in value) {
    if (Object.hasOwn(value, key)) return true;
  }
  return false;
}

function preflightProviderInput(input: unknown): void {
  if (!input || typeof input !== "object") throw new OmpPublicError("Invalid provider request");
  const record = input as Record<string, unknown>;
  if (boundedJsonBytes(record, MAX_PROVIDER_INPUT_BYTES, 512) === Number.POSITIVE_INFINITY) {
    throw new OmpPublicError("Provider request is too large");
  }
  if (record.type === "session.open") {
    if (
      record.persistence !== undefined &&
      boundedJsonBytes(record.persistence, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("Session persistence input is too large");
    }
    if (record.persistence !== undefined) {
      throw new OmpPublicError("OMP Plugin Preview does not support session persistence");
    }
    const config = record.config as Record<string, unknown> | undefined;
    for (const value of [config?.mcpServers, config?.providerOptions, config?.settings]) {
      if (
        value !== undefined &&
        boundedJsonBytes(value, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
      ) {
        throw new OmpPublicError("Session configuration is too large");
      }
    }
    if (hasOwnEntries(config?.mcpServers)) {
      throw new OmpPublicError("OMP Plugin Preview does not support host MCP servers");
    }
    if (config?.toolPolicy !== undefined) {
      throw new OmpPublicError("OMP Plugin Preview does not support host tool policies");
    }
    if (hasOwnEntries(config?.providerOptions) || hasOwnEntries(config?.settings)) {
      throw new OmpPublicError("OMP Plugin Preview does not support provider options");
    }
  }
  if (record.type === "session.prompt") {
    const prompt = record.prompt as Record<string, unknown> | undefined;
    if (
      prompt?.outputSchema !== undefined &&
      boundedJsonBytes(prompt.outputSchema, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("Prompt output schema is too large");
    }
    if (prompt?.outputSchema !== undefined || prompt?.clearPendingPermissions === true) {
      throw new OmpPublicError("OMP does not support structured output or permission controls");
    }
  }
  if (record.type === "session.permission") {
    const response = record.response as Record<string, unknown> | undefined;
    if (
      response !== undefined &&
      boundedJsonBytes(response, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("Permission response is too large");
    }
  }
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function validateInputEnvelope(input: unknown): asserts input is ProviderInput {
  if (!input || typeof input !== "object") throw new OmpPublicError("Invalid provider request");
  const record = input as Record<string, unknown>;
  if (typeof record.type !== "string" || !SUPPORTED_INPUTS[record.type]) {
    throw new OmpPublicError("Unsupported provider request");
  }
  if (record.type === "catalog") {
    if (!isBoundedIdentifier(record.requestId))
      throw new OmpPublicError("Invalid provider request");
    if (
      record.cwd !== undefined &&
      (typeof record.cwd !== "string" || utf8Bytes(record.cwd) > 4_096 || record.cwd.includes("\0"))
    ) {
      throw new OmpPublicError("Invalid provider request");
    }
    return;
  }
  if (!isBoundedIdentifier(record.sessionId)) throw new OmpPublicError("Invalid provider request");
  if (record.type === "session.prompt") {
    if (!record.prompt || typeof record.prompt !== "object") {
      throw new OmpPublicError("Invalid provider request");
    }
    const prompt = record.prompt as Record<string, unknown>;
    if (!isBoundedIdentifier(prompt.clientMessageId)) {
      throw new OmpPublicError("Invalid provider request");
    }
    if (prompt.delivery !== "auto" && prompt.delivery !== "steer") {
      throw new OmpPublicError("Invalid provider request");
    }
    return;
  }
  if (record.type === "session.permission") {
    if (
      !isBoundedIdentifier(record.permissionId) ||
      !record.response ||
      typeof record.response !== "object"
    ) {
      throw new OmpPublicError("Invalid permission response");
    }
    const response = record.response as Record<string, unknown>;
    if (
      response.selectedActionId !== undefined &&
      !isBoundedIdentifier(response.selectedActionId)
    ) {
      throw new OmpPublicError("Invalid permission response");
    }
    if (Array.isArray(response.updatedPermissions) && response.updatedPermissions.length > 64) {
      throw new OmpPublicError("Invalid permission response");
    }
    return;
  }
  if (!isBoundedIdentifier(record.requestId)) throw new OmpPublicError("Invalid provider request");
  if (record.type === "session.open" && (!record.config || typeof record.config !== "object")) {
    throw new OmpPublicError("Invalid provider request");
  }
  if (
    record.type === "session.configure" &&
    (!record.changes || typeof record.changes !== "object")
  ) {
    throw new OmpPublicError("Invalid provider request");
  }
}

function errorDetails(error: unknown, fallback: string): { message: string } {
  return { message: error instanceof OmpPublicError ? error.message : fallback };
}

export function createOmpConnection(
  runtime: OmpRuntime,
  capabilities: readonly string[],
  scheduler?: OmpTimelineScheduler,
): ProviderConnection {
  const safeCapabilities = [...new Set(capabilities)].filter(
    (capability) => SUPPORTED_CAPABILITIES[capability],
  );
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, { token: symbol; session: OmpProviderSession }>();
  const opening = new Map<string, { token: symbol; promise: Promise<OmpProviderSession> }>();
  const shutdown = new AbortController();
  const activeOperations = new Set<Promise<void>>();
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const requestFailure = (
    requestId: string,
    error: unknown,
    fallback = "OMP provider request failed",
  ) => {
    emit({ type: "request.failed", requestId, error: errorDetails(error, fallback) });
  };

  const dispatch = async (input: ProviderInput): Promise<void> => {
    switch (input.type) {
      case "catalog":
        try {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: await discoverOmpCatalog(runtime, input.cwd, shutdown.signal),
          });
        } catch (error) {
          if (!closing) requestFailure(input.requestId, error, "OMP catalog discovery failed");
        }
        return;
      case "session.open": {
        if (sessions.has(input.sessionId) || opening.has(input.sessionId)) {
          requestFailure(input.requestId, new OmpPublicError("OMP session already exists"));
          return;
        }
        if (sessions.size + opening.size >= MAX_CONNECTION_SESSIONS) {
          requestFailure(input.requestId, new OmpPublicError("OMP session limit reached"));
          return;
        }
        const token = Symbol(input.sessionId);
        const sessionEmit = (event: ProviderEvent) => {
          if (
            opening.get(input.sessionId)?.token !== token &&
            sessions.get(input.sessionId)?.token !== token
          ) {
            return;
          }
          emit(event);
        };
        const pending = OmpProviderSession.open(
          input,
          runtime,
          safeCapabilities,
          sessionEmit,
          scheduler,
          shutdown.signal,
        );
        opening.set(input.sessionId, { token, promise: pending });
        try {
          const session = await pending;
          if (closing || opening.get(input.sessionId)?.token !== token) {
            await session.close();
            return;
          }
          sessions.set(input.sessionId, { token, session });
          session.publishOpened(input.requestId);
        } catch (error) {
          if (opening.get(input.sessionId)?.token === token) {
            const details = errorDetails(error, "OMP session failed to open");
            emit({ type: "request.failed", requestId: input.requestId, error: details });
            emit({ type: "session.closed", sessionId: input.sessionId, error: details });
          }
        } finally {
          if (opening.get(input.sessionId)?.token === token) opening.delete(input.sessionId);
          if (!sessions.has(input.sessionId)) opening.delete(input.sessionId);
        }
        return;
      }
      case "session.prompt": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: {
              type: "failed",
              error: { message: "Unknown OMP session" },
            },
          });
          return;
        }
        await session.prompt(input);
        return;
      }
      case "session.configure": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.configure(input);
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.interrupt(input);
        return;
      }
      case "session.close": {
        const slot = sessions.get(input.sessionId);
        if (!slot) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        try {
          await slot.session.close();
        } catch {
          throw new OmpPublicError("OMP session close failed");
        }
        if (sessions.get(input.sessionId)?.token === slot.token) sessions.delete(input.sessionId);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default:
        if ("requestId" in input) {
          requestFailure(input.requestId, new OmpPublicError("Unsupported provider request"));
        }
    }
  };

  const disposeConnection = async (): Promise<void> => {
    closing = true;
    shutdown.abort(new Error("OMP provider connection closed"));
    const sessionClosures = Promise.allSettled(
      [...sessions.values()].map(({ session }) => session.close()),
    );
    await Promise.all([Promise.all(activeOperations), sessionClosures]);
    const pending = await Promise.allSettled([...opening.values()].map((slot) => slot.promise));
    const orphanClosures: Promise<void>[] = [];
    for (const result of pending) {
      if (result.status === "fulfilled" && !sessions.has(result.value.id)) {
        orphanClosures.push(result.value.close());
      }
    }
    await Promise.allSettled(orphanClosures);
    sessions.clear();
    listeners.clear();
    closed = true;
  };
  return {
    version: 1,
    capabilities: safeCapabilities,
    async send(input) {
      if (closing || closed) throw new Error("OMP provider connection is closed");
      if (activeOperations.size >= MAX_ACTIVE_OPERATIONS) {
        throw new OmpPublicError("OMP provider is busy");
      }
      try {
        preflightProviderInput(input);
        const parsed = ProviderInputSchema.safeParse(input);
        if (!parsed.success) throw new OmpPublicError("Invalid provider request");
        input = parsed.data;
        validateInputEnvelope(input);
        requireProviderCapabilities(safeCapabilities, input);
      } catch (error) {
        const raw = input as unknown;
        if (raw && typeof raw === "object") {
          const record = raw as Record<string, unknown>;
          if (record.type === "session.prompt" && isBoundedIdentifier(record.sessionId)) {
            const prompt = record.prompt;
            if (prompt && typeof prompt === "object") {
              const clientMessageId = (prompt as Record<string, unknown>).clientMessageId;
              if (isBoundedIdentifier(clientMessageId)) {
                emit({
                  type: "session.prompt_result",
                  sessionId: record.sessionId,
                  clientMessageId,
                  result: { type: "failed", error: errorDetails(error, "OMP prompt failed") },
                });
                return;
              }
            }
          }
          if (isBoundedIdentifier(record.requestId)) {
            requestFailure(record.requestId, error, "OMP provider request failed");
            return;
          }
        }
        throw error;
      }
      const operation = Promise.resolve()
        .then(async () => {
          if (closing || closed) return;
          await dispatch(input);
        })
        .catch((error) => {
          if (input.type === "session.prompt") {
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: errorDetails(error, "OMP prompt failed") },
            });
          } else if ("requestId" in input) {
            requestFailure(input.requestId, error, "OMP provider request failed");
          }
        });
      activeOperations.add(operation);
      void operation.finally(() => activeOperations.delete(operation));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closePromise ??= disposeConnection();
      return closePromise;
    },
  };
}
