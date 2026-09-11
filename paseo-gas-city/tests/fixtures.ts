import type {
  AttentionList,
  CityRigSnapshot,
  ConvoyList,
  DispatchRequest,
  DispatchResult,
  EventList,
  GasCityProviderSelection,
  GasCitySettings,
  ProviderSelectionList,
  SessionActionRequest,
  SessionActionResult,
  SessionList,
  SupervisorDiscovery,
  WorkspaceRigMapping,
} from "../shared";

export const FIXTURE_TIMESTAMP = "2026-09-11T06:00:00Z";

export const supervisorDiscoveryFixture = {
  state: "available",
  supervisor: {
    endpointUrl: "http://127.0.0.1:7375",
    version: "1.1.1",
    buildId: "abc1234",
    uptimeSeconds: 3_600,
    cityCount: 1,
    runningCityCount: 1,
  },
  cities: [
    {
      name: "alpha-city",
      path: "/srv/gas-city/alpha",
      running: true,
      status: "running",
      error: null,
      completedPhases: ["config", "providers", "agents"],
    },
  ],
  diagnostics: [],
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies SupervisorDiscovery;

export const workspaceRigMappingFixture = {
  state: "mapped",
  workspaceId: "workspace-1",
  workspacePath: "/work/alpha/services/api",
  cityName: "alpha-city",
  rigName: "alpha",
  rigPath: "/work/alpha",
  source: "longest-ancestor",
  candidates: [
    {
      cityName: "alpha-city",
      rigName: "alpha",
      rigPath: "/work/alpha",
    },
  ],
  diagnostics: [],
} satisfies WorkspaceRigMapping;

export const cityRigSnapshotFixture = {
  city: {
    ...supervisorDiscoveryFixture.cities[0],
    suspended: false,
    uptimeSeconds: 3_550,
    agents: { total: 4, running: 2, suspended: 1, quarantined: 0 },
    sessions: { active: 2, suspended: 1 },
    work: { open: 8, ready: 3, inProgress: 2 },
  },
  rig: {
    name: "alpha",
    path: "/work/alpha",
    prefix: "al",
    suspended: false,
    agentCount: 3,
    runningAgentCount: 2,
    defaultBranch: "main",
    lastActivityAt: FIXTURE_TIMESTAMP,
  },
  rigs: [
    {
      name: "alpha",
      path: "/work/alpha",
      prefix: "al",
      suspended: false,
      agentCount: 3,
      runningAgentCount: 2,
      defaultBranch: "main",
      lastActivityAt: FIXTURE_TIMESTAMP,
    },
  ],
  partial: false,
  diagnostics: [],
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies CityRigSnapshot;

export const sessionsFixture = {
  items: [
    {
      id: "al-session-1",
      cityName: "alpha-city",
      rigName: "alpha",
      template: "alpha/reviewer",
      state: "active",
      title: "Review API",
      provider: "codex",
      sessionName: "reviewer-a1b",
      createdAt: FIXTURE_TIMESTAMP,
      lastActiveAt: FIXTURE_TIMESTAMP,
      attached: false,
      running: true,
      configuredNamedSession: false,
      activity: "working",
      activeBeadId: "al-123",
      model: "gpt-5.6",
      kind: "agent",
      submissionKinds: ["message", "submit", "respond"],
    },
  ],
  truncated: false,
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies SessionList;

export const convoysFixture = {
  items: [
    {
      id: "al-convoy-1",
      cityName: "alpha-city",
      rigName: "alpha",
      title: "Ship API",
      status: "in_progress",
      priority: 1,
      assignee: "alpha/reviewer",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      totalWork: 4,
      closedWork: 2,
      blocked: false,
    },
  ],
  truncated: false,
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies ConvoyList;

export const eventsFixture = {
  items: [
    {
      cityName: "alpha-city",
      sequence: 42,
      type: "session.woke",
      actor: "orchestrator",
      subject: "al-session-1",
      message: "Session started",
      timestamp: FIXTURE_TIMESTAMP,
      metadata: { provider: "codex", running: true },
    },
  ],
  cursor: "alpha-city:42",
  truncated: false,
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies EventList;

export const attentionFixture = {
  items: [
    {
      id: "session:al-session-1:pending",
      cityName: "alpha-city",
      rigName: "alpha",
      kind: "session",
      severity: "warning",
      code: "interaction-pending",
      title: "Reviewer needs input",
      message: "The session is waiting for an operator response.",
      resourceId: "al-session-1",
      observedAt: FIXTURE_TIMESTAMP,
    },
  ],
  truncated: false,
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies AttentionList;

export const dispatchRequestFixture = {
  kind: "bead",
  confirmed: true,
  target: { cityName: "alpha-city", rigName: "alpha", agent: "alpha/reviewer" },
  beadId: "al-123",
  reassign: false,
  owned: false,
  force: false,
  noFormula: false,
  noConvoy: false,
  merge: "direct",
} satisfies DispatchRequest;

export const dispatchFormulaRequestFixture = {
  kind: "formula",
  confirmed: true,
  target: { cityName: "alpha-city", rigName: "alpha", agent: "alpha/reviewer" },
  formula: "review-change",
  title: "Review API",
  attachedBeadId: "al-123",
  variables: { depth: "full", retries: 2 },
  force: false,
  merge: "direct",
} satisfies DispatchRequest;

export const dispatchResultFixture = {
  status: "slung",
  target: "alpha/reviewer",
  beadId: "al-123",
  formula: null,
  workflowId: null,
  rootBeadId: null,
  dashboardUrl: "http://127.0.0.1:7375/cities/alpha-city/runs",
  warnings: [],
} satisfies DispatchResult;

export const sessionActionRequestFixture = {
  action: "submit",
  cityName: "alpha-city",
  sessionId: "al-session-1",
  confirmed: true,
  message: "Continue with the review.",
  intent: "follow_up",
} satisfies SessionActionRequest;

export const sessionActionRequestFixtures = [
  {
    action: "wake",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
  },
  {
    action: "stop",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
  },
  {
    action: "suspend",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
  },
  {
    action: "close",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
  },
  {
    action: "kill",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
  },
  {
    action: "message",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
    message: "Check the latest change.",
  },
  sessionActionRequestFixture,
  {
    action: "respond",
    cityName: "alpha-city",
    sessionId: "al-session-1",
    confirmed: true,
    requestId: "permission-1",
    response: "allow",
    text: null,
    metadata: {},
  },
] satisfies SessionActionRequest[];

export const sessionActionResultFixture = {
  status: "accepted",
  sessionId: "al-session-1",
  requestId: "request-1",
  eventCursor: "42",
} satisfies SessionActionResult;

export const providerSelectionFixture = {
  cityName: "alpha-city",
  sessionId: "al-session-1",
} satisfies GasCityProviderSelection;

export const providerSelectionsFixture = {
  items: [
    {
      selection: providerSelectionFixture,
      label: "alpha-city / reviewer",
      detail: "Review API",
      upstreamProvider: "codex",
      running: true,
      selectable: true,
      unavailableReason: null,
    },
  ],
  truncated: false,
  refreshedAt: FIXTURE_TIMESTAMP,
} satisfies ProviderSelectionList;

export const settingsFixture = {
  endpointUrl: "http://127.0.0.1:7375",
  allowRemoteEndpoint: false,
  mutationsEnabled: false,
  refreshIntervalMs: 10_000,
  eventLimit: 100,
  workspaceMappings: [{ workspaceId: "workspace-1", cityName: "alpha-city", rigName: "alpha" }],
} satisfies GasCitySettings;
