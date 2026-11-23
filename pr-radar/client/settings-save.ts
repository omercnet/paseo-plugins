import { fallbackRuleTarget } from "../shared/routed-labels";

/**
 * A change to a settings document: a partial value, or a function of the newest document that
 * returns one. A list edit (add or remove a rule) must be a function, because the list it builds
 * on may have changed while an earlier save was still in flight.
 */
export type SettingsPatch<Values> = Partial<Values> | ((latest: Values) => Partial<Values>);

export interface SettingsSaveOptions<Values> {
  /**
   * Field values the caller's UI input was built from (mount, last resync, or this client's own
   * accepted write). For uncontrolled inputs, pass this so conflict detection checks against what
   * the user actually saw rather than `deps.latest()` at enqueue time.
   */
  base?: Partial<Values>;
}

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
  /** Called with null when a write succeeds and with a message when it fails or conflicts. */
  report(message: string | null): void;
  /** Called with the conflicting field keys whenever a plain patch is refused for a same-field conflict. */
  onConflict?(keys: Array<keyof Values>): void;
  /** Sleeps; replaceable so a test controls the clock. Defaults to setTimeout. */
  wait?(ms: number): Promise<void>;
  /** A monotonic time in milliseconds that bounds the wait; replaceable like `wait`. Defaults to performance.now. */
  now?(): number;
}

const RETRY_POLL_MS = 20;
const RETRY_MAX_WAIT_MS = 1000;

export const SAME_FIELD_CONFLICT_MESSAGE =
  "Settings were not saved: another client changed the same setting. Review the updated value and apply your edit again.";

// A clock that never steps back: a wall clock set backwards (a time sync, a manual change) would
// keep the wait polling past its deadline and hold up every later save. Falls back to the wall
// clock only where `performance` does not exist.
function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// Structural equality for plain JSON-like setting values (strings, primitives, arrays, objects),
// treating missing keys and explicit `undefined` keys alike.
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).filter((key) => aRecord[key] !== undefined);
  const bKeys = Object.keys(bRecord).filter((key) => bRecord[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && sameValue(aRecord[key], bRecord[key]));
}

interface QueuedPatch<Values> {
  patch: SettingsPatch<Values>;
  // Base values of the fields a plain patch expects to replace, captured when the edit was queued.
  baseFields?: Partial<Values>;
  settle(saved: boolean): void;
}

/**
 * Saves settings one write at a time. Patches queued while a write is in flight are applied in
 * order to the newest document when their write starts, so two quick edits both survive and a
 * function patch never sees a stale list. A write the host refuses is retried once when a newer
 * document has arrived, with every patch applied again to that document. A function patch must
 * therefore be pure and idempotent: a retry can run on a document that already holds its effect
 * (the host may have saved the write and lost the reply).
 *
 * Plain-patch conflict guarantee: for every key touched by a plain patch, the queue compares the
 * server's current value against the expected base value (`options.base[key]` when provided by the
 * caller, otherwise `deps.latest().values[key]` when the patch was queued). On attempt 0, any
 * mismatch refuses immediately without writing; on retry (attempt 1), a mismatch refuses unless
 * the server already holds this batch's own parsed value (the lost-reply case). Refused writes do
 * not call `deps.report(null)`, so an existing conflict message stays visible while the conflict
 * stands. For uncontrolled inputs, callers must supply the input's mounted or last-synced value in
 * `options.base` (for example via `initFieldState` / `syncFieldFromServer` / `finishFieldSave`)
 * and advance it only on resync or this client's own accepted write; without an explicit base, the
 * queue only sees `deps.latest()` at enqueue time. Each caller learns whether the write holding
 * its own patch succeeded.
 */
