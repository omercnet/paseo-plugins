import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acknowledgeViewerUpdates, resolveViewerScope } from "../server/viewer-scope";

type GhHandler = (args: string[]) => string;
const gh = vi.hoisted(() => ({ handler: undefined as GhHandler | undefined }));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string }) => void,
  ) => {
    try {
      callback(null, { stdout: gh.handler?.(args) ?? "" });
    } catch (error) {
      callback(error as Error);
    }
  },
}));

const relative = join("plugin-data", "pr-radar", "inbox-state.json");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pr-radar-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  gh.handler = undefined;
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true })));
});

describe("inbox state location", () => {
  test("writes under PASEO_HOME with private mode", async () => {
    const paseoHome = await temporaryDirectory();
    vi.stubEnv("PASEO_HOME", paseoHome);
    const { acknowledgedAt } = await acknowledgeViewerUpdates({ windowDays: 7 });
    const path = join(paseoHome, relative);
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.windows["7"].acknowledgedAt).toBe(acknowledgedAt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("falls back to ~/.paseo when PASEO_HOME is unset", async () => {
    const home = await temporaryDirectory();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("PASEO_HOME", "");
    delete process.env.PASEO_HOME;
    await acknowledgeViewerUpdates({ windowDays: 7 });
    await expect(readFile(join(home, ".paseo", relative), "utf8")).resolves.toContain(
      '"version":2',
    );
  });
});

function pullRequest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    number: 1,
    title: "Fix checkout",
    url: `https://github.com/acme/app/pull/${id}`,
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    author: { login: "dependabot[bot]", type: "Bot" },
    repository: { nameWithOwner: "acme/app" },
    commentsCount: 2,
    labels: [{ name: "security" }],
    ...overrides,
  };
}

function ghFor(options: {
  checks: string;
  enrichmentFails?: boolean;
  authored?: unknown[];
}): GhHandler {
  return (args) => {
    if (args[0] === "api" && args[1] === "user") return "octocat\n";
    if (args[0] === "search") {
      const filter = args.find((arg) => arg.startsWith("--author") || arg.startsWith("--review"));
      const scopeOnly = args.includes("--json=url");
      const rows = filter?.startsWith("--author")
        ? (options.authored ?? [pullRequest("PR_1")])
        : [];
      return JSON.stringify(
        scopeOnly ? rows.map((row) => ({ url: (row as { url: string }).url })) : rows,
      );
    }
    if (options.enrichmentFails) throw new Error("graphql down");
    return JSON.stringify({
      data: {
        nodes: [
          null,
          {
            id: "PR_1",
            baseRefName: "main",
            headRefName: "fix",
            reviewDecision: "APPROVED",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            statusCheckRollup: { state: options.checks },
          },
        ],
      },
    });
  };
}

describe("viewer scope inbox", () => {
  test("reports changes since the last refresh until acknowledged", async () => {
    const paseoHome = await temporaryDirectory();
    vi.stubEnv("PASEO_HOME", paseoHome);
    const url = "https://github.com/acme/app/pull/PR_1";

    gh.handler = ghFor({ checks: "PENDING" });
    const first = await resolveViewerScope({ urls: [url], windowDays: 30 });
    expect(first.error).toBeNull();
    expect(first.viewer).toBe("octocat");
    expect(first.updates).toBe(0);
    expect(first.authoredUrls).toEqual([url]);
    expect(first.inboxItems[0]).toMatchObject({
      authorKind: "bot",
      isSecurity: true,
      checksStatus: "pending",
      reviewDecision: "approved",
      role: "author",
    });

    gh.handler = ghFor({ checks: "SUCCESS" });
    const second = await resolveViewerScope({ urls: [url], windowDays: 30 });
    expect(second.updates).toBe(1);
    expect(second.inboxItems[0].changes).toContain("Checks: pending → success");

    await acknowledgeViewerUpdates({ windowDays: 30 });
    const third = await resolveViewerScope({ urls: [url], windowDays: 30 });
    expect(third.updates).toBe(0);
    expect(third.acknowledgedAt).not.toBeNull();
  });

  test("uses conservative states when GitHub detail requests fail", async () => {
    vi.stubEnv("PASEO_HOME", await temporaryDirectory());
    gh.handler = ghFor({ checks: "SUCCESS", enrichmentFails: true });
    const result = await resolveViewerScope({ urls: [], windowDays: 7 });
    expect(result.coverageNote).toContain("1 GitHub detail request failed");
    expect(result.inboxItems[0]).toMatchObject({ checksStatus: "none", mergeable: "UNKNOWN" });
  });

  test("returns an error result when the GitHub CLI is unavailable", async () => {
    vi.stubEnv("PASEO_HOME", await temporaryDirectory());
    vi.spyOn(console, "error").mockImplementation(() => {});
    gh.handler = () => {
      throw new Error("gh: not logged in");
    };
    const result = await resolveViewerScope({ urls: [], windowDays: 7 });
    expect(result.error).toBe("gh: not logged in");
    expect(result.inboxItems).toEqual([]);
  });
});
