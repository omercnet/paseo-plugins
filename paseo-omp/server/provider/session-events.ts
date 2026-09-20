import type { OmpRpcEvent } from "./omp-rpc-protocol";

export function isNativeTurnActivity(event: OmpRpcEvent): boolean {
  if (
    event.type === "agent_start" ||
    event.type === "turn_start" ||
    event.type === "turn_end" ||
    event.type === "agent_end" ||
    event.type === "auto_compaction_start" ||
    event.type === "auto_compaction_end"
  ) {
    return true;
  }
  if (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  ) {
    return event.message.role === "assistant";
  }
  return event.type.startsWith("tool_execution_");
}
export function isRuntimeConfigEvent(event: OmpRpcEvent): boolean {
  return (
    event.type === "model_changed" ||
    event.type === "thinking_level_changed" ||
    event.type === "retry_fallback_applied" ||
    event.type === "retry_fallback_succeeded"
  );
}

export function isPassiveUiMethod(method: string): boolean {
  return (
    method === "cancel" ||
    method === "notify" ||
    method === "open_url" ||
    method === "setStatus" ||
    method === "setWidget" ||
    method === "setTitle" ||
    method === "set_editor_text"
  );
}
