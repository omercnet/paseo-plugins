import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One history point every this often, `HISTORY_LENGTH` of them: five minutes in all. */
export const HISTORY_EVERY_MS = 10_000;
export const HISTORY_LENGTH = 30;

const percent = z.number().min(0).max(100);

/** Usage of the daemon host. Percentages are 0-100; `null` means the host cannot report it yet. */
const sample = z.object({
  cpu: percent.nullable(),
  memory: percent.nullable(),
  disk: percent.nullable(),
  /** Disk read plus write throughput in bytes per second. */
  io: z.number().min(0).nullable(),
});

export type Sample = z.infer<typeof sample>;

/** What one agent's whole process tree is costing, including everything its tools launched. */
const session = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  /** CPU in cores: 1.5 means one and a half cores busy, summed over the tree. */
  cores: z.number().min(0),
  /** Resident memory in bytes, summed over the tree. */
  rss: z.number().min(0),
  /** The busiest process in the tree, which is usually what is actually heavy. */
  command: z.string(),
  processes: z.number().int().min(1),
  heavy: z.boolean(),
});

export type Session = z.infer<typeof session>;

const load = z.object({ cores: z.number().min(0), rss: z.number().min(0) });

export const getUsage = defineRpc({
  name: "top.usage",
  input: z.object({}),
  output: sample.extend({
    /** Earlier samples, oldest first, `HISTORY_EVERY_MS` apart, so a fresh client has a timeline. */
    history: z.array(sample).max(HISTORY_LENGTH),
    totalMemory: z.number().positive(),
    /** Busiest first. `null` where the host cannot attribute processes (where the process list cannot be read). */
    sessions: z.array(session).nullable(),
    /**
     * Everything scanned that is not listed in `sessions`: processes of no agent, of other daemons'
     * agents, and of sessions past the list cap. Time spent in the kernel, exited processes and the
     * page cache are not processes, so sessions plus this are not the whole host's usage.
     */
    other: load,
  }),
});
