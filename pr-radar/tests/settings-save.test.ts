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

// A test waits on a promise instead of a clock. This bound only turns a hang (a gate that never
// opens) into a failure that names what was awaited; it never decides how events interleave.
const GATE_LIMIT_MS = 2000;

function bounded<T>(gate: Promise<T>, awaited: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${awaited}`)), GATE_LIMIT_MS);
  });
  return Promise.race([gate, limit]).finally(() => clearTimeout(timer));
}

// A queue of events a test takes one at a time; `take` resolves when the next one arrives.
function eventQueue<T>() {
  const items: T[] = [];
  const takers: Array<(item: T) => void> = [];
  return {
    push(item: T) {
      const taker = takers.shift();
      if (taker) taker(item);
      else items.push(item);
    },
    take(): Promise<T> {
      const item = items.shift();
      return item === undefined
        ? new Promise<T>((resolve) => takers.push(resolve))
        : Promise.resolve(item);
    },
  };
}

type HostEvent =
  | { kind: "write"; reply(): void }
  | { kind: "wait"; release(): void }
  | { kind: "settled" };

// A host that behaves like Paseo's settings store: the revision changes with every accepted write
// and a write against an older revision is refused. The screen sees the new document and revision
// only when the test renders, after the write's reply (a render that lags), and a saved document
// is remembered with the old revision until then. A write waits for the test to reply, and the
// queue's wait for a newer revision waits for the test to release it.
function fakeHost(initial: Doc) {
  let stored = { values: initial, revision: 1 };
  let rendered = { values: initial, revision: "1" };
  const attempts: Array<{ values: Doc; revision: string; accepted: boolean }> = [];
  const reports: Array<string | null> = [];
  const events = eventQueue<HostEvent>();
  let refuseAll = false;
  let loseReply = false;
  let clock = 0;
  let waits = 0;

  const render = () => {
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
        events.push({
          kind: "write",
          reply() {
            const accepted = !refuseAll && revision === String(stored.revision);
            attempts.push({ values, revision, accepted });
            if (accepted) stored = { values, revision: stored.revision + 1 };
            // A lost reply: the host saved the document but the client is told false.
            const replyLost = accepted && loseReply;
            if (replyLost) loseReply = false;
            resolve(accepted && !replyLost);
          },
        });
      }),
    report: (message) => reports.push(message),
    // The queue's bound on its wait counts this clock, which moves only when the queue waits.
    now: () => clock,
    wait: (ms) => {
      clock += ms;
      waits += 1;
      return new Promise<void>((release) => events.push({ kind: "wait", release }));
    },
  });

  return {
    save,
    attempts,
    reports,
    waits: () => waits,
    stored: () => stored.values,
    refuseAllWrites() {
      refuseAll = true;
    },
    loseNextReply() {
      loseReply = true;
    },
    // The screen renders what the host has now (a render that was waiting catches up).
    render,
    // Another client saves; this screen sees it when it next renders.
    otherClientSaves(values: Doc) {
      stored = { values, revision: stored.revision + 1 };
    },
    // Resolves when the queue has a write in flight, so a test can queue a second edit during it.
    async nextWrite() {
      const event = await bounded(events.take(), "a write to start");
      if (event.kind !== "write") throw new Error(`expected a write, got ${event.kind}`);
      return event;
    },
    // Answers every write and renders whenever the queue waits for a newer revision, until the
    // given saves have all settled.
    async finishAll(...saves: Array<Promise<boolean>>) {
      const results = Promise.all(saves);
      void results.then(() => events.push({ kind: "settled" }));
      for (;;) {
        const event = await bounded(events.take(), "the queue to write, wait or finish");
        if (event.kind === "settled") return results;
        if (event.kind === "write") event.reply();
        else {
          render();
          event.release();
        }
      }
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
    const firstWrite = await host.nextWrite();
    // The second add happens while the first write is in flight and nothing has re-rendered.
    const second = host.save(add(ruleB));
    firstWrite.reply();
    expect(await host.finishAll(first, second)).toEqual([true, true]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA, ruleB]);
  });

  test("a second write that starts on the revision the first just replaced is retried, not refused", async () => {
    const host = fakeHost(empty);
    const first = host.save(add(ruleA));
    const firstWrite = await host.nextWrite();
    const second = host.save(add(ruleB));
    firstWrite.reply();
    expect(await host.finishAll(first, second)).toEqual([true, true]);
    // The host refused the stale-revision write once; the retry used the newer revision.
    expect(host.attempts.map((attempt) => attempt.accepted)).toEqual([true, false, true]);
    expect(host.reports.filter((report) => report !== null)).toEqual([]);
  });

  test("an add and a remove made during an in-flight save both apply, in order", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA] });
    const added = host.save(add(ruleB));
    const write = await host.nextWrite();
    const removed = host.save(remove(ruleA));
    write.reply();
    expect(await host.finishAll(added, removed)).toEqual([true, true]);
    // The removed rule does not come back, and the added rule is not lost.
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
  });

  test("a rule is removed by what it says, not by the position pressed on an older list", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA, ruleB, ruleC] });
    // Remove A, then (before any render) remove C, which was at position 2 on the old list.
    const removeFirst = host.save(remove(ruleA));
    const write = await host.nextWrite();
    const removeLast = host.save(remove(ruleC));
    write.reply();
    await host.finishAll(removeFirst, removeLast);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
  });

  test("a field edit queued behind a list edit keeps the list edit", async () => {
    const host = fakeHost(empty);
    const added = host.save(add(ruleA));
    const write = await host.nextWrite();
    const prefix = host.save({ routingLabelPrefixes: "ade.kind" });
    write.reply();
    await host.finishAll(added, prefix);
    expect(host.stored()).toMatchObject({
      routingLabelFallbacks: [ruleA],
      routingLabelPrefixes: "ade.kind",
    });
  });

  test("a change another client saved in the meantime is kept when a refused write is retried", async () => {
    const host = fakeHost(empty);
    const mine = host.save(add(ruleA));
    const write = await host.nextWrite();
    // The other client saves rule B before this screen's write reaches the host.
    host.otherClientSaves({ ...empty, routingLabelFallbacks: [ruleB] });
    write.reply();
    expect(await host.finishAll(mine)).toEqual([true]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB, ruleA]);
  });

  test("patches queued together are written once, in order", async () => {
    const host = fakeHost(empty);
    // The first call has not started a write yet when the second is queued, so one write holds both.
    const results = [
      host.save({ routingLabelPrefixes: "a.b" }),
      host.save((latest) => ({ routingLabelPrefixes: `${latest.routingLabelPrefixes} c.d` })),
    ];
    expect(await host.finishAll(...results)).toEqual([true, true]);
    expect(host.attempts).toHaveLength(1);
    expect(host.stored().routingLabelPrefixes).toBe("a.b c.d");
  });

  test("a refused write with no newer revision is not retried: it waits out the bound, then reports", async () => {
    const host = fakeHost(empty);
    const ok = host.save({ routingLabelPrefixes: "ade.kind" });
    expect(await host.finishAll(ok)).toEqual([true]);
    host.render();
    const waitsBefore = host.waits();

    host.refuseAllWrites();
    const refused = host.save({ routingLabelPrefixes: "x.y" });
    expect(await host.finishAll(refused)).toEqual([false]);
    // One refusal, no repeat of it, and a wait of exactly the bound (1000 ms in 20 ms steps).
    expect(host.attempts.filter((attempt) => !attempt.accepted)).toHaveLength(1);
    expect(host.waits() - waitsBefore).toBe(50);
    expect(host.reports.at(-1)).toMatch(/^Settings were not saved: /);
  });

  test("a write the host saved but whose reply was lost is retried without doubling a list edit", async () => {
    const host = fakeHost(empty);
    host.loseNextReply();
    const added = host.save(add(ruleA));
    // The host saves the rule and the reply says false; the host's new document then arrives, and
    // the retry applies the same edit to a document that already holds it.
    expect(await host.finishAll(added)).toEqual([true]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA]);
  });

  test("each caller hears whether the write holding its own patch worked", async () => {
    const host = fakeHost(empty);
    host.refuseAllWrites();
    const first = host.save({ routingLabelPrefixes: "a.b" });
    const write = await host.nextWrite();
    const second = host.save({ routingLabelPrefixes: "c.d" });
    write.reply();
    expect(await host.finishAll(first, second)).toEqual([false, false]);
  });

  test("an invalid result reports the first problem and writes nothing", async () => {
    const host = fakeHost(empty);
    const saved = await bounded(
      host.save({ routingLabelPrefixes: "x".repeat(1025) }),
      "the invalid save to settle",
    );
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

  test("add treats a repository that differs only in case as the same rule", () => {
    expect(addFallbackRule([ruleA], { ...ruleA, repository: "ACME/A" })).toEqual([ruleA]);
    expect(addFallbackRule([{ ...ruleA, repository: "Acme/A" }], ruleA)).toEqual([
      { ...ruleA, repository: "Acme/A" },
    ]);
  });

  test("add treats the same end instant written another way as the same rule", () => {
    // 18:00Z is 19:00 at +01:00, and a fraction of zero changes nothing.
    expect(addFallbackRule([ruleA], { ...ruleA, until: "2026-11-25T19:00:00+01:00" })).toEqual([
      ruleA,
    ]);
    expect(addFallbackRule([ruleA], { ...ruleA, until: "2026-11-25T18:00:00.000Z" })).toEqual([
      ruleA,
    ]);
  });

  test("add keeps rules that differ in repository or in end instant", () => {
    expect(addFallbackRule([ruleA], { ...ruleA, repository: "acme/other" })).toHaveLength(2);
    expect(addFallbackRule([ruleA], { ...ruleA, until: "2026-11-25T18:00:01Z" })).toHaveLength(2);
    expect(addFallbackRule([ruleA], { ...ruleA, repository: "*" })).toHaveLength(2);
  });

  test("add keeps the rule already listed when only the note differs", () => {
    const listed = { ...ruleA, note: "first" };
    expect(addFallbackRule([listed], { ...ruleA, note: "second" })).toEqual([listed]);
  });

  test("a timestamp that does not parse matches only itself", () => {
    const odd = { ...ruleA, until: "not a date" };
    expect(addFallbackRule([odd], { ...odd })).toEqual([odd]);
    expect(addFallbackRule([odd], { ...odd, until: "also not a date" })).toHaveLength(2);
  });

  test("remove drops one matching rule and ignores a rule that is already gone", () => {
    expect(removeFallbackRule([ruleA, ruleB], ruleA)).toEqual([ruleB]);
    expect(removeFallbackRule([ruleB], ruleA)).toEqual([ruleB]);
    expect(removeFallbackRule([ruleA, { ...ruleA }], ruleA)).toEqual([ruleA]);
  });

  test("remove takes the row that was pressed when the list holds equivalent rows", () => {
    // An old list can hold both spellings of the same rule; pressing the second removes the second.
    const first = { ...ruleA, repository: "Acme/A", note: "x" };
    const second = { ...ruleA, until: "2026-11-25T19:00:00+01:00", note: "x" };
    expect(removeFallbackRule([first, second], second)).toEqual([first]);
    expect(removeFallbackRule([first, second], first)).toEqual([second]);
    // A row pressed as written elsewhere in the list still goes before an equivalent earlier one.
    expect(removeFallbackRule([second, first], first)).toEqual([second]);
  });

  test("remove finds a rule written another way, and the one with the same note", () => {
    const listed = [
      { ...ruleA, note: "one" },
      { ...ruleA, repository: "ACME/A", note: "two" },
    ];
    expect(removeFallbackRule(listed, { ...ruleA, note: "two" })).toEqual([listed[0]]);
    expect(
      removeFallbackRule(listed, { ...ruleA, until: "2026-11-25T19:00:00+01:00", note: "one" }),
    ).toEqual([listed[1]]);
  });
});
