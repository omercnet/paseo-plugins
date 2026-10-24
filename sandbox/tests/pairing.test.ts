import { serializeRelayConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import { describe, expect, test } from "vitest";
import { relayConnection } from "../server/pairing";

const offer = {
  v: 2 as const,
  serverId: "srv_test",
  daemonPublicKeyB64: "a2V5/with+chars==",
  relay: { endpoint: "relay.example.test:443", useTls: true },
  minimumSecurityMode: "protected" as const,
};
const link = (value: unknown) =>
  JSON.stringify({
    url: `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(value)).toString("base64url")}`,
  });

describe("relayConnection", () => {
  test("matches Paseo's own serializer, with TLS and protected security pinned", () => {
    expect(relayConnection(link(offer), "pw")).toBe(
      serializeRelayConnectionUri({ offer, password: "pw" }),
    );
  });

  test("refuses a plaintext relay instead of downgrading the connection", () => {
    const plaintext = { ...offer, relay: { endpoint: offer.relay.endpoint } };
    expect(() => relayConnection(link(plaintext), "pw")).toThrow("without TLS");
  });

  test("refuses a relay endpoint that is not host:port", () => {
    const hostile = { ...offer, relay: { endpoint: "evil.example/x?", useTls: true } };
    expect(() => relayConnection(link(hostile), "pw")).toThrow("host:port");
  });

  test("refuses a link that carries no offer", () => {
    expect(() => relayConnection(JSON.stringify({ url: "https://app.paseo.sh/" }), "pw")).toThrow(
      "without an offer",
    );
  });
});
