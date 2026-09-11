import { describe, expect, test } from "bun:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GasCityClient, GasCityClientError } from "../server/gas-city-client";
import { createGasCityHandlers } from "../server/handlers";
import { mapWorkspaceToRig } from "../server/workspace-mapping";
import { GasCitySettingsSchema } from "../shared";

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

const health = {
  status: "ok",
  version: "1.4.1",
  build_id: "build-1",
  uptime_sec: 30,
  cities_total: 1,
  cities_running: 1,
};
const cities = {
  items: [
    {
      name: "alpha-city",
      path: "/city",
      running: true,
      status: "running",
      phases_completed: ["agents"],
    },
  ],
  total: 1,
};
const rigs = {
  items: [
    {
      name: "alpha",
      path: "/work/alpha",
      prefix: "al",
      suspended: false,
      agent_count: 2,
      running_count: 1,
      default_branch: "main",
      last_activity: "2026-09-11T06:00:00Z",
    },
  ],
  total: 1,
};
const status = {
  name: "alpha-city",
  path: "/city",
  version: "1.4.1",
  uptime_sec: 30,
  suspended: false,
  agent_count: 2,
  rig_count: 1,
  running: 1,
  agents: { total: 2, running: 1, suspended: 0, quarantined: 0 },
  rigs: { total: 1, suspended: 0 },
  work: { in_progress: 1, ready: 2, open: 3 },
  mail: {},
  session_counts_detail: { active: 1, suspended: 0 },
};
const sessions = {
  items: [
    {
      id: "session-1",
      kind: "agent",
      template: "alpha/reviewer",
      state: "active",
      title: "Review API",
      provider: "codex",
      session_name: "reviewer-a1b",
      created_at: "2026-09-11T06:00:00Z",
      last_active: "2026-09-11T06:01:00Z",
      attached: false,
      rig: "alpha",
      running: true,
      active_bead: "al-1",
      activity: "in-turn",
      configured_named_session: false,
      submission_capabilities: { message: true, submit: true, respond: true },
    },
  ],
  total: 1,
};
const convoys = {
  items: [
    {
      id: "al-convoy-1",
      title: "Ship API",
      status: "in_progress",
      issue_type: "convoy",
      created_at: "2026-09-11T06:00:00Z",
      priority: 1,
      is_blocked: true,
    },
  ],
  total: 1,
};
const pending = {
  items: [{ session_id: "session-1", request_id: "permission-1", kind: "tool-approval" }],
  total: 1,
};
const events = {
  items: [
    {
      seq: 42,
      type: "session.woke",
      ts: "2026-09-11T06:00:00Z",
      actor: "orchestrator",
      subject: "session-1",
      message: "Session started",
      payload: { running: true },
    },
  ],
  total: 1,
};

function fixtureFetch(request: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(request));
  const path = `${url.pathname}${url.search}`;
  if (path === "/health") return Promise.resolve(jsonResponse(health));
  if (path === "/v0/cities") return Promise.resolve(jsonResponse(cities));
  if (path === "/v0/city/alpha-city/status") return Promise.resolve(jsonResponse(status));
  if (path === "/v0/city/alpha-city/rigs") return Promise.resolve(jsonResponse(rigs));
  if (path.startsWith("/v0/city/alpha-city/sessions"))
    return Promise.resolve(jsonResponse(sessions));
  if (path.startsWith("/v0/city/alpha-city/convoys")) return Promise.resolve(jsonResponse(convoys));
  if (path === "/v0/city/alpha-city/pending") return Promise.resolve(jsonResponse(pending));
  if (path.startsWith("/v0/city/alpha-city/events")) return Promise.resolve(jsonResponse(events));
  if (path === "/v0/events?limit=10") {
    return Promise.resolve(
      jsonResponse({ ...events, items: [{ ...events.items[0], city: "alpha-city" }] }),
    );
  }
  if (path === "/v0/city/alpha-city/sling") {
    expect(new Headers(init?.headers).get("X-GC-Request")).toBeTruthy();
    return Promise.resolve(
      jsonResponse({ status: "slung", target: "alpha/reviewer", bead: "al-1", warnings: [] }),
    );
  }
  if (path === "/v0/city/alpha-city/session/session-1/messages") {
    expect(new Headers(init?.headers).get("X-GC-Request")).toBeTruthy();
    return Promise.resolve(
      jsonResponse({ status: "accepted", request_id: "request-1", event_cursor: "42" }),
    );
  }
  return Promise.resolve(jsonResponse({ title: "not found" }, { status: 404 }));
}

