/**
 * Focused web keyboard/IME bridge. Its invisible editable sink gives the browser
 * a real composition target without modifying image children. Only controlled
 * canvas focus consumes host keys; blur releases the original remote channel.
 * Browser-reserved shortcuts are outside JavaScript's interception guarantees.
 */
import {
  type CanvasKeyboardEvent,
  type CanvasKeyEnvelope,
  createBrowserCanvasKeyboard,
} from "./browser-canvas-keyboard";

interface KeyboardDomEvent extends CanvasKeyEnvelope {
  data?: string | null;
  inputType?: string;
  clipboardData?: { getData(type: string): string } | null;
  preventDefault(): void;
  stopPropagation(): void;
}
interface KeyboardElement {
  tabIndex: number;
  value: string;
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  focus(options?: { preventScroll: boolean }): void;
  remove(): void;
  addEventListener(
    type: string,
    listener: (event: KeyboardDomEvent) => void,
    options?: { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: KeyboardDomEvent) => void,
    options?: { capture?: boolean },
  ): void;
}
export interface KeyboardCanvasNode extends KeyboardElement {
  appendChild(child: KeyboardElement): void;
  ownerDocument: {
    activeElement: unknown;
    hidden: boolean;
    createElement(tag: "textarea"): KeyboardElement;
    addEventListener(type: string, listener: (event: KeyboardDomEvent) => void): void;
    removeEventListener(type: string, listener: (event: KeyboardDomEvent) => void): void;
    defaultView: {
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    } | null;
  };
}
interface BindingOptions {
  enabled(): boolean;
  enqueue(event: CanvasKeyboardEvent): boolean;
  finish(): void;
  cancel(): void;
  onError(error: Error): void;
}

// Android soft keyboards delete through InputConnection.deleteSurroundingText.
// Chrome reports keydown 229/"Unidentified", then beforeinput delete* only when
// the sink has text next to the caret. With an empty sink the keydown and keyup
// are all that arrive, so the sink always keeps one invisible character to delete.
const SINK_TEXT = "\u200B";
// Character deletions map to the key a hardware keyboard sends. Word deletions
// stay unmapped: the remote shortcut depends on the host OS (Ctrl or Option).
const IME_EDIT_KEYS: Record<string, string> = {
  deleteContentBackward: "Backspace",
  deleteContentForward: "Delete",
};

