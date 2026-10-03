import { describe, expect, test } from "vitest";
import { supportsScreens } from "../client/capabilities";

describe("host capability detection", () => {
  const register = () => () => {};

  test("uses screens only when the host has both the screen and sidebar header APIs", () => {
    expect(supportsScreens({ addScreen: register, addSidebarHeaderItem: register })).toBe(true);
    expect(supportsScreens({ addScreen: register })).toBe(false);
  });

  test("falls back on 0.9 and 0.10 hosts, which only expose surfaces", () => {
    expect(supportsScreens({})).toBe(false);
  });
});
