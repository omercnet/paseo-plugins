import type {
  AttentionItem,
  GasCityConvoy,
  GasCityEvent,
  GasCitySession,
  GasCityWorkItem,
} from "../shared";

export type DashboardRow =
  | { kind: "status"; tone: "loading" | "error" | "refreshing" | "stale"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "attention"; item: AttentionItem }
  | { kind: "session"; item: GasCitySession }
  | { kind: "convoy"; item: GasCityConvoy }
  | { kind: "work"; item: GasCityWorkItem }
  | { kind: "event"; item: GasCityEvent };

export interface DashboardSection {
  id: "attention" | "sessions" | "convoys" | "work" | "events";
  title: string;
  data: DashboardRow[];
  truncated: boolean;
}

export interface DashboardData {
  attention:
    | { scope: "city" | "city-and-rig"; items: readonly AttentionItem[]; truncated: boolean }
    | undefined;
  sessions:
    | { scope: "city" | "rig"; items: readonly GasCitySession[]; truncated: boolean }
    | undefined;
  convoys:
    | {
        scope: "city" | "rig-and-unattributed";
        items: readonly GasCityConvoy[];
        truncated: boolean;
      }
    | undefined;
  work:
    | { scope: "city" | "rig"; items: readonly GasCityWorkItem[]; truncated: boolean }
    | undefined;
  events:
    | { scope: "supervisor-head" | "city"; items: readonly GasCityEvent[]; truncated: boolean }
    | undefined;
}

const severityOrder = { critical: 0, warning: 1, info: 2 } as const;

function timestamp(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function withEmptyRow<T>(items: readonly T[], message: string, wrap: (item: T) => DashboardRow) {
  return items.length > 0 ? items.map(wrap) : [{ kind: "empty", message } satisfies DashboardRow];
}

export function buildDashboardSections(data: DashboardData): DashboardSection[] {
  const attention = [...(data.attention?.items ?? [])].sort((left, right) => {
    const bySeverity = severityOrder[left.severity] - severityOrder[right.severity];
    if (bySeverity !== 0) return bySeverity;
    return timestamp(right.observedAt) - timestamp(left.observedAt);
  });
  const sessions = [...(data.sessions?.items ?? [])].sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1;
    return (
      timestamp(right.lastActiveAt ?? right.createdAt) -
      timestamp(left.lastActiveAt ?? left.createdAt)
    );
  });
  const convoys = [...(data.convoys?.items ?? [])].sort((left, right) => {
    if (left.blocked !== right.blocked) return left.blocked ? -1 : 1;
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (
      timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt)
    );
  });
  const events = [...(data.events?.items ?? [])].sort(
    (left, right) => right.sequence - left.sequence,
  );
  const work = [...(data.work?.items ?? [])].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (
      timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt)
    );
  });

  return [
    {
      id: "attention",
      title:
        data.attention?.scope === "city-and-rig"
          ? "Attention · city + rig"
          : "Attention · city-wide",
      data: withEmptyRow(attention, "No resources need attention.", (item) => ({
        kind: "attention",
        item,
      })),
      truncated: data.attention?.truncated ?? false,
    },
    {
      id: "sessions",
      title: data.sessions?.scope === "rig" ? "Sessions · mapped rig" : "Sessions · city-wide",
      data: withEmptyRow(sessions, "No sessions in this scope.", (item) => ({
        kind: "session",
        item,
      })),
      truncated: data.sessions?.truncated ?? false,
    },
    {
      id: "convoys",
      title:
        data.convoys?.scope === "rig-and-unattributed"
          ? "Convoys · mapped rig + unattributed"
          : "Convoys · city-wide",
      data: withEmptyRow(convoys, "No convoys in this scope.", (item) => ({
        kind: "convoy",
        item,
      })),
      truncated: data.convoys?.truncated ?? false,
    },
    {
      id: "work",
      title: data.work?.scope === "rig" ? "Work · mapped rig" : "Work · city-wide",
      data: withEmptyRow(work, "No work in this scope.", (item) => ({ kind: "work", item })),
      truncated: data.work?.truncated ?? false,
    },
    {
      id: "events",
      title:
        data.events?.scope === "supervisor-head"
          ? "Supervisor events · head snapshot"
          : "Recent events · city-wide",
      data: withEmptyRow(events, "No recent events.", (item) => ({ kind: "event", item })),
      truncated: data.events?.truncated ?? false,
    },
  ];
}

