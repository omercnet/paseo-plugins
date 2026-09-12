import { z } from "zod";
import { GAS_CITY_LIMITS } from "./limits";

const boundedString = (maximum: number) => z.string().max(maximum);
const boundedNullableString = (maximum: number) => boundedString(maximum).nullable();
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const identifierSchema = boundedString(GAS_CITY_LIMITS.identifier).min(1);
export const nameSchema = boundedString(GAS_CITY_LIMITS.name).min(1);
export const pathSchema = boundedString(GAS_CITY_LIMITS.path).min(1);
export const titleSchema = boundedString(GAS_CITY_LIMITS.title).min(1);
export const statusSchema = boundedString(GAS_CITY_LIMITS.status).min(1);
export const timestampSchema = boundedString(GAS_CITY_LIMITS.timestamp).datetime({ offset: true });
export const endpointUrlSchema = boundedString(GAS_CITY_LIMITS.endpointUrl)
  .url()
  .superRefine((value, context) => {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Gas City endpoint must use HTTP or HTTPS" });
    }
    if (endpoint.username || endpoint.password) {
      context.addIssue({ code: "custom", message: "Gas City endpoint cannot contain credentials" });
    }
    if (endpoint.search) {
      context.addIssue({ code: "custom", message: "Gas City endpoint cannot contain a query" });
    }
    if (endpoint.hash) {
      context.addIssue({ code: "custom", message: "Gas City endpoint cannot contain a fragment" });
    }
  });

