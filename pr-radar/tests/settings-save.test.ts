import { describe, expect, test } from "vitest";
import {
  addFallbackRule,
  createSettingsSaveQueue,
  removeFallbackRule,
  type SettingsParse,
} from "../client/settings-save";
import { DEFAULT_PR_RADAR_SETTINGS, type LabelFallbackRule } from "../shared/settings";

type Doc = { routingLabelFallbacks: LabelFallbackRule[]; routingLabelPrefixes: string };

const ruleA: LabelFallbackRule = { repository: "acme/a", until: "2026-11-25T18:00:00Z" };
const ruleB: LabelFallbackRule = { repository: "acme/b", until: "2026-11-26T18:00:00Z" };
const ruleC: LabelFallbackRule = { repository: "acme/c", until: "2026-11-27T18:00:00Z", note: "c" };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A host whose writes finish only when the test says so, and whose latest document is the one
// the screen last rendered: it changes only when a save is remembered, like a render that lags a
// write.
function fakeHost(initial: Doc) {
  let rendered = initial;
  let stored = initial;
  const writes: Doc[] = [];
  const pending: Array<() => void> = [];
  const reports: Array<string | null> = [];
  let accept = true;
  const save = createSettingsSaveQueue<Doc>({
    latest: () => ({ values: rendered, revision: "r1" }),
    remember: (values) => {
      rendered = values;
    },
    parse: (values): SettingsParse<Doc> =>
      values.routingLabelPrefixes.length > 1024
        ? { success: false, message: "too long" }
        : { success: true, data: values },
    write: (values) =>
      new Promise<boolean>((resolve) => {
        writes.push(values);
        pending.push(() => {
          if (accept) stored = values;
          resolve(accept);
        });
      }),
    report: (message) => reports.push(message),
  });
  return {
    save,
    writes,
    reports,
    stored: () => stored,
    rejectWrites: () => {
      accept = false;
    },
    // Lets the oldest in-flight write finish, then lets the queue start the next one.
    async finishOne() {
      await tick();
      pending.shift()?.();
      await tick();
    },
    // Lets the queue start the write for what has been queued so far.
    tick,
  };
}

const empty: Doc = { ...DEFAULT_PR_RADAR_SETTINGS, routingLabelFallbacks: [] };

describe("settings save queue", () => {
  test("two rapid rule additions during an in-flight save both survive", async () => {
    const host = fakeHost(empty);
    const first = host.save((latest) => ({
      routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, ruleA),
    }));
    await host.tick();
    // The second add happens while the first write is still in flight and nothing has re-rendered.
    const second = host.save((latest) => ({
      routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, ruleB),
    }));
    await host.finishOne();
    await host.finishOne();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA, ruleB]);
  });

  test("an add and a remove made during an in-flight save both apply, in order", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA] });
    const added = host.save((latest) => ({
      routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, ruleB),
    }));
    await host.tick();
    const removed = host.save((latest) => ({
      routingLabelFallbacks: removeFallbackRule(latest.routingLabelFallbacks, ruleA),
    }));
    await host.finishOne();
    await host.finishOne();
    expect([await added, await removed]).toEqual([true, true]);
    // The removed rule does not come back, and the added rule is not lost.
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
  });

  test("a rule is removed by what it says, not by the position pressed on an older list", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA, ruleB, ruleC] });
    // Remove A, then (before any render) remove C, which was at position 2 on the old list.
    const removeA = host.save((latest) => ({
      routingLabelFallbacks: removeFallbackRule(latest.routingLabelFallbacks, ruleA),
    }));
    await host.tick();
    const removeC = host.save((latest) => ({
      routingLabelFallbacks: removeFallbackRule(latest.routingLabelFallbacks, ruleC),
    }));
    await host.finishOne();
    await host.finishOne();
    await Promise.all([removeA, removeC]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
  });

  test("a field edit queued behind a list edit keeps the list edit", async () => {
    const host = fakeHost(empty);
    const add = host.save((latest) => ({
      routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, ruleA),
    }));
    await host.tick();
    const prefix = host.save({ routingLabelPrefixes: "ade.kind" });
    await host.finishOne();
    await host.finishOne();
    await Promise.all([add, prefix]);
    expect(host.stored()).toMatchObject({
      routingLabelFallbacks: [ruleA],
      routingLabelPrefixes: "ade.kind",
    });
  });

  test("patches queued together are written once, in order", async () => {
    const host = fakeHost(empty);
    const results = [
      host.save({ routingLabelPrefixes: "a.b" }),
      host.save((latest) => ({ routingLabelPrefixes: `${latest.routingLabelPrefixes} c.d` })),
    ];
    // The first call has not started a write yet when the second is queued, so one write holds both.
    await host.finishOne();
    expect(await Promise.all(results)).toEqual([true, true]);
    expect(host.writes).toHaveLength(1);
    expect(host.stored().routingLabelPrefixes).toBe("a.b c.d");
  });

  test("each caller hears whether the write holding its own patch worked", async () => {
    const host = fakeHost(empty);
    const ok = host.save({ routingLabelPrefixes: "ade.kind" });
    await host.finishOne();
    expect(await ok).toBe(true);

    host.rejectWrites();
    const conflicted = host.save({ routingLabelPrefixes: "x.y" });
    await host.finishOne();
    expect(await conflicted).toBe(false);
    expect(host.reports.at(-1)).toBe("Settings changed concurrently; please retry.");
  });

  test("an invalid result reports the first problem and writes nothing", async () => {
    const host = fakeHost(empty);
    const saved = await host.save({ routingLabelPrefixes: "x".repeat(1025) });
    expect(saved).toBe(false);
    expect(host.writes).toHaveLength(0);
    expect(host.reports.at(-1)).toBe("too long");
  });
});

describe("fallback rule list helpers", () => {
  test("add keeps an identical rule once and leaves the input alone", () => {
    const rules = [ruleA];
    expect(addFallbackRule(rules, { ...ruleA })).toEqual([ruleA]);
    expect(addFallbackRule(rules, ruleB)).toEqual([ruleA, ruleB]);
    expect(rules).toEqual([ruleA]);
  });

  test("remove drops one matching rule and ignores a rule that is already gone", () => {
    expect(removeFallbackRule([ruleA, ruleB], ruleA)).toEqual([ruleB]);
    expect(removeFallbackRule([ruleB], ruleA)).toEqual([ruleB]);
    expect(removeFallbackRule([ruleA, { ...ruleA }], ruleA)).toEqual([ruleA]);
  });
});
