import type { HostSummary } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  buildAddInput,
  buildUpdatePatch,
  directoryFromMessage,
  errorMessage,
  formatMetadata,
  parseMetadata,
} from "../client/hosts";

const host: HostSummary = {
  registrationId: "reg_1",
  serverId: "srv_build",
  label: "Build box",
  source: { id: "cli", key: "build-box" },
  metadata: { team: "infra", zone: "a" },
  enabled: true,
  status: "online",
  targetDescription: "ssh://deploy@build-box",
  lastOnlineAt: null,
  nextRetryAt: null,
  error: null,
};

const unchanged = {
  label: "Build box",
  metadata: formatMetadata(host.metadata),
  connection: "",
  replaceIdentity: false,
};

describe("parseMetadata", () => {
  it("reads key=value lines, keeps '=' inside values and skips blank lines", () => {
    expect(parseMetadata("team=infra\n\n url = a=b \n")).toEqual({
      ok: true,
      value: { team: "infra", url: "a=b" },
    });
  });

  it("reports the line that is not key=value", () => {
    expect(parseMetadata("team=infra\nnovalue")).toEqual({
      ok: false,
      error: "Metadata line 2 needs the form key=value.",
    });
    expect(parseMetadata("=x").ok).toBe(false);
  });
});

describe("buildAddInput", () => {
  it("requires a connection", () => {
    expect(buildAddInput({ connection: "  ", label: "", metadata: "", sourceKey: "" }).ok).toBe(
      false,
    );
  });

  it("omits optional fields that are blank", () => {
    expect(
      buildAddInput({ connection: " host:6767 ", label: " ", metadata: "", sourceKey: "" }),
    ).toEqual({ ok: true, value: { connection: "host:6767" } });
  });

  it("carries label, metadata and source key when given", () => {
    expect(
      buildAddInput({
        connection: "host:6767",
        label: "Build",
        metadata: "team=infra",
        sourceKey: "build",
      }),
    ).toEqual({
      ok: true,
      value: {
        connection: "host:6767",
        label: "Build",
        metadata: { team: "infra" },
        sourceKey: "build",
      },
    });
  });
});

describe("buildUpdatePatch", () => {
  it("sends nothing when nothing changed, so saved fields are never rewritten", () => {
    expect(buildUpdatePatch(host, unchanged)).toEqual({ ok: true, value: {} });
  });

  it("never sends a connection when the write-only field is blank, even with replaceIdentity", () => {
    expect(buildUpdatePatch(host, { ...unchanged, replaceIdentity: true })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("clears the label with null and replaces the whole metadata map", () => {
    expect(buildUpdatePatch(host, { ...unchanged, label: "  ", metadata: "team=ops" })).toEqual({
      ok: true,
      value: { label: null, metadata: { team: "ops" } },
    });
  });

  it("treats a metadata reorder as unchanged", () => {
    expect(buildUpdatePatch(host, { ...unchanged, metadata: "zone=a\nteam=infra" })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("sends a new connection, and replaceIdentity only when accepted", () => {
    expect(buildUpdatePatch(host, { ...unchanged, connection: "ssh://new" })).toEqual({
      ok: true,
      value: { connection: "ssh://new" },
    });
    expect(
      buildUpdatePatch(host, { ...unchanged, connection: "ssh://new", replaceIdentity: true }),
    ).toEqual({ ok: true, value: { connection: "ssh://new", replaceIdentity: true } });
  });

  it("rejects malformed metadata without producing a patch", () => {
    expect(buildUpdatePatch(host, { ...unchanged, metadata: "oops" }).ok).toBe(false);
  });
});

describe("errorMessage", () => {
  it("prefers the daemon's user message over the transport message", () => {
    const error = Object.assign(new Error("Denied requestType=hosts.update.request code=x"), {
      userMessage: "You need access management to change a connection.",
    });
    expect(errorMessage(error)).toBe("You need access management to change a connection.");
  });

  it("falls back to the message, then to the string form", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(Object.assign(new Error("boom"), { userMessage: "" }))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("directoryFromMessage", () => {
  const directory = { self: { serverId: "srv_self", label: "Self" }, hosts: [host] };

  it("returns the directory carried by hosts.changed", () => {
    const message = {
      type: "hosts.changed",
      payload: { subscriptionId: "sub_1", directory },
    } as SessionOutboundMessage;
    expect(directoryFromMessage(message)).toEqual(directory);
  });

  it("ignores every other message", () => {
    expect(directoryFromMessage({ type: "pong" } as unknown as SessionOutboundMessage)).toBeNull();
  });
});
