import { describe, expect, it } from "vitest";
import {
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  browserInputEventSchema,
  mapDisplayedPoint,
  viewportSchema,
} from "../shared/browser";

describe("mapDisplayedPoint", () => {
  it("maps a contained image point into canonical CSS pixels", () => {
    expect(
      mapDisplayedPoint({ x: 320, y: 180, width: 640, height: 360 }, { width: 1280, height: 720 }),
    ).toEqual({ x: 640, y: 360 });
  });

  it("rejects coordinates outside the displayed image", () => {
    expect(() =>
      mapDisplayedPoint({ x: 641, y: 20, width: 640, height: 360 }, { width: 1280, height: 720 }),
    ).toThrow("outside the displayed frame");
  });

  it("clamps an inclusive bottom-right edge inside the browser viewport", () => {
    expect(
      mapDisplayedPoint({ x: 640, y: 360, width: 640, height: 360 }, { width: 1280, height: 720 }),
    ).toEqual({ x: 1279, y: 719 });
  });
});

describe("shared RPC validation", () => {
  it("bounds the canonical viewport independently of viewer size", () => {
    expect(viewportSchema.safeParse(MIN_VIEWPORT).success).toBe(true);
    expect(viewportSchema.safeParse(MAX_VIEWPORT).success).toBe(true);
    expect(viewportSchema.safeParse({ width: 320, height: 240 }).success).toBe(false);
    expect(viewportSchema.safeParse({ width: 2560, height: 1440 }).success).toBe(false);
  });

  it("rejects unbounded input text and scroll deltas", () => {
    expect(
      browserInputEventSchema.safeParse({ kind: "type", text: "x".repeat(4_001) }).success,
    ).toBe(false);
    expect(
      browserInputEventSchema.safeParse({
        kind: "scroll",
        point: { x: 1, y: 1, width: 10, height: 10 },
        deltaX: 0,
        deltaY: 4_001,
      }).success,
    ).toBe(false);
  });
});
