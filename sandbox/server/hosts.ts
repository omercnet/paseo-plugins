import type { HostAdd, HostSummary, HostUpdate } from "@getpaseo/protocol/hosts";

/** The slice of the daemon's `paseo.hosts` that the plugin uses. */
export interface HostsClient {
  list(): Promise<{ hosts: HostSummary[] }>;
  add(input: HostAdd): Promise<HostSummary>;
  update(registrationId: string, patch: HostUpdate): Promise<HostSummary>;
  remove(registrationId: string): Promise<void>;
  client(serverId: string): Promise<{
    workspaces: { open(input: { cwd: string }): Promise<unknown> };
    dispose(): Promise<void>;
  }>;
}

/** What sandbox provisioning needs from connected hosts, so tests can supply an in-memory one. */
export interface SandboxHosts {
  list(): Promise<HostSummary[]>;
  add(input: HostAdd): Promise<HostSummary>;
  update(registrationId: string, patch: HostUpdate): Promise<HostSummary>;
  remove(registrationId: string): Promise<void>;
  /** Opens `cwd` as a workspace on the host with `serverId`, which registers its project there. */
  openWorkspace(serverId: string, cwd: string): Promise<void>;
}

export function sandboxHosts(hosts: HostsClient): SandboxHosts {
  return {
    async list() {
      return (await hosts.list()).hosts;
    },
    add: (input) => hosts.add(input),
    update: (registrationId, patch) => hosts.update(registrationId, patch),
    remove: (registrationId) => hosts.remove(registrationId),
    async openWorkspace(serverId, cwd) {
      const remote = await hosts.client(serverId);
      try {
        await remote.workspaces.open({ cwd });
      } finally {
        await remote.dispose();
      }
    },
  };
}