export const MetadataValueSchema = z.union([
  boundedString(GAS_CITY_LIMITS.metadataValue),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const BoundedMetadataSchema = z
  .record(boundedString(GAS_CITY_LIMITS.metadataKey).min(1), MetadataValueSchema)
  .refine((value) => Object.keys(value).length <= GAS_CITY_LIMITS.metadataEntries, {
    message: `Metadata cannot contain more than ${GAS_CITY_LIMITS.metadataEntries} entries`,
  });

export const GasCityDiagnosticSchema = z
  .object({
    code: statusSchema,
    message: boundedString(GAS_CITY_LIMITS.errorMessage),
    retryable: z.boolean(),
  })
  .strict();

export const SupervisorSummarySchema = z
  .object({
    endpointUrl: endpointUrlSchema,
    version: boundedNullableString(GAS_CITY_LIMITS.status),
    buildId: boundedNullableString(GAS_CITY_LIMITS.identifier),
    uptimeSeconds: countSchema.nullable(),
    cityCount: countSchema,
    runningCityCount: countSchema,
  })
  .strict();

export const CitySummarySchema = z
  .object({
    name: nameSchema,
    path: pathSchema,
    running: z.boolean(),
    status: boundedNullableString(GAS_CITY_LIMITS.status),
    error: boundedNullableString(GAS_CITY_LIMITS.errorMessage),
    completedPhases: z.array(statusSchema).max(GAS_CITY_LIMITS.diagnostics),
  })
  .strict();

export const SupervisorDiscoverySchema = z
  .object({
    state: z.enum(["available", "unreachable", "invalid-response", "not-configured"]),
    supervisor: SupervisorSummarySchema.nullable(),
    cities: z.array(CitySummarySchema).max(GAS_CITY_LIMITS.cities),
    diagnostics: z.array(GasCityDiagnosticSchema).max(GAS_CITY_LIMITS.diagnostics),
    refreshedAt: timestampSchema,
  })
  .strict();
export const RigGitStatusSchema = z
  .object({
    branch: nameSchema,
    clean: z.boolean(),
    changedFiles: countSchema,
    ahead: countSchema,
    behind: countSchema,
  })
  .strict();

export const RigSummarySchema = z
  .object({
    name: nameSchema,
    path: pathSchema,
    prefix: boundedNullableString(GAS_CITY_LIMITS.identifier),
    suspended: z.boolean(),
    agentCount: countSchema,
    runningAgentCount: countSchema,
    defaultBranch: boundedNullableString(GAS_CITY_LIMITS.name),
    lastActivityAt: timestampSchema.nullable(),
    git: RigGitStatusSchema.nullable(),
  })
  .strict();

export const MappingCandidateSchema = z
  .object({
    cityName: nameSchema,
    rigName: nameSchema,
    rigPath: pathSchema,
  })
  .strict();

export const WorkspaceRigMappingSchema = z
  .object({
    state: z.enum(["mapped", "unmapped", "ambiguous", "unavailable"]),
    workspaceId: identifierSchema,
    workspacePath: pathSchema.nullable(),
    cityName: nameSchema.nullable(),
    rigName: nameSchema.nullable(),
    rigPath: pathSchema.nullable(),
    source: z.enum(["explicit", "longest-ancestor"]).nullable(),
    candidates: z.array(MappingCandidateSchema).max(GAS_CITY_LIMITS.mappingCandidates),
    diagnostics: z.array(GasCityDiagnosticSchema).max(GAS_CITY_LIMITS.diagnostics),
  })
  .strict();

export const AgentCountsSchema = z
  .object({
    total: countSchema,
    running: countSchema,
    suspended: countSchema,
    quarantined: countSchema,
  })
  .strict();

export const SessionCountsSchema = z
  .object({
    active: countSchema,
    suspended: countSchema,
  })
  .strict();

export const WorkCountsSchema = z
  .object({
    open: countSchema,
    ready: countSchema,
    inProgress: countSchema,
  })
  .strict();

export const CityRigSnapshotSchema = z
  .object({
    city: CitySummarySchema.extend({
      suspended: z.boolean(),
      uptimeSeconds: countSchema.nullable(),
      agents: AgentCountsSchema,
      sessions: SessionCountsSchema,
      work: WorkCountsSchema,
      totalsScope: z.literal("city"),
    }).strict(),
    rig: RigSummarySchema.nullable(),
    rigs: z.array(RigSummarySchema).max(GAS_CITY_LIMITS.rigs),
    partial: z.boolean(),
    diagnostics: z.array(GasCityDiagnosticSchema).max(GAS_CITY_LIMITS.diagnostics),
    refreshedAt: timestampSchema,
  })
  .strict();

export const GasCitySessionSchema = z
  .object({
    id: identifierSchema,
    cityName: nameSchema,
    rigName: nameSchema.nullable(),
    template: nameSchema,
    state: statusSchema,
    title: titleSchema,
    provider: nameSchema,
    sessionName: nameSchema,
    createdAt: timestampSchema,
    lastActiveAt: timestampSchema.nullable(),
    attached: z.boolean(),
    running: z.boolean(),
    configuredNamedSession: z.boolean(),
    activity: boundedNullableString(GAS_CITY_LIMITS.status),
    activeBeadId: identifierSchema.nullable(),
    model: boundedNullableString(GAS_CITY_LIMITS.name),
    kind: boundedNullableString(GAS_CITY_LIMITS.status),
    submissionKinds: z.array(statusSchema).max(GAS_CITY_LIMITS.diagnostics),
  })
  .strict();

export const SessionListSchema = z
  .object({
    scope: z.enum(["city", "rig"]),
    items: z.array(GasCitySessionSchema).max(GAS_CITY_LIMITS.sessions),
    truncated: z.boolean(),
    refreshedAt: timestampSchema,
  })
  .strict();

export const GasCityConvoySchema = z
  .object({
    id: identifierSchema,
    cityName: nameSchema,
    rigName: nameSchema.nullable(),
    title: titleSchema,
    status: statusSchema,
    priority: z.number().int().min(0).max(4).nullable(),
    assignee: boundedNullableString(GAS_CITY_LIMITS.name),
    createdAt: timestampSchema,
    updatedAt: timestampSchema.nullable(),
    totalWork: countSchema.nullable(),
    closedWork: countSchema.nullable(),
    blocked: z.boolean(),
  })
  .strict()
  .refine(
    (convoy) =>
      convoy.totalWork === null ||
      convoy.closedWork === null ||
      convoy.closedWork <= convoy.totalWork,
    { message: "Closed convoy work cannot exceed total work" },
  );

export const ConvoyListSchema = z
  .object({
    scope: z.enum(["city", "rig-and-unattributed"]),
    items: z.array(GasCityConvoySchema).max(GAS_CITY_LIMITS.convoys),
    truncated: z.boolean(),
    refreshedAt: timestampSchema,
  })
  .strict();
export const GasCityWorkItemSchema = z
  .object({
    id: identifierSchema,
    cityName: nameSchema,
    rigName: nameSchema.nullable(),
    title: titleSchema,
    status: statusSchema,
    type: statusSchema,
    priority: z.number().int().min(0).max(4).nullable(),
    assignee: boundedNullableString(GAS_CITY_LIMITS.name),
    createdAt: timestampSchema,
    updatedAt: timestampSchema.nullable(),
    blocked: z.boolean().nullable(),
  })
  .strict();

export const WorkListSchema = z
  .object({
    scope: z.enum(["city", "rig"]),
    items: z.array(GasCityWorkItemSchema).max(GAS_CITY_LIMITS.workItems),
    truncated: z.boolean(),
    partial: z.boolean(),
    refreshedAt: timestampSchema,
  })
  .strict();

export const GasCityEventSchema = z
  .object({
    cityName: nameSchema.nullable(),
    sequence: countSchema,
    type: boundedString(GAS_CITY_LIMITS.eventType).min(1),
    actor: boundedNullableString(GAS_CITY_LIMITS.name),
    subject: boundedNullableString(GAS_CITY_LIMITS.identifier),
    message: boundedNullableString(GAS_CITY_LIMITS.message),
    timestamp: timestampSchema,
    metadata: BoundedMetadataSchema,
  })
  .strict();

export const EventListSchema = z
  .object({
    scope: z.enum(["supervisor-head", "city"]),
    items: z.array(GasCityEventSchema).max(GAS_CITY_LIMITS.events),
    cursor: boundedNullableString(GAS_CITY_LIMITS.cursor),
    truncated: z.boolean(),
    refreshedAt: timestampSchema,
  })
  .strict();

export const AttentionItemSchema = z
  .object({
    id: identifierSchema,
    cityName: nameSchema,
    rigName: nameSchema.nullable(),
    kind: z.enum(["city", "rig", "session", "convoy", "work"]),
    severity: z.enum(["info", "warning", "critical"]),
    code: statusSchema,
    title: titleSchema,
    message: boundedString(GAS_CITY_LIMITS.message),
    requestId: identifierSchema.nullable(),
    resourceId: identifierSchema.nullable(),
    observedAt: timestampSchema,
  })
  .strict();

export const AttentionListSchema = z
  .object({
    scope: z.enum(["city", "city-and-rig"]),
    items: z.array(AttentionItemSchema).max(GAS_CITY_LIMITS.attentionItems),
    truncated: z.boolean(),
    refreshedAt: timestampSchema,
  })
  .strict();

export const DispatchTargetSchema = z
  .object({
    cityName: nameSchema,
    rigName: nameSchema.nullable(),
    agent: nameSchema,
  })
  .strict();

const confirmedMutation = {
  confirmed: z.literal(true),
  target: DispatchTargetSchema,
};

export const DispatchRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...confirmedMutation,
      kind: z.literal("bead"),
      beadId: identifierSchema,
      reassign: z.boolean(),
      owned: z.boolean(),
      force: z.boolean(),
      noFormula: z.boolean(),
      noConvoy: z.boolean(),
      merge: z.enum(["direct", "mr", "local"]),
    })
    .strict(),
  z
    .object({
      ...confirmedMutation,
      kind: z.literal("formula"),
      formula: nameSchema,
      title: titleSchema,
      attachedBeadId: identifierSchema.nullable(),
      variables: BoundedMetadataSchema,
      force: z.boolean(),
      merge: z.enum(["direct", "mr", "local"]),
    })
    .strict(),
]);

