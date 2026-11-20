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
}

interface QueuedPatch<Values> {
  patch: SettingsPatch<Values>;
  settle(saved: boolean): void;
}

/**
 * Saves settings one write at a time. Patches queued while a write is in flight are applied in
 * order to the newest document when their write starts, so two quick edits both survive and a
 * function patch never sees a stale list. Each caller learns whether the write holding its own
 * patch succeeded.
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

  async function writeBatch(batch: QueuedPatch<Values>[]): Promise<boolean> {
    deps.report(null);
    const { values, revision } = deps.latest();
    let next = values;
    for (const { patch } of batch) {
      next = { ...next, ...(typeof patch === "function" ? patch(next) : patch) };
    }
    const parsed = deps.parse(next);
    if (!parsed.success) {
      deps.report(parsed.message);
      return false;
    }
    const written = await deps.write(parsed.data, revision);
    if (written === false) {
      deps.report("Settings changed concurrently; please retry.");
      return false;
    }
    deps.remember(parsed.data);
    return true;
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

function sameRule(a: RuleIdentity, b: RuleIdentity): boolean {
  return a.repository === b.repository && a.until === b.until && (a.note ?? "") === (b.note ?? "");
}

// Appends a rule to the newest list; an identical rule already there is kept once.
export function addFallbackRule<Rule extends RuleIdentity>(
  rules: readonly Rule[],
  rule: Rule,
): Rule[] {
  return rules.some((existing) => sameRule(existing, rule)) ? [...rules] : [...rules, rule];
}

// Removes a rule from the newest list by what it says, not by its position: the position the
// user pressed may belong to an older list.
export function removeFallbackRule<Rule extends RuleIdentity>(
  rules: readonly Rule[],
  rule: RuleIdentity,
): Rule[] {
  const at = rules.findIndex((existing) => sameRule(existing, rule));
  return at < 0 ? [...rules] : rules.filter((_, index) => index !== at);
}
