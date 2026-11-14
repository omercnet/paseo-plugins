import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const HttpsUrlSchema = z.url({ protocol: /^https$/ });

export const GitHubInboxItemSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  url: HttpsUrlSchema,
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
  linkedIssues: z.array(HttpsUrlSchema).default([]),
});

export type GitHubInboxItem = z.infer<typeof GitHubInboxItemSchema>;

export const GitHubIssueItemSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  url: HttpsUrlSchema,
  title: z.string(),
  repository: z.string(),
  author: z.string().nullable(),
  authorKind: z.enum(["human", "bot"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  isSecurity: z.boolean(),
  comments: z.number().int().nonnegative(),
  labels: z.array(z.string()),
  role: z.enum(["author", "assignee", "owner"]),
});

export type GitHubIssueItem = z.infer<typeof GitHubIssueItemSchema>;

export const viewerScope = defineRpc({
  name: "pr-radar.viewer-scope",
  input: z.object({
    urls: z.array(HttpsUrlSchema).max(200),
    windowDays: z.number().int().min(1).max(365).default(30),
  }),
  output: z.object({
    viewer: z.string().nullable(),
    authoredUrls: z.array(HttpsUrlSchema),
    reviewRequestedUrls: z.array(HttpsUrlSchema),
    inboxItems: z.array(GitHubInboxItemSchema),
    issueItems: z.array(GitHubIssueItemSchema).default([]),
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

export const LocalDirEntrySchema = z.object({
  path: z.string(),
  label: z.string(),
  kind: z.enum(["repo", "worktree", "dir"]),
  branch: z.string().nullable().default(null),
  isMatch: z.boolean().default(false),
});

export type LocalDirEntry = z.infer<typeof LocalDirEntrySchema>;

export const listLocalDirs = defineRpc({
  name: "pr-radar.list-local-dirs",
  input: z.object({
    query: z.string().default(""),
    repository: z.string().default(""),
  }),
  output: z.object({
    expandedSourceDir: z.string(),
    entries: z.array(LocalDirEntrySchema),
    suggestedClonePath: z.string(),
  }),
});

export const prepareWorkspaceCwd = defineRpc({
  name: "pr-radar.prepare-workspace-cwd",
  input: z.object({
    itemKind: z.enum(["pr", "issue"]).default("pr"),
    repository: z.string().trim().min(1),
    prNumber: z.number().int().positive(),
    headRefName: z.string().default(""),
    baseRefName: z.string().default(""),
    targetDir: z.string().trim().nullable().default(null),
    allowClone: z.boolean().default(false),
    cwdMode: z.enum(["CWD-WORKTREE", "CWD-BASE"]).default("CWD-WORKTREE"),
    worktreeName: z.string().trim().nullable().default(null),
  }),
  output: z.object({
    cwd: z.string(),
    baseRoot: z.string(),
    cwdTag: z.enum(["CWD-WORKTREE", "CWD-BASE"]),
    cloned: z.boolean(),
    worktreeCreated: z.boolean(),
  }),
});

export const RoutingScriptResultSchema = z.object({
  profile: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  modeId: z.string().optional(),
  contextMode: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
});

export type RoutingScriptResult = z.infer<typeof RoutingScriptResultSchema>;

export const runRoutingScript = defineRpc({
  name: "pr-radar.run-routing-script",
  input: z.object({
    payload: z.record(z.string(), z.unknown()),
  }),
  output: RoutingScriptResultSchema,
});
