import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { createRuntimeOwner } from "./runtime-owner";

/** Exercise native publication/cleanup without starting Chromium or touching any profile. */
function fixture() {
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "test",
  });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let intercept: (method: string) => Promise<void> = async () => {};
  const page = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      await intercept(method);
      return method === "Runtime.evaluate" ? { result: { value: "pointer" } } : {};
    },
  };
  const control = runtime as unknown as {
    page: typeof page;
    requirePage: () => Promise<typeof page>;
    documentGeneration: number;
  };
  Object.assign(runtime, {
    page,
    emulationAppliedPage: page,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  control.requirePage = async () => control.page;
  return {
    runtime,
    control,
    page,
    calls,
    intercept: (next: typeof intercept) => {
      intercept = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("runtime-owned live input", () => {
  it("completes acknowledged input that navigates while closing original held-input cleanup", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    state.intercept(async (method) => {
      if (method !== "Input.dispatchKeyEvent" || state.calls.at(-1)?.params.type !== "keyDown")
        return;
      state.control.documentGeneration++;
      await state.runtime.endLiveInput("owned");
    });
    await expect(
      state.runtime.dispatchKey(
        { kind: "key", type: "down", key: "Enter", code: "Enter", modifiers: 0, repeat: false },
        "owned",
      ),
    ).resolves.toBeUndefined();
    expect(state.calls.filter((call) => call.params.type === "keyDown")).toHaveLength(1);
    expect(state.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(1);
    await expect(state.runtime.assertLiveInput("owned")).rejects.toThrow("attachment");
  });

  it("does not complete target replacement or an unacknowledged send as successful navigation", async () => {
    for (const scenario of ["replacement", "uncertain"] as const) {
      const state = fixture();
      await state.runtime.beginLiveInput("owned");
      state.intercept(async (method) => {
        if (method !== "Input.dispatchMouseEvent") return;
        state.control.documentGeneration++;
        if (scenario === "uncertain") throw new Error("Mutation outcome is unknown");
        state.control.page = { send: async () => ({}) };
      });
      await expect(state.runtime.mouseDown(20, 30, "left", 1, "owned")).rejects.toThrow(
        scenario === "replacement" ? "attachment" : "unknown",
      );
      state.intercept(async () => {});
      await state.runtime.endLiveInput("owned");
    }
  });

  it("does not restore held touches after an acknowledged touch start navigates", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    state.intercept(async (method) => {
      if (method !== "Input.dispatchTouchEvent" || state.calls.at(-1)?.params.type !== "touchStart")
        return;
      state.control.documentGeneration++;
      await state.runtime.endLiveInput("owned");
    });
    await state.runtime.touch("touchStart", [{ x: 20, y: 30, id: 7 }], "owned");
    await state.runtime.releaseHeldInput();
    expect(state.calls.filter((call) => call.params.type === "touchCancel")).toHaveLength(1);
    await expect(state.runtime.assertLiveInput("owned")).rejects.toThrow("attachment");
  });

  it("releases original held mouse after plugin/IPC disappearance without another policy request", async () => {
    vi.useFakeTimers();
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await vi.advanceTimersByTimeAsync(4_000);
    await state.runtime.assertLiveInput("owned");
    await state.runtime.cursorAt(10, 20, "owned");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
    await expect(state.runtime.mouseMove(20, 30, "owned")).rejects.toThrow("attachment");
  });

  it("releases a cancelled held drag at its last native pointer position, not the origin", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(300, 410, "owned");
    await state.runtime.endLiveInput("owned");
    const released = state.calls.filter((call) => call.params.type === "mouseReleased");
    expect(released).toHaveLength(1);
    expect(released[0]?.params).toMatchObject({ x: 300, y: 410, button: "left", buttons: 0 });
  });

  it("releases a held button where an unacknowledged press was sent", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    state.intercept(async (method) => {
      if (method === "Input.dispatchMouseEvent") throw new Error("Unknown publication outcome");
    });
    await expect(state.runtime.mouseDown(55, 66, "left", 1, "owned")).rejects.toThrow();
    state.intercept(async () => {});
    await state.runtime.endLiveInput("owned");
    const released = state.calls.filter((call) => call.params.type === "mouseReleased");
    expect(released[0]?.params).toMatchObject({ x: 55, y: 66 });
  });

  it.each(["move", "up"] as const)(
    "an expired %s rejected before publication does not change the release point",
    async (operation) => {
      vi.useFakeTimers();
      const state = fixture();
      await state.runtime.beginLiveInput("owned");
      await state.runtime.mouseDown(10, 20, "left", 1, "owned");
      // Move the clock without firing the timer so assertLiveInput owns the expiry.
      vi.setSystemTime(Date.now() + 5_001);
      const rejected =
        operation === "move"
          ? state.runtime.mouseMove(500, 600, "owned")
          : state.runtime.mouseUp(500, 600, "left", 1, "owned");
      await expect(rejected).rejects.toThrow("attachment");
      expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toMatchObject([
        { params: { x: 10, y: 20 } },
      ]);
    },
  );

  it("a move rejected after replacement keeps the original attachment's last published point", async () => {
    const state = fixture();
    const replacement: unknown[] = [];
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(30, 40, "owned");
    state.control.page = { send: async (...args: unknown[]) => replacement.push(args) } as never;
    await expect(state.runtime.mouseMove(500, 600, "owned")).rejects.toThrow("attachment");
    await state.runtime.endLiveInput("owned");
    expect(replacement).toEqual([]);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toMatchObject([
      { params: { x: 30, y: 40 } },
    ]);
  });

  it("discrete text and key input pinned to a channel never reach a navigated document", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("discrete");
    state.control.documentGeneration++;
    await expect(state.runtime.insertText("late", "discrete")).rejects.toThrow("attachment");
    await expect(state.runtime.keyDown("Enter", "Enter", "discrete")).rejects.toThrow("attachment");
    expect(
      state.calls.filter((call) => /^Input\.(insertText|dispatchKeyEvent)$/.test(call.method)),
    ).toEqual([]);
  });

  it("acknowledged moves renew idle expiry but never the absolute five-minute limit", async () => {
    vi.useFakeTimers();
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    for (let index = 0; index < 74; index++) {
      await vi.advanceTimersByTimeAsync(4_000);
      await state.runtime.mouseMove(20, 30, "owned");
    }
    await vi.advanceTimersByTimeAsync(4_001);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
  });

  it("cancels possibly published touch after lost acknowledgment and keeps original attachment on replacement", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    state.intercept(async (method) => {
      if (method === "Input.dispatchTouchEvent") throw new Error("Unknown publication outcome");
    });
    await expect(
      state.runtime.touch("touchStart", [{ x: 20, y: 30, id: 7 }], "owned"),
    ).rejects.toThrow("Unknown publication");
    const replacementCalls: string[] = [];
    state.control.page = {
      send: async (method) => {
        replacementCalls.push(method);
        return {};
      },
    };
    await state.runtime.endLiveInput("owned");
    expect(state.calls.filter((call) => call.params.type === "touchCancel")).toHaveLength(1);
    expect(replacementCalls).toEqual([]);
  });

  it("ends removed touch contacts before moving survivors and cancels remaining held contacts", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.touch(
      "touchStart",
      [
        { x: 20, y: 30, id: 7 },
        { x: 60, y: 30, id: 9 },
      ],
      "owned",
    );
    await state.runtime.touch("touchMove", [{ x: 25, y: 35, id: 7 }], "owned");
    expect(
      state.calls
        .filter((call) => call.method === "Input.dispatchTouchEvent")
        .map((call) => call.params),
    ).toEqual([
      {
        type: "touchStart",
        touchPoints: [
          { x: 20, y: 30, id: 7 },
          { x: 60, y: 30, id: 9 },
        ],
      },
      { type: "touchEnd", touchPoints: [{ x: 60, y: 30, id: 9 }] },
      { type: "touchMove", touchPoints: [{ x: 25, y: 35, id: 7 }] },
    ]);
    await state.runtime.endLiveInput("owned");
    expect(state.calls.filter((call) => call.params.type === "touchCancel")).toHaveLength(1);
  });

  it("same-URL document replacement refuses publication and optional cursor rejects CSS URL values", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    state.control.documentGeneration++;
    await expect(state.runtime.mouseMove(20, 30, "owned")).rejects.toThrow("attachment");
    expect(state.calls).toEqual([]);
    await state.runtime.endLiveInput("owned");
    await state.runtime.beginLiveInput("next");
    state.control.page.send = async () => ({
      result: { value: "url(https://secret.invalid/cursor), pointer" },
    });
    expect(await state.runtime.cursorAt(20, 30, "next")).toBeNull();
    await state.runtime.endLiveInput("next");
  });

  it("native leave uses only the fixed outside point and refuses departure while a button is held", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseLeave("owned");
    expect(state.calls[0]?.params).toEqual({
      type: "mouseMoved",
      x: -1,
      y: -1,
      button: "none",
      buttons: 0,
    });
    await state.runtime.mouseDown(20, 30, "left", 1, "owned");
    await expect(state.runtime.mouseLeave("owned")).rejects.toThrow("Release held");
    await state.runtime.endLiveInput("owned");
    await expect(state.runtime.mouseLeave("owned")).rejects.toThrow("attachment");
  });

  it("private runtime routing preserves gesture identity and refuses malformed native contact sets", async () => {
    const owner = await createRuntimeOwner();
    const runtime = {
      beginLiveInput: vi.fn(),
      assertLiveInput: vi.fn(),
      endLiveInput: vi.fn(),
      touch: vi.fn(),
      mouseMove: vi.fn(),
      dispatchKey: vi.fn(),
      insertText: vi.fn(),
    };
    const owned = { runtimeId: "owned", runtime } as unknown as Parameters<typeof owner.request>[0];
    await owner.request(owned, "input.begin", { gestureId: "gesture" });
    await owner.request(owned, "mouse.move", { gestureId: "gesture", x: 20, y: 30 });
    await owner.request(owned, "touch", {
      gestureId: "gesture",
      type: "start",
      points: [{ id: 7, x: 20, y: 30 }],
    });
    expect(runtime.beginLiveInput).toHaveBeenCalledWith("gesture");
    expect(runtime.mouseMove).toHaveBeenCalledWith(20, 30, "gesture");
    expect(runtime.touch).toHaveBeenCalledWith("touchStart", [{ id: 7, x: 20, y: 30 }], "gesture");
    for (const points of [
      [
        { id: 7, x: 20, y: 30 },
        { id: 7, x: 30, y: 40 },
      ],
      [],
      [{ id: true, x: 20, y: 30 }],
    ]) {
      await expect(
        owner.request(owned, "touch", { gestureId: "gesture", type: "start", points }),
      ).rejects.toThrow();
    }
    expect(runtime.touch).toHaveBeenCalledTimes(1);
    const event = {
      kind: "key",
      type: "down",
      key: "Enter",
      code: "Enter",
      modifiers: 0,
      repeat: false,
    };
    await owner.request(owned, "input.key", { gestureId: "gesture", event });
    await owner.request(owned, "input.text", { gestureId: "gesture", text: "漢字😀" });
    expect(runtime.dispatchKey).toHaveBeenCalledWith(event, "gesture");
    expect(runtime.insertText).toHaveBeenCalledWith("漢字😀", "gesture");
    await expect(owner.request(owned, "input.key", { event })).rejects.toThrow();
    await expect(
      owner.request(owned, "input.key", {
        gestureId: "gesture",
        event: { ...event, modifiers: 99 },
      }),
    ).rejects.toThrow();
    await expect(
      owner.request(owned, "input.text", { gestureId: "gesture", text: "x".repeat(16001) }),
    ).rejects.toThrow();
    expect(runtime.dispatchKey).toHaveBeenCalledTimes(1);
    expect(runtime.insertText).toHaveBeenCalledTimes(1);
  });

  it("unpressed movement retains the ordinary no-button packet", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseMove(20, 30, "owned");
    expect(state.calls[0]?.params).toEqual({
      type: "mouseMoved",
      x: 20,
      y: 30,
      button: "none",
      buttons: 0,
    });
    await state.runtime.endLiveInput("owned");
  });

  for (const [button, mask] of [
    ["left", 1],
    ["right", 2],
    ["middle", 4],
  ] as const) {
    it(`held ${button} movement carries its native button and mask until release`, async () => {
      const state = fixture();
      await state.runtime.beginLiveInput("owned");
      await state.runtime.mouseDown(10, 20, button, 1, "owned");
      await state.runtime.mouseMove(20, 30, "owned");
      await state.runtime.mouseUp(20, 30, button, 1, "owned");
      await state.runtime.mouseMove(30, 40, "owned");
      expect(
        state.calls.filter((call) => call.params.type === "mouseMoved").map((call) => call.params),
      ).toEqual([
        { type: "mouseMoved", x: 20, y: 30, button, buttons: mask },
        { type: "mouseMoved", x: 30, y: 40, button: "none", buttons: 0 },
      ]);
      await state.runtime.endLiveInput("owned");
    });
  }

  it("multiple held buttons use canonical priority, and cleanup leaves the next gesture unpressed", async () => {
    const state = fixture();
    await state.runtime.beginLiveInput("owned");
    await state.runtime.mouseDown(10, 20, "middle", 1, "owned");
    await state.runtime.mouseDown(10, 20, "right", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.mouseUp(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.mouseUp(10, 20, "right", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.endLiveInput("owned");
    await state.runtime.beginLiveInput("next");
    await state.runtime.mouseMove(20, 30, "next");
    expect(
      state.calls
        .filter((call) => call.params.type === "mouseMoved")
        .map((call) => [call.params.button, call.params.buttons]),
    ).toEqual([
      ["right", 6],
      ["left", 7],
      ["right", 6],
      ["middle", 4],
      ["none", 0],
    ]);
    expect(
      state.calls.filter((call) => call.params.type === "mouseReleased").at(-1)?.params.button,
    ).toBe("middle");
    await state.runtime.endLiveInput("next");
  });
});

it("publishes ordered native Unicode/repeat/shortcut keys and committed text on the pinned attachment", async () => {
  const state = fixture();
  await state.runtime.beginLiveInput("keys");
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "é", code: "KeyE", modifiers: 0, repeat: false },
    "keys",
  );
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "é", code: "KeyE", modifiers: 0, repeat: true },
    "keys",
  );
  await state.runtime.dispatchKey(
    { kind: "key", type: "up", key: "é", code: "KeyE", modifiers: 0, repeat: false },
    "keys",
  );
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "Control", code: "ControlLeft", modifiers: 2, repeat: false },
    "keys",
  );
  await state.runtime.mouseDown(10, 20, "left", 1, "keys");
  await state.runtime.insertText("漢字\n😀", "keys");
  expect(
    state.calls
      .filter((call) => call.method === "Input.dispatchKeyEvent")
      .map((call) => call.params),
  ).toMatchObject([
    { type: "keyDown", text: "é", code: "KeyE", autoRepeat: false },
    { type: "keyDown", text: "é", autoRepeat: true },
    { type: "keyUp", code: "KeyE" },
    { type: "rawKeyDown", code: "ControlLeft", modifiers: 2 },
  ]);
  expect(state.calls.find((call) => call.params.type === "mousePressed")?.params.modifiers).toBe(2);
  expect(state.calls.find((call) => call.method === "Input.insertText")?.params).toEqual({
    text: "漢字\n😀",
  });
  await state.runtime.endLiveInput("keys");
  expect(state.calls.at(-1)?.params).toMatchObject({
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
  });
});