/** DOM-only binding; callers must dispose it and reset on route/control changes. */
export function bindBrowserCanvasKeyboard(node: KeyboardCanvasNode, options: BindingOptions) {
  const document = node.ownerDocument;
  const previousTabIndex = node.tabIndex;
  const sink = document.createElement("textarea");
  sink.tabIndex = -1;
  sink.setAttribute("aria-label", "Type in the shared browser");
  sink.setAttribute("autocomplete", "off");
  sink.setAttribute("autocapitalize", "off");
  sink.setAttribute("spellcheck", "false");
  Object.assign(sink.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    opacity: "0",
    left: "0",
    top: "0",
    padding: "0",
    border: "0",
    pointerEvents: "none",
  });
  node.tabIndex = 0;
  node.appendChild(sink);
  sink.value = SINK_TEXT;
  let composing = false;
  let compositionAdmitted = false;
  let altTextPending: string | null = null;
  // Soft keyboards (Android Chrome) report edits outside a composition, such as
  // a space after a word, every key on non-predictive keyboards, or Backspace,
  // as keydown 229/"Unidentified" followed by beforeinput insertText or delete*.
  // That keydown carries no key to forward, so the edit itself is the only source.
  let imeTextPending = false;
  const focused = () => document.activeElement === sink || document.activeElement === node;
  const keyboard = createBrowserCanvasKeyboard({
    ...options,
    enabled: () => options.enabled() && focused() && !document.hidden,
  });
  const consume = (event: KeyboardDomEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const reset = () => {
    keyboard.reset();
    compositionAdmitted = false;
    composing = false;
    altTextPending = null;
    imeTextPending = false;
    sink.value = SINK_TEXT;
  };
  const cancel = () => {
    reset();
    options.cancel();
  };
  const focus = () => {
    if (options.enabled() && !document.hidden) {
      sink.focus({ preventScroll: true });
    }
  };
  const down = (event: KeyboardDomEvent) => {
    if (!focused()) {
      return;
    }
    imeTextPending =
      event.keyCode === 229 || event.key === "Process" || event.key === "Unidentified";
    // Local paste supplies clipboard bytes separately. Sending Ctrl/Meta+V would
    // additionally paste an unrelated remote clipboard and duplicate the action.
    const pasteShortcut =
      !event.altKey &&
      (((event.ctrlKey || event.metaKey) && event.code === "KeyV") ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "Insert"));
    if (pasteShortcut) {
      if (options.enabled()) {
        event.stopPropagation();
      }
      return;
    }
    if (keyboard.key("down", event)) {
      const altPrintable =
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.getModifierState?.("AltGraph") &&
        Array.from(event.key).length === 1;
      altTextPending = altPrintable ? event.key : null;
      if (altTextPending) {
        // Option layouts can produce text with Alt held. Only the browser's
        // ensuing insertion event qualifies it; an Alt shortcut may emit none.
        event.stopPropagation();
      } else {
        consume(event);
      }
    } else if (options.enabled() && (composing || event.isComposing)) {
      event.stopPropagation();
    }
  };
  const up = (event: KeyboardDomEvent) => {
    // Document observes releases after focus loss without consuming Paseo input.
    if (keyboard.key("up", event) && focused()) {
      consume(event);
    }
    altTextPending = null;
  };
  const compositionStart = () => {
    altTextPending = null;
    composing = true;
    compositionAdmitted = options.enabled() && focused() && !document.hidden;
  };
  const commitText = (value: string) => {
    if (value.length > 16_000) {
      options.onError(new Error("Text is too long. Send up to 16,000 characters at once."));
      return;
    }
    keyboard.text(value);
  };
  const compositionEnd = (event: KeyboardDomEvent) => {
    const accepted = compositionAdmitted && options.enabled() && focused();
    composing = false;
    compositionAdmitted = false;
    if (accepted) {
      commitText(event.data ?? "");
    }
    sink.value = SINK_TEXT;
  };
  // One full press, as the matching hardware key would send it.
  const pressKey = (key: string) => {
    const press = {
      key,
      code: key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
    };
    if (keyboard.key("down", press)) {
      keyboard.key("up", press);
    }
  };
  const beforeInput = (event: KeyboardDomEvent) => {
    if (!composing && options.enabled() && focused()) {
      consume(event);
      const editKey =
        imeTextPending && event.inputType ? IME_EDIT_KEYS[event.inputType] : undefined;
      if (editKey) {
        pressKey(editKey);
      } else if (
        event.inputType === "insertText" &&
        event.data &&
        (imeTextPending || event.data === altTextPending)
      ) {
        commitText(event.data);
      }
      altTextPending = null;
    }
  };
  // Blink applies a deleteSurroundingText deletion even when its beforeinput was
  // cancelled. Put the sink text back so the next Backspace still has a target.
  const input = () => {
    if (!composing && sink.value !== SINK_TEXT) {
      sink.value = SINK_TEXT;
    }
  };
  const paste = (event: KeyboardDomEvent) => {
    if (!options.enabled() || !focused()) {
      return;
    }
    consume(event);
    altTextPending = null;
    commitText(event.clipboardData?.getData("text/plain") ?? "");
    sink.value = SINK_TEXT;
  };
  const visibility = () => {
    if (document.hidden) {
      cancel();
    }
  };
  const listeners: Array<[KeyboardElement, string, (event: KeyboardDomEvent) => void]> = [
    [node, "pointerdown", focus],
    [node, "mousedown", focus],
    [node, "touchstart", focus],
    [node, "focus", focus],
    [sink, "keydown", down],
    [node, "keydown", down],
    [sink, "compositionstart", compositionStart],
    [sink, "compositionend", compositionEnd],
    [sink, "beforeinput", beforeInput],
    [sink, "input", input],
    [sink, "paste", paste],
    [sink, "blur", cancel],
  ];
  for (const [element, type, listener] of listeners) {
    element.addEventListener(type, listener);
  }
  document.addEventListener("keyup", up);
  document.addEventListener("visibilitychange", visibility);
  document.defaultView?.addEventListener("blur", cancel);
  return {
    reset,
    dispose() {
      cancel();
      for (const [element, type, listener] of listeners) {
        element.removeEventListener(type, listener);
      }
      document.removeEventListener("keyup", up);
      document.removeEventListener("visibilitychange", visibility);
      document.defaultView?.removeEventListener("blur", cancel);
      node.tabIndex = previousTabIndex;
      sink.remove();
    },
  };
}
