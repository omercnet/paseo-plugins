import { z } from "zod";
import { GAS_CITY_LIMITS } from "../shared/limits";

export const GAS_CITY_DEFAULT_ENDPOINT_URL = "http://127.0.0.1:8372";

const EXTERNAL_MESSAGING_ROOT = "/api/external-messaging";
const MAX_SSE_FRAME_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = MAX_SSE_FRAME_BYTES * 2;
const MAX_REGISTRATION_BYTES = 16 * 1024;
const JsonObjectSchema = z.record(z.string(), z.unknown());

export type GasCitySseFrame = {
  id: string | null;
  event: "message" | "error" | "heartbeat";
  data: string;
};

export type GasCityRegistration = {
  clientId: string;
  conversationId: string | null;
};

export type GasCityInboundAck = {
  turnId: string | null;
};

export type GasCitySubscription = {
  close(): void;
};

export type GasCityStreamCallbacks = {
  onFrame(frame: GasCitySseFrame): void;
  onDisconnect(error: Error): void;
};

export interface GasCityTransport {
  register(input: {
    endpointUrl: string;
    cityName: string;
    sessionName: string;
    signal?: AbortSignal;
  }): Promise<GasCityRegistration>;
  subscribe(input: {
    endpointUrl: string;
    clientId: string;
    lastEventId: string | null;
    signal?: AbortSignal;
    callbacks: GasCityStreamCallbacks;
  }): Promise<GasCitySubscription>;
  sendInbound(input: {
    endpointUrl: string;
    clientId: string;
    text: string;
    clientMessageId: string;
    signal?: AbortSignal;
  }): Promise<GasCityInboundAck>;
}

export class GasCityTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code: string; retryable: boolean }) {
    super(message);
    this.name = "GasCityTransportError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function validateGasCityEndpointUrl(value: string): string {
  if (value.length === 0 || value.length > GAS_CITY_LIMITS.endpointUrl) {
    throw new GasCityTransportError("Gas City endpoint URL is invalid", {
      code: "invalid_endpoint",
      retryable: false,
    });
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GasCityTransportError("Gas City endpoint URL is invalid", {
      code: "invalid_endpoint",
      retryable: false,
    });
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new GasCityTransportError("Gas City endpoint URL must be a plain HTTP(S) origin", {
      code: "invalid_endpoint",
      retryable: false,
    });
  }

  return url.toString().replace(/\/$/, "");
}

export class FetchGasCityTransport implements GasCityTransport {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  async register(input: {
    endpointUrl: string;
    cityName: string;
    sessionName: string;
    signal?: AbortSignal;
  }): Promise<GasCityRegistration> {
    const response = await this.request(input.endpointUrl, "/register", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ cityName: input.cityName, sessionName: input.sessionName }),
      signal: input.signal,
    });
    const payload = await readJsonObject(response, MAX_REGISTRATION_BYTES, "registration");
    const clientId = boundedString(
      payload.clientId,
      "registration clientId",
      GAS_CITY_LIMITS.identifier,
    );
    const conversationId = optionalBoundedString(
      payload.conversationId,
      "registration conversationId",
      GAS_CITY_LIMITS.identifier,
    );
    return { clientId, conversationId };
  }

  async subscribe(input: {
    endpointUrl: string;
    clientId: string;
    lastEventId: string | null;
    signal?: AbortSignal;
    callbacks: GasCityStreamCallbacks;
  }): Promise<GasCitySubscription> {
    const controller = new AbortController();
    const removeAbortListener = forwardAbort(input.signal, controller);
    let response: Response;

    try {
      response = await this.fetcher(
        this.url(input.endpointUrl, `/${encodeURIComponent(input.clientId)}/events`),
        {
          headers: {
            accept: "text/event-stream",
            ...(input.lastEventId === null ? {} : { "Last-Event-ID": input.lastEventId }),
          },
          signal: controller.signal,
        },
      );
    } catch (error) {
      removeAbortListener();
      throw transportFailure(error);
    }

    if (response.status === 401 || response.status === 403) {
      removeAbortListener();
      controller.abort();
      throw new GasCityTransportError("Gas City external messaging authorization was revoked", {
        code: "authorization_revoked",
        retryable: false,
      });
    }
    if (!response.ok) {
      removeAbortListener();
      controller.abort();
      throw new GasCityTransportError(`Gas City event stream failed with HTTP ${response.status}`, {
        code: "stream_http_error",
        retryable: response.status >= 500,
      });
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      removeAbortListener();
      controller.abort();
      throw new GasCityTransportError("Gas City event stream did not return SSE", {
        code: "invalid_stream",
        retryable: false,
      });
    }
    if (!response.body) {
      removeAbortListener();
      controller.abort();
      throw new GasCityTransportError("Gas City event stream has no body", {
        code: "invalid_stream",
        retryable: false,
      });
    }

    void consumeSse(response.body, input.callbacks, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          input.callbacks.onDisconnect(transportFailure(error));
        }
      })
      .finally(removeAbortListener);

    return { close: () => controller.abort() };
  }

  async sendInbound(input: {
    endpointUrl: string;
    clientId: string;
    text: string;
    clientMessageId: string;
    signal?: AbortSignal;
  }): Promise<GasCityInboundAck> {
    const response = await this.request(
      input.endpointUrl,
      `/${encodeURIComponent(input.clientId)}/inbound`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ text: input.text, clientMessageId: input.clientMessageId }),
        signal: input.signal,
      },
    );
    const payload = await readJsonObject(
      response,
      MAX_REGISTRATION_BYTES,
      "inbound acknowledgement",
    );
    return {
      turnId: optionalBoundedString(payload.turnId, "inbound turnId", GAS_CITY_LIMITS.identifier),
    };
  }

  private async request(endpointUrl: string, path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(this.url(endpointUrl, path), init);
    } catch (error) {
      throw transportFailure(error);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GasCityTransportError("Gas City external messaging authorization was revoked", {
        code: "authorization_revoked",
        retryable: false,
      });
    }
    if (!response.ok) {
      throw new GasCityTransportError(
        `Gas City external messaging failed with HTTP ${response.status}`,
        {
          code: "http_error",
          retryable: response.status >= 500,
        },
      );
    }
    return response;
  }

  private url(endpointUrl: string, suffix: string): string {
    return `${validateGasCityEndpointUrl(endpointUrl)}${EXTERNAL_MESSAGING_ROOT}${suffix}`;
  }
}

