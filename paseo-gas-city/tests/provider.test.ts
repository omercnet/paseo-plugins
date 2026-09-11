import { describe, expect, test } from "bun:test";
import type {
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import {
  createGasCitySessionProvider,
  GAS_CITY_SESSION_PROVIDER_CAPABILITIES,
  type GasCitySchedule,
} from "../server/provider";
import {
  type GasCityInboundAck,
  type GasCityRegistration,
  type GasCitySseFrame,
  type GasCityStreamCallbacks,
  type GasCitySubscription,
  type GasCityTransport,
  parseSseFrames,
} from "../server/provider-transport";

class FakeGasCityTransport implements GasCityTransport {
  readonly calls: string[] = [];
  readonly subscriptions: Array<{
    input: Parameters<GasCityTransport["subscribe"]>[0];
    callbacks: GasCityStreamCallbacks;
  }> = [];
  readonly inbound: Array<Parameters<GasCityTransport["sendInbound"]>[0]> = [];
  registration: GasCityRegistration = { clientId: "client-1", conversationId: "conversation-1" };
  acknowledgement: GasCityInboundAck = { turnId: "turn-1" };

  async register(): Promise<GasCityRegistration> {
    this.calls.push("register");
    return this.registration;
  }

  async subscribe(
    input: Parameters<GasCityTransport["subscribe"]>[0],
  ): Promise<GasCitySubscription> {
    this.calls.push("subscribe");
    this.subscriptions.push({ input, callbacks: input.callbacks });
    return { close: () => this.calls.push("close-stream") };
  }

  async sendInbound(
    input: Parameters<GasCityTransport["sendInbound"]>[0],
  ): Promise<GasCityInboundAck> {
    this.calls.push("inbound");
    this.inbound.push(input);
    return this.acknowledgement;
  }

  frame(frame: GasCitySseFrame): void {
    this.subscriptions.at(-1)?.callbacks.onFrame(frame);
  }
}

const connectionRequest: ProviderConnectRequest = {
  versions: [1],
  capabilities: [...GAS_CITY_SESSION_PROVIDER_CAPABILITIES],
};

function sessionOpen(
  persistence?: Extract<ProviderInput, { type: "session.open" }>["persistence"],
): Extract<ProviderInput, { type: "session.open" }> {
  return {
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-session-1",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      providerOptions: { cityName: "alpha", sessionName: "reviewer" },
      persist: true,
    },
    persistence,
    history: persistence ? "replay" : "skip",
  };
}

function prompt(clientMessageId = "message-1"): Extract<ProviderInput, { type: "session.prompt" }> {
  return {
    type: "session.prompt",
    sessionId: "paseo-session-1",
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "Inspect the change." }] },
    },
  };
}

describe("Gas City Paseo provider", () => {
  test("subscribes before posting, streams a terminal reply, and persists the replay cursor", async () => {
    const transport = new FakeGasCityTransport();
    const connection = await createGasCitySessionProvider({ transport }).connect(connectionRequest);
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send(sessionOpen());
    await connection.send(prompt());

    expect(transport.calls).toEqual(["register", "subscribe", "inbound"]);
    expect(transport.inbound[0]).toMatchObject({
      clientMessageId: "message-1",
      text: "Inspect the change.",
    });
    expect(events.filter((event) => event.type === "session.prompt_result")).toEqual([
      {
        type: "session.prompt_result",
        sessionId: "paseo-session-1",
        clientMessageId: "message-1",
        result: { type: "turn", turnId: "gas-city:message-1" },
      },
    ]);

    transport.frame({
      id: "cursor-1",
      event: "message",
      data: JSON.stringify({
        type: "message",
        clientMessageId: "message-1",
        turnId: "turn-1",
        messageId: "reply-1",
        text: "<untrusted>reply</untrusted>",
        state: "completed",
      }),
    });

    expect(events).toContainEqual({
      type: "timeline.item",
      sessionId: "paseo-session-1",
      item: {
        id: "reply-1",
        type: "assistant_message",
        text: "<untrusted>reply</untrusted>",
        messageId: "reply-1",
      },
    });
    expect(
      events.filter(
        (event) => event.type === "session.turn" && event.turnId === "gas-city:message-1",
      ),
    ).toEqual([
      {
        type: "session.turn",
        sessionId: "paseo-session-1",
        turnId: "gas-city:message-1",
        state: "started",
      },
      {
        type: "session.turn",
        sessionId: "paseo-session-1",
        turnId: "gas-city:message-1",
        state: "completed",
      },
    ]);
    const persistence = events.findLast((event) => event.type === "session.persistence");
    expect(persistence).toMatchObject({
      type: "session.persistence",
      persistence: {
        version: 1,
        data: { cursor: "cursor-1", connection: { clientId: "client-1" } },
      },
    });

    await connection.close();
    expect(transport.calls).toContain("close-stream");
  });

  test("restores opaque connection state and resumes the stream with Last-Event-ID", async () => {
    const transport = new FakeGasCityTransport();
    const reconnects: Array<() => void> = [];
    const schedule: GasCitySchedule = (callback) => {
      reconnects.push(callback);
      return 0 as never;
    };
    const connection = await createGasCitySessionProvider({
      transport,
      setTimeout: schedule,
    }).connect(connectionRequest);
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send(
      sessionOpen({
        version: 1,
        data: {
          version: 1,
          selection: {
            cityName: "alpha",
            sessionName: "reviewer",
            endpointUrl: "http://127.0.0.1:8372",
          },
          connection: { clientId: "saved-client", conversationId: "saved-conversation" },
          cursor: "saved-cursor",
        },
      }),
    );

    expect(transport.calls).toEqual(["subscribe"]);
    expect(transport.subscriptions[0]?.input).toMatchObject({
      clientId: "saved-client",
      lastEventId: "saved-cursor",
    });
    expect(events).toContainEqual({ type: "session.ready", sessionId: "paseo-session-1" });
    transport.frame({ id: "replayed-cursor", event: "heartbeat", data: "" });
    transport.subscriptions[0]?.callbacks.onDisconnect(new Error("stream dropped"));
    const reconnect = reconnects.shift();
    if (!reconnect) {
      throw new Error("Expected a reconnect callback");
    }
    reconnect();
    await Promise.resolve();

    expect(transport.subscriptions[1]?.input.lastEventId).toBe("replayed-cursor");
    await connection.close();
  });

  test("fails closed on malformed frames while settling the prompt and started turn once", async () => {
    const transport = new FakeGasCityTransport();
    const connection = await createGasCitySessionProvider({ transport }).connect(connectionRequest);
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send(sessionOpen());
    await connection.send(prompt());
    transport.frame({ id: "bad-1", event: "message", data: "not-json" });
    transport.frame({ id: "bad-2", event: "message", data: "not-json" });

    expect(
      events.filter(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "message-1",
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "session.turn" && event.state !== "started"),
    ).toEqual([
      {
        type: "session.turn",
        sessionId: "paseo-session-1",
        turnId: "gas-city:message-1",
        state: "failed",
        error: { code: "gas_city_error", message: "Gas City message frame is not valid JSON" },
      },
    ]);
    expect(events.filter((event) => event.type === "session.runtime_failed")).toHaveLength(1);
  });

  test("bounds and validates SSE frames before emitting them", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('id: replay-1\nevent: message\ndata: {"type":"message"}\n\n'),
        );
        controller.close();
      },
    });
    const frames: GasCitySseFrame[] = [];

    await parseSseFrames(stream, (frame) => frames.push(frame));

    expect(frames).toEqual([{ id: "replay-1", event: "message", data: '{"type":"message"}' }]);
  });
});