function handlerFixture(mutationsEnabled = false) {
  const settings = GasCitySettingsSchema.parse({ mutationsEnabled });
  const client = new GasCityClient({
    endpointUrl: settings.endpointUrl,
    allowRemoteEndpoint: false,
    fetch: fixtureFetch,
  });
  const handlers = createGasCityHandlers({
    getSettings: () => settings,
    createClient: () => client,
    now: () => new Date("2026-09-11T06:00:00Z"),
  });
  const context = {
    paseo: {
      workspaces: {
        ref: () => ({ refresh: async () => ({ workspaceDirectory: "/work/alpha/services/api" }) }),
      },
    },
  } as unknown as PluginHandlerContext;
  return { handlers, context };
}

describe("GasCityClient security boundary", () => {
  test("rejects non-loopback endpoints before fetch by default", async () => {
    let called = false;
    const client = new GasCityClient({
      endpointUrl: "http://192.0.2.10:8372",
      allowRemoteEndpoint: false,
      fetch: async () => {
        called = true;
        return jsonResponse(health);
      },
    });
    await expect(client.health()).rejects.toMatchObject({ code: "endpoint-not-allowed" });
    expect(called).toBeFalse();
  });

  test("rejects credentials, fragments, and non-http schemes", () => {
    for (const endpointUrl of [
      "http://user:pass@127.0.0.1:8372",
      "http://127.0.0.1:8372/#secret",
      "file:///tmp/gc.sock",
    ]) {
      expect(() => new GasCityClient({ endpointUrl, allowRemoteEndpoint: false })).toThrow(
        GasCityClientError,
      );
    }
  });

  test("rejects localhost when DNS returns any non-loopback address", async () => {
    const client = new GasCityClient({
      endpointUrl: "http://localhost:8372",
      allowRemoteEndpoint: false,
      fetch: fixtureFetch,
      lookup: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "192.0.2.10", family: 4 },
      ],
    });
    await expect(client.health()).rejects.toMatchObject({ code: "endpoint-not-allowed" });
  });

  test("rejects redirects to a disallowed host", async () => {
    let calls = 0;
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "http://192.0.2.2/x" } });
      },
    });
    await expect(client.health()).rejects.toMatchObject({ code: "endpoint-not-allowed" });
    expect(calls).toBe(1);
  });

  test("enforces response byte limits", async () => {
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      maxResponseBytes: 8,
      fetch: async () => jsonResponse(health),
    });
    await expect(client.health()).rejects.toMatchObject({ code: "response-too-large" });
  });

  test("rejects malformed upstream payloads", async () => {
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      fetch: async () => jsonResponse({ ...health, cities_total: "one" }),
    });
    await expect(client.health()).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("workspace-to-rig mapping", () => {
  test("uses the canonical longest ancestor and reports ties", async () => {
    const common = {
      workspaceId: "workspace-1",
      workspacePath: "/real/work/services/api",
      cities: cities.items,
      overrides: [],
      canonicalizePath: async (path: string) => path.replace("/link", "/real"),
    };
    const mapped = await mapWorkspaceToRig({
      ...common,
      rigsByCity: new Map([
        [
          "alpha-city",
          [
            { ...rigs.items[0], name: "root", path: "/link/work" },
            { ...rigs.items[0], name: "services", path: "/link/work/services" },
          ],
        ],
      ]),
    });
    expect(mapped).toMatchObject({
      state: "mapped",
      rigName: "services",
      source: "longest-ancestor",
    });

    const ambiguous = await mapWorkspaceToRig({
      ...common,
      rigsByCity: new Map([
        [
          "alpha-city",
          [
            { ...rigs.items[0], name: "one", path: "/real/work" },
            { ...rigs.items[0], name: "two", path: "/real/work" },
          ],
        ],
      ]),
    });
    expect(ambiguous.state).toBe("ambiguous");
  });

  test("explicit mappings take precedence over path ancestry", async () => {
    const mapped = await mapWorkspaceToRig({
      workspaceId: "workspace-1",
      workspacePath: "/outside",
      cities: cities.items,
      rigsByCity: new Map([["alpha-city", rigs.items]]),
      overrides: [{ workspaceId: "workspace-1", cityName: "alpha-city", rigName: "alpha" }],
    });
    expect(mapped).toMatchObject({ state: "mapped", rigName: "alpha", source: "explicit" });
  });
});

