import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  AttentionListSchema,
  CityRigSnapshotSchema,
  ConvoyListSchema,
  DispatchResultSchema,
  type discoverSupervisor,
  type dispatchWork,
  EventListSchema,
  GAS_CITY_LIMITS,
  type GasCityDiagnostic,
  type GasCityRpcSettings,
  GasCityRpcSettingsSchema,
  type getCityRigSnapshot,
  type listAttention,
  type listConvoys,
  type listEvents,
  type listSessions,
  type listWork,
  type performSessionAction,
  type resolveWorkspaceRig,
  SessionActionResultSchema,
  SessionListSchema,
  SupervisorDiscoverySchema,
  WorkListSchema,
} from "../shared";
import {
  GasCityClient,
  GasCityClientError,
  type UpstreamCity,
  type UpstreamConvoy,
  type UpstreamEvent,
  UpstreamEventSchema,
  type UpstreamRig,
  type UpstreamSession,
  type UpstreamWorkItem,
} from "./gas-city-client";
import { mapWorkspaceToRig } from "./workspace-mapping";

export interface GasCityHandlerDependencies {
  createClient?: (settings: GasCityRpcSettings) => GasCityClient;
  now?: () => Date;
}

export interface GasCityHandlers {
  discoverSupervisor(
    input: RpcInput<typeof discoverSupervisor>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof discoverSupervisor>>;
  resolveWorkspaceRig(
    input: RpcInput<typeof resolveWorkspaceRig>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof resolveWorkspaceRig>>;
  getCityRigSnapshot(
    input: RpcInput<typeof getCityRigSnapshot>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof getCityRigSnapshot>>;
  listSessions(
    input: RpcInput<typeof listSessions>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof listSessions>>;
  listConvoys(
    input: RpcInput<typeof listConvoys>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof listConvoys>>;
  listWork(
    input: RpcInput<typeof listWork>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof listWork>>;
  listEvents(
    input: RpcInput<typeof listEvents>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof listEvents>>;
  listAttention(
    input: RpcInput<typeof listAttention>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof listAttention>>;
  dispatchWork(
    input: RpcInput<typeof dispatchWork>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof dispatchWork>>;
  performSessionAction(
    input: RpcInput<typeof performSessionAction>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof performSessionAction>>;
}

function diagnostic(code: string, message: string, retryable: boolean): GasCityDiagnostic {
  return { code, message, retryable };
}

function nullable(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function refreshedAt(now: () => Date): string {
  return now().toISOString();
}

function safeError(action: string, error: unknown): Error {
  if (error instanceof GasCityClientError) {
    console.error("[paseo-gas-city] RPC failed", {
      action,
      code: error.code,
      correlationId: error.correlationId,
      status: error.status,
    });
    if (error.code === "invalid-endpoint" || error.code === "endpoint-not-allowed") {
      return new Error("Gas City endpoint configuration is invalid.");
    }
    if (error.code === "invalid-response" || error.code === "response-too-large") {
      return new Error("Gas City returned an invalid response.");
    }
    if (error.code === "timeout") return new Error("Gas City request timed out.");
    if (error.code === "unreachable") return new Error("Gas City supervisor is unreachable.");
    if (error.code === "canceled") return new Error("Gas City request was canceled.");
    return new Error("Gas City request failed.");
  }
  console.error("[paseo-gas-city] RPC failed", { action, error });
  return new Error(`Unable to ${action}. Check Paseo plugin logs for details.`);
}

function discoveryFailure(error: unknown, now: () => Date): RpcOutput<typeof discoverSupervisor> {
  const invalid =
    error instanceof GasCityClientError &&
    (error.code === "invalid-response" || error.code === "response-too-large");
  const configuration =
    error instanceof GasCityClientError &&
    (error.code === "invalid-endpoint" || error.code === "endpoint-not-allowed");
  const code = configuration ? "invalid-endpoint" : invalid ? "invalid-response" : "unreachable";
  const message = configuration
    ? "The Gas City endpoint configuration is invalid."
    : invalid
      ? "The Gas City supervisor returned an invalid response."
      : "The Gas City supervisor is unreachable.";
  if (error instanceof GasCityClientError) {
    console.error("[paseo-gas-city] Supervisor discovery failed", {
      code: error.code,
      correlationId: error.correlationId,
      status: error.status,
    });
  }
  return SupervisorDiscoverySchema.parse({
    state: configuration ? "not-configured" : invalid ? "invalid-response" : "unreachable",
    supervisor: null,
    cities: [],
    diagnostics: [diagnostic(code, message, !configuration)],
    refreshedAt: refreshedAt(now),
  });
}

function citySummary(city: UpstreamCity) {
  return {
    name: city.name,
    path: city.path,
    running: city.running,
    status: nullable(city.status),
    error: nullable(city.error),
    completedPhases: city.phases_completed ?? [],
  };
}

function rigSummary(rig: UpstreamRig) {
  return {
    name: rig.name,
    path: rig.path,
    prefix: nullable(rig.prefix),
    suspended: rig.suspended,
    agentCount: rig.agent_count,
    runningAgentCount: rig.running_count,
    defaultBranch: nullable(rig.default_branch),
    lastActivityAt: nullable(rig.last_activity),
    git: rig.git
      ? {
          branch: rig.git.branch,
          clean: rig.git.clean,
          changedFiles: rig.git.changed_files,
          ahead: rig.git.ahead,
          behind: rig.git.behind,
        }
      : null,
  };
}

function submissionKinds(session: UpstreamSession): string[] {
  const capabilities = session.submission_capabilities;
  if (!capabilities) return [];
  return Object.entries(capabilities)
    .filter((entry): entry is [string, true] => entry[1] === true)
    .map(([name]) => name)
    .slice(0, GAS_CITY_LIMITS.diagnostics);
}

function sessionItem(cityName: string, session: UpstreamSession) {
  return {
    id: session.id,
    cityName,
    rigName: nullable(session.rig),
    template: session.template,
    state: session.state,
    title: session.title,
    provider: session.provider,
    sessionName: session.session_name,
    createdAt: session.created_at,
    lastActiveAt: nullable(session.last_active),
    attached: session.attached,
    running: session.running,
    configuredNamedSession: session.configured_named_session ?? false,
    activity: nullable(session.activity),
    activeBeadId: nullable(session.active_bead),
    model: nullable(session.model),
    kind: nullable(session.kind ?? session.agent_kind),
    submissionKinds: submissionKinds(session),
  };
}

function convoyItem(cityName: string, convoy: UpstreamConvoy, rigs: readonly UpstreamRig[]) {
  const explicitRig = convoy.metadata?.rig;
  const rigName = explicitRig && rigs.some(({ name }) => name === explicitRig) ? explicitRig : null;
  return {
    id: convoy.id,
    cityName,
    rigName,
    title: convoy.title,
    status: convoy.status,
    priority: convoy.priority ?? null,
    assignee: nullable(convoy.assignee),
    createdAt: convoy.created_at,
    updatedAt: nullable(convoy.updated_at),
    totalWork: null,
    closedWork: null,
    blocked: convoy.is_blocked ?? false,
  };
}

function workItem(cityName: string, rigName: string | null, item: UpstreamWorkItem) {
  return {
    id: item.id,
    cityName,
    rigName,
    title: item.title,
    status: item.status,
    type: item.issue_type,
    priority: item.priority ?? null,
    assignee: nullable(item.assignee),
    createdAt: item.created_at,
    updatedAt: nullable(item.updated_at),
    blocked: item.is_blocked ?? null,
  };
}

function upstreamListTruncated(response: {
  items: readonly unknown[] | null;
  total: number;
  next_cursor?: string;
  partial?: boolean;
}): boolean {
  return (
    Boolean(response.next_cursor) ||
    Boolean(response.partial) ||
    response.total > (response.items?.length ?? 0)
  );
}

function eventMetadata(event: UpstreamEvent) {
  const metadata: Record<string, string | number | boolean | null> = {};
  if (
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
  ) {
    for (const [key, value] of Object.entries(event.payload)) {
      if (
        Object.keys(metadata).length < GAS_CITY_LIMITS.metadataEntries &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null)
      ) {
        metadata[key] = value;
      }
    }
  }
  for (const [key, value] of [
    ["session_id", event.session_id],
    ["run_id", event.run_id],
    ["step_id", event.step_id],
  ] as const) {
    if (value && Object.keys(metadata).length < GAS_CITY_LIMITS.metadataEntries)
      metadata[key] = value;
  }
  return metadata;
}

function eventItem(event: UpstreamEvent, fallbackCity: string | null) {
  return {
    cityName: nullable(event.city) ?? fallbackCity,
    sequence: event.seq,
    type: event.type,
    actor: nullable(event.actor),
    subject: nullable(event.subject ?? event.session_id ?? event.run_id),
    message: nullable(event.message),
    timestamp: event.ts,
    metadata: eventMetadata(event),
  };
}

function parseEventItems(items: readonly unknown[] | null, fallbackCity: string | null) {
  const parsed = [];
  let dropped = 0;
  for (const item of items ?? []) {
    const result = UpstreamEventSchema.safeParse(item);
    if (result.success) parsed.push(eventItem(result.data, fallbackCity));
    else dropped += 1;
  }
  return { items: parsed, dropped };
}

function requireMutations(settings: GasCityRpcSettings, confirmed: boolean) {
  if (!settings.mutationsEnabled) {
    throw new Error("Gas City mutations are disabled by the interactive safety interlock.");
  }
  if (!confirmed) throw new Error("Gas City mutation requires explicit confirmation.");
}

async function workspacePath(
  workspaceId: string,
  context: PluginHandlerContext,
): Promise<string | null> {
  const workspace = await context.paseo.workspaces.ref(workspaceId).refresh();
  return workspace?.workspaceDirectory ?? null;
}

export function createGasCityHandlers(
  dependencies: GasCityHandlerDependencies = {},
): GasCityHandlers {
  const createClient =
    dependencies.createClient ??
    ((settings) =>
      new GasCityClient({
        endpointUrl: settings.endpointUrl,
        allowRemoteEndpoint: settings.allowRemoteEndpoint,
      }));
  const now = dependencies.now ?? (() => new Date());

  const resources = (input: { settings: GasCityRpcSettings }) => {
    const settings = GasCityRpcSettingsSchema.parse(input.settings);
    return { settings, client: createClient(settings) };
  };

  return {
    async discoverSupervisor(input) {
      try {
        const { client } = resources(input);
        const [health, cities] = await Promise.all([client.health(), client.cities()]);
        return SupervisorDiscoverySchema.parse({
          state: "available",
          supervisor: {
            endpointUrl: client.endpoint.href.replace(/\/$/, ""),
            version: nullable(health.version),
            buildId: nullable(health.build_id),
            uptimeSeconds: health.uptime_sec,
            cityCount: health.cities_total,
            runningCityCount: health.cities_running,
          },
          cities: (cities.items ?? []).map(citySummary),
          diagnostics: [],
          refreshedAt: refreshedAt(now),
        });
      } catch (error) {
        return discoveryFailure(error, now);
      }
    },

    async resolveWorkspaceRig(input, context) {
      const { settings, client } = resources(input);
      try {
        const [path, cityResponse] = await Promise.all([
          workspacePath(input.workspaceId, context),
          client.cities(),
        ]);
        const cities = cityResponse.items ?? [];
        const rigPairs = await Promise.all(
          cities
            .filter(({ running }) => running)
            .map(async (city) => [city.name, await client.rigs(city.name)] as const),
        );
        const rigsByCity = new Map(
          rigPairs.map(([cityName, response]) => [cityName, response.items ?? []] as const),
        );
        return await mapWorkspaceToRig({
          workspaceId: input.workspaceId,
          workspacePath: path,
          cities,
          rigsByCity,
          overrides: settings.workspaceMappings,
        });
      } catch (error) {
        console.error("[paseo-gas-city] Workspace mapping failed", {
          code: error instanceof GasCityClientError ? error.code : "internal",
          correlationId: error instanceof GasCityClientError ? error.correlationId : null,
        });
        return {
          state: "unavailable",
          workspaceId: input.workspaceId,
          workspacePath: null,
          cityName: null,
          rigName: null,
          rigPath: null,
          source: null,
          candidates: [],
          diagnostics: [
            diagnostic(
              "mapping-unavailable",
              "Gas City rig mapping is temporarily unavailable.",
              true,
            ),
          ],
        };
      }
    },
    async getCityRigSnapshot(input, _context) {
      const { client } = resources(input);
      try {
        const [cities, status, rigs] = await Promise.all([
          client.cities(),
          client.cityStatus(input.cityName),
          client.rigs(input.cityName),
        ]);
        const city = (cities.items ?? []).find(({ name }) => name === input.cityName);
        const diagnostics: GasCityDiagnostic[] = [];
        if (status.partial) {
          diagnostics.push(
            diagnostic("partial-status", "Gas City reported an incomplete city snapshot.", true),
          );
        }
        const rigItems = rigs.items ?? [];
        const selectedRig = input.rigName
          ? (rigItems.find(({ name }) => name === input.rigName) ?? null)
          : null;
        if (input.rigName && !selectedRig) {
          diagnostics.push(
            diagnostic("rig-not-found", "The requested Gas City rig was not found.", false),
          );
        }
        return CityRigSnapshotSchema.parse({
          city: {
            name: city?.name ?? status.name,
            path: city?.path ?? status.path,
            running: city?.running ?? true,
            status: nullable(city?.status),
            error: nullable(city?.error),
            completedPhases: city?.phases_completed ?? [],
            suspended: status.suspended,
            uptimeSeconds: status.uptime_sec,
            agents: {
              total: status.agents.total,
              running: status.agents.running,
              suspended: status.agents.suspended,
              quarantined: status.agents.quarantined,
            },
            sessions: status.session_counts_detail ?? { active: 0, suspended: 0 },
            work: {
              open: status.work.open,
              ready: status.work.ready,
              inProgress: status.work.in_progress,
            },
            totalsScope: "city",
          },
          rig: selectedRig ? rigSummary(selectedRig) : null,
          rigs: rigItems.map(rigSummary),
          partial: Boolean(status.partial) || (input.rigName !== null && selectedRig === null),
          diagnostics,
          refreshedAt: refreshedAt(now),
        });
      } catch (error) {
        throw safeError("load the Gas City snapshot", error);
      }
    },

    async listSessions(input) {
      const { client } = resources(input);
      try {
        const response = await client.sessions(input.cityName);
        const items = (response.items ?? [])
          .filter((session) => input.rigName === null || session.rig === input.rigName)
          .map((session) => sessionItem(input.cityName, session));
        return SessionListSchema.parse({
          scope: input.rigName === null ? "city" : "rig",
          items,
          truncated: upstreamListTruncated(response),
          refreshedAt: refreshedAt(now),
        });
      } catch (error) {
        throw safeError("list Gas City sessions", error);
      }
    },

    async listConvoys(input) {
      const { client } = resources(input);
      try {
        const [response, rigs] = await Promise.all([
          client.convoys(input.cityName),
          client.rigs(input.cityName),
        ]);
        const rigItems = rigs.items ?? [];
        const items = (response.items ?? [])
          .map((convoy) => convoyItem(input.cityName, convoy, rigItems))
          .filter(
            (convoy) =>
              input.rigName === null || convoy.rigName === null || convoy.rigName === input.rigName,
          );
        return ConvoyListSchema.parse({
          scope: input.rigName === null ? "city" : "rig-and-unattributed",
          items,
          truncated: upstreamListTruncated(response),
          refreshedAt: refreshedAt(now),
        });
      } catch (error) {
        throw safeError("list Gas City convoys", error);
      }
    },

    async listWork(input) {
      const { settings, client } = resources(input);
      try {
        const response = await client.work(input.cityName, input.rigName, settings.eventLimit);
        return WorkListSchema.parse({
          scope: input.rigName === null ? "city" : "rig",
          items: (response.items ?? []).map((item) =>
            workItem(input.cityName, input.rigName, item),
          ),
          truncated: upstreamListTruncated(response),
          partial: Boolean(response.partial),
          refreshedAt: refreshedAt(now),
        });
      } catch (error) {
        throw safeError("list Gas City work", error);
      }
    },

    async listEvents(input) {
      const { settings, client } = resources(input);
      try {
        if (input.scope === "supervisor") {
          const response = await client.supervisorEvents(settings.eventLimit);
          const events = parseEventItems(response.items, null);
          return EventListSchema.parse({
            scope: "supervisor-head",
            items: events.items,
            cursor: null,
            truncated: events.dropped > 0 || response.total > events.items.length,
            refreshedAt: refreshedAt(now),
          });
        }
        const response = await client.cityEvents(input.cityName, input.cursor, settings.eventLimit);
        const events = parseEventItems(response.items, input.cityName);
        return EventListSchema.parse({
          scope: "city",
          items: events.items,
          cursor: nullable(response.next_cursor),
          truncated: events.dropped > 0 || upstreamListTruncated(response),
          refreshedAt: refreshedAt(now),
        });
      } catch (error) {
        throw safeError("list Gas City events", error);
      }
    },

    async listAttention(input) {
      const { client } = resources(input);
      try {
        const [status, sessions, convoys, pending, rigs] = await Promise.all([
          client.cityStatus(input.cityName),
          client.sessions(input.cityName),
          client.convoys(input.cityName),
          client.pending(input.cityName),
          client.rigs(input.cityName),
        ]);
        const observedAt = refreshedAt(now);
        const sessionById = new Map((sessions.items ?? []).map((session) => [session.id, session]));
        const rigItems = rigs.items ?? [];
        const items: Array<{
          id: string;
          cityName: string;
          rigName: string | null;
          kind: "city" | "rig" | "session" | "convoy" | "work";
          severity: "info" | "warning" | "critical";
          code: string;
          title: string;
          message: string;
          requestId: string | null;
          resourceId: string | null;
          observedAt: string;
        }> = [];
        if (status.suspended) {
          items.push({
            id: `city:${input.cityName}:suspended`,
            cityName: input.cityName,
            rigName: null,
            kind: "city",
            severity: "warning",
            code: "city-suspended",
            title: `${input.cityName} is suspended`,
            message: "The city will not reconcile work until it is resumed.",
            requestId: null,
            resourceId: input.cityName,
            observedAt,
          });
        }
        if (status.agents.quarantined > 0) {
          items.push({
            id: `city:${input.cityName}:quarantined`,
            cityName: input.cityName,
            rigName: null,
            kind: "city",
            severity: "critical",
            code: "agents-quarantined",
            title: "Agents are quarantined",
            message: `${status.agents.quarantined} agent(s) require operator attention.`,
            requestId: null,
            resourceId: input.cityName,
            observedAt,
          });
        }
        if (status.partial) {
          items.push({
            id: `city:${input.cityName}:partial`,
            cityName: input.cityName,
            rigName: null,
            kind: "city",
            severity: "warning",
            code: "partial-status",
            title: "City status is incomplete",
            message: "One or more Gas City status backends did not respond.",
            requestId: null,
            resourceId: input.cityName,
            observedAt,
          });
        }
        for (const entry of pending.items ?? []) {
          const session = sessionById.get(entry.session_id);
          if (input.rigName !== null && session?.rig !== input.rigName) continue;
          items.push({
            id: `session:${entry.session_id}:pending:${entry.request_id}`,
            cityName: input.cityName,
            rigName: nullable(session?.rig),
            kind: "session",
            severity: "warning",
            code: "interaction-pending",
            title: `${session?.title ?? entry.session_id} needs input`,
            message: `The session is waiting for an operator response (${entry.kind}).`,
            requestId: entry.request_id,
            resourceId: entry.session_id,
            observedAt,
          });
        }
        for (const convoy of convoys.items ?? []) {
          if (!convoy.is_blocked) continue;
          const rigName = convoyItem(input.cityName, convoy, rigItems).rigName;
          if (input.rigName !== null && rigName !== null && rigName !== input.rigName) continue;
          items.push({
            id: `convoy:${convoy.id}:blocked`,
            cityName: input.cityName,
            rigName,
            kind: "convoy",
            severity: "warning",
            code: "convoy-blocked",
            title: `${convoy.title} is blocked`,
            message: "The convoy has unresolved dependencies.",
            requestId: null,
            resourceId: convoy.id,
            observedAt,
          });
        }
        const upstreamTruncated = [sessions, convoys, pending, rigs].some(upstreamListTruncated);
        const truncated = items.length > GAS_CITY_LIMITS.attentionItems || upstreamTruncated;
        return AttentionListSchema.parse({
          items: items.slice(0, GAS_CITY_LIMITS.attentionItems),
          scope: input.rigName === null ? "city" : "city-and-rig",
          truncated,
          refreshedAt: observedAt,
        });
      } catch (error) {
        throw safeError("derive Gas City attention", error);
      }
    },

    async dispatchWork(input) {
      const { settings, client } = resources(input);
      const request = input.request;
      requireMutations(settings, request.confirmed);
      const target = request.target;
      const scope = target.rigName
        ? { rig: target.rigName, scope_kind: "rig", scope_ref: target.rigName }
        : {};
      const body =
        request.kind === "bead"
          ? {
              ...scope,
              target: target.agent,
              bead: request.beadId,
              reassign: request.reassign,
              owned: request.owned,
              force: request.force,
              no_formula: request.noFormula,
              no_convoy: request.noConvoy,
              merge: request.merge,
            }
          : {
              ...scope,
              target: target.agent,
              formula: request.formula,
              title: request.title,
              attached_bead_id: request.attachedBeadId ?? undefined,
              vars: Object.fromEntries(
                Object.entries(request.variables).map(([key, value]) => [key, String(value)]),
              ),
              force: request.force,
              merge: request.merge,
            };
      try {
        const result = await client.sling(target.cityName, body);
        return DispatchResultSchema.parse({
          status: result.status,
          target: result.target,
          beadId: nullable(result.bead),
          formula: nullable(result.formula),
          workflowId: nullable(result.workflow_id),
          rootBeadId: nullable(result.root_bead_id),
          dashboardUrl: nullable(result.dashboard_url),
          warnings: result.warnings ?? [],
        });
      } catch (error) {
        throw safeError("dispatch Gas City work", error);
      }
    },

    async performSessionAction(input) {
      const { settings, client } = resources(input);
      const request = input.request;
      requireMutations(settings, request.confirmed);
      let action: string = request.action;
      let body: unknown;
      if (request.action === "message") body = { message: request.message };
      if (request.action === "submit") body = { message: request.message, intent: request.intent };
      if (request.action === "respond") {
        body = {
          request_id: request.requestId,
          action: request.response,
          text: request.text ?? undefined,
          metadata: Object.fromEntries(
            Object.entries(request.metadata).map(([key, value]) => [key, String(value)]),
          ),
        };
      }
      if (request.action === "message") action = "messages";
      try {
        const result = await client.sessionAction(
          request.cityName,
          request.sessionId,
          action,
          body,
        );
        return SessionActionResultSchema.parse({
          status: result.status,
          sessionId: result.id ?? request.sessionId,
          requestId: nullable(result.request_id),
          eventCursor: result.event_cursor === undefined ? null : String(result.event_cursor),
        });
      } catch (error) {
        throw safeError("perform the Gas City session action", error);
      }
    },
  };
}

const defaultHandlers = createGasCityHandlers();

export const handleDiscoverSupervisor = defaultHandlers.discoverSupervisor;
export const handleResolveWorkspaceRig = defaultHandlers.resolveWorkspaceRig;
export const handleGetCityRigSnapshot = defaultHandlers.getCityRigSnapshot;
export const handleListSessions = defaultHandlers.listSessions;
export const handleListConvoys = defaultHandlers.listConvoys;
export const handleListWork = defaultHandlers.listWork;
export const handleListEvents = defaultHandlers.listEvents;
export const handleListAttention = defaultHandlers.listAttention;
export const handleDispatchWork = defaultHandlers.dispatchWork;
export const handlePerformSessionAction = defaultHandlers.performSessionAction;
