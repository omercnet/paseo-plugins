import type { HubProcess } from "../shared/hub";

export type HubProcessTone = "success" | "warning" | "danger" | "muted";

const FAILED_STATES: Record<string, true> = { crashed: true, error: true, failed: true };
const ACTIVE_STATES: Record<string, true> = { ready: true, running: true };
const TERMINAL_STATES: Record<string, true> = { exited: true, stopped: true };

export function hubProcessTone(process: HubProcess): HubProcessTone {
  const state = process.state.toLowerCase();
  if (FAILED_STATES[state] || (process.exitCode !== null && process.exitCode !== 0)) {
    return "danger";
  }
  if (ACTIVE_STATES[state]) return "success";
  if (TERMINAL_STATES[state]) return "muted";
  return "warning";
}

export function summarizeHubProcesses(processes: readonly HubProcess[]): {
  visible: boolean;
  label: string;
} {
  if (processes.length === 0) return { visible: false, label: "Hub" };
  const hasFailure = processes.some((process) => hubProcessTone(process) === "danger");
  return {
    visible: true,
    label: `Hub · ${processes.length}${hasFailure ? " !" : ""}`,
  };
}
