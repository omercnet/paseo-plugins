/**
 * Stock RN TextInput binding for the native Keyboard button. The caller places
 * the hidden Live input and owns the visible Compose draft/Done sheet. Android
 * hardware-key shortcuts are not exposed by this RN software-keyboard API.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, type TextInput, type TextInputProps } from "react-native";
import type { CanvasKeyboardEvent } from "./browser-canvas-keyboard";
import { createBrowserNativeKeyboard } from "./browser-native-keyboard";

interface NativeRelayOptions {
  enabled(): boolean;
  ownershipKey: string;
  enqueue(event: CanvasKeyboardEvent): boolean;
  finish(): void;
  cancel(): void;
  onError(error: Error): void;
}

/** No native input is focused automatically; focus runs only from Keyboard. */
export function useBrowserNativeKeyboard(options: NativeRelayOptions) {
  const current = useRef(options);
  current.current = options;
  const alive = useRef(true);
  const inputRef = useRef<TextInput | null>(null);
  const [value, setValue] = useState("");
  const [generation, setGeneration] = useState(0);
  const currentGeneration = useRef(0);
  const focusedTarget = useRef<number | null>(null);
  const lastEventCount = useRef(-1);
  const rotateInput = useCallback(() => {
    focusedTarget.current = null;
    lastEventCount.current = -1;
    currentGeneration.current += 1;
    if (alive.current && Platform.OS !== "web") {
      setGeneration(currentGeneration.current);
    }
  }, []);
  const [relay] = useState(() =>
    createBrowserNativeKeyboard({
      enabled: () => alive.current && Platform.OS !== "web" && current.current.enabled(),
      enqueue: (event) => current.current.enqueue(event),
      finish: () => current.current.finish(),
      onError: (error) => {
        rotateInput();
        current.current.onError(error);
      },
      onValue: (next) => {
        if (alive.current) setValue(next);
      },
    }),
  );
  const reset = useCallback(() => {
    relay.reset();
    rotateInput();
  }, [relay, rotateInput]);
  const previousOwner = useRef(options.ownershipKey);
  useLayoutEffect(() => {
    if (previousOwner.current === options.ownershipKey) return;
    previousOwner.current = options.ownershipKey;
    reset();
  }, [reset, options.ownershipKey]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      relay.reset();
    };
  }, [relay]);
  const focus = useCallback(() => {
    if (Platform.OS !== "web" && current.current.enabled()) inputRef.current?.focus();
  }, []);
  const callbackCurrent = () =>
    alive.current &&
    currentGeneration.current === generation &&
    current.current.ownershipKey === options.ownershipKey &&
    current.current.enabled();
  const inputProps: TextInputProps = {
    value,
    autoCorrect: false,
    autoCapitalize: "none",
    autoComplete: "off",
    spellCheck: false,
    contextMenuHidden: true,
    multiline: false,
    submitBehavior: "submit",
    onFocus: (event) => {
      const target = event.nativeEvent.target;
      if (callbackCurrent() && Number.isSafeInteger(target) && target > 0) {
        focusedTarget.current = target;
      }
    },
    onChange: (event) => {
      const { target, text, eventCount } = event.nativeEvent;
      if (
        !callbackCurrent() ||
        target !== focusedTarget.current ||
        !Number.isSafeInteger(eventCount) ||
        eventCount < 0 ||
        eventCount <= lastEventCount.current
      )
        return;
      lastEventCount.current = eventCount;
      relay.changeText(text);
    },
    onKeyPress: (event) => {
      if (callbackCurrent() && focusedTarget.current !== null)
        relay.keyPress(event.nativeEvent.key);
    },
    onSelectionChange: (event) => {
      if (!callbackCurrent() || event.nativeEvent.target !== focusedTarget.current) return;
      const { start, end } = event.nativeEvent.selection;
      if (!relay.selection(start, end)) reset();
    },
    onBlur: () => {
      if (!callbackCurrent() || focusedTarget.current === null) return;
      reset();
      current.current.cancel();
    },
  };
  return {
    inputRef,
    inputProps,
    inputKey: `${options.ownershipKey}:${generation}`,
    focus,
    reset,
    composeText: relay.compose,
  };
}
