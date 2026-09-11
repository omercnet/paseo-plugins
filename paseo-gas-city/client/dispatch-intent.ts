import { useSyncExternalStore } from "react";
import { parseSlingArguments, type SlingArguments } from "./view-model";

export interface SlingIntent extends SlingArguments {
  id: number;
  parseError: string | null;
}

const intents = new Map<string, SlingIntent>();
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const listener of listeners) listener();
}

export function queueSlingIntent(workspaceId: string, args: string): SlingIntent {
  const parsed = parseSlingArguments(args);
  const intent: SlingIntent = {
    id: nextId++,
    beadId: parsed?.beadId ?? "",
    agent: parsed?.agent ?? "",
    parseError: parsed
      ? null
      : "Use /sling <bead-id> [agent-role]. Quote roles that contain spaces.",
  };
  intents.set(workspaceId, intent);
  emit();
  return intent;
}

export function getSlingIntent(workspaceId: string): SlingIntent | null {
  return intents.get(workspaceId) ?? null;
}

export function dismissSlingIntent(workspaceId: string, id: number): void {
  if (intents.get(workspaceId)?.id !== id) return;
  intents.delete(workspaceId);
  emit();
}

export function subscribeSlingIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSlingIntent(workspaceId: string): SlingIntent | null {
  return useSyncExternalStore(
    subscribeSlingIntent,
    () => getSlingIntent(workspaceId),
    () => null,
  );
}
