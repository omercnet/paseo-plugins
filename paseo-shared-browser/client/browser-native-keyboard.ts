/**
 * Basic native software typing, separate from Compose's explicit Done commit.
 * This relay knows only text it just inserted at the remote caret. It never
 * replaces a remote field or infers a correction outside that local suffix.
 * RN does not expose composition commits; complex IME belongs in Compose mode.
 */
import type { CanvasKeyboardEvent } from "./browser-canvas-keyboard";

interface NativeKeyboardOptions {
  enabled(): boolean;
  enqueue(event: CanvasKeyboardEvent): boolean;
  finish(): void;
  onValue(value: string): void;
  onError(error: Error): void;
}
const MAX_LOCAL_SUFFIX = 1_024;

/** Infer only a whole final grapheme from the original known suffix boundaries. */
function isOneTrailingGrapheme(before: string, after: string): boolean {
  if (typeof Intl.Segmenter === "function") {
    const segments = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(before),
    ];
    return segments.at(-1)?.index === after.length;
  }
  // Hermes versions without Segmenter can safely count plain ASCII only. A code
  // point count would corrupt emoji/combining clusters under native Backspace.
  return /^[\x20-\x7e]*$/.test(before) && before.length - after.length === 1;
}

/** Event envelopes come from TextInput, not inferred native hardware shortcuts. */
export function createBrowserNativeKeyboard(options: NativeKeyboardOptions) {
  let suffix = "";
  let pendingBackspace: string | null = null;
  const setSuffix = (value: string) => {
    suffix = value;
    options.onValue(value);
  };
  const reset = () => {
    pendingBackspace = null;
    setSuffix("");
  };
  const rejectEdit = () => {
    reset();
    options.onError(
      new Error(
        "Use Compose and Done for IME or text corrections. Live typing supports basic text and Backspace.",
      ),
    );
  };
  const press = (key: "Backspace" | "Enter", code: "Backspace" | "Enter") => {
    if (!options.enabled()) return false;
    const down = options.enqueue({
      kind: "key",
      type: "down",
      key,
      code,
      modifiers: 0,
      repeat: false,
    });
    if (!down) return false;
    const up = options.enqueue({ kind: "key", type: "up", key, code, modifiers: 0, repeat: false });
    if (up) options.finish();
    return up;
  };
  const changeText = (value: string) => {
    if (!options.enabled()) {
      reset();
      return;
    }
    if (pendingBackspace !== null) {
      const previous = pendingBackspace;
      pendingBackspace = null;
      if (previous.startsWith(value) && value.length < previous.length) {
        // onKeyPress already forwarded the physical Backspace. Drop local
        // context so an OS-specific deletion width cannot authorize later edits.
        setSuffix("");
        return;
      }
      rejectEdit();
      return;
    }
    if (value === suffix) return;
    if (value.startsWith(suffix)) {
      const appended = value.slice(suffix.length);
      if (appended.length > 16_000) {
        reset();
        options.onError(new Error("Text is too long. Send up to 16,000 characters at once."));
        return;
      }
      if (options.enqueue({ kind: "text", text: appended })) {
        setSuffix(value.length > MAX_LOCAL_SUFFIX ? "" : value);
        options.finish();
      }
      return;
    }
    if (suffix.startsWith(value)) {
      // A missing onKeyPress can be repaired only for one complete known
      // grapheme. Bulk replacement/deletion is a Compose edit, not live input.
      if (isOneTrailingGrapheme(suffix, value) && press("Backspace", "Backspace")) {
        setSuffix("");
        return;
      }
    }
    rejectEdit();
  };
  const keyPress = (key: string) => {
    if (!options.enabled()) return;
    if (key === "Backspace") {
      if (press("Backspace", "Backspace")) pendingBackspace = suffix || null;
    } else if (key === "Enter") {
      press("Enter", "Enter");
      reset();
    }
  };
  const selection = (start: number, end: number) => {
    // Native selection notifications may precede the matching text change.
    // A collapsed caret at/after the suffix, or the pending physical deletion,
    // grants no edit authority and can wait for that qualified change callback.
    if (start === end && (end >= suffix.length || pendingBackspace !== null)) {
      return true;
    }
    if (start !== end || end !== suffix.length) {
      // Hidden Live input has no selection editor. A moved local caret cannot
      // establish an equivalent remote caret and therefore revokes the suffix.
      reset();
      return false;
    }
    return true;
  };
  const compose = (value: string): boolean => {
    if (!options.enabled() || !value) return false;
    if (value.length > 16_000) {
      options.onError(new Error("Text is too long. Send up to 16,000 characters at once."));
      return false;
    }
    const accepted = options.enqueue({ kind: "text", text: value });
    if (accepted) {
      reset();
      options.finish();
    }
    return accepted;
  };
  return { reset, changeText, keyPress, selection, compose };
}
