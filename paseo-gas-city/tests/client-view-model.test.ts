import { describe, expect, test } from "bun:test";
import {
  buildDashboardSections,
  cityQueryRoot,
  convoyProgress,
  parseSlingArguments,
  presentSection,
  refreshPresentation,
  selectAvailableCity,
  sessionAccessibilityLabel,
  sessionActionsFor,
} from "../client/view-model";
import {
  attentionFixture,
  convoysFixture,
  eventsFixture,
  sessionsFixture,
  workFixture,
} from "./fixtures";

describe("Gas City dashboard view model", () => {
  test("prioritizes operational rows and names their actual scopes", () => {
    const sections = buildDashboardSections({
      attention: {
        ...attentionFixture,
        items: [
          attentionFixture.items[0],
          { ...attentionFixture.items[0], id: "critical", severity: "critical" },
        ],
      },
      sessions: {
        ...sessionsFixture,
        items: [
          { ...sessionsFixture.items[0], id: "stopped", running: false },
          sessionsFixture.items[0],
        ],
      },
      convoys: {
        ...convoysFixture,
        items: [
          convoysFixture.items[0],
          { ...convoysFixture.items[0], id: "blocked", blocked: true },
        ],
      },
      work: workFixture,
      events: {
        ...eventsFixture,
        items: [eventsFixture.items[0], { ...eventsFixture.items[0], sequence: 43 }],
      },
    });

    expect(sections.map(({ title }) => title)).toEqual([
      "Attention · city + rig",
      "Sessions · mapped rig",
      "Convoys · mapped rig + unattributed",
      "Work · mapped rig",
      "Recent events · city-wide",
    ]);
    expect(sections[0]?.data[0]).toMatchObject({ kind: "attention", item: { id: "critical" } });
    expect(sections[1]?.data[0]).toMatchObject({ kind: "session", item: { running: true } });
    expect(sections[2]?.data[0]).toMatchObject({ kind: "convoy", item: { id: "blocked" } });
    expect(sections[3]?.data[0]).toMatchObject({ kind: "work", item: { id: "al-123" } });
    expect(sections[4]?.data[0]).toMatchObject({ kind: "event", item: { sequence: 43 } });
  });

  test("orders equal-state rows by recency and nullable priority", () => {
    const sections = buildDashboardSections({
      attention: {
        ...attentionFixture,
        items: [
          { ...attentionFixture.items[0], id: "older", observedAt: "invalid" },
          attentionFixture.items[0],
        ],
      },
      sessions: {
        ...sessionsFixture,
        items: [
          {
            ...sessionsFixture.items[0],
            id: "older",
            createdAt: "2026-09-10T06:00:00Z",
            lastActiveAt: null,
          },
          sessionsFixture.items[0],
        ],
      },
      convoys: {
        ...convoysFixture,
        items: [
          { ...convoysFixture.items[0], id: "unprioritized", priority: null },
          convoysFixture.items[0],
        ],
      },
      work: {
        ...workFixture,
        items: [
          { ...workFixture.items[0], id: "unprioritized", priority: null },
          workFixture.items[0],
        ],
      },
      events: eventsFixture,
    });

    expect(sections[0]?.data[0]).toMatchObject({
      kind: "attention",
      item: { id: "session:al-session-1:pending" },
    });
    expect(sections[1]?.data[0]).toMatchObject({ kind: "session", item: { id: "al-session-1" } });
    expect(sections[2]?.data[0]).toMatchObject({ kind: "convoy", item: { id: "al-convoy-1" } });
    expect(sections[3]?.data[0]).toMatchObject({ kind: "work", item: { id: "al-123" } });
  });

  test("keeps every empty operational lane explicit", () => {
    const sections = buildDashboardSections({
      attention: { scope: "city", items: [], truncated: false },
      sessions: { scope: "city", items: [], truncated: false },
      convoys: { scope: "city", items: [], truncated: false },
      work: { scope: "city", items: [], truncated: false },
      events: { scope: "city", items: [], truncated: false },
    });

    expect(sections.map((section) => section.data[0])).toEqual([
      { kind: "empty", message: "No resources need attention." },
      { kind: "empty", message: "No sessions in this scope." },
      { kind: "empty", message: "No convoys in this scope." },
      { kind: "empty", message: "No work in this scope." },
      { kind: "empty", message: "No recent events." },
    ]);
  });

  test("surfaces loading, errors, refreshing, and retained stale data", () => {
    const section = buildDashboardSections({
      attention: attentionFixture,
      sessions: undefined,
      convoys: undefined,
      work: undefined,
      events: undefined,
    })[0];
    if (!section) throw new Error("Missing attention section");

    expect(
      presentSection(section, { hasData: false, isPending: true, isFetching: true, error: null })
        .data[0],
    ).toMatchObject({ kind: "status", tone: "loading" });
    expect(
      presentSection(section, {
        hasData: false,
        isPending: false,
        isFetching: false,
        error: new Error("offline"),
      }).data[0],
    ).toMatchObject({ kind: "status", tone: "error" });
    expect(
      presentSection(section, {
        hasData: true,
        isPending: false,
        isFetching: false,
        error: new Error("offline"),
      }).data[0],
    ).toEqual({ kind: "status", tone: "stale", message: "Refresh failed. Showing stale data." });
    expect(
      presentSection(section, { hasData: true, isPending: false, isFetching: true, error: null })
        .data[0],
    ).toMatchObject({ kind: "status", tone: "refreshing" });
  });

  test("presents aggregate refresh state without hiding failures", () => {
    expect(
      refreshPresentation({
        hasData: false,
        isPending: false,
        isFetching: false,
        error: new Error("offline"),
      }),
    ).toEqual({ state: "error", label: "Load failed" });
    expect(
      refreshPresentation({ hasData: true, isPending: false, isFetching: true, error: null }),
    ).toEqual({ state: "refreshing", label: "Refreshing stale data" });
    expect(
      refreshPresentation({
        hasData: true,
        isPending: false,
        isFetching: false,
        error: new Error("offline"),
      }),
    ).toEqual({ state: "stale", label: "Refresh failed · showing stale data" });
    expect(
      refreshPresentation({
        hasData: true,
        isPending: false,
        isFetching: false,
        error: null,
        refreshedAt: "invalid",
      }),
    ).toEqual({ state: "ready", label: "Live data ready" });
  });

  test("parses sling arguments without constraining generic role names", () => {
    expect(parseSlingArguments("gc-42 city/reviewer")).toEqual({
      beadId: "gc-42",
      agent: "city/reviewer",
    });
    expect(parseSlingArguments("gc-42 'review role'")).toEqual({
      beadId: "gc-42",
      agent: "review role",
    });
    expect(parseSlingArguments("gc-42 review\\ role")).toEqual({
      beadId: "gc-42",
      agent: "review role",
    });
    expect(parseSlingArguments("gc-42 one two")).toBeNull();
    expect(parseSlingArguments("gc-42 'unterminated")).toBeNull();
  });

  test("derives capability-aware actions and immediately valid city selection", () => {
    expect(sessionActionsFor(sessionsFixture.items[0])).toEqual([
      "message",
      "submit",
      "stop",
      "suspend",
      "close",
      "kill",
    ]);
    expect(
      sessionActionsFor({ ...sessionsFixture.items[0], running: false, submissionKinds: [] }),
    ).toEqual(["wake", "close"]);
    expect(
      sessionActionsFor({ ...sessionsFixture.items[0], state: "closed", running: false }),
    ).toEqual([]);
    expect(selectAvailableCity("removed", [{ name: "alpha" }, { name: "beta" }])).toBe("alpha");
    expect(selectAvailableCity("beta", [{ name: "alpha" }, { name: "beta" }])).toBe("beta");
    expect(cityQueryRoot("host-1", "http://127.0.0.1:8372", "alpha", null)).toEqual([
      "gas-city",
      "host-1",
      "http://127.0.0.1:8372",
      "alpha",
      "all-rigs",
    ]);
  });

  test("builds concise accessible session and convoy descriptions", () => {
    expect(sessionAccessibilityLabel(sessionsFixture.items[0])).toContain("Review API. running.");
    expect(convoyProgress(convoysFixture.items[0])).toBe("2 of 4 work items closed");
    expect(convoyProgress({ ...convoysFixture.items[0], totalWork: null })).toBe(
      "Progress unavailable",
    );
  });
});