export function createSettingsSaveQueue<Values extends object>(
  deps: SettingsSaveQueueDeps<Values>,
): (patch: SettingsPatch<Values>, options?: SettingsSaveOptions<Values>) => Promise<boolean> {
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
    const now = deps.now ?? monotonicNow;
    const deadline = now() + RETRY_MAX_WAIT_MS;
    for (;;) {
      const newest = deps.latest();
      if (newest.revision !== revision) return newest;
      if (now() >= deadline) return null;
      await wait(RETRY_POLL_MS);
    }
  }

  async function writeBatch(batch: QueuedPatch<Values>[]): Promise<boolean> {
    const plainBase = new Map<keyof Values, unknown>();
    for (const { baseFields } of batch) {
      if (!baseFields) continue;
      for (const key of Object.keys(baseFields) as Array<keyof Values>) {
        if (!plainBase.has(key)) plainBase.set(key, baseFields[key]);
      }
    }
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
      const conflicts: Array<keyof Values> = [];
      for (const [key, expected] of plainBase) {
        const current = base.values[key];
        const isLostReplyMatch = attempt > 0 && sameValue(parsed.data[key], current);
        if (!sameValue(expected, current) && !isLostReplyMatch) {
          conflicts.push(key);
        }
      }
      if (conflicts.length > 0) {
        deps.onConflict?.(conflicts);
        deps.report(SAME_FIELD_CONFLICT_MESSAGE);
        return false;
      }
      const written = await deps.write(parsed.data, base.revision);
      if (written !== false) {
        deps.remember(parsed.data);
        deps.report(null);
        // Carry this client's own accepted plain-field writes forward as the expected base for any
        // follow-up edits already queued while this write was in flight (for example rapid typing).
        for (const [key, expected] of plainBase) {
          for (const pending of queue) {
            if (
              pending.baseFields &&
              Object.hasOwn(pending.baseFields, key) &&
              sameValue(pending.baseFields[key], expected)
            ) {
              pending.baseFields[key] = parsed.data[key];
            }
          }
        }
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

  return (patch, options) =>
    new Promise<boolean>((resolve) => {
      let baseFields: Partial<Values> | undefined;
      if (typeof patch !== "function") {
        const current = deps.latest().values;
        const explicitBase = options?.base;
        const snapshot: Partial<Values> = {};
        for (const key of Object.keys(patch) as Array<keyof Values>) {
          snapshot[key] =
            explicitBase && Object.hasOwn(explicitBase, key) ? explicitBase[key] : current[key];
        }
        baseFields = snapshot;
      }
      queue.push({ patch, baseFields, settle: resolve });
      chain = chain.then(flush);
    });
}

/**
 * Tracks an uncontrolled text input's base value, local draft, server value, remount key and
 * conflict state. `base` advances only on resync (external update with no local edit, or explicit
 * user resync) or after this client's own accepted write, so an uncontrolled input never silently
 * reverts an external update on a later keystroke.
 */
export interface UncontrolledFieldState {
  base: string;
  draft: string;
  server: string;
  mountKey: number;
  conflicted: boolean;
}

export function initFieldState(server: string): UncontrolledFieldState {
  return { base: server, draft: server, server, mountKey: 0, conflicted: false };
}

// Called when the host delivers a new server value for the field. If this client holds no unsaved
// edit, no in-flight save and no standing conflict, resync and bump `mountKey` so the uncontrolled
// input displays the new value. Otherwise preserve the local edit, base and conflict state while
// recording the latest server value so the UI can show it.
export function syncFieldFromServer(
  state: UncontrolledFieldState,
  server: string,
  inFlight: boolean,
): UncontrolledFieldState {
  if (server === state.server) return state;
  const hasUnsaved = state.conflicted || inFlight || state.draft !== state.base;
  if (!hasUnsaved) {
    return {
      base: server,
      draft: server,
      server,
      mountKey: state.mountKey + 1,
      conflicted: false,
    };
  }
  return { ...state, server };
}

export function editFieldDraft(
  state: UncontrolledFieldState,
  next: string,
): UncontrolledFieldState {
  return { ...state, draft: next };
}

export function finishFieldSave(
  state: UncontrolledFieldState,
  written: string,
  saved: boolean,
  conflicted: boolean,
): UncontrolledFieldState {
  if (saved) {
    return { ...state, base: written, conflicted: false };
  }
  if (conflicted) {
    return { ...state, conflicted: true };
  }
  return state;
}

export function resyncFieldToServer(state: UncontrolledFieldState): UncontrolledFieldState {
  return {
    base: state.server,
    draft: state.server,
    server: state.server,
    mountKey: state.mountKey + 1,
    conflicted: false,
  };
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

// An add-rule patch that also tells the caller whether the add changed anything. The question is
// answered by the list the patch last ran on inside the save queue, which holds every edit queued
// before it, so a rule whose removal is still pending is not "already there" and a rule whose
// add is still pending is. (A check against the rendered settings would see neither.)
//
// `wasDuplicate` is true only when the list holds an equivalent rule that is not this one as
// written (it differs in its note, which the add would drop). A rule that is already listed
// exactly as entered counts as saved: that is what a double press of Add, or a retry after a lost
// reply (the host saved this very add), finds.
export function fallbackRuleAdder<Rule extends RuleIdentity>(rule: Rule) {
  let duplicate = false;
  return {
    patch(latest: { routingLabelFallbacks: readonly Rule[] }) {
      const listed = latest.routingLabelFallbacks.find((existing) => sameTarget(existing, rule));
      duplicate = listed !== undefined && !sameText(listed, rule);
      return { routingLabelFallbacks: addFallbackRule(latest.routingLabelFallbacks, rule) };
    },
    wasDuplicate: () => duplicate,
  };
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
