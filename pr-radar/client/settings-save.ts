import { fallbackRuleTarget } from "../shared/routed-labels";

/**
 * A change to a settings document: a partial value, or a function of the newest document that
 * returns one. A list edit (add or remove a rule) must be a function, because the list it builds
 * on may have changed while an earlier save was still in flight.
 */
export type SettingsPatch<Values> = Partial<Values> | ((latest: Values) => Partial<Values>);

export type SettingsParse<Values> =
  | { success: true; data: Values }
  | { success: false; message: string };

export interface SettingsSaveQueueDeps<Values> {
  /** The newest document and revision known to the client; read when a queued write starts. */
  latest(): { values: Values; revision: string };
  /** Remembers a document that was just saved, before the host sends the new state back. */
  remember(values: Values): void;
  parse(values: Values): SettingsParse<Values>;
  /** Writes the whole document against `revision`; resolves false on a concurrent change. */
  write(values: Values, revision: string): Promise<boolean>;
  /** Called with null when a write starts and with a message when it fails. */
  report(message: string | null): void;
  /** Sleeps; replaceable so a test controls the clock. Defaults to setTimeout. */
  wait?(ms: number): Promise<void>;
  /** The time in milliseconds that bounds the wait; replaceable like `wait`. Defaults to Date.now. */
  now?(): number;
}

const RETRY_POLL_MS = 20;
const RETRY_MAX_WAIT_MS = 1000;

interface QueuedPatch<Values> {
  patch: SettingsPatch<Values>;
  settle(saved: boolean): void;
}

/**
 * Saves settings one write at a time. Patches queued while a write is in flight are applied in
 * order to the newest document when their write starts, so two quick edits both survive and a
 * function patch never sees a stale list. A write the host refuses is retried once when a newer
 * document has arrived, with every patch applied again to that document. A function patch must
 * therefore be pure and idempotent: a retry can run on a document that already holds its effect
 * (the host may have saved the write and lost the reply). A plain patch replaces its own fields,
 * so after a retry it wins over another client's edit of the same field. Each caller learns whether
 * the write holding its own patch succeeded.
 */
export function createSettingsSaveQueue<Values extends object>(
  deps: SettingsSaveQueueDeps<Values>,
): (patch: SettingsPatch<Values>) => Promise<boolean> {
  let queue: QueuedPatch<Values>[] = [];
  let chain: Promise<void> = Promise.resolve();

  async function flush(): Promise<void> {
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    let saved = false;
    try {
      saved = await writeBatch(batch);
    } catch (error) {
      deps.report(error instanceof Error ? error.message : "Could not save settings.");
    }
    for (const entry of batch) entry.settle(saved);
  }

  // After a write the host reports the new revision on a later render, so the next write in the
  // queue may start against the revision the previous write already replaced and be refused as
  // a concurrent change. Wait for a newer revision until a clock deadline (not a count of waits,
  // so a throttled background tab ends after one late timer); the caller then rebuilds the batch
  // on it. Resolves null when none arrives.
  async function newerThan(revision: string): Promise<{ values: Values; revision: string } | null> {
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const now = deps.now ?? Date.now;
    const deadline = now() + RETRY_MAX_WAIT_MS;
    for (;;) {
      const newest = deps.latest();
      if (newest.revision !== revision) return newest;
      if (now() >= deadline) return null;
      await wait(RETRY_POLL_MS);
    }
  }

  async function writeBatch(batch: QueuedPatch<Values>[]): Promise<boolean> {
    deps.report(null);
    let base = deps.latest();
    for (let attempt = 0; attempt < 2; attempt++) {
      let next = base.values;
      for (const { patch } of batch) {
        next = { ...next, ...(typeof patch === "function" ? patch(next) : patch) };
      }
      const parsed = deps.parse(next);
      if (!parsed.success) {
        deps.report(parsed.message);
        return false;
      }
      const written = await deps.write(parsed.data, base.revision);
      if (written !== false) {
        deps.remember(parsed.data);
        return true;
      }
      // Refused. The host says no more than "false" for a stale revision, a document it rejects
      // and a lost connection alike, so retry only when a newer document has actually arrived
      // (the stale-revision case); otherwise a retry would just repeat the refusal.
      if (attempt === 0) {
        const newest = await newerThan(base.revision);
        if (!newest) break;
        base = newest;
      }
    }
    deps.report(
      "Settings were not saved: they changed in the meantime or the host refused the write. Please retry.",
    );
    return false;
  }

  return (patch) =>
    new Promise<boolean>((resolve) => {
      queue.push({ patch, settle: resolve });
      chain = chain.then(flush);
    });
}

interface RuleIdentity {
  repository: string;
  until: string;
  note?: string | undefined;
}

// Two rules with the same repository (any case) and end instant do the same thing, however they
// are written; the first one listed is the one that applies, so a second would only use a slot.
function sameTarget(a: RuleIdentity, b: RuleIdentity): boolean {
  return fallbackRuleTarget(a) === fallbackRuleTarget(b);
}

function sameText(a: RuleIdentity, b: RuleIdentity): boolean {
  return a.repository === b.repository && a.until === b.until && (a.note ?? "") === (b.note ?? "");
}

// The note is part of what the user sees, so removing a rule matches it too.
function sameRule(a: RuleIdentity, b: RuleIdentity): boolean {
  return sameTarget(a, b) && (a.note ?? "") === (b.note ?? "");
}

// Appends a rule to the newest list. A rule that does the same as one already there (its note
// aside) is not added again: the rule already in the list stays as it is.
export function addFallbackRule<Rule extends RuleIdentity>(
  rules: readonly Rule[],
  rule: Rule,
): Rule[] {
  return rules.some((existing) => sameTarget(existing, rule)) ? [...rules] : [...rules, rule];
}

// Removes a rule from the newest list by what it says, not by its position: the position the
// user pressed may belong to an older list. The row pressed (exactly as written) goes first; a
// rule that only reads the same (case, end written another way) is the fallback, so a list that
// already holds equivalent rows loses the one that was pressed.
export function removeFallbackRule<Rule extends RuleIdentity>(
  rules: readonly Rule[],
  rule: RuleIdentity,
): Rule[] {
  const exact = rules.findIndex((existing) => sameText(existing, rule));
  const at = exact >= 0 ? exact : rules.findIndex((existing) => sameRule(existing, rule));
  return at < 0 ? [...rules] : rules.filter((_, index) => index !== at);
}
