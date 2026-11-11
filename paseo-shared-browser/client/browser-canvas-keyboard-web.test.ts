import { describe, expect, it } from "vitest";
import type { CanvasKeyboardEvent } from "./browser-canvas-keyboard";
import { bindBrowserCanvasKeyboard, type KeyboardCanvasNode } from "./browser-canvas-keyboard-web";

type Listener = (event: never) => void;

/** Minimal DOM: only listener registration and focus, enough to drive the real adapter. */
function fakeDom() {
  const registry = new Map<string, Set<Listener>>();
  const target = (name: string) => ({
    add(type: string, listener: Listener) {
      const key = `${name}:${type}`;
      registry.set(key, (registry.get(key) ?? new Set()).add(listener));
    },
    remove(type: string, listener: Listener) {
      registry.get(`${name}:${type}`)?.delete(listener);
    },
  });
  const nodeTarget = target("node");
  const sinkTarget = target("sink");
  const docTarget = target("doc");
  const winTarget = target("win");
  const document = {
    activeElement: null as unknown,
    hidden: false,
    createElement: () => sink,
    addEventListener: docTarget.add,
    removeEventListener: docTarget.remove,
    defaultView: { addEventListener: winTarget.add, removeEventListener: winTarget.remove },
  };
  const sink = {
    tabIndex: 0,
    value: "",
    style: {},
    setAttribute() {},
    focus() {
      document.activeElement = sink;
    },
    remove() {},
    addEventListener: sinkTarget.add,
    removeEventListener: sinkTarget.remove,
  };
  const node = {
    ...sink,
    appendChild() {},
    ownerDocument: document,
    addEventListener: nodeTarget.add,
    removeEventListener: nodeTarget.remove,
  } as unknown as KeyboardCanvasNode;
  sink.focus();
  const fire = (name: string, type: string, event: object = {}) => {
    for (const listener of registry.get(`${name}:${type}`) ?? [])
      (listener as (event: object) => void)({
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
  };
  return { node, document, fire };
}

const key = {
  key: "a",
  code: "KeyA",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
};

function bind() {
  const dom = fakeDom();
  const events: CanvasKeyboardEvent[] = [];
  let cancels = 0;
  const binding = bindBrowserCanvasKeyboard(dom.node, {
    enabled: () => true,
    enqueue: (event) => {
      events.push(event);
      return true;
    },
    finish: () => {},
    cancel: () => {
      cancels += 1;
    },
    onError: () => {},
  });
  return { ...dom, events, binding, cancels: () => cancels };
}

describe("web canvas keyboard adapter cancellation", () => {
  it.each([
    ["sink blur", (dom: ReturnType<typeof bind>) => dom.fire("sink", "blur")],
    ["window blur", (dom: ReturnType<typeof bind>) => dom.fire("win", "blur")],
    [
      "page hidden",
      (dom: ReturnType<typeof bind>) => {
        dom.document.hidden = true;
        dom.fire("doc", "visibilitychange");
      },
    ],
  ])("%s cancels the held key and drops its late release", (_name, lose) => {
    const dom = bind();
    dom.fire("sink", "keydown", key);
    expect(dom.events.map((event) => event.kind)).toEqual(["key"]);
    lose(dom);
    expect(dom.cancels()).toBe(1);
    dom.document.hidden = false;
    dom.fire("doc", "keyup", key);
    dom.fire("sink", "keydown", { ...key, repeat: true });
    expect(dom.events).toHaveLength(1);
  });
});

/** Android Chrome reports soft-keyboard edits as keydown 229 / "Unidentified". */
const ime = { ...key, key: "Unidentified", code: "", keyCode: 229 };
const texts = (dom: ReturnType<typeof bind>) =>
  dom.events.flatMap((event) => (event.kind === "text" ? [event.text] : []));

/** Gboard-style composition of one word, ending with compositionend. */
function composeWord(dom: ReturnType<typeof bind>, word: string) {
  dom.fire("sink", "keydown", ime);
  dom.fire("sink", "compositionstart", { data: "" });
  for (let index = 1; index <= word.length; index += 1) {
    if (index > 1) dom.fire("sink", "keydown", { ...ime, isComposing: true });
    dom.fire("sink", "beforeinput", {
      inputType: "insertCompositionText",
      data: word.slice(0, index),
    });
  }
  dom.fire("sink", "compositionend", { data: word });
}

describe("web canvas keyboard adapter Android IME sequences", () => {
  it("commits a composed word exactly once", () => {
    const dom = bind();
    composeWord(dom, "hello");
    expect(texts(dom)).toEqual(["hello"]);
  });

  it("commits text an IME inserts outside a composition (space after a word)", () => {
    const dom = bind();
    composeWord(dom, "hello");
    dom.fire("sink", "keydown", ime);
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: " " });
    composeWord(dom, "world");
    expect(texts(dom).join("")).toBe("hello world");
  });

  it("commits insertText that shares the composing keydown of a batched IME edit", () => {
    const dom = bind();
    dom.fire("sink", "keydown", ime);
    dom.fire("sink", "compositionstart", { data: "" });
    dom.fire("sink", "beforeinput", { inputType: "insertCompositionText", data: "hi" });
    dom.fire("sink", "keydown", { ...ime, isComposing: true });
    dom.fire("sink", "compositionend", { data: "hi" });
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "." });
    expect(texts(dom)).toEqual(["hi", "."]);
  });

  it("commits keyboards that send every character as insertText without composition", () => {
    const dom = bind();
    for (const character of "abc123") {
      dom.fire("sink", "keydown", ime);
      dom.fire("sink", "beforeinput", { inputType: "insertText", data: character });
    }
    expect(texts(dom).join("")).toBe("abc123");
  });

  it("keeps only the final composition after deleteContentBackward and IME correction", () => {
    const dom = bind();
    dom.fire("sink", "keydown", ime);
    dom.fire("sink", "compositionstart", { data: "" });
    dom.fire("sink", "beforeinput", { inputType: "insertCompositionText", data: "teh" });
    dom.fire("sink", "beforeinput", { inputType: "deleteContentBackward", data: null });
    dom.fire("sink", "beforeinput", { inputType: "insertCompositionText", data: "the" });
    dom.fire("sink", "compositionend", { data: "the" });
    expect(texts(dom)).toEqual(["the"]);
  });

  it("commits Korean syllable compositions exactly once", () => {
    const dom = bind();
    composeWord(dom, "한");
    composeWord(dom, "글");
    expect(texts(dom).join("")).toBe("한글");
  });

  it("does not commit insertText after a physical key the adapter consumed or blocked", () => {
    const dom = bind();
    dom.fire("sink", "keydown", key);
    dom.binding.reset();
    // A held key blocked by reset reaches the browser default insertion.
    dom.fire("sink", "keydown", { ...key, repeat: true });
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "a" });
    // A non-IME keydown also disarms an earlier IME edge.
    dom.fire("sink", "keydown", ime);
    dom.fire("sink", "keydown", { ...key, repeat: true });
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "a" });
    expect(texts(dom)).toEqual([]);
  });

  it("drops IME insertText once reset or not in control", () => {
    const dom = bind();
    dom.fire("sink", "keydown", ime);
    dom.binding.reset();
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "x" });
    expect(texts(dom)).toEqual([]);
  });

  it("commits every insertText of one IME keydown until the next keydown", () => {
    const dom = bind();
    dom.fire("sink", "keydown", ime);
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "a" });
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "b" });
    expect(texts(dom)).toEqual(["a", "b"]);
  });

  it.each([
    ["Unidentified", { ...key, key: "Unidentified", code: "" }],
    ["Process", { ...key, key: "Process", code: "" }],
  ])("treats a %s keydown without keyCode 229 as an IME edge", (_name, edge) => {
    const dom = bind();
    dom.fire("sink", "keydown", edge);
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "x" });
    expect(texts(dom)).toEqual(["x"]);
  });
});
