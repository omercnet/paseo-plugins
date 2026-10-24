import type { HostAdd, HostSummary, HostUpdate } from "@getpaseo/protocol/hosts";
import type { SandboxHosts } from "../server/hosts";

/** The controller's connected-host registry, in memory, with the daemon's conflict rule. */
export class FakeHosts implements SandboxHosts {
  rows: HostSummary[] = [];
  updates: HostUpdate[] = [];
  opened: string[] = [];

  async list() {
    return this.rows;
  }

  async add(input: HostAdd) {
    const key = input.sourceKey ?? input.connection;
    if (this.rows.some((row) => row.source.key === key)) throw new Error("source_conflict");
    const row: HostSummary = {
      registrationId: `reg-${key}`,
      serverId: "srv_box",
      label: input.label ?? null,
      source: { id: "plugin:sandbox", key },
      metadata: input.metadata ?? {},
      enabled: true,
      status: "online",
      targetDescription: "relay",
      lastOnlineAt: null,
      nextRetryAt: null,
      error: null,
    };
    this.rows.push(row);
    return row;
  }

  async update(registrationId: string, patch: HostUpdate) {
    const row = this.rows.find((candidate) => candidate.registrationId === registrationId);
    if (!row) throw new Error("unknown host");
    this.updates.push(patch);
    row.status = "online";
    row.error = null;
    return row;
  }

  async remove(registrationId: string) {
    this.rows = this.rows.filter((row) => row.registrationId !== registrationId);
  }

  async openWorkspace(_serverId: string, cwd: string) {
    this.opened.push(cwd);
  }
}
