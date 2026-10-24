import type { CredentialSummary } from "../shared/credentials";
import type { Sandbox } from "../shared/sandbox";

/** One line a person can act on. Work in flight comes first, then a failure, then the state. */
export function describeSandbox(sandbox: Sandbox) {
  if (sandbox.busy) return `${sandbox.busy}...`;
  if (sandbox.error) return `Failed: ${sandbox.error}`;
  if (sandbox.runtime === "stopped") return "Stopped. Its project data is kept.";
  if (sandbox.runtime === "missing") return "Not running. Start it to finish setting up.";
  const reason = sandbox.host?.error ? ` ${sandbox.host.error}` : "";
  switch (sandbox.host?.status) {
    case "error":
      return `Running, but Paseo cannot connect to it.${reason} Restart it to retry.`;
    case "disabled":
      return "Running, but its host is disabled. Restart it to enable the host again.";
    default:
      break;
  }
  if (sandbox.stale) return "Running with older credentials. Restart it to apply the new ones.";
  switch (sandbox.host?.status) {
    case "online":
      return "Running. Its project is in the sidebar.";
    case "offline":
      return `Running, reconnecting.${reason}`;
    default:
      return "Running, connecting.";
  }
}

/** A running sandbox that Restart would fix: older credentials or a host that is not working. */
export function needsRestart(sandbox: Sandbox) {
  return (
    sandbox.runtime === "running" &&
    (sandbox.stale || sandbox.host?.status === "error" || sandbox.host?.status === "disabled")
  );
}

export function repositoryName(repo: string) {
  return (
    repo
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split("/")
      .at(-1) ?? ""
  );
}

export function hasModelCredential(credentials: readonly CredentialSummary[] | undefined) {
  return credentials?.some((entry) => entry.kind === "model") ?? false;
}
