import { afterEach, describe, expect, it } from "vitest";
import { CdpUnknownOutcomeError } from "../server/cdp";
import { RUNTIME_PROTOCOL_VERSION } from "../server/runtime-protocol";
import { RuntimeSupervisor } from "../server/supervisor";

const supervisors: RuntimeSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
});

async function agentFixture() {
  let url = "https://original.invalid/";
  let generation = "1:1";
  let afterDown = false;
  let failStateAfterDown = false;
  let unknownText = false;
  const calls: { operation: string; url: string; input: Record<string, unknown> }[] = [];
  const supervisor = new RuntimeSupervisor({
    owner: {
      create: async () => ({ runtimeId: "r".repeat(40) }),
      stop: async () => {},
      request: async (_runtime, operation, input) => {
        calls.push({ operation, input: (input ?? {}) as Record<string, unknown>, url });
        if (operation === "identity") return { userAgent: "review fixture" };
        if (operation === "state") {
          if (failStateAfterDown && afterDown) {
            failStateAfterDown = false;
            throw new Error("Metadata read failed after mouse press");
          }
          return {
            url,
            title: "fixture",
            inputGeneration: generation,
            canGoBack: false,
            canGoForward: false,
          };
        }
        if (operation === "frame") {
          const bytes = Buffer.from("fixture frame");
          return {
            width: 1280,
            height: 800,
            dataBase64: bytes.toString("base64"),
            byteLength: bytes.length,
            capturedAt: new Date().toISOString(),
            transport: "screenshot",
          };
        }
        if (operation === "mouse.down") afterDown = true;
        if (operation === "text.insert" && unknownText)
          throw new CdpUnknownOutcomeError("publication unknown");
        return null;
      },
    },
  });
  supervisors.push(supervisor);
  const bridge = supervisor.claimBridge("review-bridge");
  const ticket = "t".repeat(40);
  let requestId = 0;
  const dispatch = (method: string, rest: Record<string, unknown>) =>
    supervisor.dispatch({
      id: String(++requestId),
      version: RUNTIME_PROTOCOL_VERSION,
      token: "",
      method,
      ...rest,
    } as unknown as Parameters<typeof supervisor.dispatch>[0]);
  await dispatch("ticket.issue", { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ticket });
  await dispatch("ticket.bind", {
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    ticket,
    agentId: "review-agent",
    workspaceId: "review-workspace",
  });
  const request = (operation: string, input: Record<string, unknown> = {}) =>
    dispatch("agent.request", { ticket, operation, input });
  await request("acquire-control");
  await request("capture");
  return {
    request,
    calls,
    navigate: () => {
      url = "https://replacement.invalid/";
      generation = "1:2";
    },
    failAfterDown: () => {
      failStateAfterDown = true;
    },
    unknownText: () => {
      unknownText = true;
    },
  };
}

const click = {
  kind: "click",
  point: { x: 10, y: 20, width: 1280, height: 800 },
  button: "left",
  clickCount: 1,
};
const published = (calls: { operation: string }[]) =>
  calls.filter((call) => /^(text|key|mouse)\./.test(call.operation));

describe("agent input after autonomous navigation", () => {
  it.each([
    { kind: "type", text: "must not go to replacement page" },
    { kind: "key", key: "Enter" },
    click,
  ])("publishes nothing for $kind once the captured document was replaced", async (event) => {
    const fixture = await agentFixture();
    fixture.navigate();
    const before = fixture.calls.length;
    await expect(fixture.request("input", { event })).rejects.toThrow();
    expect(published(fixture.calls.slice(before))).toEqual([]);
  });

  it("pins discrete input to the original attachment and document", async () => {
    const fixture = await agentFixture();
    await fixture.request("input", { event: { kind: "type", text: "ok" } });
    const ops = fixture.calls.map((call) => call.operation);
    const begin = ops.lastIndexOf("input.begin");
    expect(begin).toBeGreaterThan(-1);
    expect(ops.indexOf("text.insert", begin)).toBeGreaterThan(begin);
    expect(ops.indexOf("input.end", begin)).toBeGreaterThan(ops.indexOf("text.insert", begin));
    const insert = fixture.calls.filter((call) => call.operation === "text.insert").at(-1);
    expect(insert?.input.gestureId).toBe(fixture.calls[begin]?.input.gestureId);
  });
});

describe("agent input capture consumption", () => {
  it("spends the capture after a partially completed click fails with RUNTIME_FAILURE", async () => {
    const fixture = await agentFixture();
    fixture.failAfterDown();
    await expect(fixture.request("input", { event: click })).rejects.toMatchObject({
      code: "RUNTIME_FAILURE",
    });
    expect(fixture.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.operation === "mouse.up")).toHaveLength(1);
    await expect(fixture.request("input", { event: click })).rejects.toThrow();
    expect(fixture.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
  });

  it("keeps the capture when input is denied before admission", async () => {
    const fixture = await agentFixture();
    await fixture.request("release-control");
    await expect(fixture.request("input", { event: click })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await fixture.request("acquire-control");
    await fixture.request("input", { event: click });
    expect(fixture.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
  });

  it("invalidates observations on an unknown publication outcome", async () => {
    const fixture = await agentFixture();
    fixture.unknownText();
    await expect(
      fixture.request("input", { event: { kind: "type", text: "once" } }),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    await expect(
      fixture.request("input", { event: { kind: "type", text: "once" } }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fixture.calls.filter((call) => call.operation === "text.insert")).toHaveLength(1);
  });
});
