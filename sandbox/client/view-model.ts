import type { CredentialSummary } from "../shared/credentials";
import type { Sandbox } from "../shared/sandbox";

function runningStatus(sandbox: Sandbox) {
  const { host } = sandbox;
  if (host?.status === "error") {
    const sentences = [
      "Running, but Paseo cannot connect to it.",
      host.error,
      "Restart it to retry.",
    ];
    return sentences.filter(Boolean).join(" ");
  }
  if (host?.status === "disabled")
    return "Running, but its host is disabled. Restart it to enable the host again.";
  if (sandbox.stale) return "Running with older credentials. Restart it to apply the new ones.";
  if (host?.status === "online") return "Running. Its project is in the sidebar.";
  if (host?.status === "offline")
    return host.error ? `Running, reconnecting. ${host.error}` : "Running, reconnecting";
  return "Running, connecting";
}

/** One line a person can act on. Work in flight comes first, then a failure, then the state. */
export function describeSandbox(sandbox: Sandbox) {
  if (sandbox.busy) return `${sandbox.busy}...`;
  if (sandbox.error) return `Failed: ${sandbox.error}`;
  if (sandbox.runtime === "stopped") return "Stopped. Its project data is kept.";
  if (sandbox.runtime === "missing") return "Not running. Start it to finish setting up.";
  return runningStatus(sandbox);
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
