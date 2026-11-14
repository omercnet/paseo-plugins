import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const EXAMPLES_DIR = resolve(__dirname, "../examples");
const ADE_BIN_DIR = join(homedir(), "src", "djbclark-ade", "bin");

describe("djbclark-ade routing sync", () => {
  const adeRouteAgent = join(ADE_BIN_DIR, "route_agent.py");
  test.skipIf(!existsSync(adeRouteAgent))(
    "examples/route_agent.py matches ~/src/djbclark-ade/bin/route_agent.py",
    () => {
      const localBytes = readFileSync(join(EXAMPLES_DIR, "route_agent.py"));
      const adeBytes = readFileSync(adeRouteAgent);
      expect(localBytes.equals(adeBytes)).toBe(true);
    },
  );

  const adePrRadarRoute = join(ADE_BIN_DIR, "pr-radar-route");
  test.skipIf(!existsSync(adePrRadarRoute))(
    "examples/pr-radar-route.py matches ~/src/djbclark-ade/bin/pr-radar-route",
    () => {
      const localBytes = readFileSync(join(EXAMPLES_DIR, "pr-radar-route.py"));
      const adeBytes = readFileSync(adePrRadarRoute);
      expect(localBytes.equals(adeBytes)).toBe(true);
    },
  );
});