describe("Gas City RPC handlers", () => {
  test("normalizes discovery, mapping, snapshots, sessions, convoys, events, and attention", async () => {
    const { handlers, context } = handlerFixture();
    expect(await handlers.discoverSupervisor({}, context)).toMatchObject({
      state: "available",
      supervisor: { endpointUrl: "http://127.0.0.1:8372", version: "1.4.1" },
    });
    expect(
      await handlers.resolveWorkspaceRig({ workspaceId: "workspace-1" }, context),
    ).toMatchObject({
      state: "mapped",
      rigName: "alpha",
    });
    expect(
      await handlers.getCityRigSnapshot({ cityName: "alpha-city", rigName: "alpha" }, context),
    ).toMatchObject({
      city: { work: { open: 3, ready: 2, inProgress: 1 } },
      rig: { name: "alpha" },
      partial: false,
    });
    expect(
      await handlers.listSessions({ cityName: "alpha-city", rigName: "alpha" }, context),
    ).toMatchObject({
      items: [{ id: "session-1", provider: "codex", activeBeadId: "al-1" }],
      truncated: false,
    });
    expect(
      await handlers.listConvoys({ cityName: "alpha-city", rigName: "alpha" }, context),
    ).toMatchObject({
      items: [{ id: "al-convoy-1", rigName: "alpha", blocked: true }],
    });
    expect(
      await handlers.listEvents(
        { scope: "city", cityName: "alpha-city", afterSequence: 41, limit: 10 },
        context,
      ),
    ).toMatchObject({ items: [{ sequence: 42, cityName: "alpha-city" }] });
    expect(
      await handlers.listAttention({ cityName: "alpha-city", rigName: "alpha" }, context),
    ).toMatchObject({
      items: [
        { id: "session:session-1:pending", code: "interaction-pending" },
        { id: "convoy:al-convoy-1:blocked", code: "convoy-blocked" },
      ],
    });
    expect(
      await handlers.listProviderSelections({ cityName: "alpha-city" }, context),
    ).toMatchObject({
      items: [
        {
          selection: { cityName: "alpha-city", sessionId: "session-1" },
          upstreamProvider: "codex",
          selectable: true,
        },
      ],
      truncated: false,
    });
  });

  test("keeps mutations observe-only unless enabled and preserves correlation headers", async () => {
    const disabled = handlerFixture();
    await expect(
      disabled.handlers.dispatchWork(
        {
          kind: "bead",
          confirmed: true,
          target: { cityName: "alpha-city", rigName: "alpha", agent: "alpha/reviewer" },
          beadId: "al-1",
          reassign: false,
          owned: false,
          force: false,
          noFormula: false,
          noConvoy: false,
          merge: "direct",
        },
        disabled.context,
      ),
    ).rejects.toThrow("mutations are disabled");

    const enabled = handlerFixture(true);
    expect(
      await enabled.handlers.dispatchWork(
        {
          kind: "bead",
          confirmed: true,
          target: { cityName: "alpha-city", rigName: "alpha", agent: "alpha/reviewer" },
          beadId: "al-1",
          reassign: false,
          owned: false,
          force: false,
          noFormula: false,
          noConvoy: false,
          merge: "direct",
        },
        enabled.context,
      ),
    ).toMatchObject({ status: "slung", beadId: "al-1" });
    expect(
      await enabled.handlers.performSessionAction(
        {
          action: "message",
          cityName: "alpha-city",
          sessionId: "session-1",
          confirmed: true,
          message: "Continue.",
        },
        enabled.context,
      ),
    ).toEqual({
      status: "accepted",
      sessionId: "session-1",
      requestId: "request-1",
      eventCursor: "42",
    });
  });
});
