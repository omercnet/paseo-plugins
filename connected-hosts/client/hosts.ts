import type { HostAdd, HostDirectory, HostSummary, HostUpdate, PaseoApi } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { useCallback, useEffect, useState } from "react";

export type Built<T> = { ok: true; value: T } | { ok: false; error: string };

/** Prefers the daemon's `userMessage` over the transport message, which appends request details. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const { userMessage } = error as Error & { userMessage?: unknown };
    return typeof userMessage === "string" && userMessage ? userMessage : error.message;
  }
  return String(error);
}

/** One `key=value` per line. Blank lines are skipped; the value may contain `=`. */
export function parseMetadata(text: string): Built<Record<string, string>> {
  const metadata: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    const key = at < 0 ? "" : line.slice(0, at).trim();
    if (!key) return { ok: false, error: `Metadata line ${index + 1} needs the form key=value.` };
    metadata[key] = line.slice(at + 1).trim();
  }
  return { ok: true, value: metadata };
}

export function formatMetadata(metadata: Record<string, string>): string {
  return Object.keys(metadata)
    .sort()
    .map((key) => `${key}=${metadata[key]}`)
    .join("\n");
}

export interface AddForm {
  connection: string;
  label: string;
  metadata: string;
  sourceKey: string;
}

export function buildAddInput(form: AddForm): Built<HostAdd> {
  const connection = form.connection.trim();
  if (!connection)
    return { ok: false, error: "Enter a connection, such as host:6767 or ssh://user@host." };
  const metadata = parseMetadata(form.metadata);
  if (!metadata.ok) return metadata;
  const input: HostAdd = { connection };
  const label = form.label.trim();
  if (label) input.label = label;
  if (Object.keys(metadata.value).length > 0) input.metadata = metadata.value;
  const sourceKey = form.sourceKey.trim();
  if (sourceKey) input.sourceKey = sourceKey;
  return { ok: true, value: input };
}

export interface EditForm {
  label: string;
  metadata: string;
  /** Write-only: blank leaves the saved connection untouched. */
  connection: string;
  replaceIdentity: boolean;
}

/**
 * Sends only what the user changed. A field still equal to its prefilled text is never parsed or
 * sent, so values the form cannot round-trip (padding, `=` in a key) are not rewritten and a
 * label-only edit never asks for metadata permission.
 */
export function buildUpdatePatch(host: HostSummary, form: EditForm): Built<HostUpdate> {
  const patch: HostUpdate = {};
  if (form.label !== (host.label ?? "")) {
    const label = form.label.trim() || null;
    if (label !== host.label) patch.label = label;
  }
  if (form.metadata !== formatMetadata(host.metadata)) {
    const metadata = parseMetadata(form.metadata);
    if (!metadata.ok) return metadata;
    if (formatMetadata(metadata.value) !== formatMetadata(host.metadata)) {
      patch.metadata = metadata.value;
    }
  }
  const connection = form.connection.trim();
  if (connection) {
    patch.connection = connection;
    if (form.replaceIdentity) patch.replaceIdentity = true;
  }
  return { ok: true, value: patch };
}

export function directoryFromMessage(message: SessionOutboundMessage): HostDirectory | null {
  return message.type === "hosts.changed" ? message.payload.directory : null;
}

export interface DirectoryHandlers {
  onDirectory(directory: HostDirectory): void;
  onError(message: string): void;
}

/**
 * Follows the selected daemon's saved hosts and returns the cleanup. `observe()` throws
 * synchronously when the daemon is offline or too old, so that is reported like any other failure.
 */
export function observeDirectory(paseo: PaseoApi, handlers: DirectoryHandlers): () => void {
  try {
    const subscription = paseo.hosts.observe();
    const stop = subscription.subscribe({
      snapshot: handlers.onDirectory,
      update: (message) => {
        const directory = directoryFromMessage(message);
        if (directory) handlers.onDirectory(directory);
      },
      error: (cause) => handlers.onError(errorMessage(cause)),
    });
    return () => {
      stop();
      void subscription.release();
    };
  } catch (cause) {
    handlers.onError(errorMessage(cause));
    return () => {};
  }
}

export interface HostDirectoryState {
  directory: HostDirectory | null;
  error: string | null;
  /** Subscribes again after a failure. */
  retry(): void;
}

/** Live view of the selected daemon's saved hosts. Resets when the selected host changes. */
export function useHostDirectory(paseo: PaseoApi): HostDirectoryState {
  const [directory, setDirectory] = useState<HostDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setDirectory(null);
    setError(null);
    return observeDirectory(paseo, {
      onDirectory: (next) => {
        setDirectory(next);
        setError(null);
      },
      onError: setError,
    });
  }, [paseo, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { directory, error, retry };
}
