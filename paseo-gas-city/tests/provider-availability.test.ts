import type { PluginServerContext } from "@getpaseo/plugin/server";
import { expect, test } from "vitest";
import contribute from "../index.server";

test("does not register a native session provider for Gas City v1.4.1", () => {
  let registrations = 0;

  contribute({
    registerSettings() {},
    handle() {},
    registerProvider() {
      registrations += 1;
    },
  } as unknown as PluginServerContext);

  expect(registrations).toBe(0);
});
