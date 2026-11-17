import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SESSION_EVENTS_AFTER_PINNED_RUNTIME } from "./omp-sdk-contract.types";

// A runtime check on purpose: the nightly latest-OMP lane compiles the contract types against a
// newer SDK than the pin, so a type assertion here would fail that lane instead of the pin bump.
test("lists session events newer than the pinned OMP SDK only while the SDK predates them", () => {
  // Node resolution from this directory, the same lookup tsc uses for the contract types. The
  // package does not export `./package.json`, so it cannot be resolved by specifier.
  let manifest: string | undefined;
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json");
    if (existsSync(candidate)) {
      manifest = candidate;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!manifest) throw new Error("@oh-my-pi/pi-coding-agent is not installed");
  const installed = String(JSON.parse(readFileSync(manifest, "utf8")).version);
  const version = (value: string) => value.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const [major = 0, minor = 0, patch = 0] = version(installed);
  expect([major, minor, patch].every(Number.isSafeInteger) && major > 0).toBe(true);

  // Typed so the check still compiles once the last entry is removed and the map is `{}`.
  const entries = Object.entries<string>(SESSION_EVENTS_AFTER_PINNED_RUNTIME);
  const stale = entries.filter(([, addedIn]) => {
    const [addedMajor = 0, addedMinor = 0, addedPatch = 0] = version(addedIn);
    return (major - addedMajor || minor - addedMinor || patch - addedPatch) >= 0;
  });
  expect(
    stale,
    `@oh-my-pi/pi-coding-agent ${installed} has these events: remove them from ` +
      "SESSION_EVENTS_AFTER_PINNED_RUNTIME in tests/omp-sdk-contract.types.ts",
  ).toEqual([]);
});
