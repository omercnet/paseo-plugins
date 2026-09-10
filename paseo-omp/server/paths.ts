import { homedir } from "node:os";

/** Root of omp's per-machine agent state (`agent.db`, `history.db`, `memories/`). */
export function ompAgentDir(): string {
  return process.env.PASEO_OMP_AGENT_DIR ?? `${homedir()}/.omp/agent`;
}
