import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpLoginSchema } from "./omp-accounts";
import { OmpStoreSchema } from "./omp-store";

/** A server name as `omp` lists it. It ends up in a slash command, so it never starts with `-`. */
export const OmpMcpNameSchema = z.string().regex(/^[a-zA-Z0-9_.:][a-zA-Z0-9_.:-]{0,99}$/u);

/** One line of `/mcp list`: `name | transport | state | target [source]`. */
export const OmpMcpServerSchema = z.object({
  name: OmpMcpNameSchema,
  transport: z.string(),
  /** `enabled` or `disabled`, as OMP words it. */
  state: z.string(),
  /** The URL of a remote server, or the command line of a local one. */
  target: z.string(),
  /** Where the definition lives, such as `user` or a tool OMP imported it from. */
  source: z.string(),
});
export type OmpMcpServer = z.infer<typeof OmpMcpServerSchema>;

/** An OAuth authorization in flight; the same steps as an account sign-in. */
export const OmpMcpAuthSchema = OmpLoginSchema.omit({ provider: true }).extend({
  name: OmpMcpNameSchema,
});
export type OmpMcpAuth = z.infer<typeof OmpMcpAuthSchema>;

export const OmpMcpsViewSchema = z.object({
  installed: z.boolean(),
  servers: z.array(OmpMcpServerSchema),
  auths: z.array(OmpMcpAuthSchema),
  error: z.string().nullable(),
});
export type OmpMcpsView = z.infer<typeof OmpMcpsViewSchema>;

export const OMP_MCP_ACTIONS = ["test", "enable", "disable", "remove"] as const;
export const OmpMcpActionSchema = z.enum(OMP_MCP_ACTIONS);
export type OmpMcpAction = z.infer<typeof OmpMcpActionSchema>;

/**
 * A remote server's URL, or the command line OMP starts for a local one. A URL goes after `--url`,
 * so it is a single token; anything after `--` is the command.
 */
export const OmpMcpTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n]+$/u, "Use a single line")
  .refine(
    (target) => !/^https?:\/\//iu.test(target) || /^\S+$/u.test(target),
    "A server URL can't contain spaces",
  );

export const listOmpMcps = defineRpc({
  name: "paseo-omp.list-mcps",
  /** `refresh` asks omp again instead of answering from the last listing. */
  input: z.object({ store: OmpStoreSchema.optional(), refresh: z.boolean().optional() }),
  output: OmpMcpsViewSchema,
});

/** Adds the server to omp's user MCP file with `/mcp add`. `ok` is false when omp reports a failure. */
export const addOmpMcp = defineRpc({
  name: "paseo-omp.add-mcp",
  input: z.object({
    store: OmpStoreSchema.optional(),
    name: OmpMcpNameSchema,
    target: OmpMcpTargetSchema,
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Runs the matching `/mcp` command through omp. `ok` is false when omp reports the command failed. */
export const runOmpMcpAction = defineRpc({
  name: "paseo-omp.run-mcp-action",
  input: z.object({
    store: OmpStoreSchema.optional(),
    name: OmpMcpNameSchema,
    action: OmpMcpActionSchema,
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const startOmpMcpAuth = defineRpc({
  name: "paseo-omp.start-mcp-auth",
  input: z.object({ store: OmpStoreSchema.optional(), name: OmpMcpNameSchema }),
  output: OmpMcpAuthSchema,
});

export const submitOmpMcpAuthCode = defineRpc({
  name: "paseo-omp.submit-mcp-auth-code",
  input: z.object({
    store: OmpStoreSchema.optional(),
    authId: z.string(),
    code: z.string().trim().min(1).max(4096),
  }),
  output: OmpMcpAuthSchema,
});

export const cancelOmpMcpAuth = defineRpc({
  name: "paseo-omp.cancel-mcp-auth",
  input: z.object({ store: OmpStoreSchema.optional(), authId: z.string() }),
  output: OmpMcpAuthSchema.nullable(),
});