export const DispatchResultSchema = z
  .object({
    status: statusSchema,
    target: nameSchema,
    beadId: identifierSchema.nullable(),
    formula: nameSchema.nullable(),
    workflowId: identifierSchema.nullable(),
    rootBeadId: identifierSchema.nullable(),
    dashboardUrl: boundedNullableString(GAS_CITY_LIMITS.path),
    warnings: z.array(boundedString(GAS_CITY_LIMITS.message)).max(GAS_CITY_LIMITS.warnings),
  })
  .strict();

const sessionMutationBase = {
  cityName: nameSchema,
  sessionId: identifierSchema,
  confirmed: z.literal(true),
};

export const SessionActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...sessionMutationBase,
      action: z.enum(["wake", "stop", "suspend", "close", "kill"]),
    })
    .strict(),
  z
    .object({
      ...sessionMutationBase,
      action: z.literal("message"),
      message: boundedString(GAS_CITY_LIMITS.prompt).min(1),
    })
    .strict(),
  z
    .object({
      ...sessionMutationBase,
      action: z.literal("submit"),
      message: boundedString(GAS_CITY_LIMITS.prompt).min(1),
      intent: z.enum(["default", "follow_up", "interrupt_now"]),
    })
    .strict(),
  z
    .object({
      ...sessionMutationBase,
      action: z.literal("respond"),
      requestId: identifierSchema,
      response: z.enum(["allow", "deny", "answer"]),
      text: boundedNullableString(GAS_CITY_LIMITS.prompt),
      metadata: BoundedMetadataSchema,
    })
    .strict(),
]);

export const SessionActionResultSchema = z
  .object({
    status: statusSchema,
    sessionId: identifierSchema,
    requestId: identifierSchema.nullable(),
    eventCursor: boundedNullableString(GAS_CITY_LIMITS.cursor),
  })
  .strict();

export type GasCityDiagnostic = z.infer<typeof GasCityDiagnosticSchema>;
export type SupervisorDiscovery = z.infer<typeof SupervisorDiscoverySchema>;
export type WorkspaceRigMapping = z.infer<typeof WorkspaceRigMappingSchema>;
export type CityRigSnapshot = z.infer<typeof CityRigSnapshotSchema>;
export type GasCitySession = z.infer<typeof GasCitySessionSchema>;
export type SessionList = z.infer<typeof SessionListSchema>;
export type GasCityConvoy = z.infer<typeof GasCityConvoySchema>;
export type ConvoyList = z.infer<typeof ConvoyListSchema>;
export type GasCityWorkItem = z.infer<typeof GasCityWorkItemSchema>;
export type WorkList = z.infer<typeof WorkListSchema>;
export type GasCityEvent = z.infer<typeof GasCityEventSchema>;
export type EventList = z.infer<typeof EventListSchema>;
export type AttentionItem = z.infer<typeof AttentionItemSchema>;
export type AttentionList = z.infer<typeof AttentionListSchema>;
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;
export type DispatchResult = z.infer<typeof DispatchResultSchema>;
export type SessionActionRequest = z.infer<typeof SessionActionRequestSchema>;
export type SessionActionResult = z.infer<typeof SessionActionResultSchema>;
