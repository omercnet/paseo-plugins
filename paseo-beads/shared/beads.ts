import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BEADS_LIMITS = {
  issueList: 500,
  rawIssueList: 501,
  globalReadyIds: 25_000,
  identifier: 256,
  title: 4_096,
  statusOrType: 128,
  assignee: 512,
  label: 256,
  labels: 128,
  body: 262_144,
  relationships: 2_000,
  publicMessage: 512,
  timestamp: 64,
} as const;

const identifierSchema = z.string().max(BEADS_LIMITS.identifier);
const titleSchema = z.string().max(BEADS_LIMITS.title);
const statusOrTypeSchema = z.string().max(BEADS_LIMITS.statusOrType);
const timestampSchema = z.string().max(BEADS_LIMITS.timestamp).datetime();

export const BeadDependencySchema = z.object({
  id: identifierSchema,
  title: titleSchema,
  status: statusOrTypeSchema,
  issueType: statusOrTypeSchema,
  dependencyType: statusOrTypeSchema,
});

export const BeadSummarySchema = z.object({
  id: identifierSchema,
  title: titleSchema,
  status: statusOrTypeSchema,
  priority: z.number().int().min(0).max(4),
  issueType: statusOrTypeSchema,
  assignee: z.string().max(BEADS_LIMITS.assignee).nullable(),
  labels: z.array(z.string().max(BEADS_LIMITS.label)).max(BEADS_LIMITS.labels),
  parent: identifierSchema.nullable(),
  updatedAt: timestampSchema.nullable(),
  dependencyCount: z.number().int().nonnegative(),
  dependentCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  isReady: z.boolean(),
  isBlocked: z.boolean(),
});

export const BeadDetailSchema = BeadSummarySchema.extend({
  description: z.string().max(BEADS_LIMITS.body).nullable(),
  acceptanceCriteria: z.string().max(BEADS_LIMITS.body).nullable(),
  design: z.string().max(BEADS_LIMITS.body).nullable(),
  notes: z.string().max(BEADS_LIMITS.body).nullable(),
  dependencies: z.array(BeadDependencySchema).max(BEADS_LIMITS.relationships),
  dependents: z.array(BeadDependencySchema).max(BEADS_LIMITS.relationships),
});

export const BeadsSnapshotSchema = z.object({
  state: z.enum(["ready", "not_initialized", "bd_unavailable"]),
  issues: z.array(BeadSummarySchema).max(BEADS_LIMITS.issueList),
  truncated: z.boolean(),
  refreshedAt: timestampSchema,
  message: z.string().max(BEADS_LIMITS.publicMessage).nullable(),
});

export type BeadSummary = z.infer<typeof BeadSummarySchema>;
export type BeadDetail = z.infer<typeof BeadDetailSchema>;
export type BeadsSnapshot = z.infer<typeof BeadsSnapshotSchema>;

const workspaceInput = z.object({
  workspaceId: identifierSchema.min(1),
});

export const getWorkspaceBeads = defineRpc({
  name: "paseo-beads.get-workspace-beads",
  input: workspaceInput,
  output: BeadsSnapshotSchema,
});

export const getWorkspaceBead = defineRpc({
  name: "paseo-beads.get-workspace-bead",
  input: workspaceInput.extend({
    issueId: identifierSchema
      .min(1)
      .refine((value) => !value.startsWith("-"), "Issue ID must not start with a hyphen"),
  }),
  output: z.object({ detail: BeadDetailSchema.nullable() }),
});
