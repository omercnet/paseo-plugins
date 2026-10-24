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

/** Sends only what changed, so an untouched field is never rewritten or erased. */
export function buildUpdatePatch(host: HostSummary, form: EditForm): Built<HostUpdate> {
  const patch: HostUpdate = {};
  const label = form.label.trim() || null;
  if (label !== host.label) patch.label = label;
  const metadata = parseMetadata(form.metadata);
  if (!metadata.ok) return metadata;
  if (formatMetadata(metadata.value) !== formatMetadata(host.metadata)) {
    patch.metadata = metadata.value;
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

export interface HostDirectoryState {
  directory: HostDirectory | null;
  error: string | null;
  refresh(): Promise<void>;
}

/** Live view of the selected daemon's saved hosts. Resets when the selected host changes. */
export function useHostDirectory(paseo: PaseoApi): HostDirectoryState {
  const [directory, setDirectory] = useState<HostDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDirectory(null);
    setError(null);
    const subscription = paseo.hosts.observe();
    const stop = subscription.subscribe({
      snapshot: (snapshot) => {
        setDirectory(snapshot);
        setError(null);
      },
      update: (message) => {
        const next = directoryFromMessage(message);
        if (next) setDirectory(next);
      },
      error: (cause) => setError(errorMessage(cause)),
    });
    subscription.ready.catch((cause) => setError(errorMessage(cause)));
    return () => {
      stop();
      void subscription.release();
    };
  }, [paseo]);

  const refresh = useCallback(async () => {
    try {
      setDirectory(await paseo.hosts.list());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [paseo]);

  return { directory, error, refresh };
}
