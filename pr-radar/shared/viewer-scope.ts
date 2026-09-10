import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const GitHubInboxItemSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  repository: z.string(),
  author: z.string().nullable(),
  authorKind: z.enum(["human", "bot"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  isDraft: z.boolean(),
  isSecurity: z.boolean(),
  comments: z.number().int().nonnegative(),
  labels: z.array(z.string()),
  mergeable: z.enum(["UNKNOWN", "MERGEABLE", "CONFLICTING"]),
  mergeStateStatus: z.string().nullable(),
  checksStatus: z.enum(["success", "pending", "none", "failure"]),
  reviewDecision: z.enum(["pending", "approved", "changes_requested"]).nullable(),
  role: z.enum(["author", "reviewer"]),
  changes: z.array(z.string()),
});

export type GitHubInboxItem = z.infer<typeof GitHubInboxItemSchema>;

export const viewerScope = defineRpc({
  name: "pr-radar.viewer-scope",
  input: z.object({
    urls: z.array(z.url()).max(200),
    windowDays: z.number().int().min(1).max(365).default(30),
  }),
  output: z.object({
    viewer: z.string().nullable(),
    authoredUrls: z.array(z.url()),
    reviewRequestedUrls: z.array(z.url()),
    inboxItems: z.array(GitHubInboxItemSchema),
    truncated: z.boolean(),
    coverageNote: z.string(),
    updates: z.number().int().nonnegative(),
    acknowledgedAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const acknowledgeViewerScope = defineRpc({
  name: "pr-radar.acknowledge-updates",
  input: z.object({ windowDays: z.number().int().min(1).max(365) }),
  output: z.object({ acknowledgedAt: z.string() }),
});
