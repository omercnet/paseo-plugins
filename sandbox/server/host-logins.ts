import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostLoginId } from "../shared/credentials";
import { credentialValueSchema } from "../shared/credentials";
import type { HostMount } from "./provider";

/** The `paseo` user in runtime/Dockerfile. It must be able to write what it is given. */
const SANDBOX_UID = 1000;

interface HostLoginFolder {
  /** Where the host keeps it. Honors the variable the tool itself honors. */
  source(env: NodeJS.ProcessEnv): string;
  /** Where the sandbox's tool looks, set by the runtime image. */
  target: string;
  /**
   * Files and folders the host's agent would run or obey at its next start. The sandbox gets them
   * read-only, so a compromised sandbox cannot plant a hook that runs on the host. This is a
   * best-effort list of known entries, not a boundary: the folder as a whole is still writable.
   */
  protect: readonly string[];
}

const FOLDERS: Record<Exclude<HostLoginId, "github">, HostLoginFolder> = {
  claude: {
    source: (env) => env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
    target: "/home/paseo/.claude",
    protect: [
      "settings.json",
      "settings.local.json",
      "CLAUDE.md",
      "hooks",
      "plugins",
      "skills",
      "commands",
      "agents",
    ],
  },
  codex: {
    source: (env) => env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    target: "/home/paseo/.codex",
    protect: ["config.toml", "hooks.json", "AGENTS.md", "prompts", "skills"],
  },
  opencode: {
    source: (env) =>
      join(env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode"),
    target: "/home/paseo/.local/share/opencode",
    protect: [],
  },
};

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
}

interface HostMountRequest {
  enabled: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sandboxUid?: number;
}

/** The mounts for the shared logins, or an error saying exactly what to fix on this host. */
export async function hostLoginMounts({
  enabled,
  env = process.env,
  platform = process.platform,
  sandboxUid = SANDBOX_UID,
}: HostMountRequest): Promise<HostMount[]> {
  const requested = Object.entries(FOLDERS).filter(([id]) => enabled.includes(id));
  if (requested.length === 0) return [];
  if (platform !== "linux")
    throw new Error(
      "Sharing this host's agent logins is supported on Linux hosts only. Turn it off in Sandbox settings.",
    );
  const mounts: HostMount[] = [];
  for (const [id, folder] of requested) {
    const source = folder.source(env);
    // Docker splits a --mount value on commas and honors quotes, so such a path would be misread.
    if (/[,"]/.test(source))
      throw new Error(
        `Cannot share the ${id} login: ${source} contains a comma or quote, which a Docker mount cannot carry.`,
      );
    const info = await stat(source).catch((error: unknown) => {
      if (isMissing(error))
        throw new Error(
          `Cannot share the ${id} login: ${source} does not exist on this host. Sign in with ${id} here first, or turn it off in Sandbox settings.`,
        );
      throw error;
    });
    // Sandbox agents run as one fixed uid. A folder they cannot write would fail at the first token refresh.
    if (info.uid !== sandboxUid && (info.mode & 0o002) === 0)
      throw new Error(
        `Cannot share the ${id} login: ${source} is owned by uid ${info.uid}, but sandbox agents run as uid ${sandboxUid} and could not refresh the login.`,
      );
    mounts.push({ source, target: folder.target, readOnly: false });
    for (const entry of folder.protect) {
      const path = join(source, entry);
      if (await exists(path))
        mounts.push({ source: path, target: join(folder.target, entry), readOnly: true });
    }
  }
  return mounts;
}

/** Runs `gh` on the host and resolves with stdout. Injected so tests need no real GitHub login. */
export type RunGh = (args: readonly string[]) => Promise<string>;

const runGh: RunGh = (args) =>
  new Promise((resolve, reject) => {
    execFile("gh", [...args], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
  });

/**
 * The host's GitHub token. A `gh` login is a long-lived token that is not rotated by use, so it
 * can be handed over as a value, unlike the Claude and Codex logins that are shared as files.
 */
export async function hostGithubToken(run: RunGh = runGh): Promise<string> {
  let output: string;
  try {
    output = await run(["auth", "token", "--hostname", "github.com"]);
  } catch (error) {
    if (isMissing(error))
      throw new Error(
        "Cannot share the GitHub login: the GitHub CLI (gh) is not installed on this host. Install it and run `gh auth login`, or turn it off in Sandbox settings.",
      );
    throw new Error(
      "Cannot share the GitHub login: gh is not signed in to github.com on this host. Run `gh auth login`, or turn it off in Sandbox settings.",
    );
  }
  const token = output.trim();
  if (!credentialValueSchema.safeParse(token).success)
    throw new Error("Cannot share the GitHub login: `gh auth token` returned no usable token.");
  return token;
}
