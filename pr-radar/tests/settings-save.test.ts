import { describe, expect, test, vi } from "vitest";
import {
  addFallbackRule,
  createSettingsSaveQueue,
  editFieldDraft,
  fallbackRuleAdder,
  finishFieldSave,
  initFieldState,
  removeFallbackRule,
  resyncFieldToServer,
  SAME_FIELD_CONFLICT_MESSAGE,
  type SettingsParse,
  syncFieldFromServer,
} from "../client/settings-save";
import { DEFAULT_PR_RADAR_SETTINGS, type LabelFallbackRule } from "../shared/settings";

type Doc = { routingLabelFallbacks: LabelFallbackRule[]; routingLabelPrefixes: string };

const ruleA: LabelFallbackRule = { repository: "acme/a", until: "2026-11-25T18:00:00Z" };
const ruleB: LabelFallbackRule = { repository: "acme/b", until: "2026-11-26T18:00:00Z" };
const ruleC: LabelFallbackRule = { repository: "acme/c", until: "2026-11-27T18:00:00Z", note: "c" };

// A test waits on a promise instead of a clock. This bound only turns a hang (a gate that never
// opens) into a failure that names what was awaited; it never decides how events interleave.
const GATE_LIMIT_MS = 2000;
// How far the fake clock moves for one wait of the queue (its own step is 20 ms; the bound 1000).
const LATE_WAIT_MS = 600;

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
    // The queue's bound on its wait reads this clock, which moves only when the queue waits and by
    // more than the step it asked for (a slow or throttled timer), so a loop that counts its waits
    // instead of reading the clock runs 50 times and is told apart from one that reads it.
    now: () => clock,
    wait: () => {
      clock += LATE_WAIT_MS;
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
    // One refusal, no repeat of it, and a wait that ends when the clock passes the 1000 ms bound:
    // two waits of 600 ms, not the 50 waits of 20 ms a count of timers would make.
    expect(host.attempts.filter((attempt) => !attempt.accepted)).toHaveLength(1);
    expect(host.waits() - waitsBefore).toBe(2);
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

  test("re-adding a rule whose removal is still pending adds it back, and says it changed something", async () => {
    const host = fakeHost({ ...empty, routingLabelFallbacks: [ruleA] });
    const removed = host.save(remove(ruleA));
    const write = await host.nextWrite();
    // The screen still shows rule A (the removal has not rendered), yet the add must go through.
    const adder = fallbackRuleAdder(ruleA);
    const added = host.save(adder.patch);
    write.reply();
    expect(await host.finishAll(removed, added)).toEqual([true, true]);
    expect(adder.wasDuplicate()).toBe(false);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA]);
  });

  test("adding a rule whose add is still pending is a duplicate and changes nothing", async () => {
    const host = fakeHost(empty);
    const first = fallbackRuleAdder(ruleA);
    const firstSave = host.save(first.patch);
    const write = await host.nextWrite();
    const second = fallbackRuleAdder<LabelFallbackRule>({ ...ruleA, note: "later note" });
    const secondSave = host.save(second.patch);
    write.reply();
    expect(await host.finishAll(firstSave, secondSave)).toEqual([true, true]);
    expect(first.wasDuplicate()).toBe(false);
    expect(second.wasDuplicate()).toBe(true);
    // The rule saved first stays as it was, note and all.
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA]);
  });

  test("an add is judged again on each run, so a retry on a newer document decides afresh", async () => {
    const host = fakeHost(empty);
    const adder = fallbackRuleAdder(ruleA);
    const added = host.save(adder.patch);
    const write = await host.nextWrite();
    // Another client saves the same rule, with a note of its own, first; the refused write is
    // retried on that document, so the add is now a duplicate and keeps the listed note.
    const theirs = { ...ruleA, note: "theirs" };
    host.otherClientSaves({ ...empty, routingLabelFallbacks: [theirs] });
    write.reply();
    expect(await host.finishAll(added)).toEqual([true]);
    expect(adder.wasDuplicate()).toBe(true);
    expect(host.stored().routingLabelFallbacks).toEqual([theirs]);
  });

  test("a rule already listed exactly as entered counts as saved: a double press is not an error", async () => {
    const host = fakeHost(empty);
    const first = fallbackRuleAdder(ruleA);
    const second = fallbackRuleAdder({ ...ruleA });
    const firstSave = host.save(first.patch);
    const write = await host.nextWrite();
    const secondSave = host.save(second.patch);
    write.reply();
    expect(await host.finishAll(firstSave, secondSave)).toEqual([true, true]);
    expect([first.wasDuplicate(), second.wasDuplicate()]).toEqual([false, false]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA]);
  });

  test("a retry after a lost reply finds this very add already saved and does not call it a duplicate", async () => {
    const host = fakeHost(empty);
    host.loseNextReply();
    const adder = fallbackRuleAdder(ruleA);
    expect(await host.finishAll(host.save(adder.patch))).toEqual([true]);
    expect(adder.wasDuplicate()).toBe(false);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleA]);
  });

  test("the wait for a newer revision is bounded by a clock that cannot step back", async () => {
    // The wall clock is set back on every read (a time sync gone wrong) while the monotonic clock
    // moves forward 600 ms per read: a wait bounded by Date.now would poll until the guard stops it.
    let wall = 1_000_000_000_000;
    let monotonic = 0;
    const wallSpy = vi.spyOn(Date, "now").mockImplementation(() => (wall -= 60_000));
    const monotonicSpy = vi.spyOn(performance, "now").mockImplementation(() => (monotonic += 600));
    let waits = 0;
    try {
      const save = createSettingsSaveQueue<Doc>({
        latest: () => ({ values: empty, revision: "1" }),
        remember: () => {},
        parse: (values) => ({ success: true, data: values }),
        write: async () => false,
        report: () => {},
        wait: async () => {
          waits += 1;
          if (waits > 200) throw new Error("the wait was never bounded");
        },
      });
      expect(await save({ routingLabelPrefixes: "x.y" })).toBe(false);
      expect(waits).toBeLessThanOrEqual(3);
    } finally {
      wallSpy.mockRestore();
      monotonicSpy.mockRestore();
    }
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

  test("two clients: a stale plain-field retry is refused when another client changed that field", async () => {
    let stored = {
      values: { ...empty, routingLabelPrefixes: "ade." },
      revision: 1,
    };
    const makeClient = () => {
      let rendered = { values: stored.values, revision: String(stored.revision) };
      const reports: Array<string | null> = [];
      const attempts: Array<{ values: Doc; revision: string; accepted: boolean }> = [];
      const render = () => {
        rendered = { values: stored.values, revision: String(stored.revision) };
      };
      const save = createSettingsSaveQueue<Doc>({
        latest: () => rendered,
        remember: (values) => {
          rendered = { values, revision: rendered.revision };
        },
        parse: (values) => ({ success: true, data: values }),
        write: async (values, revision) => {
          const accepted = revision === String(stored.revision);
          attempts.push({ values, revision, accepted });
          if (accepted) stored = { values, revision: stored.revision + 1 };
          return accepted;
        },
        report: (message) => reports.push(message),
        wait: async () => {
          render();
        },
        now: () => 0,
      });
      return { save, reports, attempts, render };
    };

    const clientA = makeClient();
    const clientB = makeClient();

    // Client B saves a newer downgrade prefix list first.
    expect(await clientB.save({ routingLabelPrefixes: "ade.kind" })).toBe(true);
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind");

    // Client A still holds revision 1 ("ade.") and tries to replace the same field.
    expect(await clientA.save({ routingLabelPrefixes: "team/" })).toBe(false);
    // Only the initial stale write ran; no retry overwrote client B's list.
    expect(clientA.attempts).toHaveLength(1);
    expect(clientA.attempts[0]?.accepted).toBe(false);
    expect(clientA.reports.at(-1)).toBe(SAME_FIELD_CONFLICT_MESSAGE);
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind");

    // Once client A has seen B's value (rendered during the conflict wait), re-applying succeeds.
    expect(await clientA.save({ routingLabelPrefixes: "ade.kind, team/" })).toBe(true);
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind, team/");
  });

  test("two clients: a stale plain-field retry still succeeds when another client edited a different field", async () => {
    const host = fakeHost({ ...empty, routingLabelPrefixes: "ade." });
    const mine = host.save({ routingLabelPrefixes: "ade.kind" });
    const write = await host.nextWrite();
    // Another client only added a fallback rule; routingLabelPrefixes stayed "ade.".
    host.otherClientSaves({
      ...empty,
      routingLabelPrefixes: "ade.",
      routingLabelFallbacks: [ruleB],
    });
    write.reply();
    expect(await host.finishAll(mine)).toEqual([true]);
    expect(host.stored()).toMatchObject({
      routingLabelPrefixes: "ade.kind",
      routingLabelFallbacks: [ruleB],
    });
  });

  test("rapid edits by the same client to the same plain field both succeed", async () => {
    const host = fakeHost(empty);
    const first = host.save({ routingLabelPrefixes: "a" });
    const write = await host.nextWrite();
    const second = host.save({ routingLabelPrefixes: "ad" });
    write.reply();
    expect(await host.finishAll(first, second)).toEqual([true, true]);
    expect(host.stored().routingLabelPrefixes).toBe("ad");
    expect(host.reports.filter((report) => report !== null)).toEqual([]);
  });

  test("a queued plain edit refuses if another client changed that field while an earlier write was in flight", async () => {
    const host = fakeHost({ ...empty, routingLabelPrefixes: "ade." });
    const addRule = host.save(add(ruleA));
    const write = await host.nextWrite();
    // User edits prefixes while seeing "ade." and while add(ruleA) is still in flight.
    const editPrefixes = host.save({ routingLabelPrefixes: "team/" });
    // Another client saves a newer prefix list before add(ruleA) lands.
    host.otherClientSaves({ ...empty, routingLabelPrefixes: "ade.kind" });
    write.reply();
    expect(await host.finishAll(addRule, editPrefixes)).toEqual([true, false]);
    expect(host.stored()).toMatchObject({
      routingLabelPrefixes: "ade.kind",
      routingLabelFallbacks: [ruleA],
    });
    expect(host.reports.at(-1)).toBe(SAME_FIELD_CONFLICT_MESSAGE);
  });

  test("a lost reply on a plain-field write does not falsely conflict on retry", async () => {
    const host = fakeHost({ ...empty, routingLabelPrefixes: "ade." });
    host.loseNextReply();
    const saved = host.save({ routingLabelPrefixes: "team/" });
    expect(await host.finishAll(saved)).toEqual([true]);
    expect(host.stored().routingLabelPrefixes).toBe("team/");
    expect(host.reports.filter((report) => report !== null)).toEqual([]);
  });

  test("a full reset refuses when another client added a fallback rule in the meantime", async () => {
    const host = fakeHost({ ...empty, routingLabelPrefixes: "ade." });
    const reset = host.save({ ...empty });
    const write = await host.nextWrite();
    host.otherClientSaves({
      ...empty,
      routingLabelPrefixes: "ade.",
      routingLabelFallbacks: [ruleB],
    });
    write.reply();
    expect(await host.finishAll(reset)).toEqual([false]);
    expect(host.stored().routingLabelFallbacks).toEqual([ruleB]);
    expect(host.reports.at(-1)).toBe(SAME_FIELD_CONFLICT_MESSAGE);
  });

  test("uncontrolled input: external change then keystroke then Backspace is refused and does not revert B", async () => {
    let stored = {
      values: { ...empty, routingLabelPrefixes: "ade." },
      revision: 1,
    };
    let renderedA = { values: stored.values, revision: "1" };
    const reportsA: Array<string | null> = [];
    const writesA: Array<{ values: Doc; revision: string }> = [];
    const saveA = createSettingsSaveQueue<Doc>({
      latest: () => renderedA,
      remember: (values) => {
        renderedA = { values, revision: renderedA.revision };
      },
      parse: (values) => ({ success: true, data: values }),
      write: async (values, revision) => {
        writesA.push({ values, revision });
        const accepted = revision === String(stored.revision);
        if (accepted) stored = { values, revision: stored.revision + 1 };
        return accepted;
      },
      report: (message) => reportsA.push(message),
      wait: async () => {
        renderedA = { values: stored.values, revision: String(stored.revision) };
      },
      now: () => 0,
    });

    // Client A mounts its uncontrolled input showing "ade.".
    let fieldA = initFieldState("ade.");

    // Client B narrows prefixes to "ade.kind" and Client A's latest() updates to rev 2 while its
    // uncontrolled input still shows "ade." (before any resync).
    stored = { values: { ...empty, routingLabelPrefixes: "ade.kind" }, revision: 2 };
    renderedA = { values: stored.values, revision: "2" };

    // Client A types `x` ("ade.x"): passes the input's base ("ade."), not latest() ("ade.kind").
    fieldA = editFieldDraft(fieldA, "ade.x");
    const savedX = await saveA(
      { routingLabelPrefixes: "ade.x" },
      { base: { routingLabelPrefixes: fieldA.base } },
    );
    fieldA = finishFieldSave(fieldA, "ade.x", savedX, !savedX);
    expect(savedX).toBe(false);
    expect(fieldA.conflicted).toBe(true);
    expect(fieldA.base).toBe("ade.");
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind");

    // Client A presses Backspace back to "ade.": must still be refused and never revert B.
    fieldA = editFieldDraft(fieldA, "ade.");
    const savedBackspace = await saveA(
      { routingLabelPrefixes: "ade." },
      { base: { routingLabelPrefixes: fieldA.base } },
    );
    fieldA = finishFieldSave(fieldA, "ade.", savedBackspace, !savedBackspace);
    expect(savedBackspace).toBe(false);
    expect(fieldA.conflicted).toBe(true);
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind");
    expect(writesA).toHaveLength(0);
    // The conflict message stayed visible across both attempts (report(null) was never called).
    expect(reportsA).toEqual([SAME_FIELD_CONFLICT_MESSAGE, SAME_FIELD_CONFLICT_MESSAGE]);
  });

  test("uncontrolled input: a refusal is not defeated by subsequent keystrokes until resynced or re-applied", async () => {
    let stored = {
      values: { ...empty, routingLabelPrefixes: "ade." },
      revision: 1,
    };
    let renderedA = { values: stored.values, revision: "1" };
    const reportsA: Array<string | null> = [];
    const writesA: Array<{ values: Doc; revision: string; accepted: boolean }> = [];
    const saveA = createSettingsSaveQueue<Doc>({
      latest: () => renderedA,
      remember: (values) => {
        renderedA = { values, revision: renderedA.revision };
      },
      parse: (values) => ({ success: true, data: values }),
      write: async (values, revision) => {
        const accepted = revision === String(stored.revision);
        writesA.push({ values, revision, accepted });
        if (accepted) stored = { values, revision: stored.revision + 1 };
        return accepted;
      },
      report: (message) => reportsA.push(message),
      wait: async () => {
        renderedA = { values: stored.values, revision: String(stored.revision) };
      },
      now: () => 0,
    });

    let fieldA = initFieldState("ade.");

    // B saves "ade.kind" while A is still at rev 1.
    stored = { values: { ...empty, routingLabelPrefixes: "ade.kind" }, revision: 2 };

    // First keystroke on stale rev 1: server rejects attempt 0, retry conflicts on rev 2.
    fieldA = editFieldDraft(fieldA, "team/");
    const first = await saveA(
      { routingLabelPrefixes: "team/" },
      { base: { routingLabelPrefixes: fieldA.base } },
    );
    fieldA = finishFieldSave(
      syncFieldFromServer(fieldA, renderedA.values.routingLabelPrefixes, false),
      "team/",
      first,
      !first,
    );
    expect(first).toBe(false);
    expect(fieldA.conflicted).toBe(true);
    expect(fieldA.server).toBe("ade.kind");
    expect(fieldA.draft).toBe("team/");
    expect(fieldA.mountKey).toBe(0);
    expect(writesA).toHaveLength(1);
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind");

    // Next keystrokes must keep failing without writing or clearing the conflict message.
    for (const nextText of ["team/a", "team/ab", "ade.kind"]) {
      fieldA = editFieldDraft(fieldA, nextText);
      const ok = await saveA(
        { routingLabelPrefixes: nextText },
        { base: { routingLabelPrefixes: fieldA.base } },
      );
      fieldA = finishFieldSave(fieldA, nextText, ok, !ok);
      expect(ok).toBe(false);
      expect(fieldA.conflicted).toBe(true);
    }
    expect(writesA).toHaveLength(1);
    expect(reportsA.every((msg) => msg === SAME_FIELD_CONFLICT_MESSAGE)).toBe(true);
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind");

    // Explicitly re-applying against the shown server value succeeds and clears the conflict.
    fieldA = editFieldDraft(fieldA, "ade.kind, team/");
    const reapplied = await saveA(
      { routingLabelPrefixes: fieldA.draft },
      { base: { routingLabelPrefixes: fieldA.server } },
    );
    fieldA = finishFieldSave(fieldA, fieldA.draft, reapplied, !reapplied);
    expect(reapplied).toBe(true);
    expect(fieldA.conflicted).toBe(false);
    expect(fieldA.base).toBe("ade.kind, team/");
    expect(stored.values.routingLabelPrefixes).toBe("ade.kind, team/");
    expect(reportsA.at(-1)).toBeNull();
  });

  test("uncontrolled input resyncs on external change with no local edit, and preserves local edits otherwise", () => {
    const initial = initFieldState("ade.");

    // External update with no local edit and nothing in flight: resync and bump mountKey.
    const synced = syncFieldFromServer(initial, "ade.kind", false);
    expect(synced).toEqual({
      base: "ade.kind",
      draft: "ade.kind",
      server: "ade.kind",
      mountKey: 1,
      conflicted: false,
    });

    // External update while user has an unsaved local edit: keep base, draft and mountKey, record server.
    const edited = editFieldDraft(synced, "ade.kind, team/");
    const kept = syncFieldFromServer(edited, "org.", false);
    expect(kept).toEqual({
      base: "ade.kind",
      draft: "ade.kind, team/",
      server: "org.",
      mountKey: 1,
      conflicted: false,
    });

    // Explicit resync replaces the draft with the server value, bumps mountKey and clears conflict.
    const conflicted = finishFieldSave(kept, "ade.kind, team/", false, true);
    expect(conflicted.conflicted).toBe(true);
    expect(resyncFieldToServer(conflicted)).toEqual({
      base: "org.",
      draft: "org.",
      server: "org.",
      mountKey: 2,
      conflicted: false,
    });
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

  test("a date that does not exist is never the same rule as the day it rolls over to", () => {
    // V8 reads 2026-11-31 as 2026-12-01; the first never applies and the second does.
    const never = { ...ruleA, until: "2026-11-31T12:00Z" };
    const real = { ...ruleA, until: "2026-12-01T12:00Z" };
    expect(addFallbackRule([never], real)).toEqual([never, real]);
    expect(addFallbackRule([real], never)).toEqual([real, never]);
    // The same impossible date written twice is still one rule.
    expect(addFallbackRule([never], { ...never })).toEqual([never]);
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