export type RefreshPresentation =
  | { state: "loading"; label: string }
  | { state: "error"; label: string }
  | { state: "refreshing"; label: string }
  | { state: "stale"; label: string }
  | { state: "ready"; label: string };

export function presentSection(
  section: DashboardSection,
  query: { hasData: boolean; isPending: boolean; isFetching: boolean; error: unknown },
): DashboardSection {
  if (!query.hasData && query.isPending) {
    return {
      ...section,
      data: [
        { kind: "status", tone: "loading", message: `Loading ${section.title.toLowerCase()}…` },
      ],
    };
  }
  if (!query.hasData && query.error) {
    return {
      ...section,
      data: [
        {
          kind: "status",
          tone: "error",
          message: `Could not load ${section.title.toLowerCase()}.`,
        },
      ],
    };
  }
  if (query.hasData && query.error) {
    return {
      ...section,
      data: [
        { kind: "status", tone: "stale", message: "Refresh failed. Showing stale data." },
        ...section.data,
      ],
    };
  }
  if (query.hasData && query.isFetching) {
    return {
      ...section,
      data: [
        { kind: "status", tone: "refreshing", message: "Refreshing stale data…" },
        ...section.data,
      ],
    };
  }
  return section;
}
export function refreshPresentation(input: {
  hasData: boolean;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refreshedAt?: string | null;
}): RefreshPresentation {
  if (!input.hasData && input.isPending) return { state: "loading", label: "Loading live data" };
  if (!input.hasData && input.error) return { state: "error", label: "Load failed" };
  if (input.hasData && input.error)
    return { state: "stale", label: "Refresh failed · showing stale data" };
  if (input.hasData && input.isFetching)
    return { state: "refreshing", label: "Refreshing stale data" };
  if (input.refreshedAt) {
    const parsed = Date.parse(input.refreshedAt);
    if (Number.isFinite(parsed)) {
      return { state: "ready", label: `Updated ${new Date(parsed).toLocaleTimeString()}` };
    }
  }
  return { state: "ready", label: "Live data ready" };
}

export type SessionActionName =
  | "wake"
  | "message"
  | "submit"
  | "stop"
  | "suspend"
  | "close"
  | "kill";

export function sessionActionsFor(
  session: Pick<GasCitySession, "running" | "state" | "submissionKinds">,
): SessionActionName[] {
  if (session.state.toLowerCase() === "closed") return [];
  if (!session.running) return ["wake", "close"];
  const actions: SessionActionName[] = [];
  if (session.submissionKinds.includes("message")) actions.push("message");
  if (session.submissionKinds.includes("submit")) actions.push("submit");
  actions.push("stop", "suspend", "close", "kill");
  return actions;
}

export function selectAvailableCity(
  preferred: string | null,
  cities: readonly { name: string }[],
): string | null {
  if (preferred && cities.some(({ name }) => name === preferred)) return preferred;
  return cities[0]?.name ?? null;
}

export function cityQueryRoot(
  hostId: string,
  endpointUrl: string,
  cityName: string,
  rigName: string | null,
) {
  return ["gas-city", hostId, endpointUrl, cityName, rigName ?? "all-rigs"] as const;
}

export interface SlingArguments {
  beadId: string;
  agent: string;
}

function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }

  if (escaped) token += "\\";
  if (quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

export function parseSlingArguments(input: string): SlingArguments | null {
  const tokens = tokenize(input);
  if (!tokens || tokens.length > 2) return null;
  return { beadId: tokens[0] ?? "", agent: tokens[1] ?? "" };
}

export function sessionAccessibilityLabel(session: GasCitySession): string {
  const state = session.running ? "running" : session.state;
  const rig = session.rigName ? `Rig ${session.rigName}` : "City session";
  const activity = session.activity ? `Activity ${session.activity}` : "No reported activity";
  return `${session.title}. ${state}. ${rig}. Provider ${session.provider}. ${activity}.`;
}

export function convoyProgress(convoy: GasCityConvoy): string {
  if (convoy.closedWork === null || convoy.totalWork === null) return "Progress unavailable";
  return `${convoy.closedWork} of ${convoy.totalWork} work items closed`;
}
