import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { GAS_CITY_LIMITS } from "../shared/limits";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalString = z.string().optional();
const nullableItems = <T extends z.ZodType>(item: T, maximum: number) =>
  z.object({
    items: z.array(item).max(maximum).nullable(),
    total: nonnegativeInteger,
    next_cursor: optionalString,
    partial: z.boolean().optional(),
    partial_errors: z.array(z.string()).max(GAS_CITY_LIMITS.diagnostics).nullable().optional(),
  });

export const UpstreamHealthSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    build_id: optionalString,
    uptime_sec: nonnegativeInteger,
    cities_total: nonnegativeInteger,
    cities_running: nonnegativeInteger,
    packs_lock_sha256: optionalString,
    startup: z
      .object({
        ready: z.boolean(),
        phase: optionalString,
        phases_completed: z
          .array(z.string())
          .max(GAS_CITY_LIMITS.diagnostics)
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const UpstreamCitySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    running: z.boolean(),
    status: optionalString,
    error: optionalString,
    phases_completed: z.array(z.string()).max(GAS_CITY_LIMITS.diagnostics).nullable().optional(),
  })
  .strict();

export const UpstreamCitiesSchema = z
  .object({
    items: z.array(UpstreamCitySchema).max(GAS_CITY_LIMITS.cities).nullable(),
    total: nonnegativeInteger,
  })
  .strict();

export const UpstreamRigSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    suspended: z.boolean(),
    prefix: optionalString,
    default_branch: optionalString,
    agent_count: nonnegativeInteger,
    running_count: nonnegativeInteger,
    last_activity: optionalString,
  })
  .strict();

export const UpstreamRigsSchema = nullableItems(UpstreamRigSchema, GAS_CITY_LIMITS.rigs).strict();

const countGroup = (keys: readonly string[]) =>
  z.object(Object.fromEntries(keys.map((key) => [key, nonnegativeInteger]))).strict();

export const UpstreamStatusSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    version: optionalString,
    uptime_sec: nonnegativeInteger,
    suspended: z.boolean(),
    agent_count: nonnegativeInteger,
    rig_count: nonnegativeInteger,
    running: nonnegativeInteger,
    agents: countGroup(["total", "running", "suspended", "quarantined"]),
    rigs: countGroup(["total", "suspended"]),
    work: countGroup(["in_progress", "ready", "open"]),
    mail: z.object({}).passthrough(),
    session_counts_detail: countGroup(["active", "suspended"]).optional(),
    partial: z.boolean().optional(),
    partial_errors: z.array(z.string()).max(GAS_CITY_LIMITS.diagnostics).nullable().optional(),
    agent_details: z.array(z.unknown()).nullable().optional(),
    named_session_details: z.array(z.unknown()).nullable().optional(),
    rig_details: z.array(z.unknown()).nullable().optional(),
    beads: z.unknown().optional(),
    beads_version: optionalString,
    dolt_version: optionalString,
    conditional_writes: z.unknown().optional(),
    store_health: z.unknown().optional(),
  })
  .strict();

