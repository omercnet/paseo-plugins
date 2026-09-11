import { describe, expect, test } from "bun:test";
import {
  buildDashboardSections,
  convoyProgress,
  parseSlingArguments,
  presentSection,
  refreshPresentation,
  sessionAccessibilityLabel,
} from "../client/view-model";
import { attentionFixture, convoysFixture, eventsFixture, sessionsFixture } from "./fixtures";

describe("Gas City dashboard view model", () => {
  test("prioritizes critical attention, running sessions, blocked convoys, and newest events", () => {
    const sections = buildDashboardSections({
      attention: {
        truncated: false,
        items: [
          attentionFixture.items[0],
          { ...attentionFixture.items[0], id: "critical", severity: "critical" },
        ],
      },
      sessions: {
        truncated: false,
        items: [
          { ...sessionsFixture.items[0], id: "stopped", running: false },
          sessionsFixture.items[0],
        ],
      },
      convoys: {
        truncated: false,
        items: [
          convoysFixture.items[0],
          { ...convoysFixture.items[0], id: "blocked", blocked: true },
        ],
      },
      events: {
        truncated: false,
        items: [eventsFixture.items[0], { ...eventsFixture.items[0], sequence: 43 }],
      },
    });

    expect(sections[0]?.data[0]).toMatchObject({ kind: "attention", item: { id: "critical" } });
    expect(sections[1]?.data[0]).toMatchObject({ kind: "session", item: { running: true } });
    expect(sections[2]?.data[0]).toMatchObject({ kind: "convoy", item: { id: "blocked" } });
    expect(sections[3]?.data[0]).toMatchObject({ kind: "event", item: { sequence: 43 } });
  });

  test("keeps every empty operational lane explicit", () => {
    const sections = buildDashboardSections({
      attention: { items: [], truncated: false },
      sessions: { items: [], truncated: false },
      convoys: { items: [], truncated: false },
      events: { items: [], truncated: false },
    });

    expect(sections.map((section) => section.data[0])).toEqual([
      { kind: "empty", message: "No resources need attention." },
      { kind: "empty", message: "No sessions in this scope." },
      { kind: "empty", message: "No convoys in this scope." },
      { kind: "empty", message: "No recent events." },
    ]);
  });

  test("surfaces loading, stale refresh, and hard errors without hiding retained data", () => {
    const section = buildDashboardSections({
      attention: attentionFixture,
      sessions: undefined,
      convoys: undefined,
      events: undefined,
    })[0];
    expect(section).toBeDefined();
    if (!section) throw new Error("Missing attention section");

    expect(
      presentSection(section, { hasData: false, isPending: true, isFetching: true, error: null })
        .data[0],
    ).toMatchObject({ kind: "status", tone: "loading" });
    expect(
      presentSection(section, {
        hasData: true,
        isPending: false,
        isFetching: false,
        error: new Error("offline"),
      }).data[0],
    ).toEqual({ kind: "status", tone: "stale", message: "Refresh failed. Showing stale data." });
    expect(
      refreshPresentation({
        hasData: false,
        isPending: false,
        isFetching: false,
        error: new Error("offline"),
      }),
    ).toEqual({ state: "error", label: "Load failed" });
  });

  test("parses /sling arguments and rejects ambiguous input", () => {
    expect(parseSlingArguments("gc-42 city/reviewer")).toEqual({
      beadId: "gc-42",
      agent: "city/reviewer",
    });
    expect(parseSlingArguments("gc-42 'review role'")).toEqual({
      beadId: "gc-42",
      agent: "review role",
    });
    expect(parseSlingArguments("gc-42 one two")).toBeNull();
    expect(parseSlingArguments("gc-42 'unterminated")).toBeNull();
  });

  test("builds concise accessible session and convoy descriptions", () => {
    expect(sessionAccessibilityLabel(sessionsFixture.items[0])).toContain("Review API. running.");
    expect(convoyProgress(convoysFixture.items[0])).toBe("2 of 4 work items closed");
    expect(convoyProgress({ ...convoysFixture.items[0], totalWork: null })).toBe(
      "Progress unavailable",
    );
  });
});
