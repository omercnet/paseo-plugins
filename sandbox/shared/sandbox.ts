import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const hostStatusSchema = z.enum(["error", "connecting", "online", "offline", "disabled"]);

export const sandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string().nullable(),
  createdAt: z.string(),
  runtime: z.enum(["running", "stopped", "missing"]),
  /** The connected host Paseo shows in its sidebar, once the sandbox registered one. */
  host: z
    .object({
      status: hostStatusSchema,
      serverId: z.string().nullable(),
      /** The daemon's own explanation for a failed connection. */
      error: z.string().nullable(),
    })
    .nullable(),
  /** Running with older credentials than the ones saved now. Restart to apply. */
  stale: z.boolean(),
  /** Plain-words description of the operation in flight. */
  busy: z.string().nullable(),
  /** The last operation's failure, until the next one starts. */
  error: z.string().nullable(),
});
export type Sandbox = z.infer<typeof sandboxSchema>;

const sandboxList = z.object({
  runtime: z.object({ available: z.boolean(), problem: z.string().nullable() }),
  sandboxes: z.array(sandboxSchema),
});
const idInput = z.object({ id: z.string().min(1) });

export const listSandboxes = defineRpc({
  name: "sandbox.list",
  input: z.object({}),
  output: sandboxList,
});

/**
 * Starts provisioning and answers at once; progress and failure arrive through
 * `sandbox.list` as `busy` and `error`. `repoUrl` is an https URL or `owner/repo` on GitHub.
 */
export const createSandbox = defineRpc({
  name: "sandbox.create",
  input: z.object({
    name: z.string().trim().min(1).max(64),
    repoUrl: z.string().trim().min(1).max(512),
  }),
  output: z.object({ id: z.string() }),
});

export const startSandbox = defineRpc({
  name: "sandbox.start",
  input: idInput,
  output: z.object({}),
});

export const stopSandbox = defineRpc({
  name: "sandbox.stop",
  input: idInput,
  output: z.object({}),
});

/** Deletes the sandbox and everything stored in it. */
export const removeSandbox = defineRpc({
  name: "sandbox.remove",
  input: idInput,
  output: z.object({}),
});