export const UpstreamSessionSchema = z
  .object({
    id: z.string(),
    kind: optionalString,
    template: z.string(),
    state: z.string(),
    reason: optionalString,
    title: z.string(),
    alias: optionalString,
    provider: z.string(),
    display_name: optionalString,
    session_name: z.string(),
    work_dir: optionalString,
    created_at: z.string(),
    last_active: optionalString,
    last_nudge_delivered_at: optionalString,
    attached: z.boolean(),
    rig: optionalString,
    pool: optionalString,
    agent_kind: optionalString,
    running: z.boolean(),
    active_bead: optionalString,
    last_output: optionalString,
    model: optionalString,
    context_pct: z.number().int().optional(),
    context_window: z.number().int().optional(),
    activity: optionalString,
    submission_capabilities: z
      .object({
        message: z.boolean().optional(),
        submit: z.boolean().optional(),
        respond: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    configured_named_session: z.boolean().optional(),
    options: z.record(z.string(), z.string()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const UpstreamSessionsSchema = nullableItems(
  UpstreamSessionSchema,
  GAS_CITY_LIMITS.sessions,
).strict();

export const UpstreamConvoySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    issue_type: z.string(),
    created_at: z.string(),
    updated_at: optionalString,
    priority: z.number().int().min(0).max(4).optional(),
    assignee: optionalString,
    is_blocked: z.boolean().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const UpstreamConvoysSchema = nullableItems(
  UpstreamConvoySchema,
  GAS_CITY_LIMITS.convoys,
).strict();

export const UpstreamEventSchema = z
  .object({
    seq: nonnegativeInteger,
    type: z.string(),
    ts: z.string(),
    actor: z.string(),
    subject: optionalString,
    message: optionalString,
    city: optionalString,
    session_id: optionalString,
    run_id: optionalString,
    step_id: optionalString,
    payload: z.record(z.string(), z.unknown()),
    workflow: z.unknown().optional(),
  })
  .strict();

export const UpstreamEventsSchema = nullableItems(
  UpstreamEventSchema,
  GAS_CITY_LIMITS.events,
).strict();

export const UpstreamPendingSchema = nullableItems(
  z
    .object({
      session_id: z.string(),
      request_id: z.string(),
      kind: z.string(),
    })
    .strict(),
  GAS_CITY_LIMITS.attentionItems,
).strict();

export const UpstreamSlingResultSchema = z
  .object({
    status: z.string(),
    target: z.string(),
    formula: optionalString,
    bead: optionalString,
    workflow_id: optionalString,
    root_bead_id: optionalString,
    attached_bead_id: optionalString,
    mode: optionalString,
    warnings: z.array(z.string()).max(GAS_CITY_LIMITS.warnings).nullable().optional(),
    dashboard_url: optionalString,
    run: z.unknown().optional(),
  })
  .strict();

export const UpstreamSessionActionResultSchema = z
  .object({
    status: z.string(),
    id: optionalString,
    request_id: optionalString,
    event_cursor: z.union([z.string(), z.number().int().nonnegative()]).optional(),
  })
  .strict();

export type UpstreamHealth = z.infer<typeof UpstreamHealthSchema>;
export type UpstreamCity = z.infer<typeof UpstreamCitySchema>;
export type UpstreamRig = z.infer<typeof UpstreamRigSchema>;
export type UpstreamStatus = z.infer<typeof UpstreamStatusSchema>;
export type UpstreamSession = z.infer<typeof UpstreamSessionSchema>;
export type UpstreamConvoy = z.infer<typeof UpstreamConvoySchema>;
export type UpstreamEvent = z.infer<typeof UpstreamEventSchema>;

export type GasCityClientErrorCode =
  | "invalid-endpoint"
  | "endpoint-not-allowed"
  | "timeout"
  | "unreachable"
  | "upstream-error"
  | "invalid-response"
  | "response-too-large";

export class GasCityClientError extends Error {
  readonly code: GasCityClientErrorCode;
  readonly status: number | null;
  readonly correlationId: string | null;

  constructor(
    code: GasCityClientErrorCode,
    message: string,
    options: { status?: number; correlationId?: string | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GasCityClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.correlationId = options.correlationId ?? null;
  }
}

type Lookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GasCityClientOptions {
  endpointUrl: string;
  allowRemoteEndpoint: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: Fetch;
  lookup?: Lookup;
}

interface RequestOptions<T extends z.ZodType> {
  schema: T;
  method?: "GET" | "POST";
  body?: unknown;
  mutation?: boolean;
  signal?: AbortSignal;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "::1" ||
    normalized.startsWith("::ffff:127.") ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new GasCityClientError("invalid-endpoint", "Gas City endpoint is invalid.", { cause });
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new GasCityClientError("invalid-endpoint", "Gas City endpoint must use HTTP or HTTPS.");
  }
  if (endpoint.username || endpoint.password) {
    throw new GasCityClientError(
      "invalid-endpoint",
      "Gas City endpoint cannot contain credentials.",
    );
  }
  if (endpoint.hash) {
    throw new GasCityClientError(
      "invalid-endpoint",
      "Gas City endpoint cannot contain a fragment.",
    );
  }
  endpoint.search = "";
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/`;
  return endpoint;
}

async function assertEndpointAllowed(
  url: URL,
  allowRemoteEndpoint: boolean,
  lookup: Lookup,
): Promise<void> {
  if (allowRemoteEndpoint) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isLoopbackAddress(hostname)) return;
    throw new GasCityClientError(
      "endpoint-not-allowed",
      "Gas City endpoint must be loopback unless remote endpoints are enabled.",
    );
  }
  if (hostname !== "localhost") {
    throw new GasCityClientError(
      "endpoint-not-allowed",
      "Gas City endpoint must use an explicit loopback host.",
    );
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new GasCityClientError("unreachable", "Gas City supervisor is unreachable.", { cause });
  }
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(({ address }) => !isLoopbackAddress(address))
  ) {
    throw new GasCityClientError(
      "endpoint-not-allowed",
      "Gas City endpoint did not resolve exclusively to loopback addresses.",
    );
  }
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximum) {
    throw new GasCityClientError(
      "response-too-large",
      "Gas City response exceeded the size limit.",
      {
        status: response.status,
        correlationId: response.headers.get("x-gc-request-id"),
      },
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new GasCityClientError(
        "response-too-large",
        "Gas City response exceeded the size limit.",
        {
          status: response.status,
          correlationId: response.headers.get("x-gc-request-id"),
        },
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export class GasCityClient {
  readonly endpoint: URL;
  private readonly allowRemoteEndpoint: boolean;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: Fetch;
  private readonly lookup: Lookup;

  constructor(options: GasCityClientOptions) {
    this.endpoint = parseEndpoint(options.endpointUrl);
    this.allowRemoteEndpoint = options.allowRemoteEndpoint;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.lookup = options.lookup ?? (dnsLookup as Lookup);
  }

  private async request<T extends z.ZodType>(
    path: string,
    options: RequestOptions<T>,
  ): Promise<z.output<T>> {
    let url = new URL(path.replace(/^\//, ""), this.endpoint);
    let redirects = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        await assertEndpointAllowed(url, this.allowRemoteEndpoint, this.lookup);
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: options.method ?? "GET",
            headers: {
              accept: "application/json",
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
              ...(options.mutation ? { "X-GC-Request": crypto.randomUUID() } : {}),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            throw new GasCityClientError("timeout", "Gas City request timed out.", { cause });
          }
          throw new GasCityClientError("unreachable", "Gas City supervisor is unreachable.", {
            cause,
          });
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (options.mutation || !location || redirects++ >= MAX_REDIRECTS) {
            throw new GasCityClientError("upstream-error", "Gas City rejected the request.", {
              status: response.status,
              correlationId: response.headers.get("x-gc-request-id"),
            });
          }
          url = new URL(location, url);
          continue;
        }

        const correlationId = response.headers.get("x-gc-request-id");
        const text = await readBoundedBody(response, this.maxResponseBytes);
        if (!response.ok) {
          console.error("[paseo-gas-city] Gas City request failed", {
            correlationId,
            status: response.status,
            path: url.pathname,
          });
          throw new GasCityClientError("upstream-error", "Gas City rejected the request.", {
            status: response.status,
            correlationId,
          });
        }

        let value: unknown;
        try {
          value = text === "" ? {} : JSON.parse(text);
        } catch (cause) {
          console.error("[paseo-gas-city] Gas City returned invalid JSON", {
            correlationId,
            path: url.pathname,
          });
          throw new GasCityClientError(
            "invalid-response",
            "Gas City returned an invalid response.",
            {
              correlationId,
              cause,
            },
          );
        }
        const parsed = options.schema.safeParse(value);
        if (!parsed.success) {
          console.error("[paseo-gas-city] Gas City response validation failed", {
            correlationId,
            path: url.pathname,
            issues: parsed.error.issues.slice(0, 8),
          });
          throw new GasCityClientError(
            "invalid-response",
            "Gas City returned an invalid response.",
            {
              correlationId,
              cause: parsed.error,
            },
          );
        }
        return parsed.data;
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  health(signal?: AbortSignal) {
    return this.request("health", { schema: UpstreamHealthSchema, signal });
  }

  cities(signal?: AbortSignal) {
    return this.request("v0/cities", { schema: UpstreamCitiesSchema, signal });
  }

  cityStatus(cityName: string, signal?: AbortSignal) {
    return this.request(`v0/city/${encodeURIComponent(cityName)}/status`, {
      schema: UpstreamStatusSchema,
      signal,
    });
  }

  rigs(cityName: string, signal?: AbortSignal) {
    return this.request(`v0/city/${encodeURIComponent(cityName)}/rigs`, {
      schema: UpstreamRigsSchema,
      signal,
    });
  }

  sessions(cityName: string, signal?: AbortSignal) {
    return this.request(
      `v0/city/${encodeURIComponent(cityName)}/sessions?limit=${GAS_CITY_LIMITS.sessions}`,
      { schema: UpstreamSessionsSchema, signal },
    );
  }

  convoys(cityName: string, signal?: AbortSignal) {
    return this.request(
      `v0/city/${encodeURIComponent(cityName)}/convoys?limit=${GAS_CITY_LIMITS.convoys}`,
      { schema: UpstreamConvoysSchema, signal },
    );
  }

  pending(cityName: string, signal?: AbortSignal) {
    return this.request(`v0/city/${encodeURIComponent(cityName)}/pending`, {
      schema: UpstreamPendingSchema,
      signal,
    });
  }

  cityEvents(cityName: string, limit: number, signal?: AbortSignal) {
    return this.request(`v0/city/${encodeURIComponent(cityName)}/events?limit=${limit}`, {
      schema: UpstreamEventsSchema,
      signal,
    });
  }

  supervisorEvents(cursor: string | null, limit: number, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.request(`v0/events?${query}`, { schema: UpstreamEventsSchema, signal });
  }

  sling(cityName: string, body: unknown, signal?: AbortSignal) {
    return this.request(`v0/city/${encodeURIComponent(cityName)}/sling`, {
      schema: UpstreamSlingResultSchema,
      method: "POST",
      body,
      mutation: true,
      signal,
    });
  }

  sessionAction(
    cityName: string,
    sessionId: string,
    action: string,
    body: unknown,
    signal?: AbortSignal,
  ) {
    return this.request(
      `v0/city/${encodeURIComponent(cityName)}/session/${encodeURIComponent(sessionId)}/${action}`,
      {
        schema: UpstreamSessionActionResultSchema,
        method: "POST",
        body,
        mutation: true,
        signal,
      },
    );
  }
}