it("cleans possibly published keys on the original page and rejects unmatched repeat/up", async () => {
  const state = fixture();
  await state.runtime.beginLiveInput("keys");
  const down = {
    kind: "key",
    type: "down",
    key: "Shift",
    code: "ShiftRight",
    modifiers: 8,
    repeat: false,
  } as const;
  await expect(state.runtime.dispatchKey({ ...down, repeat: true }, "keys")).rejects.toThrow();
  await expect(state.runtime.dispatchKey({ ...down, type: "up" }, "keys")).rejects.toThrow();
  state.intercept(async (method) => {
    if (method === "Input.dispatchKeyEvent") throw new Error("Lost key acknowledgment");
  });
  await expect(state.runtime.dispatchKey(down, "keys")).rejects.toThrow("Lost key");
  state.control.page = { send: async () => ({}) };
  await state.runtime.endLiveInput("keys");
  expect(state.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(1);
});

it("expires held keyboard modifiers without another client request", async () => {
  vi.useFakeTimers();
  const state = fixture();
  await state.runtime.beginLiveInput("keys");
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "Alt", code: "AltLeft", modifiers: 1, repeat: false },
    "keys",
  );
  await vi.advanceTimersByTimeAsync(5001);
  expect(state.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(1);
  await expect(state.runtime.insertText("late", "keys")).rejects.toThrow("attachment");
});
