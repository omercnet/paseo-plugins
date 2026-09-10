import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Health/compatibility facts about the omp CLI itself, surfaced on the global OMP page. This is
// an explicit allowlist, not a passthrough: every field is either a resolved filesystem path, a
// boolean presence check, or a version string parsed out of a bounded subprocess probe. Raw
// stdout/stderr, environment variables, config file text, and arbitrary provider diagnostics
// never cross this boundary — see server/provider-diagnostics.ts for the redaction boundary.

/** Outcome of the bounded `omp --version` probe. Mirrors the four states callers must handle. */
export const OmpVersionStatusSchema = z.enum(["ok", "not-found", "timeout", "malformed"]);
export type OmpVersionStatus = z.infer<typeof OmpVersionStatusSchema>;

// Mirrors OmpMemorySectionSchema.backend in shared/omp-config.ts. Duplicated as a literal rather
// than imported so this module's wire contract does not shift silently if that schema changes.
const MemoryBackendSchema = z.enum(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);

export const OmpProviderHealthSchema = z.object({
  binary: z.object({
    /** Whether an executable file was found (env override or PATH), independent of a working
     * `--version`. */
    installed: z.boolean(),
    /** Absolute resolved path, or null when nothing executable was found. Metadata only. */
    resolvedPath: z.string().nullable(),
    /** Parsed semver-like substring from `--version` output; never the raw stdout line. */
    version: z.string().nullable(),
    versionStatus: OmpVersionStatusSchema,
  }),
  rpcUi: z.object({
    /** False when the binary was unavailable, so the probe was never attempted. */
    checked: z.boolean(),
    /** Null when checked but the probe itself failed (timeout/error), not merely unsupported. */
    supported: z.boolean().nullable(),
  }),
  roots: z.object({
    agentRoot: z.string(),
    configPath: z.string(),
    configAvailable: z.boolean(),
    sessionRoot: z.string(),
    sessionRootAvailable: z.boolean(),
  }),
  databases: z.object({
    agentDbPresent: z.boolean(),
    historyDbPresent: z.boolean(),
  }),
  memoryBackend: MemoryBackendSchema.nullable(),
  checkedAt: z.string(),
});
export type OmpProviderHealth = z.infer<typeof OmpProviderHealthSchema>;

export const getOmpProviderHealth = defineRpc({
  name: "paseo-omp.get-provider-health",
  input: z.object({}),
  output: OmpProviderHealthSchema,
});
