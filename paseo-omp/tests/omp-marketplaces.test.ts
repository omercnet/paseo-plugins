import { describe, expect, test } from "vitest";
import {
  browseOmpMarketplaceWithDependencies,
  listOmpMarketplacesWithDependencies,
  mutateOmpMarketplaceWithDependencies,
  type OmpPluginDependencies,
  parseOmpCatalog,
  parseOmpMarketplaceList,
} from "../server/omp-plugins";
import type { BoundedRun } from "../server/provider-diagnostics";
import { OmpMarketplaceMutationSchema, redactSourceCredentials } from "../shared/omp-plugins";

function completed(stdout: string, exitCode = 0): BoundedRun {
  return {
    outcome: "exited",
    stdout,
    truncated: false,
    exitCode,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
  };
}

function dependenciesFor(runPlugin: OmpPluginDependencies["runPlugin"]): OmpPluginDependencies {
  return {
    async resolveExecutable() {
      return "/trusted/omp";
    },
    runPlugin,
  };
}

const LIST_OUTPUT = "Configured Marketplaces:\n\n  demo-catalog  /tmp/some dir/catalog\n";
const CATALOG_OUTPUT =
  "Available Plugins (demo-catalog):\n\n  hello@1.0.0\n    Says hello\n  other\n    Another plugin\n  bare\n";

describe("OMP marketplace listing", () => {
  test("keeps names and sources that contain spaces and drops invalid names", () => {
    expect(
      parseOmpMarketplaceList(
        "Configured Marketplaces:\n\n  official  owner/repo\n" +
          "  demo-catalog  /tmp/some dir/catalog\n  bad name  x\n",
      ),
    ).toEqual([
      { name: "official", source: "owner/repo" },
      { name: "demo-catalog", source: "/tmp/some dir/catalog" },
    ]);
  });

  test("never returns credentials embedded in a catalog URL", () => {
    expect(
      parseOmpMarketplaceList(
        "Configured Marketplaces:\n\n  private  https://user:s3cret@git.example.com/org/repo.git\n" +
          "  ssh-style  git@github.com:org/repo.git\n",
      ),
    ).toEqual([
      { name: "private", source: "https://git.example.com/org/repo.git" },
      { name: "ssh-style", source: "git@github.com:org/repo.git" },
    ]);
    expect(redactSourceCredentials("https://token@host/x?a=b@c")).toBe("https://host/x?a=b@c");
    expect(redactSourceCredentials("owner/repo")).toBe("owner/repo");
  });

  test("treats the empty-state message as no marketplaces and rejects unknown output", () => {
    expect(
      parseOmpMarketplaceList(
        "No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>\n",
      ),
    ).toEqual([]);
    expect(() => parseOmpMarketplaceList("something else entirely")).toThrow();
  });

  test("reports unavailable when OMP exits non-zero", async () => {
    const state = await listOmpMarketplacesWithDependencies(
      dependenciesFor(async () => completed("", 1)),
    );
    expect(state).toEqual({
      available: false,
      marketplaces: [],
      error: "OMP plugin discovery failed.",
    });
  });
});

describe("OMP marketplace catalog", () => {
  test("builds installable name@marketplace ids with versions and descriptions", () => {
    expect(parseOmpCatalog(CATALOG_OUTPUT, "demo-catalog")).toEqual([
      { id: "hello@demo-catalog", version: "1.0.0", description: "Says hello" },
      { id: "other@demo-catalog", version: null, description: "Another plugin" },
      { id: "bare@demo-catalog", version: null, description: null },
    ]);
  });

  test("treats an empty catalog as no plugins and rejects unknown output", () => {
    expect(parseOmpCatalog("No plugins found in demo-catalog\n", "demo-catalog")).toEqual([]);
    expect(() => parseOmpCatalog("Failed to discover plugins", "demo-catalog")).toThrow();
  });

  test("keeps mixed-case plugin names and enforces the 128-character id limit", () => {
    const long = "a".repeat(64);
    expect(parseOmpCatalog("Available Plugins (m):\n\n  MixedCase@2.0\n    Upper\n", "m")).toEqual([
      { id: "MixedCase@m", version: "2.0", description: "Upper" },
    ]);
    const marketplace = "b".repeat(63);
    expect(parseOmpCatalog(`Available Plugins (x):\n\n  ${long}\n`, marketplace)).toEqual([
      { id: `${long}@${marketplace}`, version: null, description: null },
    ]);
    expect(parseOmpCatalog(`Available Plugins (x):\n\n  ${long}\n`, `${marketplace}b`)).toEqual([]);
    expect(parseOmpCatalog(`Available Plugins (x):\n\n  ${long}x\n`, marketplace)).toEqual([]);
  });

  test("does not attach a skipped entry's description to the previous plugin", () => {
    expect(
      parseOmpCatalog(
        "Available Plugins (m):\n\n  bare\n  bad_name\n    Belongs to the skipped entry\n",
        "m",
      ),
    ).toEqual([{ id: "bare@m", version: null, description: null }]);
  });

  test("asks OMP for exactly the selected marketplace", async () => {
    const calls: string[][] = [];
    const state = await browseOmpMarketplaceWithDependencies(
      { marketplace: "demo-catalog" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        return completed(CATALOG_OUTPUT);
      }),
    );
    expect(calls).toEqual([["plugin", "discover", "demo-catalog"]]);
    expect(state.available).toBe(true);
    expect(state.plugins).toHaveLength(3);
  });
});

describe("OMP marketplace mutation", () => {
  test("adds a catalog without a shell and returns the refreshed list", async () => {
    const calls: string[][] = [];
    const result = await mutateOmpMarketplaceWithDependencies(
      { action: "add", source: "owner/repo" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        return completed(args[2] === "list" ? LIST_OUTPUT : "Added marketplace: owner/repo");
      }),
    );
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "owner/repo"],
      ["plugin", "marketplace", "list"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.state.marketplaces.map(({ name }) => name)).toEqual(["demo-catalog"]);
  });

  test("a rejected add reports failure but still shows the current catalogs", async () => {
    const result = await mutateOmpMarketplaceWithDependencies(
      { action: "add", source: "owner/missing" },
      dependenciesFor(async (_executable, args) =>
        args[2] === "list" ? completed(LIST_OUTPUT) : completed("", 1),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("OMP rejected the plugin operation.");
    expect(result.state.marketplaces).toHaveLength(1);
  });

  test("removes by marketplace name", async () => {
    const calls: string[][] = [];
    await mutateOmpMarketplaceWithDependencies(
      { action: "remove", marketplace: "demo-catalog" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        return completed("No marketplaces configured");
      }),
    );
    expect(calls[0]).toEqual(["plugin", "marketplace", "remove", "demo-catalog"]);
  });

  test.each([
    { action: "add", source: "--force" },
    { action: "add", source: "owner/repo\n--force" },
    { action: "remove", marketplace: "../escape" },
    { action: "remove", marketplace: "a/b" },
    { action: "remove", marketplace: "-rf" },
  ])("rejects unsafe input %j", (input) => {
    expect(OmpMarketplaceMutationSchema.safeParse(input).success).toBe(false);
  });
});
