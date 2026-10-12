import type * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dial } from "../client/gauge";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  effects: [] as Array<() => unknown>,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof React>()),
  useRef: <T,>(current: T) => ({ current }),
  useEffect: (effect: () => unknown) => {
    mocks.effects.push(effect);
  },
}));

vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  Easing: { out: (easing: unknown) => easing, cubic: "cubic" },
  Animated: {
    Value: class {
      interpolate() {
        return "0deg";
      }
    },
    timing: () => ({ start: mocks.start, stop: mocks.stop }),
    View: "AnimatedView",
  },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));

const theme = {
  colors: {
    surface0: "s0",
    surface1: "s1",
    surface2: "s2",
    border: "border",
    foreground: "fg",
    foregroundMuted: "muted",
    accent: "accent",
    accentForeground: "af",
    statusSuccess: "ok",
    statusWarning: "warn",
    statusDanger: "danger",
  },
};

beforeEach(() => {
  mocks.start.mockReset();
  mocks.stop.mockReset();
  mocks.effects.length = 0;
});

describe("Dial", () => {
  it("stops the needle animation when the value changes or the dial goes away", () => {
    Dial({
      theme: theme as never,
      size: 100,
      icon: "Cpu",
      label: "CPU",
      value: 40,
      text: "40%",
    });
    const cleanup = mocks.effects[0]?.();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
    (cleanup as () => void)();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
