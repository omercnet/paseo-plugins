import { describe, expect, it } from "vitest";
import type { CanvasKeyboardEvent } from "./browser-canvas-keyboard";
import { createBrowserNativeKeyboard } from "./browser-native-keyboard";

function fixture() {
  const events: CanvasKeyboardEvent[] = [];
  const errors: Error[] = [];
  let value = "";
  let enabled = true;
  const relay = createBrowserNativeKeyboard({
    enabled: () => enabled,
    enqueue(event) {
      events.push(event);
      return true;
    },
    finish() {},
    onValue(next) {
      value = next;
    },
    onError(error) {
      errors.push(error);
    },
  });
  return {
    relay,
    events,
    errors,
    value: () => value,
    disable: () => {
      enabled = false;
    },
  };
}
describe("native Basic and Compose relay", () => {
  it("inserts only appended basic text and never duplicates physical Backspace on change", () => {
    const f = fixture();
    f.relay.changeText("a");
    f.relay.changeText("ab");
    f.relay.changeText("ab🙂");
    f.relay.keyPress("Backspace");
    f.relay.changeText("ab");
    expect(f.events.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "🙂" },
    ]);
    expect(f.events.filter((event) => event.kind === "key").map((event) => event.type)).toEqual([
      "down",
      "up",
    ]);
    expect(f.value()).toBe("");
    f.relay.changeText("c");
    expect(f.events.at(-1)).toEqual({ kind: "text", text: "c" });
  });
  it("forwards empty Backspace and Enter as deliberate physical keys, not inferred field edits", () => {
    const f = fixture();
    f.relay.keyPress("Backspace");
    f.relay.keyPress("Enter");
    expect(
      f.events.map((event) => (event.kind === "key" ? [event.key, event.type] : null)),
    ).toEqual([
      ["Backspace", "down"],
      ["Backspace", "up"],
      ["Enter", "down"],
      ["Enter", "up"],
    ]);
  });
  it("refuses local autocorrect, middle edits, and bulk deletion without rewriting remote text", () => {
    for (const edit of ["abd", "aXbc", "a"]) {
      const f = fixture();
      f.relay.changeText("abc");
      f.relay.changeText(edit);
      expect(f.events).toEqual([{ kind: "text", text: "abc" }]);
      expect(f.errors).toHaveLength(1);
      expect(f.value()).toBe("");
    }
  });
  it("one complete Unicode grapheme deletion is one Backspace when its key event is absent", () => {
    const f = fixture();
    f.relay.changeText("👩‍👩‍👧‍👦");
    f.relay.changeText("");
    expect(f.events.filter((event) => event.kind === "key")).toHaveLength(2);
    expect(f.errors).toHaveLength(0);
  });
  it("never infers Backspace from removing only part of a combining or joined cluster", () => {
    for (const [before, after] of [
      ["e\u0301", "e"],
      ["👩‍👩‍👧‍👦", "👩"],
    ] as const) {
      const f = fixture();
      f.relay.changeText(before);
      f.relay.changeText(after);
      expect(f.events.filter((event) => event.kind === "key")).toHaveLength(0);
      expect(f.errors).toHaveLength(1);
    }
  });
  it("Compose inserts the explicit Done draft once and rejects oversized or unowned commits", () => {
    const f = fixture();
    expect(f.events).toHaveLength(0);
    expect(f.relay.compose("日本語🙂")).toBe(true);
    expect(f.events).toEqual([{ kind: "text", text: "日本語🙂" }]);
    expect(f.relay.compose("x".repeat(16_001))).toBe(false);
    f.disable();
    expect(f.relay.compose("different owner")).toBe(false);
    expect(f.events).toHaveLength(1);
  });
  it("bounds local context independently of already inserted remote text", () => {
    const f = fixture();
    f.relay.changeText("a".repeat(1_025));
    expect(f.value()).toBe("");
    f.relay.changeText("b");
    expect(f.events.at(-1)).toEqual({ kind: "text", text: "b" });
    f.relay.selection(0, 1);
    expect(f.value()).toBe("");
  });
});
