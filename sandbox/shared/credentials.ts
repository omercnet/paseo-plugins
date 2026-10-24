import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Credentials the runtime knows how to use. Anything else is a custom environment variable.
 * `login` hands the value to the agent CLI on stdin instead of the environment, for CLIs whose
 * daemon-side protocol ignores the variable; `logout` clears what `login` stored.
 */
export const CREDENTIAL_PRESETS = [
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude subscription token",
    hint: "Run `claude setup-token` once on any machine. Needs a Pro, Max, Team or Enterprise plan. Valid for one year.",
    kind: "model",
    lifetimeDays: 365,
  },
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    hint: "A Claude Console key. Billed per token.",
    kind: "model",
    lifetimeDays: null,
  },
  {
    name: "CODEX_API_KEY",
    label: "OpenAI API key for Codex",
    hint: "An OpenAI Platform key. Codex ignores OPENAI_API_KEY, so the sandbox signs Codex in with it.",
    kind: "model",
    lifetimeDays: null,
    login: ["codex", "login", "--with-api-key"],
    logout: ["sh", "-c", 'test ! -f "$CODEX_HOME/auth.json" || codex logout'],
  },
  {
    name: "OPENAI_API_KEY",
    label: "OpenAI API key for OpenCode",
    hint: "An OpenAI Platform key for OpenCode models.",
    kind: "model",
    lifetimeDays: null,
  },
  {
    name: "GITHUB_TOKEN",
    label: "GitHub token",
    hint: "A fine-grained personal access token with read access to the repositories you clone. Used for git over https on github.com.",
    kind: "git",
    lifetimeDays: null,
  },
] as const;

export type CredentialKind = (typeof CREDENTIAL_PRESETS)[number]["kind"] | "other";

const RESERVED = /^(PASEO_|DOCKER_|LD_|BASH_|NODE_)|^(PATH|HOME|USER|SHELL|ENV|IFS|PWD)$/;

/** An environment variable name that cannot override how the sandbox itself runs. */
export const credentialNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use upper case letters, digits and underscores")
  .refine((name) => !RESERVED.test(name), "That name is reserved by the sandbox runtime");

/** One line, so it cannot smuggle a second variable into the container environment. */
export const credentialValueSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !/[\r\n\0]/.test(value), "Use a single line without control characters");

export const credentialSummarySchema = z.object({
  name: z.string(),
  label: z.string(),
  kind: z.enum(["model", "git", "other"]),
  savedAt: z.string(),
  /** Only when the provider documents a lifetime. Never a guess. */
  expiresAt: z.string().nullable(),
});
export type CredentialSummary = z.infer<typeof credentialSummarySchema>;

const listOutput = z.object({ credentials: z.array(credentialSummarySchema) });

/** Names and dates only. Values never leave the daemon. */
export const listCredentials = defineRpc({
  name: "sandbox.credentials.list",
  input: z.object({}),
  output: listOutput,
});

/** Write-only: replaces any value already saved under `name`. */
export const setCredential = defineRpc({
  name: "sandbox.credentials.set",
  input: z.object({ name: credentialNameSchema, value: credentialValueSchema }),
  output: listOutput,
});

export const removeCredential = defineRpc({
  name: "sandbox.credentials.remove",
  input: z.object({ name: credentialNameSchema }),
  output: listOutput,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = 30;

/** Plain words for a saved credential, with an actionable line once it nears its end of life. */
export function credentialNotice(summary: CredentialSummary | undefined, now = Date.now()) {
  if (!summary) return { hint: "Not set", warning: null };
  const hint = `Saved ${new Date(summary.savedAt).toLocaleDateString()}. Enter a new value to replace it.`;
  if (!summary.expiresAt) return { hint, warning: null };
  const left = Math.ceil((Date.parse(summary.expiresAt) - now) / DAY_MS);
  if (left > WARN_DAYS) return { hint, warning: null };
  const fix = "Generate a new one and save it here, then restart the sandboxes.";
  return { hint, warning: left <= 0 ? `Expired. ${fix}` : `Expires in ${left} days. ${fix}` };
}
