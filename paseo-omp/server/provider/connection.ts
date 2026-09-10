import {
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { discoverOmpCatalog } from "./catalog";
import type { OmpRuntime } from "./omp-rpc";
import { OmpProviderSession } from "./session";
import type { OmpTimelineScheduler } from "./timeline-projector";

function errorDetails(error: unknown, prefix?: string): { message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { message: prefix ? `${prefix}: ${message}` : message };
}

export function createOmpConnection(
  runtime: OmpRuntime,
  capabilities: readonly string[],
  scheduler?: OmpTimelineScheduler,
): ProviderConnection {
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

  const requestFailure = (requestId: string, error: unknown, prefix?: string) => {
    emit({ type: "request.failed", requestId, error: errorDetails(error, prefix) });
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
          requestFailure(input.requestId, new Error(`Session already exists: ${input.sessionId}`));
          return;
        }
        const pending = OmpProviderSession.open(
          input,
          runtime,
          capabilities,
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
              error: { message: `Unknown OMP session: ${input.sessionId}` },
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
          requestFailure(input.requestId, new Error(`Unknown OMP session: ${input.sessionId}`));
          return;
        }
        await session.configure(input);
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId);
        if (!session) {
          requestFailure(input.requestId, new Error(`Unknown OMP session: ${input.sessionId}`));
          return;
        }
        await session.interrupt(input);
        return;
      }
      case "session.close": {
        const session = sessions.get(input.sessionId);
        if (!session) {
          requestFailure(input.requestId, new Error(`Unknown OMP session: ${input.sessionId}`));
          return;
        }
        sessions.delete(input.sessionId);
        await session.close(input);
        return;
      }
      default:
        if ("requestId" in input) {
          requestFailure(input.requestId, new Error(`Unsupported provider input: ${input.type}`));
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
    capabilities,
    async send(input) {
      if (closing || closed) throw new Error("OMP provider connection is closed");
      requireProviderCapabilities(capabilities, input);
      queueMicrotask(() => {
        if (closing || closed) return;
        const operation = dispatch(input).catch((error) => {
          if (input.type === "session.prompt") {
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: errorDetails(error) },
            });
          } else if ("requestId" in input) {
            requestFailure(input.requestId, error);
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