export async function parseSseFrames(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: GasCitySseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) {
          throw new GasCityTransportError("Gas City SSE stream ended with a partial frame", {
            code: "malformed_stream",
            retryable: false,
          });
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new GasCityTransportError("Gas City SSE buffer exceeded its limit", {
          code: "stream_too_large",
          retryable: false,
        });
      }
      while (true) {
        const separator = findFrameSeparator(buffer);
        if (separator === null) {
          break;
        }
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.end);
        if (raw.length === 0) {
          continue;
        }
        if (raw.length > MAX_SSE_FRAME_BYTES) {
          throw new GasCityTransportError("Gas City SSE frame exceeded its limit", {
            code: "frame_too_large",
            retryable: false,
          });
        }
        const frame = parseSseFrame(raw);
        if (frame) {
          onFrame(frame);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  callbacks: GasCityStreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  await parseSseFrames(stream, callbacks.onFrame, signal);
  throw new GasCityTransportError("Gas City SSE stream closed", {
    code: "stream_closed",
    retryable: true,
  });
}

function parseSseFrame(raw: string): GasCitySseFrame | null {
  let id: string | null = null;
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") {
      id = boundedString(value, "SSE event id", GAS_CITY_LIMITS.cursor);
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    } else if (field.length > 0) {
      throw new GasCityTransportError("Gas City SSE frame contains an unsupported field", {
        code: "malformed_stream",
        retryable: false,
      });
    }
  }
  if (event !== "message" && event !== "error" && event !== "heartbeat") {
    throw new GasCityTransportError("Gas City SSE frame has an unsupported event type", {
      code: "malformed_stream",
      retryable: false,
    });
  }
  if (event !== "heartbeat" && data.length === 0) {
    throw new GasCityTransportError("Gas City SSE frame is missing data", {
      code: "malformed_stream",
      retryable: false,
    });
  }
  return { id, event, data: data.join("\n") };
}

function findFrameSeparator(value: string): { index: number; end: number } | null {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, end: crlf + 4 };
  }
  return { index: lf, end: lf + 2 };
}

async function readJsonObject(
  response: Response,
  maximum: number,
  label: string,
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (body.length > maximum) {
    throw new GasCityTransportError(`Gas City ${label} exceeded its size limit`, {
      code: "response_too_large",
      retryable: false,
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new GasCityTransportError(`Gas City ${label} is not valid JSON`, {
      code: "invalid_response",
      retryable: false,
    });
  }
  const parsed = JsonObjectSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GasCityTransportError(`Gas City ${label} is not a JSON object`, {
      code: "invalid_response",
      retryable: false,
    });
  }
  return parsed.data;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new GasCityTransportError(`Gas City ${label} is invalid`, {
      code: "invalid_response",
      retryable: false,
    });
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return boundedString(value, label, maximum);
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => {};
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function transportFailure(error: unknown): GasCityTransportError {
  if (error instanceof GasCityTransportError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new GasCityTransportError("Gas City request was canceled", {
      code: "canceled",
      retryable: false,
    });
  }
  return new GasCityTransportError("Gas City external messaging is unavailable", {
    code: "unavailable",
    retryable: true,
  });
}
