import type { HostSummary, PaseoApi } from "@getpaseo/client";
import { HostAddSchema, HostUpdateSchema } from "@getpaseo/protocol/hosts";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import {
  buildAddInput,
  buildUpdatePatch,
  directoryFromMessage,
  errorMessage,
  formatMetadata,
  observeDirectory,
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

  it("does not rewrite a stored label the form would trim when only metadata changes", () => {
    const padded = { ...host, label: " Build box " };
    expect(
      buildUpdatePatch(padded, { ...unchanged, label: " Build box ", metadata: "team=ops" }),
    ).toEqual({ ok: true, value: { metadata: { team: "ops" } } });
  });

  it("does not rewrite metadata or ask for permission it does not need on a label-only edit", () => {
    const padded = { ...host, metadata: { team: " infra ", "a=b": "x" } };
    const text = formatMetadata(padded.metadata);
    expect(buildUpdatePatch(padded, { ...unchanged, label: "Renamed", metadata: text })).toEqual({
      ok: true,
      value: { label: "Renamed" },
    });
  });

  it("lets a label change through when the untouched metadata cannot be parsed back", () => {
    const multiline = { ...host, metadata: { note: "a\nb" } };
    const result = buildUpdatePatch(multiline, {
      ...unchanged,
      label: "Renamed",
      metadata: formatMetadata(multiline.metadata),
    });
    expect(result).toEqual({ ok: true, value: { label: "Renamed" } });
  });

  it("sends nothing for a host without a label and a blank label field", () => {
    const unlabeled = { ...host, label: null };
    expect(buildUpdatePatch(unlabeled, { ...unchanged, label: "" })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("clears all metadata with an empty map", () => {
    expect(buildUpdatePatch(host, { ...unchanged, metadata: "" })).toEqual({
      ok: true,
      value: { metadata: {} },
    });
  });

  it("produces inputs the daemon schemas accept", () => {
    const add = buildAddInput({
      connection: "host:6767",
      label: "Build",
      metadata: "team=infra",
      sourceKey: "build",
    });
    const update = buildUpdatePatch(host, {
      label: "",
      metadata: "team=ops",
      connection: "ssh://new",
      replaceIdentity: true,
    });
    expect(add.ok && HostAddSchema.safeParse(add.value).success).toBe(true);
    expect(update.ok && HostUpdateSchema.safeParse(update.value).success).toBe(true);
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

describe("observeDirectory", () => {
  const directory = { self: { serverId: "srv_self", label: "Self" }, hosts: [host] };
  const changed = {
    type: "hosts.changed",
    payload: { subscriptionId: "sub_1", directory },
  } as SessionOutboundMessage;

  function fakePaseo(observe: () => unknown) {
    return { hosts: { observe } } as unknown as PaseoApi;
  }

  it("reports a synchronous observe failure instead of throwing", () => {
    const onError = vi.fn();
    const offline = Object.assign(new Error("transport"), {
      userMessage: "The managing daemon is offline",
    });
    const stop = observeDirectory(
      fakePaseo(() => {
        throw offline;
      }),
      { onDirectory: vi.fn(), onError },
    );
    expect(onError).toHaveBeenCalledWith("The managing daemon is offline");
    expect(() => stop()).not.toThrow();
  });

  it("forwards snapshots and hosts.changed, ignores other messages, and releases once", () => {
    const release = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    interface Observer {
      snapshot(value: unknown): void;
      update(message: SessionOutboundMessage): void;
      error(cause: unknown): void;
    }
    const subscribe = vi.fn((_observer: Observer) => unsubscribe);
    const subscription = { subscribe, release };
    const onDirectory = vi.fn();
    const onError = vi.fn();
    const stop = observeDirectory(
      fakePaseo(() => subscription),
      { onDirectory, onError },
    );

    const observer = subscribe.mock.calls[0][0];
    observer.snapshot(directory);
    observer.update({ type: "pong" } as unknown as SessionOutboundMessage);
    observer.update(changed);
    observer.error(new Error("link lost"));
    expect(onDirectory).toHaveBeenCalledTimes(2);
    expect(onDirectory).toHaveBeenLastCalledWith(directory);
    expect(onError).toHaveBeenCalledWith("link lost");

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
