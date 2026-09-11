import { describe, expect, test } from "bun:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GasCityClient, GasCityClientError } from "../server/gas-city-client";
import { createGasCityHandlers } from "../server/handlers";
import { mapWorkspaceToRig } from "../server/workspace-mapping";
import { GasCitySettingsSchema, toGasCityRpcSettings } from "../shared";

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
      git: { branch: "main", clean: true, changed_files: 0, ahead: 0, behind: 0 },
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
const work = {
  items: [
    {
      id: "al-1",
      title: "Review API",
      status: "in_progress",
      issue_type: "task",
      created_at: "2026-09-11T06:00:00Z",
      updated_at: "2026-09-11T06:01:00Z",
      priority: 1,
      assignee: "alpha/reviewer",
      is_blocked: false,
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
  if (path.startsWith("/v0/city/alpha-city/beads")) return Promise.resolve(jsonResponse(work));
  if (path === "/v0/events?limit=100") {
    return Promise.resolve(
      jsonResponse({
        event_cursor: "alpha-city:42",
        items: [{ ...events.items[0], city: "alpha-city" }],
        total: 1,
      }),
    );
  }
  if (path === "/v0/city/alpha-city/sling") {
    expect(new Headers(init?.headers).get("X-GC-Request")).toBeTruthy();
    return Promise.resolve(
      jsonResponse({ status: "slung", target: "alpha/reviewer", bead: "al-1", warnings: [] }),
    );
  }
  if (path === "/v0/city/alpha-city/session/session-1/respond") {
    expect(JSON.parse(String(init?.body))).toEqual({
      request_id: "permission-1",
      action: "allow",
      metadata: {},
    });
    return Promise.resolve(jsonResponse({ status: "accepted", id: "session-1" }));
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
  const rpcSettings = toGasCityRpcSettings(settings);
  const handlers = createGasCityHandlers({
    createClient: (requestSettings) =>
      new GasCityClient({
        endpointUrl: requestSettings.endpointUrl,
        allowRemoteEndpoint: requestSettings.allowRemoteEndpoint,
        fetch: fixtureFetch,
      }),
    now: () => new Date("2026-09-11T06:00:00Z"),
  });
  const context = {
    paseo: {
      workspaces: {
        ref: () => ({ refresh: async () => ({ workspaceDirectory: "/work/alpha/services/api" }) }),
      },
    },
  } as unknown as PluginHandlerContext;
  return { handlers, context, settings: rpcSettings };
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
      "http://127.0.0.1:8372?token=secret",
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

  test("passes city pagination cursors without inventing supervisor cursors", async () => {
    const requests: string[] = [];
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      fetch: async (request) => {
        requests.push(String(request));
        return jsonResponse(events);
      },
    });
    await client.cityEvents("alpha-city", "next-page", 25);
    expect(requests).toEqual([
      "http://127.0.0.1:8372/v0/city/alpha-city/events?limit=25&cursor=next-page",
    ]);
  });

  test("reports caller cancellation separately from timeout", async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const controller = new AbortController();
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      fetch: async (_request, init) => {
        init?.signal?.addEventListener("abort", () =>
          response.reject(new DOMException("Aborted", "AbortError")),
        );
        started.resolve();
        return response.promise;
      },
    });
    const request = client.health(controller.signal);
    await started.promise;
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "canceled" });
  });

  test("preserves the bounded-response error when stream cancellation fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("too-large"));
      },
      cancel() {
        throw new Error("cancel callback failed");
      },
    });
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      maxResponseBytes: 2,
      fetch: async () => new Response(body),
    });
    await expect(client.health()).rejects.toMatchObject({ code: "response-too-large" });
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

  test("reports missing paths, unmatched paths, and stale overrides honestly", async () => {
    const common = {
      workspaceId: "workspace-1",
      cities: cities.items,
      rigsByCity: new Map([["alpha-city", rigs.items]]),
    };
    await expect(
      mapWorkspaceToRig({ ...common, workspacePath: null, overrides: [] }),
    ).resolves.toMatchObject({
      state: "unmapped",
      diagnostics: [{ code: "workspace-path-unavailable" }],
    });
    await expect(
      mapWorkspaceToRig({ ...common, workspacePath: "/elsewhere", overrides: [] }),
    ).resolves.toMatchObject({ state: "unmapped", candidates: [] });
    await expect(
      mapWorkspaceToRig({
        ...common,
        workspacePath: "/work/alpha",
        overrides: [{ workspaceId: "workspace-1", cityName: "alpha-city", rigName: "missing" }],
      }),
    ).resolves.toMatchObject({
      state: "unavailable",
      source: "explicit",
      diagnostics: [{ code: "mapping-target-unavailable" }],
    });
  });
});

