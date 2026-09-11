import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  BEADS_LIMITS,
  type BeadDetail,
  BeadDetailSchema,
  type BeadSummary,
  BeadSummarySchema,
  BeadsSnapshotSchema,
  type getWorkspaceBead,
  type getWorkspaceBeads,
} from "../shared/beads";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 512;

const rawIdentifierSchema = z.string().max(BEADS_LIMITS.identifier);
const rawTitleSchema = z.string().max(BEADS_LIMITS.title);
const rawStatusOrTypeSchema = z.string().max(BEADS_LIMITS.statusOrType);
const rawTimestampSchema = z.string().max(BEADS_LIMITS.timestamp).datetime();

const RawBeadSummarySchema = z.object({
  id: rawIdentifierSchema,
  title: rawTitleSchema,
  status: rawStatusOrTypeSchema,
  priority: z.number().int().min(0).max(4),
  issue_type: rawStatusOrTypeSchema,
  assignee: z.string().max(BEADS_LIMITS.assignee).nullable().optional(),
  labels: z
    .array(z.string().max(BEADS_LIMITS.label))
    .max(BEADS_LIMITS.labels)
    .nullable()
    .optional(),
  parent: rawIdentifierSchema.nullable().optional(),
  updated_at: rawTimestampSchema.nullable().optional(),
  dependency_count: z.number().int().nonnegative().nullable().optional(),
  dependent_count: z.number().int().nonnegative().nullable().optional(),
  comment_count: z.number().int().nonnegative().nullable().optional(),
});

const RawBeadDependencySchema = z.object({
  id: rawIdentifierSchema,
  title: rawTitleSchema,
  status: rawStatusOrTypeSchema,
  issue_type: rawStatusOrTypeSchema,
  dependency_type: rawStatusOrTypeSchema,
});

const RawBeadDetailSchema = RawBeadSummarySchema.extend({
  description: z.string().max(BEADS_LIMITS.body).nullable().optional(),
  acceptance_criteria: z.string().max(BEADS_LIMITS.body).nullable().optional(),
  design: z.string().max(BEADS_LIMITS.body).nullable().optional(),
  notes: z.string().max(BEADS_LIMITS.body).nullable().optional(),
  dependencies: z
    .array(RawBeadDependencySchema)
    .max(BEADS_LIMITS.relationships)
    .nullable()
    .optional(),
  dependents: z
    .array(RawBeadDependencySchema)
    .max(BEADS_LIMITS.relationships)
    .nullable()
    .optional(),
  comments: z.array(z.unknown()).max(BEADS_LIMITS.relationships).nullable().optional(),
});

const RawIssueListSchema = z.array(RawBeadSummarySchema).max(BEADS_LIMITS.rawIssueList);
const RawDetailListSchema = z.array(RawBeadDetailSchema).max(BEADS_LIMITS.rawIssueList);
const RawReadyIssueListSchema = z
  .array(z.object({ id: rawIdentifierSchema }))
  .max(BEADS_LIMITS.globalReadyIds);
const JsonEnvelopeSchema = z.object({
  schema_version: z.number().int(),
  data: z.unknown(),
});

type RawBeadSummary = z.infer<typeof RawBeadSummarySchema>;
type RawBeadDetail = z.infer<typeof RawBeadDetailSchema>;
type CommandError = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type BdCommandRunner = (
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string }>;

const defaultBdCommandRunner: BdCommandRunner = async (command, args, options) =>
  execFileAsync(command, args, options);

function parseJson(stdout: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    const error = new Error("Beads returned invalid JSON.") as CommandError;
    error.stdout = stdout;
    throw error;
  }

  const hasEnvelopeData =
    typeof value === "object" && value !== null && Object.hasOwn(value, "data");
  const envelope = hasEnvelopeData
    ? JsonEnvelopeSchema.safeParse(value)
    : { success: false as const };
  return envelope.success ? envelope.data.data : value;
}

async function runBd(
  directory: string,
  args: readonly string[],
  runner: BdCommandRunner,
): Promise<unknown> {
  const { stdout } = await runner("bd", ["--readonly", "-C", directory, ...args], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return parseJson(stdout);
}

async function loadReadyIds(
  directory: string,
  runner: BdCommandRunner,
): Promise<ReadonlySet<string>> {
  const result = await runBd(directory, ["list", "--ready", "--json", "--limit", "0"], runner);
  return new Set(RawReadyIssueListSchema.parse(result).map(({ id }) => id));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === "string"
      ? error.slice(0, MAX_DIAGNOSTIC_CHARS).replace(/\s+/g, " ").trim() || "Unknown failure"
      : "Unknown failure";
  }
  const commandError = error as CommandError;
  const output = commandError.stderr || commandError.stdout || commandError.message;
  const text = Buffer.isBuffer(output)
    ? output.subarray(0, MAX_DIAGNOSTIC_CHARS).toString("utf8")
    : output.slice(0, MAX_DIAGNOSTIC_CHARS);
  return text.replace(/\s+/g, " ").trim() || "Unknown failure";
}

function isBdUnavailable(error: unknown): boolean {
  return (error as CommandError | undefined)?.code === "ENOENT";
}

function isNotInitialized(error: unknown): boolean {
  return /no beads project found/i.test(errorText(error));
}

function unexpectedFailure(action: string, error: unknown): Error {
  const commandError = error as CommandError | undefined;
  if (commandError?.killed || commandError?.signal === "SIGTERM") {
    return new Error(`Unable to ${action}: Beads timed out after 10 seconds.`);
  }

  console.error(`[paseo-beads] Unable to ${action}: ${errorText(error)}`);
  return new Error(`Unable to ${action}. Check Paseo plugin logs for details.`);
}

