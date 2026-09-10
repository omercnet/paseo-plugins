import {
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  ProviderInputSchema,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { discoverOmpCatalog } from "./catalog";
import type { OmpRuntime } from "./omp-rpc";
import { OmpProviderSession } from "./session";
import type { OmpTimelineScheduler } from "./timeline-projector";
import { OmpPublicError } from "./security";

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
    if (!isBoundedIdentifier(record.requestId)) throw new OmpPublicError("Invalid provider request");
    if (
      record.cwd !== undefined &&
      (typeof record.cwd !== "string" || record.cwd.length > 4_096 || record.cwd.includes("\0"))
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
    if (!isBoundedIdentifier(record.permissionId) || !record.response || typeof record.response !== "object") {
      throw new OmpPublicError("Invalid permission response");
    }
    const response = record.response as Record<string, unknown>;
    if (response.selectedActionId !== undefined && !isBoundedIdentifier(response.selectedActionId)) {
      throw new OmpPublicError("Invalid permission response");
    }
    if (Array.isArray(response.updatedPermissions) && response.updatedPermissions.length > 64) {
      throw new OmpPublicError("Invalid permission response");
    }
    if (JSON.stringify(response).length > 256 * 1024) {
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
  const sessions = new Map<string, OmpProviderSession>();
  const opening = new Map<string, Promise<OmpProviderSession>>();
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
        const pending = OmpProviderSession.open(
          input,
          runtime,
          safeCapabilities,
          emit,
          scheduler,
          shutdown.signal,
        );
        opening.set(input.sessionId, pending);
        try {
          const session = await pending;
          if (closing) {
            await session.close();
            return;
          }
          sessions.set(input.sessionId, session);
          session.publishOpened(input.requestId);
        } catch (error) {
          const details = errorDetails(error, "OMP session failed to open");
          emit({ type: "request.failed", requestId: input.requestId, error: details });
          emit({ type: "session.closed", sessionId: input.sessionId, error: details });
        } finally {
          opening.delete(input.sessionId);
        }
        return;
      }
      case "session.prompt": {
        const session = sessions.get(input.sessionId);
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
        const session = sessions.get(input.sessionId);
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.configure(input);
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId);
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.interrupt(input);
        return;
      }
      case "session.close": {
        const session = sessions.get(input.sessionId);
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        sessions.delete(input.sessionId);
        await session.close(input);
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
    const sessionClosures = Promise.all([...sessions.values()].map((session) => session.close()));
    await Promise.all([Promise.all(activeOperations), sessionClosures]);
    const pending = await Promise.allSettled(opening.values());
    for (const result of pending) {
      if (result.status === "fulfilled" && !sessions.has(result.value.id)) {
        await result.value.close();
      }
    }
    sessions.clear();
    listeners.clear();
    closed = true;
  };

  return {
    version: 1,
    capabilities: safeCapabilities,
    async send(input) {
      if (closing || closed) throw new Error("OMP provider connection is closed");
      const parsed = ProviderInputSchema.safeParse(input);
      if (!parsed.success) throw new OmpPublicError("Invalid provider request");
      input = parsed.data;
      validateInputEnvelope(input);
      requireProviderCapabilities(safeCapabilities, input);
      queueMicrotask(() => {
        if (closing || closed) return;
        const operation = dispatch(input).catch((error) => {
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
      });
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