describe("Gas City RPC handlers", () => {
  test("normalizes scoped control-plane data", async () => {
    const { handlers, context, settings } = handlerFixture();
    expect(await handlers.discoverSupervisor({ settings }, context)).toMatchObject({
      state: "available",
      supervisor: { endpointUrl: "http://127.0.0.1:8372", version: "1.4.1" },
    });
    expect(
      await handlers.resolveWorkspaceRig({ settings, workspaceId: "workspace-1" }, context),
    ).toMatchObject({ state: "mapped", rigName: "alpha" });
    const scope = { settings, cityName: "alpha-city", rigName: "alpha" } as const;
    expect(await handlers.getCityRigSnapshot(scope, context)).toMatchObject({
      city: { work: { open: 3, ready: 2, inProgress: 1 }, totalsScope: "city" },
      rig: { name: "alpha", git: { branch: "main", clean: true } },
      partial: false,
    });
    expect(await handlers.listSessions(scope, context)).toMatchObject({
      scope: "rig",
      items: [{ id: "session-1", provider: "codex", activeBeadId: "al-1" }],
      truncated: false,
    });
    expect(await handlers.listConvoys(scope, context)).toMatchObject({
      scope: "rig-and-unattributed",
      items: [{ id: "al-convoy-1", rigName: null, blocked: true }],
    });
    expect(await handlers.listWork(scope, context)).toMatchObject({
      scope: "rig",
      items: [{ id: "al-1", rigName: "alpha", status: "in_progress" }],
      partial: false,
    });
    expect(
      await handlers.listEvents(
        { settings, scope: "city", cityName: "alpha-city", cursor: null },
        context,
      ),
    ).toMatchObject({ scope: "city", items: [{ sequence: 42, cityName: "alpha-city" }] });
    expect(await handlers.listAttention(scope, context)).toMatchObject({
      scope: "city-and-rig",
      items: [
        {
          id: "session:session-1:pending:permission-1",
          code: "interaction-pending",
          requestId: "permission-1",
        },
        { id: "convoy:al-convoy-1:blocked", code: "convoy-blocked" },
      ],
    });
  });

  test("exposes supervisor events as a bounded head snapshot", async () => {
    const { handlers, context, settings } = handlerFixture();
    await expect(
      handlers.listEvents({ settings, scope: "supervisor" }, context),
    ).resolves.toMatchObject({
      scope: "supervisor-head",
      cursor: null,
      items: [{ sequence: 42, cityName: "alpha-city" }],
      truncated: false,
    });
  });

  test("accepts an empty supervisor event page", async () => {
    const client = new GasCityClient({
      endpointUrl: "http://127.0.0.1:8372",
      allowRemoteEndpoint: false,
      fetch: async () => jsonResponse({ event_cursor: "", items: null, total: 0 }),
    });

    await expect(client.supervisorEvents(10)).resolves.toEqual({
      event_cursor: "",
      items: null,
      total: 0,
    });
  });

  test("keeps valid custom events when a page also contains malformed events", async () => {
    const { context, settings } = handlerFixture();
    const handlers = createGasCityHandlers({
      createClient: (requestSettings) =>
        new GasCityClient({
          endpointUrl: requestSettings.endpointUrl,
          allowRemoteEndpoint: requestSettings.allowRemoteEndpoint,
          fetch: async () =>
            jsonResponse({
              items: [
                { ...events.items[0], payload: ["custom", "payload"] },
                { seq: 43, type: "broken", actor: "test", payload: null },
              ],
              total: 2,
            }),
        }),
      now: () => new Date("2026-09-11T06:00:00Z"),
    });

    await expect(
      handlers.listEvents(
        { settings, scope: "city", cityName: "alpha-city", cursor: null },
        context,
      ),
    ).resolves.toMatchObject({
      items: [{ sequence: 42, metadata: {} }],
      truncated: true,
    });
  });

  test("uses the validated RPC settings for connection, limits, and mapping overrides", async () => {
    const settings = toGasCityRpcSettings(
      GasCitySettingsSchema.parse({
        endpointUrl: "http://192.0.2.10:9000",
        allowRemoteEndpoint: true,
        eventLimit: 25,
        workspaceMappings: [
          { workspaceId: "workspace-1", cityName: "alpha-city", rigName: "alpha" },
        ],
      }),
    );
    const observedSettings: unknown[] = [];
    const requests: string[] = [];
    const handlers = createGasCityHandlers({
      createClient: (requestSettings) => {
        observedSettings.push(requestSettings);
        return new GasCityClient({
          endpointUrl: requestSettings.endpointUrl,
          allowRemoteEndpoint: requestSettings.allowRemoteEndpoint,
          fetch: async (request, init) => {
            requests.push(String(request));
            return fixtureFetch(request, init);
          },
        });
      },
      now: () => new Date("2026-09-11T06:00:00Z"),
    });
    const { context } = handlerFixture();

    await handlers.discoverSupervisor({ settings }, context);
    const mapping = await handlers.resolveWorkspaceRig(
      { settings, workspaceId: "workspace-1" },
      context,
    );
    await handlers.listEvents(
      { settings, scope: "city", cityName: "alpha-city", cursor: null },
      context,
    );

    expect(observedSettings).toEqual([settings, settings, settings]);
    expect(mapping).toMatchObject({
      source: "explicit",
      cityName: "alpha-city",
      rigName: "alpha",
    });
    expect(requests).toContain("http://192.0.2.10:9000/v0/city/alpha-city/events?limit=25");
  });

  test("marks attention truncated when an upstream aggregate is partial", async () => {
    const { context, settings } = handlerFixture();
    const handlers = createGasCityHandlers({
      createClient: (requestSettings) =>
        new GasCityClient({
          endpointUrl: requestSettings.endpointUrl,
          allowRemoteEndpoint: requestSettings.allowRemoteEndpoint,
          fetch: (request, init) => {
            const path = new URL(String(request)).pathname;
            if (path === "/v0/city/alpha-city/pending") {
              return Promise.resolve(
                jsonResponse({ ...pending, partial: true, partial_errors: ["rig unavailable"] }),
              );
            }
            return fixtureFetch(request, init);
          },
        }),
      now: () => new Date("2026-09-11T06:00:00Z"),
    });

    await expect(
      handlers.listAttention({ settings, cityName: "alpha-city", rigName: "alpha" }, context),
    ).resolves.toMatchObject({ truncated: true });
  });

  test("returns typed discovery and mapping states for rejected endpoints", async () => {
    const settings = toGasCityRpcSettings(
      GasCitySettingsSchema.parse({
        endpointUrl: "http://192.0.2.10:8372",
        allowRemoteEndpoint: false,
      }),
    );
    const handlers = createGasCityHandlers({ now: () => new Date("2026-09-11T06:00:00Z") });
    const { context } = handlerFixture();

    await expect(handlers.discoverSupervisor({ settings }, context)).resolves.toMatchObject({
      state: "not-configured",
      diagnostics: [{ code: "invalid-endpoint", retryable: false }],
    });
    await expect(
      handlers.resolveWorkspaceRig({ settings, workspaceId: "workspace-1" }, context),
    ).resolves.toMatchObject({
      state: "unavailable",
      diagnostics: [{ code: "mapping-unavailable" }],
    });
  });

  test("surfaces partial city status and a missing requested rig", async () => {
    const { context, settings } = handlerFixture();
    const handlers = createGasCityHandlers({
      createClient: (requestSettings) =>
        new GasCityClient({
          endpointUrl: requestSettings.endpointUrl,
          allowRemoteEndpoint: requestSettings.allowRemoteEndpoint,
          fetch: (request, init) => {
            const path = new URL(String(request)).pathname;
            if (path === "/v0/city/alpha-city/status") {
              return Promise.resolve(jsonResponse({ ...status, partial: true }));
            }
            return fixtureFetch(request, init);
          },
        }),
      now: () => new Date("2026-09-11T06:00:00Z"),
    });

    await expect(
      handlers.getCityRigSnapshot(
        { settings, cityName: "alpha-city", rigName: "missing" },
        context,
      ),
    ).resolves.toMatchObject({
      partial: true,
      rig: null,
      diagnostics: [{ code: "partial-status" }, { code: "rig-not-found" }],
    });
  });

  test("derives city-level attention from degraded status", async () => {
    const { context, settings } = handlerFixture();
    const handlers = createGasCityHandlers({
      createClient: (requestSettings) =>
        new GasCityClient({
          endpointUrl: requestSettings.endpointUrl,
          allowRemoteEndpoint: requestSettings.allowRemoteEndpoint,
          fetch: (request, init) => {
            const path = new URL(String(request)).pathname;
            if (path === "/v0/city/alpha-city/status") {
              return Promise.resolve(
                jsonResponse({
                  ...status,
                  suspended: true,
                  partial: true,
                  agents: { ...status.agents, quarantined: 2 },
                }),
              );
            }
            return fixtureFetch(request, init);
          },
        }),
      now: () => new Date("2026-09-11T06:00:00Z"),
    });

    const response = await handlers.listAttention(
      { settings, cityName: "alpha-city", rigName: null },
      context,
    );
    expect(response.items.map(({ code }) => code)).toEqual([
      "city-suspended",
      "agents-quarantined",
      "partial-status",
      "interaction-pending",
      "convoy-blocked",
    ]);
  });

  test("keeps mutations behind the client safety interlock and preserves correlation", async () => {
    const disabled = handlerFixture();
    const dispatchRequest = {
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
    } as const;
    await expect(
      disabled.handlers.dispatchWork(
        { settings: disabled.settings, request: dispatchRequest },
        disabled.context,
      ),
    ).rejects.toThrow("interactive safety interlock");

    const enabled = handlerFixture(true);
    await expect(
      enabled.handlers.dispatchWork(
        { settings: enabled.settings, request: dispatchRequest },
        enabled.context,
      ),
    ).resolves.toMatchObject({ status: "slung", beadId: "al-1" });
    await expect(
      enabled.handlers.dispatchWork(
        {
          settings: enabled.settings,
          request: {
            kind: "formula",
            confirmed: true,
            target: { cityName: "alpha-city", rigName: null, agent: "reviewer" },
            formula: "review-change",
            title: "Review API",
            attachedBeadId: null,
            variables: { depth: "full" },
            force: false,
            merge: "direct",
          },
        },
        enabled.context,
      ),
    ).resolves.toMatchObject({ status: "slung" });
    await expect(
      enabled.handlers.performSessionAction(
        {
          settings: enabled.settings,
          request: {
            action: "message",
            cityName: "alpha-city",
            sessionId: "session-1",
            confirmed: true,
            message: "Continue.",
          },
        },
        enabled.context,
      ),
    ).resolves.toEqual({
      status: "accepted",
      sessionId: "session-1",
      requestId: "request-1",
      eventCursor: "42",
    });
    await expect(
      enabled.handlers.performSessionAction(
        {
          settings: enabled.settings,
          request: {
            action: "respond",
            cityName: "alpha-city",
            sessionId: "session-1",
            confirmed: true,
            requestId: "permission-1",
            response: "allow",
            text: null,
            metadata: {},
          },
        },
        enabled.context,
      ),
    ).resolves.toMatchObject({ status: "accepted", sessionId: "session-1" });
  });
});
