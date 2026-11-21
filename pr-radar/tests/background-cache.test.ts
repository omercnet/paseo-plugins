import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const { gh, home } = vi.hoisted(() => ({
  gh: {
    calls: [] as string[][],
    fail: false,
    /** Fails only `gh search issues`, the way one transient search error does. */
    failIssues: false,
    /** When set, only the issue search with this flag (e.g. `--owner=testuser`) fails. */
    failIssueFlag: null as string | null,
    /** What a successful `gh search issues` prints. */
    issues: "[]",
    /** Per-search answers keyed by flag (e.g. `--owner=testuser`); override `issues`. */
    issuesByFlag: {} as Record<string, string>,
    /** What `gh api user` answers. */
    viewer: "testuser",
    /** Resolves pending gh calls when set; lets a test hold a refresh open. */
    gate: null as Promise<void> | null,
  },
  home: { dir: "" },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir };
});

vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    gh.calls.push(args);
    const respond = () => {
      if (gh.fail) return callback(new Error("gh: network down"));
      const isIssueSearch = args[0] === "search" && args[1] === "issues";
      const flagFails = gh.failIssueFlag !== null && args.includes(gh.failIssueFlag);
      if (isIssueSearch && (gh.failIssues || flagFails))
        return callback(new Error("gh: search rate limited"));
      const stdout =
        args[0] === "api" && args[1] === "user"
          ? `${gh.viewer}\n`
          : isIssueSearch
            ? (Object.entries(gh.issuesByFlag).find(([flag]) => args.includes(flag))?.[1] ??
              gh.issues)
            : "[]";
      callback(null, { stdout, stderr: "" });
    };
    if (gh.gate) void gh.gate.then(respond);
    else respond();
  },
}));

home.dir = mkdtempSync(join(tmpdir(), "pr-radar-cache-"));

const {
  acknowledgeViewerUpdates,
  resolveViewerScope,
  settleViewerScopeRefreshes,
  MAX_STALE_MS,
  resetViewerScopeCache,
  startBackgroundRefresh,
  STALE_AFTER_MS,
} = await import("../server/viewer-scope");

const issueRecord = (number: number, title = `Issue ${number}`) => ({
  id: `issue-${number}`,
  number,
  title,
  url: `https://github.com/a/b/issues/${number}`,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  author: { login: "testuser" },
  repository: { nameWithOwner: "a/b" },
  commentsCount: 0,
  labels: [],
});
/**
 * Moves the clock `ms` forward and refreshes the cached window the way a client read does: a read
 * past STALE_AFTER_MS answers from memory and refreshes in the background, one past MAX_STALE_MS
 * waits for the refresh. Either way this returns the answer a read after the refresh sees.
 */
async function refreshAfter(ms: number) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
  await resolveViewerScope({ urls: [], windowDays: 30 });
  await settleViewerScopeRefreshes();
  return resolveViewerScope({ urls: [], windowDays: 30 });
}
const refreshAgain = () => refreshAfter(STALE_AFTER_MS + 1_000);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const loginCalls = () => gh.calls.filter((args) => args[0] === "api" && args[1] === "user").length;

