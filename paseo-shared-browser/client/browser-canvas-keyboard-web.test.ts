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
  /** Dispatches to the adapter's listeners; returns whether one cancelled the default. */
  const fire = (name: string, type: string, event: object = {}) => {
    let cancelled = false;
    for (const listener of registry.get(`${name}:${type}`) ?? [])
      (listener as (event: object) => void)({
        preventDefault() {
          cancelled = true;
        },
        stopPropagation() {},
        ...event,
      });
    return cancelled;
  };
  return { node, document, sink, fire };
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

type Bound = ReturnType<typeof bind>;
/** Remote key edges, such as "down:Backspace". */
const presses = (dom: Bound) =>
  dom.events.flatMap((event) => (event.kind === "key" ? [`${event.type}:${event.key}`] : []));
const BACKSPACE = ["down:Backspace", "up:Backspace"];

/** keydown 229, one beforeinput edit, keyup 229, regardless of what the sink holds. */
function imeEdit(dom: Bound, inputType: string) {
  dom.fire("sink", "keydown", ime);
  dom.fire("sink", "beforeinput", { inputType, data: null });
  dom.fire("doc", "keyup", ime);
}

/**
 * Chrome Android applying a soft-keyboard Backspace (ImeAdapterImpl
 * deleteSurroundingText): keydown 229; only when the sink has text before the
 * caret, beforeinput deleteContentBackward, the deletion and input; keyup 229.
 * Blink applies this deletion even when beforeinput is cancelled
 * (InputMethodController::DeleteSelectionWithoutAdjustment ignores the result);
 * cancelHonored covers an engine that does honor it.
 */
function softBackspace(dom: Bound, cancelHonored = false) {
  dom.fire("sink", "keydown", ime);
  if (dom.sink.value.length > 0) {
    const cancelled = dom.fire("sink", "beforeinput", {
      inputType: "deleteContentBackward",
      data: null,
    });
    if (!cancelled || !cancelHonored) {
      dom.sink.value = dom.sink.value.slice(0, -1);
      dom.fire("sink", "input", { inputType: "deleteContentBackward", data: null });
    }
  }
  dom.fire("doc", "keyup", ime);
}

/** Hangul composition steps; Backspace inside it rewrites the composition. */
function compose(dom: Bound, steps: Array<{ inputType: string; data: string | null }>) {
  dom.fire("sink", "keydown", ime);
  dom.fire("sink", "compositionstart", { data: "" });
  for (const [index, step] of steps.entries()) {
    if (index > 0) dom.fire("sink", "keydown", { ...ime, isComposing: true });
    dom.fire("sink", "beforeinput", step);
  }
}

describe("web canvas keyboard adapter Android soft-keyboard deletion", () => {
  it.each<[string, (dom: Bound) => void, { texts: string[]; presses: string[] }]>([
    [
      "keydown 229 + beforeinput deleteContentBackward presses Backspace",
      (dom) => imeEdit(dom, "deleteContentBackward"),
      { texts: [], presses: BACKSPACE },
    ],
    [
      "keydown 229 + beforeinput deleteContentForward presses Delete",
      (dom) => imeEdit(dom, "deleteContentForward"),
      { texts: [], presses: ["down:Delete", "up:Delete"] },
    ],
    // Word deletion has no host-independent shortcut (Ctrl or Option+Backspace).
    [
      "keydown 229 + beforeinput deleteWordBackward stays unmapped",
      (dom) => imeEdit(dom, "deleteWordBackward"),
      { texts: [], presses: [] },
    ],
    [
      "keydown 229 + beforeinput deleteWordForward stays unmapped",
      (dom) => imeEdit(dom, "deleteWordForward"),
      { texts: [], presses: [] },
    ],
    [
      "Backspace before any typing (empty field, keydown carries no key)",
      (dom) => softBackspace(dom),
      { texts: [], presses: BACKSPACE },
    ],
    [
      "three Backspaces after a committed word",
      (dom) => {
        composeWord(dom, "hi");
        for (let count = 0; count < 3; count += 1) softBackspace(dom);
      },
      { texts: ["hi"], presses: [...BACKSPACE, ...BACKSPACE, ...BACKSPACE] },
    ],
    [
      "three Backspaces when the engine honors the cancelled beforeinput",
      (dom) => {
        composeWord(dom, "hi");
        for (let count = 0; count < 3; count += 1) softBackspace(dom, true);
      },
      { texts: ["hi"], presses: [...BACKSPACE, ...BACKSPACE, ...BACKSPACE] },
    ],
    [
      "Backspace after a non-composing insertText",
      (dom) => {
        dom.fire("sink", "keydown", ime);
        dom.fire("sink", "beforeinput", { inputType: "insertText", data: "a" });
        softBackspace(dom);
      },
      { texts: ["a"], presses: BACKSPACE },
    ],
    [
      "Backspace after a paste",
      (dom) => {
        dom.fire("sink", "paste", { clipboardData: { getData: () => "pasted" } });
        softBackspace(dom);
      },
      { texts: ["pasted"], presses: BACKSPACE },
    ],
    [
      "Backspace after a control reset",
      (dom) => {
        dom.binding.reset();
        softBackspace(dom);
      },
      { texts: [], presses: BACKSPACE },
    ],
    [
      "Backspace inside a composing word edits it locally (Gboard predictive)",
      (dom) => {
        compose(dom, [
          { inputType: "insertCompositionText", data: "hel" },
          { inputType: "insertCompositionText", data: "he" },
        ]);
        dom.fire("sink", "compositionend", { data: "he" });
      },
      { texts: ["he"], presses: [] },
    ],
    [
      "Hangul: Backspace removes a jamo inside the composition",
      (dom) => {
        compose(dom, [
          { inputType: "insertCompositionText", data: "ㅎ" },
          { inputType: "insertCompositionText", data: "하" },
          { inputType: "insertCompositionText", data: "한" },
          { inputType: "insertCompositionText", data: "하" },
        ]);
        dom.fire("sink", "compositionend", { data: "하" });
      },
      { texts: ["하"], presses: [] },
    ],
    [
      "Hangul: Backspace empties the composition, then deletes the committed syllable",
      (dom) => {
        composeWord(dom, "한");
        compose(dom, [
          { inputType: "insertCompositionText", data: "ㄱ" },
          { inputType: "deleteCompositionText", data: null },
        ]);
        dom.fire("sink", "compositionend", { data: "" });
        softBackspace(dom);
      },
      { texts: ["한"], presses: BACKSPACE },
    ],
    [
      "a real Backspace keydown (keyCode 8) presses once even if beforeinput follows",
      (dom) => {
        const backspace = { ...key, key: "Backspace", code: "Backspace", keyCode: 8 };
        dom.fire("sink", "keydown", backspace);
        dom.fire("sink", "beforeinput", { inputType: "deleteContentBackward", data: null });
        dom.fire("doc", "keyup", backspace);
      },
      { texts: [], presses: BACKSPACE },
    ],
    [
      "an IME deletion after a control reset is dropped",
      (dom) => {
        dom.fire("sink", "keydown", ime);
        dom.binding.reset();
        dom.fire("sink", "beforeinput", { inputType: "deleteContentBackward", data: null });
      },
      { texts: [], presses: [] },
    ],
  ])("%s", (_name, replay, expected) => {
    const dom = bind();
    replay(dom);
    expect({ texts: texts(dom), presses: presses(dom) }).toEqual(expected);
  });
});
