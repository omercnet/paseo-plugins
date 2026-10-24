import { z } from "zod";

const offerSchema = z.object({
  serverId: z.string().min(1),
  daemonPublicKeyB64: z.string().min(1),
  relay: z.object({
    endpoint: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, "relay endpoint must be host:port"),
    useTls: z.boolean().optional(),
  }),
  minimumSecurityMode: z.literal("protected").optional(),
});

const pairingSchema = z.object({ url: z.string() });

/**
 * Turns the output of `paseo daemon pair --relay --json` into the connection string `hosts.add`
 * stores. Omitting `ssl=true` downgrades the relay to plaintext, so TLS is required.
 */
export function relayConnection(pairingOutput: string, password: string): string {
  const { url: pairingUrl } = pairingSchema.parse(JSON.parse(pairingOutput));
  const encoded = pairingUrl.split("#offer=")[1]?.trim();
  if (!encoded) throw new Error("The sandbox daemon returned a pairing link without an offer.");
  const offer = offerSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  if (!offer.relay.useTls) throw new Error("The sandbox daemon offered a relay without TLS.");
  const url = new URL(`relay://${offer.relay.endpoint}/${encodeURIComponent(offer.serverId)}`);
  url.searchParams.set("key", offer.daemonPublicKeyB64);
  url.searchParams.set("ssl", "true");
  url.searchParams.set("security", offer.minimumSecurityMode ?? "protected");
  url.searchParams.set("password", password);
  return url.toString();
}