describe("background cache", () => {
  beforeEach(async () => {
    gh.fail = false;
    gh.failIssues = false;
    gh.failIssueFlag = null;
    gh.issues = "[]";
    gh.issuesByFlag = {};
    gh.viewer = "testuser";
    gh.gate = null;
    vi.useRealTimers();
    // Paseo sets PASEO_HOME for agents; keep the state file in the temp home either way.
    vi.stubEnv("PASEO_HOME", join(home.dir, ".paseo"));
    await resetViewerScopeCache();
    gh.calls = [];
  });

  afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

  test("overlapping refreshes of different windows both persist", async () => {
    const stateFile = join(home.dir, ".paseo", "plugin-data", "pr-radar", "inbox-state.json");
    rmSync(stateFile, { force: true });
    const [week, month] = await Promise.all([
      resolveViewerScope({ urls: [], windowDays: 7 }),
      resolveViewerScope({ urls: [], windowDays: 30 }),
    ]);
    expect(week.error).toBeNull();
    expect(month.error).toBeNull();
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(Object.keys(state.windows).sort()).toEqual(["30", "7"]);
  });

  test("an acknowledgement made during a refresh is not overwritten", async () => {
    await resolveViewerScope({ urls: [], windowDays: 30 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1_000);
    let release!: () => void;
    gh.gate = new Promise((resolve) => {
      release = resolve;
    });
    await resolveViewerScope({ urls: [], windowDays: 30 }); // starts a held background refresh
    const { acknowledgedAt } = await acknowledgeViewerUpdates({ windowDays: 30 });
    release();
    await resetViewerScopeCache(); // waits for that refresh to finish writing
    gh.gate = null;
    const after = await resolveViewerScope({ urls: [], windowDays: 30 });
    expect(after.acknowledgedAt).toBe(acknowledgedAt);
  });

  test("waits once, then answers from memory without calling gh", async () => {
    const first = await resolveViewerScope({ urls: [], windowDays: 30 });
    expect(first.viewer).toBe("testuser");
    const sweep = gh.calls.length;
    expect(sweep).toBeGreaterThan(3);

    const second = await resolveViewerScope({
      urls: ["https://github.com/a/b/pull/1"],
      windowDays: 30,
    });
    expect(second.viewer).toBe("testuser");
    expect(gh.calls.length).toBe(sweep);
  });

  test("a stale read returns immediately and refreshes in the background", async () => {
    await resolveViewerScope({ urls: [], windowDays: 30 });
    const before = loginCalls();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1_000);

    let release!: () => void;
    gh.gate = new Promise((resolve) => {
      release = resolve;
    });
    const answer = await resolveViewerScope({ urls: [], windowDays: 30 });
    expect(answer.viewer).toBe("testuser"); // served while the refresh is still held open
    expect(loginCalls()).toBe(before + 1);
    release();
    await flush();
  });

  test("concurrent first requests share one GitHub sweep", async () => {
    const [a, b] = await Promise.all([
      resolveViewerScope({ urls: [], windowDays: 7 }),
      resolveViewerScope({ urls: [], windowDays: 7 }),
    ]);
    expect(a.viewer).toBe("testuser");
    expect(b.viewer).toBe("testuser");
    expect(loginCalls()).toBe(1);
  });

  test("a failed background refresh keeps serving the last good snapshot", async () => {
    await resolveViewerScope({ urls: [], windowDays: 30 });
    const before = loginCalls();
    gh.fail = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1_000);
    const failed = Promise.withResolvers<void>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => failed.resolve());
    try {
      const answer = await resolveViewerScope({ urls: [], windowDays: 30 });
      await vi.runAllTimersAsync();
      expect(loginCalls()).toBeGreaterThan(before);
      await failed.promise;
      expect(answer.error).toBeNull();
      expect(answer.viewer).toBe("testuser");
      const afterFailure = resolveViewerScope({ urls: [], windowDays: 30 });
      await vi.runAllTimersAsync();
      expect(await afterFailure).toEqual(answer);
    } finally {
      await resetViewerScopeCache();
      errors.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a snapshot too old to trust is not served: a refresh that keeps failing is reported", async () => {
    await resolveViewerScope({ urls: [], windowDays: 30 });
    gh.fail = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MAX_STALE_MS + 1_000);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = await resolveViewerScope({ urls: [], windowDays: 30 });
    expect(answer.viewer).toBeNull();
    expect(answer.error).toMatch(/network down/);
    errors.mockRestore();
  });

  test("a window asked about again after a snapshot too old to serve waits for fresh data", async () => {
    await resolveViewerScope({ urls: [], windowDays: 30 });
    const before = loginCalls();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MAX_STALE_MS + 1_000);
    let release!: () => void;
    gh.gate = new Promise((resolve) => {
      release = resolve;
    });
    let answered = false;
    const pending = resolveViewerScope({ urls: [], windowDays: 30 }).then(() => {
      answered = true;
    });
    await flush();
    expect(answered).toBe(false); // old data is not served while the refresh runs
    expect(loginCalls()).toBe(before + 1);
    release();
    await pending;
  });

  test("with nothing cached, a failure is reported", async () => {
    gh.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = await resolveViewerScope({ urls: [], windowDays: 30 });
    expect(answer.viewer).toBeNull();
    expect(answer.error).toMatch(/network down/);
    errors.mockRestore();
  });

  test("the loop warms the default window at startup and stops cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const stop = startBackgroundRefresh(60_000);
    try {
      stop();
      // The first read joins the startup refresh instead of starting another sweep.
      const answer = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(answer.viewer).toBe("testuser");
      expect(loginCalls()).toBe(1);
      const calls = gh.calls.length;
      await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(gh.calls.length).toBe(calls);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gh.calls.length).toBe(calls);
    } finally {
      stop();
      vi.clearAllTimers();
      await resetViewerScopeCache();
      vi.useRealTimers();
    }
  });

  test("windows nobody asks about stop being refreshed, the default one included", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const stop = startBackgroundRefresh(60_000);
    await resolveViewerScope({ urls: [], windowDays: 30 }); // joins the startup refresh
    const calls = gh.calls.length;
    vi.setSystemTime(Date.now() + 31 * 60_000);
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(gh.calls.length).toBe(calls);
    stop();
  });

  describe("issue search failures", () => {
    const issueNumbers = (answer: { issueItems?: Array<{ number: number }> }) =>
      (answer.issueItems ?? []).map(({ number }) => number).sort();
    const WARNING = /issue search request.* failed; issue list may be stale or incomplete\./;

    test("a failed issue search keeps the cached issues and shows the warning", async () => {
      gh.issues = JSON.stringify([issueRecord(1), issueRecord(2)]);
      const first = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(issueNumbers(first)).toEqual([1, 2]);
      expect(first.coverageNote).not.toMatch(WARNING);

      gh.failIssues = true;
      const second = await refreshAgain();
      expect(issueNumbers(second)).toEqual([1, 2]);
      expect(second.coverageNote).toMatch(/^3 GitHub issue search requests failed/);
      expect(second.coverageNote).toMatch(WARNING);

      // The kept issues survive further failures, not just the first one.
      const third = await refreshAgain();
      expect(issueNumbers(third)).toEqual([1, 2]);
      expect(third.coverageNote).toMatch(WARNING);
    });

    test("a failed issue search with nothing cached gives the warning and no issues", async () => {
      gh.failIssues = true;
      const answer = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(answer.error).toBeNull();
      expect(answer.issueItems).toEqual([]);
      expect(answer.coverageNote).toMatch(WARNING);
    });

    test("a successful refresh replaces the issue list", async () => {
      gh.issues = JSON.stringify([issueRecord(1), issueRecord(2)]);
      await resolveViewerScope({ urls: [], windowDays: 30 });
      gh.issues = JSON.stringify([issueRecord(2), issueRecord(3)]);
      const answer = await refreshAgain();
      expect(issueNumbers(answer)).toEqual([2, 3]);
      expect(answer.coverageNote).not.toMatch(WARNING);
    });

    test("recovery after a failure drops the issues that closed meanwhile", async () => {
      gh.issues = JSON.stringify([issueRecord(1), issueRecord(2)]);
      await resolveViewerScope({ urls: [], windowDays: 30 });
      gh.failIssues = true;
      await refreshAgain();
      gh.failIssues = false;
      gh.issues = JSON.stringify([issueRecord(2)]);
      const answer = await refreshAgain();
      expect(issueNumbers(answer)).toEqual([2]);
      expect(answer.coverageNote).not.toMatch(WARNING);
    });

    test("kept issues expire after MAX_STALE_MS of failures; the warning stays", async () => {
      gh.issues = JSON.stringify([issueRecord(1)]);
      await resolveViewerScope({ urls: [], windowDays: 30 });
      gh.failIssues = true;
      // Each round is one stale-read refresh (61 s) after the last; the carry chain must not
      // outlive the last successful search by more than MAX_STALE_MS (360 s).
      for (let round = 1; round <= 5; round += 1) {
        const answer = await refreshAgain();
        expect(issueNumbers(answer)).toEqual([1]);
      }
      const expired = await refreshAgain();
      expect(expired.issueItems).toEqual([]);
      expect(expired.coverageNote).toMatch(WARNING);
    });

    test("issues from a window left idle past MAX_STALE_MS are not revived by a failed search", async () => {
      gh.issues = JSON.stringify([issueRecord(1)]);
      await resolveViewerScope({ urls: [], windowDays: 30 });
      gh.failIssues = true;
      const answer = await refreshAfter(MAX_STALE_MS + 1_000);
      expect(answer.error).toBeNull();
      expect(answer.issueItems).toEqual([]);
      expect(answer.coverageNote).toMatch(WARNING);
    });

    test("issues are not carried to a different viewer", async () => {
      gh.issues = JSON.stringify([issueRecord(1)]);
      await resolveViewerScope({ urls: [], windowDays: 30 });
      gh.viewer = "someone-else";
      gh.failIssues = true;
      const answer = await refreshAgain();
      expect(answer.viewer).toBe("someone-else");
      expect(answer.issueItems).toEqual([]);
      expect(answer.coverageNote).toMatch(WARNING);
    });

    test("one failed search keeps only the issues its role found", async () => {
      // Issue 1 comes from the author search alone; issue 2 from the author and owner searches.
      gh.issuesByFlag = {
        "--author=testuser": JSON.stringify([issueRecord(1), issueRecord(2)]),
        "--owner=testuser": JSON.stringify([issueRecord(2)]),
      };
      const first = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(first.issueItems?.map(({ role }) => role)).toEqual(["author", "author"]);

      // Owner search fails; the author search succeeds with one issue fewer. The issue that is
      // gone stays gone: the owner search never held it.
      gh.failIssueFlag = "--owner=testuser";
      gh.issuesByFlag = { "--author=testuser": JSON.stringify([issueRecord(2)]) };
      const answer = await refreshAgain();
      expect(issueNumbers(answer)).toEqual([2]);
      expect(answer.coverageNote).toMatch(/^1 GitHub issue search request failed/);
    });

    test("a failed search keeps its role's issues while the other searches refresh theirs", async () => {
      gh.issuesByFlag = {
        "--author=testuser": JSON.stringify([issueRecord(1)]),
        "--owner=testuser": JSON.stringify([issueRecord(3)]),
      };
      const first = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(first.issueItems?.map(({ number, role }) => `${number}:${role}`).sort()).toEqual([
        "1:author",
        "3:owner",
      ]);

      // The author search fails, so its issue 1 stays; the owner search succeeds and no longer
      // lists issue 3, so that one goes.
      gh.failIssueFlag = "--author=testuser";
      gh.issuesByFlag = { "--owner=testuser": "[]" };
      const answer = await refreshAgain();
      expect(issueNumbers(answer)).toEqual([1]);
      expect(answer.coverageNote).toMatch(/^1 GitHub issue search request failed/);
    });

    test("fresh data wins over a kept copy of the same issue", async () => {
      gh.issuesByFlag = { "--owner=testuser": JSON.stringify([issueRecord(3, "old title")]) };
      await resolveViewerScope({ urls: [], windowDays: 30 });

      // The owner search fails, but the assignee search now returns issue 3 with a new title.
      gh.failIssueFlag = "--owner=testuser";
      gh.issuesByFlag = { "--assignee=testuser": JSON.stringify([issueRecord(3, "new title")]) };
      const answer = await refreshAgain();
      expect(answer.issueItems?.map(({ title, role }) => `${title}:${role}`)).toEqual([
        "new title:assignee",
      ]);
    });

    test("a kept higher-ranked role survives a fresh row from a lower-ranked search", async () => {
      // Assigned to the viewer in a repository they own: both searches find it; it shows as assigned.
      gh.issuesByFlag = {
        "--assignee=testuser": JSON.stringify([issueRecord(3, "old title")]),
        "--owner=testuser": JSON.stringify([issueRecord(3, "old title")]),
      };
      const first = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(first.issueItems?.map(({ role }) => role)).toEqual(["assignee"]);

      // The assignee search fails; the owner search returns it with a new title. The fresh title
      // wins, the issue stays "assigned" rather than dropping to "owner".
      gh.failIssueFlag = "--assignee=testuser";
      gh.issuesByFlag = { "--owner=testuser": JSON.stringify([issueRecord(3, "new title")]) };
      const answer = await refreshAgain();
      expect(answer.issueItems?.map(({ title, role }) => `${title}:${role}`)).toEqual([
        "new title:assignee",
      ]);
    });

    test("a kept issue remembers every role that matched, not just the displayed one", async () => {
      // Matched by both the assignee and the owner search: shown as assigned.
      gh.issuesByFlag = {
        "--assignee=testuser": JSON.stringify([issueRecord(3)]),
        "--owner=testuser": JSON.stringify([issueRecord(3)]),
      };
      const first = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(first.issueItems?.map(({ role }) => role)).toEqual(["assignee"]);

      // The owner search fails; the assignee search succeeds without the issue (it was unassigned).
      // The failed owner search may still hold it, so it stays, now shown under the owner role.
      gh.failIssueFlag = "--owner=testuser";
      gh.issuesByFlag = {};
      const second = await refreshAgain();
      expect(second.issueItems?.map(({ number, role }) => `${number}:${role}`)).toEqual([
        "3:owner",
      ]);

      // Once the owner search succeeds without it, the issue is gone.
      gh.failIssueFlag = null;
      const third = await refreshAgain();
      expect(issueNumbers(third)).toEqual([]);
    });

    test("each role's kept issues expire on that role's own clock", async () => {
      gh.issuesByFlag = {
        "--author=testuser": JSON.stringify([issueRecord(1)]),
        "--owner=testuser": JSON.stringify([issueRecord(3)]),
      };
      await resolveViewerScope({ urls: [], windowDays: 30 });
      // Only the owner search fails; the author search keeps succeeding every round.
      gh.failIssueFlag = "--owner=testuser";
      for (let round = 1; round <= 5; round += 1) {
        expect(issueNumbers(await refreshAgain())).toEqual([1, 3]);
      }
      const expired = await refreshAgain();
      expect(issueNumbers(expired)).toEqual([1]);
      expect(expired.coverageNote).toMatch(WARNING);
    });

    test("a kept role stays flagged truncated until its issues expire", async () => {
      const full = Array.from({ length: 100 }, (_, index) => issueRecord(index + 1));
      gh.issuesByFlag = { "--author=testuser": JSON.stringify(full) };
      const first = await resolveViewerScope({ urls: [], windowDays: 30 });
      expect(first.truncated).toBe(true);

      gh.failIssueFlag = "--author=testuser";
      gh.issuesByFlag = {};
      const kept = await refreshAgain();
      expect(kept.issueItems).toHaveLength(100);
      expect(kept.truncated).toBe(true);

      for (let round = 1; round <= 4; round += 1) await refreshAgain();
      const expired = await refreshAgain();
      expect(expired.issueItems).toEqual([]);
      expect(expired.truncated).toBe(false);
    });

    test("a body that is not a list counts as a failed search, not an empty one", async () => {
      gh.issues = JSON.stringify([issueRecord(1)]);
      await resolveViewerScope({ urls: [], windowDays: 30 });
      gh.issues = JSON.stringify({ message: "API rate limit exceeded" });
      const answer = await refreshAgain();
      expect(issueNumbers(answer)).toEqual([1]);
      expect(answer.coverageNote).toMatch(WARNING);
    });
  });
});