async function resolveWorkspaceDirectory(
  workspaceId: string,
  context: PluginHandlerContext,
): Promise<string> {
  const workspace = await context.paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) throw new Error("Workspace not found.");
  return workspace.workspaceDirectory;
}

function normalizeSummary(raw: RawBeadSummary, readyIds: ReadonlySet<string>): BeadSummary {
  const isReady = readyIds.has(raw.id);
  return BeadSummarySchema.parse({
    id: raw.id,
    title: raw.title,
    status: raw.status,
    priority: raw.priority,
    issueType: raw.issue_type,
    assignee: raw.assignee ?? null,
    labels: raw.labels ?? [],
    parent: raw.parent ?? null,
    updatedAt: raw.updated_at ?? null,
    dependencyCount: raw.dependency_count ?? 0,
    dependentCount: raw.dependent_count ?? 0,
    commentCount: raw.comment_count ?? 0,
    isReady,
    isBlocked: raw.status === "blocked" || (raw.status === "open" && !isReady),
  });
}

function normalizeDetail(raw: RawBeadDetail, readyIds: ReadonlySet<string>): BeadDetail {
  const isReady = readyIds.has(raw.id);
  const dependencies = (raw.dependencies ?? []).map((dependency) => ({
    id: dependency.id,
    title: dependency.title,
    status: dependency.status,
    issueType: dependency.issue_type,
    dependencyType: dependency.dependency_type,
  }));
  const dependents = (raw.dependents ?? []).map((dependent) => ({
    id: dependent.id,
    title: dependent.title,
    status: dependent.status,
    issueType: dependent.issue_type,
    dependencyType: dependent.dependency_type,
  }));

  return BeadDetailSchema.parse({
    id: raw.id,
    title: raw.title,
    status: raw.status,
    priority: raw.priority,
    issueType: raw.issue_type,
    assignee: raw.assignee ?? null,
    labels: raw.labels ?? [],
    parent: raw.parent ?? null,
    updatedAt: raw.updated_at ?? null,
    dependencyCount: raw.dependency_count ?? dependencies.length,
    dependentCount: raw.dependent_count ?? dependents.length,
    commentCount: raw.comment_count ?? raw.comments?.length ?? 0,
    isReady,
    isBlocked: raw.status === "blocked" || (raw.status === "open" && !isReady),
    description: raw.description ?? null,
    acceptanceCriteria: raw.acceptance_criteria ?? null,
    design: raw.design ?? null,
    notes: raw.notes ?? null,
    dependencies,
    dependents,
  });
}

function unavailableSnapshot(state: "not_initialized" | "bd_unavailable") {
  return BeadsSnapshotSchema.parse({
    state,
    issues: [],
    truncated: false,
    refreshedAt: new Date().toISOString(),
    message:
      state === "bd_unavailable"
        ? "The bd CLI is not available on this Paseo host."
        : "Beads is not initialized for this workspace.",
  });
}

export async function handleGetWorkspaceBeads(
  { workspaceId }: RpcInput<typeof getWorkspaceBeads>,
  context: PluginHandlerContext,
  runner: BdCommandRunner = defaultBdCommandRunner,
): Promise<RpcOutput<typeof getWorkspaceBeads>> {
  const directory = await resolveWorkspaceDirectory(workspaceId, context);

  try {
    const [listJson, readyIds] = await Promise.all([
      runBd(
        directory,
        ["list", "--json", "--sort", "priority", "--limit", String(BEADS_LIMITS.rawIssueList)],
        runner,
      ),
      loadReadyIds(directory, runner),
    ]);
    const listed = RawIssueListSchema.parse(listJson);
    const truncated = listed.length > BEADS_LIMITS.issueList;
    const displayed = listed.slice(0, BEADS_LIMITS.issueList);
    const issues = displayed.map((issue) => normalizeSummary(issue, readyIds));
    return BeadsSnapshotSchema.parse({
      state: "ready",
      issues,
      truncated,
      refreshedAt: new Date().toISOString(),
      message: null,
    });
  } catch (error) {
    if (isBdUnavailable(error)) return unavailableSnapshot("bd_unavailable");
    if (isNotInitialized(error)) return unavailableSnapshot("not_initialized");
    throw unexpectedFailure("load Beads issues", error);
  }
}

export async function handleGetWorkspaceBead(
  { workspaceId, issueId }: RpcInput<typeof getWorkspaceBead>,
  context: PluginHandlerContext,
  runner: BdCommandRunner = defaultBdCommandRunner,
): Promise<RpcOutput<typeof getWorkspaceBead>> {
  const directory = await resolveWorkspaceDirectory(workspaceId, context);

  try {
    const [showJson, readyIds] = await Promise.all([
      runBd(directory, ["show", issueId, "--json", "--include-dependents"], runner),
      loadReadyIds(directory, runner),
    ]);
    const issues = RawDetailListSchema.parse(showJson);
    if (!issues[0]) return { detail: null };
    return { detail: normalizeDetail(issues[0], readyIds) };
  } catch (error) {
    if (
      /no issues? found matching(?: the provided IDs|\s+"[^"]+")|issue .* not found/i.test(
        errorText(error),
      )
    ) {
      return { detail: null };
    }
    if (isBdUnavailable(error)) {
      throw new Error("The bd CLI is not available on this Paseo host.");
    }
    if (isNotInitialized(error)) {
      throw new Error("Beads is not initialized for this workspace.");
    }
    throw unexpectedFailure("load the Beads issue", error);
  }
}
