import type { CredentialSummary } from "../shared/credentials";
import type { Sandbox } from "../shared/sandbox";

/** One line a person can act on. Work in flight comes first, then a failure, then the state. */
export function describeSandbox(sandbox: Sandbox) {
  if (sandbox.busy) return `${sandbox.busy}...`;
  if (sandbox.error) return `Failed: ${sandbox.error}`;
  if (sandbox.runtime === "stopped") return "Stopped. Its project data is kept.";
  if (sandbox.runtime === "missing") return "Not running. Start it to finish setting up.";
  if (sandbox.stale) return "Running with older credentials. Restart it to apply the new ones.";
  switch (sandbox.host?.status) {
    case "online":
      return "Running. Its project is in the sidebar.";
    case "error":
      return "Running, but Paseo cannot connect to it.";
    case "offline":
      return "Running, reconnecting.";
    default:
      return "Running, connecting.";
  }
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
