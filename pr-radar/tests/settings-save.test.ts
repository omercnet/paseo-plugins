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

// A host that behaves like Paseo's settings store: the revision changes with every accepted
// write and a write against an older revision is refused. The screen sees the new document and
// revision on a later task than the write's reply (a render that lags), and a saved document is
// remembered with the old revision until then. Writes finish only when the test says so.
function fakeHost(initial: Doc) {
  let stored = { values: initial, revision: 1 };
  let rendered = { values: initial, revision: "1" };
  const attempts: Array<{ values: Doc; revision: string; accepted: boolean }> = [];
  const pending: Array<() => void> = [];
  const reports: Array<string | null> = [];
  let refuseAll = false;
  const renderStored = () => {
    rendered = { values: stored.values, revision: String(stored.revision) };
  };
  const save = createSettingsSaveQueue<Doc>({
    latest: () => rendered,
    remember: (values) => {
      rendered = { values, revision: rendered.revision };
    },
    parse: (values): SettingsParse<Doc> =>
      values.routingLabelPrefixes.length > 1024
        ? { success: false, message: "too long" }
        : { success: true, data: values },
    write: (values, revision) =>
      new Promise<boolean>((resolve) => {
        pending.push(() => {
          const accepted = !refuseAll && revision === String(stored.revision);
          attempts.push({ values, revision, accepted });
          if (accepted) {
            stored = { values, revision: stored.revision + 1 };
            setTimeout(renderStored, 0);
          }
          resolve(accepted);
        });
      }),
    report: (message) => reports.push(message),
    wait: () => new Promise((done) => setTimeout(done, 1)),
  });
  return {
    save,
    attempts,
    reports,
    stored: () => stored.values,
    refuseAllWrites: () => {
      refuseAll = true;
    },
    // Another client saves; this screen sees it a little later.
    otherClientSaves(values: Doc) {
      stored = { values, revision: stored.revision + 1 };
      setTimeout(renderStored, 5);
    },
    // Lets the queue start its write for what has been queued so far.
    tick,
    // Finishes in-flight writes, one task apart, until every given save has settled.
    async finishAll(...saves: Array<Promise<boolean>>) {
      let settled = false;
      void Promise.all(saves).then(() => {
        settled = true;
      });
      for (let turn = 0; !settled && turn < 500; turn++) {
        await tick();
        pending.shift()?.();
      }
      return Promise.all(saves);
    },
  };
}

const empty: Doc = { ...DEFAULT_PR_RADAR_SETTINGS, routingLabelFallbacks: [] };

const add = (rule: LabelFallbackRule) => (latest: Doc) => ({
  routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, rule),
});
const remove = (rule: LabelFallbackRule) => (latest: Doc) => ({
  routingLabelFallbacks: removeFallbackRule(latest.routingLabelFallbacks, rule),
});

describe("settings save queue", () => {
  test("two rapid rule additions during an in-flight save both survive", async () => {
    const host = fakeHost(empty);
    const first = host.save(add(ruleA));
    await host.tick();
    // The second add happens while the first write is still in flight and nothing has re-rendered.
    const second = host.save(add(ruleB));
    expect(await host.finishAll(first, second)).toEqual([true, true]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA, ruleB]);
  });

  test("a second write that starts on the revision the first just replaced is retried, not refused", async () => {
    const host = fakeHost(empty);
    const first = host.save(add(ruleA));
    await host.tick();
    const second = host.save(add(ruleB));
    expect(await host.finishAll(first, second)).toEqual([true, true]);
    // The host refused the stale-revision write once; the retry used the newer revision.
    expect(host.attempts.map((attempt) => attempt.accepted)).toEqual([true, false, true]);
    expect(host.reports).not.toContain("Settings changed concurrently; please retry.");
  });

  test("an add and a remove made during an in-flight save both apply, in order", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA] });
    const added = host.save(add(ruleB));
    await host.tick();
    const removed = host.save(remove(ruleA));
    expect(await host.finishAll(added, removed)).toEqual([true, true]);
    // The removed rule does not come back, and the added rule is not lost.
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
  });

  test("a rule is removed by what it says, not by the position pressed on an older list", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA, ruleB, ruleC] });
    // Remove A, then (before any render) remove C, which was at position 2 on the old list.
    const removeFirst = host.save(remove(ruleA));
    await host.tick();
    const removeLast = host.save(remove(ruleC));
    await host.finishAll(removeFirst, removeLast);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
  });

  test("a field edit queued behind a list edit keeps the list edit", async () => {
    const host = fakeHost(empty);
    const added = host.save(add(ruleA));
    await host.tick();
    const prefix = host.save({ routingLabelPrefixes: "ade.kind" });
    await host.finishAll(added, prefix);
    expect(host.stored()).toMatchObject({
      routingLabelFallbacks: [ruleA],
      routingLabelPrefixes: "ade.kind",
    });
  });

  test("a change another client saved in the meantime is kept when a refused write is retried", async () => {
    const host = fakeHost(empty);
    const mine = host.save(add(ruleA));
    await host.tick();
    // The other client saves rule B before this screen's write reaches the host.
    host.otherClientSaves({ ...empty, routingLabelFallbacks: [ruleB] });
    expect(await host.finishAll(mine)).toEqual([true]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB, ruleA]);
  });

  test("patches queued together are written once, in order", async () => {
    const host = fakeHost(empty);
    const results = [
      host.save({ routingLabelPrefixes: "a.b" }),
      host.save((latest) => ({ routingLabelPrefixes: `${latest.routingLabelPrefixes} c.d` })),
    ];
    // The first call has not started a write yet when the second is queued, so one write holds both.
    expect(await host.finishAll(...results)).toEqual([true, true]);
    expect(host.attempts).toHaveLength(1);
    expect(host.stored().routingLabelPrefixes).toBe("a.b c.d");
  });

  test("a write the host keeps refusing is retried once, then reported", async () => {
    const host = fakeHost(empty);
    const ok = host.save({ routingLabelPrefixes: "ade.kind" });
    expect(await host.finishAll(ok)).toEqual([true]);

    host.refuseAllWrites();
    const refused = host.save({ routingLabelPrefixes: "x.y" });
    expect(await host.finishAll(refused)).toEqual([false]);
    expect(host.attempts.filter((attempt) => !attempt.accepted)).toHaveLength(2);
    expect(host.reports.at(-1)).toBe("Settings changed concurrently; please retry.");
  });

  test("each caller hears whether the write holding its own patch worked", async () => {
    const host = fakeHost(empty);
    host.refuseAllWrites();
    const first = host.save({ routingLabelPrefixes: "a.b" });
    await host.tick();
    const second = host.save({ routingLabelPrefixes: "c.d" });
    expect(await host.finishAll(first, second)).toEqual([false, false]);
  });

  test("an invalid result reports the first problem and writes nothing", async () => {
    const host = fakeHost(empty);
    const saved = await host.save({ routingLabelPrefixes: "x".repeat(1025) });
    expect(saved).toBe(false);
    expect(host.attempts).toHaveLength(0);
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
