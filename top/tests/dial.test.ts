import { describe, expect, it } from "vitest";
import {
  accessibilityValue,
  needleDegrees,
  SWEEP,
  sparkHeights,
  TICKS,
  tickPercent,
} from "../client/dial";

describe("dial geometry", () => {
  it("spreads ticks from 0 to 100 inclusive", () => {
    expect(tickPercent(0)).toBe(0);
    expect(tickPercent(TICKS - 1)).toBe(100);
  });

  it("points the needle straight up at 50 and sweeps symmetrically", () => {
    expect(needleDegrees(0)).toBe(-SWEEP / 2);
    expect(needleDegrees(50)).toBe(0);
    expect(needleDegrees(100)).toBe(SWEEP / 2);
  });

  it("rests at the start for an unknown value and stays on the dial for an out-of-range one", () => {
    expect(needleDegrees(null)).toBe(-SWEEP / 2);
    expect(needleDegrees(250)).toBe(SWEEP / 2);
    expect(needleDegrees(-5)).toBe(-SWEEP / 2);
  });

  it("scales spark bars to 0-1 and flattens unknown samples", () => {
    expect(sparkHeights([25, null, 100, 400], 100)).toEqual([0.25, 0, 1, 1]);
    expect(sparkHeights([5], 0)).toEqual([0]);
  });
});

describe("accessibilityValue", () => {
  it("gives a screen reader no current value for an unknown reading, rather than a false zero", () => {
    expect(accessibilityValue(null)).toEqual({ min: 0, max: 100 });
    expect(accessibilityValue(0)).toEqual({ min: 0, max: 100, now: 0 });
    expect(accessibilityValue(37.6)).toEqual({ min: 0, max: 100, now: 38 });
  });
});
