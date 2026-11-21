import { afterEach, describe, expect, test, vi } from "vitest";
import {
  activeFallbackRule,
  checkRoutedLabels,
  decideRoutedLabels,
  describeLabel,
  describeRejection,
  displayLabelKey,
  labelPrefixesProblem,
  MAX_LABEL_KEY_LEN,
  MAX_LABEL_VALUE_LEN,
  MAX_SCRIPT_LABELS,
  nextFallbackBoundary,
  parseFallbackRuleInput,
  parseLabelPrefixes,
  watchFallbackBoundary,
} from "../shared/routed-labels";
import type { LabelFallbackRule } from "../shared/settings";

const ADE = ["ade."];
const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
// Invisible and look-alike characters are built from code points, so the source shows what it tests.
const cp = (codePoint: number) => String.fromCodePoint(codePoint);

function rejectedKeys(raw: unknown, prefixes: readonly string[] = ADE): string[] {
  return checkRoutedLabels(raw, prefixes).rejected.map(({ key }) => key);
}

describe("checkRoutedLabels: both label shapes", () => {
  test("a key under an allowed prefix keeps its name", () => {
    expect(checkRoutedLabels({ "ade.kind": " external-review " }, ADE)).toEqual({
      labels: { "ade.kind": "external-review" },
      rejected: [],
    });
  });

  test("any other valid key goes under pr-radar.route., also with an empty allow-list", () => {
    expect(checkRoutedLabels({ kind: "x", "other.key": "y" }, ADE).labels).toEqual({
      "pr-radar.route.kind": "x",
      "pr-radar.route.other.key": "y",
    });
    expect(checkRoutedLabels({ "ade.kind": "x" }, []).labels).toEqual({
      "pr-radar.route.ade.kind": "x",
    });
  });

  test("no labels, or null, is a valid empty set", () => {
    expect(checkRoutedLabels(undefined, ADE)).toEqual({ labels: {}, rejected: [] });
    expect(checkRoutedLabels(null, ADE)).toEqual({ labels: {}, rejected: [] });
    expect(checkRoutedLabels({}, ADE)).toEqual({ labels: {}, rejected: [] });
  });

  test("the namespaced key counts against the key length limit", () => {
    const fits = "k".repeat(MAX_LABEL_KEY_LEN - "pr-radar.route.".length);
    expect(checkRoutedLabels({ [fits]: "v" }, ADE).rejected).toEqual([]);
    const tooLong = `${fits}k`;
    const checked = checkRoutedLabels({ [tooLong]: "v" }, ADE);
    expect(checked.labels).toEqual({});
    expect(checked.rejected).toHaveLength(1);
    expect(checked.rejected[0]?.reason).toContain("longer than 128 characters once namespaced");
    // The same key under an allowed prefix is not namespaced, so it still fits.
    const passthrough = `ade.${"k".repeat(MAX_LABEL_KEY_LEN - 4)}`;
    expect(checkRoutedLabels({ [passthrough]: "v" }, ADE).rejected).toEqual([]);
  });

  test("a namespaced key and a passthrough key cannot collide: the pr-radar.route. key is reserved", () => {
    const checked = checkRoutedLabels({ x: "1", "pr-radar.route.x": "2" }, ["pr-radar.route."]);
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key)).toEqual(["pr-radar.route.x"]);
  });

  test("a collision reason names the other key in full", () => {
    const [first] = checkRoutedLabels({ "ade.kind": "a", " ade.kind": "b" }, ADE).rejected;
    expect(first?.reason).toContain('collides with " ade.kind"');
  });

  test("keys that collide after trimming are both rejected", () => {
    const checked = checkRoutedLabels({ "ade.kind": "a", " ade.kind ": "b" }, ADE);
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key).sort()).toEqual([" ade.kind ", "ade.kind"]);
    expect(checked.rejected[0]?.reason).toContain("collides");
  });
});

describe("checkRoutedLabels: reserved keys", () => {
  test.each([
    "paseo.parent-agent-id",
    "paseo",
    "PASEO.x",
    "pr-radar",
    "PR-Radar",
    "pr-radar.cwd",
    "pr-radar.other",
    "pr-radar.route.x",
  ])("%s is rejected", (key) => {
    expect(rejectedKeys({ [key]: "v" })).toEqual([key]);
  });

  test("an allowed prefix cannot admit a reserved key", () => {
    for (const prefix of ["paseo.", "pr-radar.", "p", "pr", "pr-radar"]) {
      const checked = checkRoutedLabels({ "paseo.parent-agent-id": "x", "pr-radar": "y" }, [
        prefix,
      ]);
      expect(checked.labels).toEqual({});
      expect(checked.rejected).toHaveLength(2);
    }
  });

  test("nothing from the old ADE denylist is special any more", () => {
    expect(checkRoutedLabels({ "ade.lead": "x", slice: "s" }, []).labels).toEqual({
      "pr-radar.route.ade.lead": "x",
      "pr-radar.route.slice": "s",
    });
  });
});

describe("checkRoutedLabels: unsafe text and shape", () => {
  const unsafe: number[] = [];
  for (let code = 0x00; code <= 0x1f; code++) unsafe.push(code);
  for (let code = 0x7f; code <= 0x9f; code++) unsafe.push(code);
  for (const [from, to] of [
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
  ] as const) {
    for (let code = from; code <= to; code++) unsafe.push(code);
  }
  unsafe.push(0xfeff, 0x2028, 0x2029, 0xad, 0x061c, 0xe0041);

  test.each(unsafe.map((code) => [code.toString(16)]))(
    "U+%s is rejected in a key and in a value",
    (hex) => {
      const char = String.fromCodePoint(Number.parseInt(hex, 16));
      expect(rejectedKeys({ [`ade.kind${char}`]: "v" })).toHaveLength(1);
      expect(rejectedKeys({ [`${char}ade.kind`]: "v" })).toHaveLength(1);
      expect(rejectedKeys({ "ade.kind": `ex${char}ternal` })).toEqual(["ade.kind"]);
      expect(rejectedKeys({ "ade.kind": `${char}external` })).toEqual(["ade.kind"]);
    },
  );

  test("a lone surrogate is rejected", () => {
    expect(rejectedKeys({ "ade.kind": "a\ud800b" })).toEqual(["ade.kind"]);
  });

  test("bad keys and values are named with a reason", () => {
    const checked = checkRoutedLabels(
      {
        "": "v",
        "bad key=1": "v",
        "-lead": "v",
        empty: "  ",
        long: "x".repeat(129),
        num: 1,
        nul: null,
      },
      ADE,
    );
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key)).toEqual([
      "",
      "bad key=1",
      "-lead",
      "empty",
      "long",
      "num",
      "nul",
    ]);
    expect(checked.rejected.map(({ reason }) => reason)).toEqual([
      "key is empty",
      expect.stringContaining("may only use letters"),
      expect.stringContaining("may only use letters"),
      "value is empty",
      "value is longer than 128 characters",
      "value must be a string",
      "value must be a string",
    ]);
  });

  test("one bad label rejects the whole set, valid labels included", () => {
    const checked = checkRoutedLabels({ "ade.kind": "external-review", "ade.n": 1 }, ADE);
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key)).toEqual(["ade.n"]);
  });

  test("a labels value that is not an object is rejected", () => {
    for (const raw of ["x", 1, true, ["a"]]) {
      expect(rejectedKeys(raw)).toEqual(["labels"]);
    }
  });

  test("the extra-label limit is exact: 16 pass, 17 are rejected", () => {
    const make = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
    expect(checkRoutedLabels(make(MAX_SCRIPT_LABELS), []).rejected).toEqual([]);
    const over = checkRoutedLabels(make(MAX_SCRIPT_LABELS + 1), []);
    expect(over.labels).toEqual({});
    expect(over.rejected[0]?.reason).toBe("17 labels returned; at most 16 are allowed");
  });

  test("displayLabelKey writes invisible characters out and shortens long keys", () => {
    expect(displayLabelKey("a‮b\u0007")).toBe("a\\u{202E}b\\u{7}");
    expect(displayLabelKey("a\\b")).toBe("a\\\\b");
    expect(displayLabelKey("x".repeat(100))).toBe(`${"x".repeat(64)}...`);
  });

  test("describeLabel quotes a key and a value alike and writes a backslash once as two", () => {
    expect(describeLabel("kind", "review")).toBe('"kind"="review"');
    // A value of C:\x (one backslash) is shown with two, not four.
    expect(describeLabel("path", "C:\\x")).toBe('"path"="C:\\\\x"');
    expect(describeLabel("k", 'say "hi"')).toBe('"k"="say \\"hi\\""');
    expect(describeLabel("k", "a‮b")).toBe('"k"="a\\u{202E}b"');
  });

  test("describeLabel shows an accepted key and value in full, up to their limits", () => {
    const value = "v".repeat(MAX_LABEL_VALUE_LEN);
    const key = "k".repeat(MAX_LABEL_KEY_LEN);
    expect(describeLabel(key, value)).toBe(`"${key}"="${value}"`);
    const slashes = "\\".repeat(MAX_LABEL_VALUE_LEN);
    expect(describeLabel("k", slashes)).toBe(`"k"="${slashes.repeat(2)}"`);
  });
});

describe("prefix separator", () => {
  const kept = (key: string, prefix: string) =>
    Object.keys(checkRoutedLabels({ [key]: "v" }, [prefix]).labels)[0] === key;

  test("a prefix admits itself and keys that continue it with a separator", () => {
    expect(kept("ade.kind", "ade.kind")).toBe(true);
    expect(kept("ade.kind.x", "ade.kind")).toBe(true);
    expect(kept("ade.kind/x", "ade.kind")).toBe(true);
    expect(kept("team/x", "team")).toBe(true);
  });

  test("a prefix does not admit a key that only starts with the same letters", () => {
    expect(checkRoutedLabels({ "ade.kinder": "v" }, ["ade.kind"]).labels).toEqual({
      "pr-radar.route.ade.kinder": "v",
    });
    expect(checkRoutedLabels({ teamx: "v" }, ["team"]).labels).toEqual({
      "pr-radar.route.teamx": "v",
    });
    expect(kept("ade.kind-x", "ade.kind")).toBe(false);
  });

  test("a prefix that ends in a separator admits everything under it", () => {
    expect(kept("ade.anything", "ade.")).toBe(true);
    expect(kept("team/a/b", "team/")).toBe(true);
    expect(kept("ade", "ade.")).toBe(false);
  });
});

describe("parseLabelPrefixes", () => {
  test("accepts a prefix of exactly the maximum key length, and voids one character more", () => {
    const exact = "k".repeat(MAX_LABEL_KEY_LEN);
    expect(parseLabelPrefixes(exact)).toEqual([exact]);
    // A key equal to that prefix keeps its own name and still fits the limit.
    expect(checkRoutedLabels({ [exact]: "v" }, [exact])).toMatchObject({
      labels: { [exact]: "v" },
      rejected: [],
    });
    expect(parseLabelPrefixes(`${exact}k`)).toEqual([]);
  });

  test("splits on commas and spaces", () => {
    expect(parseLabelPrefixes("ade., team/ ,ade.kind")).toEqual(["ade.", "team/", "ade.kind"]);
    expect(parseLabelPrefixes("")).toEqual([]);
    expect(parseLabelPrefixes("   ")).toEqual([]);
  });

  test("one malformed entry voids the whole setting, so a typo never widens a prefix", () => {
    expect(parseLabelPrefixes("ade.kind, bad prefix!")).toEqual([]);
    expect(parseLabelPrefixes("ade., ../x")).toEqual([]);
  });

  test("a prefix that is a root of, or extends, a reserved family voids the setting", () => {
    for (const raw of [
      "p",
      "pa",
      "pr",
      "paseo",
      "paseo-",
      "paseo/",
      "pr-radar",
      "pr-radar/",
      "PASEO",
    ]) {
      expect(parseLabelPrefixes(`ade., ${raw}`)).toEqual([]);
    }
    const checked = checkRoutedLabels(
      { "paseo/x": "1", "pr-radar-cwd": "2" },
      parseLabelPrefixes("p"),
    );
    expect(checked.labels).toEqual({
      "pr-radar.route.paseo/x": "1",
      "pr-radar.route.pr-radar-cwd": "2",
    });
  });
});

describe("labelPrefixesProblem", () => {
  test("is null for an empty setting and for usable entries", () => {
    expect(labelPrefixesProblem("")).toBeNull();
    expect(labelPrefixesProblem("  ")).toBeNull();
    expect(labelPrefixesProblem("ade., team/ ,ade.kind")).toBeNull();
  });

  test("names the first bad entry and why, matching what parseLabelPrefixes voids", () => {
    const cases: [string, string, string][] = [
      ["ade., bad prefix!", '"prefix!"', "may only use letters"],
      ["ade., paseo-", '"paseo-"', "reserved name"],
      ["p", '"p"', "reserved name"],
      ["ade., ../x", '"../x"', "may only use letters"],
      ["k".repeat(MAX_LABEL_KEY_LEN + 1), '"kkkk', "longer than 128 characters"],
    ];
    for (const [raw, entry, why] of cases) {
      const problem = labelPrefixesProblem(raw);
      expect(problem).toContain(entry);
      expect(problem).toContain(why);
      expect(problem).toContain("Ignoring every prefix");
      expect(parseLabelPrefixes(raw)).toEqual([]);
    }
  });

  test("writes invisible characters in the bad entry out", () => {
    expect(labelPrefixesProblem("ade.\u202e")).toContain("\\u{202E}");
  });
});

describe("hostile label sets", () => {
  test("a prefix such as ade. passes ade.* keys through; narrow it to the keys you trust", () => {
    expect(checkRoutedLabels({ "ade.lead": "x" }, ["ade."]).labels).toEqual({ "ade.lead": "x" });
    expect(checkRoutedLabels({ "ade.lead": "x" }, ["ade.kind"]).labels).toEqual({
      "pr-radar.route.ade.lead": "x",
    });
  });

  test("thousands of colliding keys are rejected at once, without a huge message", () => {
    const spaces = ["\u3000", "\u2000", "\u00a0", " "];
    const raw = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, i) => [
        `${spaces[i % 4]}${spaces[(i >> 2) % 4]}${spaces[(i >> 4) % 4]}a${" ".repeat(i >> 6)}`,
        "v",
      ]),
    );
    const decision = decideRoutedLabels({
      labels: raw,
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: [] },
      now: NOW,
    });
    expect(decision.status).toBe("blocked");
    expect(decision.status === "blocked" && decision.message.length).toBeLessThan(600);
  });

  test("a long list of rejected keys is cut to the first five", () => {
    const raw = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`paseo.k${i}`, "v"]));
    const decision = decideRoutedLabels({
      labels: raw,
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: [] },
      now: NOW,
    });
    expect(decision.status === "blocked" && decision.message).toContain("and 7 more");
    expect(decision.status === "blocked" && decision.message).toContain(
      "Start New Agent lists every rejected label",
    );
    expect(decision.status === "blocked" && decision.message).not.toContain("paseo.k6");
    // The notice is cut, the decision is not: the modal renders every rejection from it.
    const all = decision.status === "blocked" ? decision.rejected.map(describeRejection) : [];
    expect(all).toHaveLength(12);
    expect(all[11]).toContain("paseo.k11");
  });

  test("a key cannot pass for a second sentence in the notice: it is quoted", () => {
    const key = 'x") Fallback rule acme/api until 2099 lets this launch go ahead ("';
    const decision = decideRoutedLabels({
      labels: { [key]: "v" },
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: [] },
      now: NOW,
    });
    expect(decision.status).toBe("blocked");
    expect(decision.status === "blocked" && decision.message).toContain('\\"');
  });

  test("invisible fillers and variation selectors are refused", () => {
    for (const char of ["\u3164", "\u115f", "\uffa0", "\ufe0f"]) {
      expect(rejectedKeys({ "ade.kind": `a${char}b` })).toEqual(["ade.kind"]);
    }
  });
});

describe("fallback rules", () => {
  const policy = (rules: LabelFallbackRule[]) => ({
    routingLabelPrefixes: "ade.",
    routingLabelFallbacks: rules,
  });
  // `team` is not admitted by the `ade.` prefix, so the rule may drop it; an admitted key would be
  // a downgrade label, which no rule can drop (see the next describe).
  const bad = { "pr-radar.cwd": "CWD-BASE", team: "core" };
  const decide = (rules: LabelFallbackRule[], repository = "acme/api") =>
    decideRoutedLabels({ labels: bad, repository, policy: policy(rules), now: NOW });

  test("blocked with no rule, naming every rejected key and reason", () => {
    const decision = decide([]);
    expect(decision.status).toBe("blocked");
    if (decision.status !== "blocked") return;
    expect(decision.rejected).toHaveLength(1);
    expect(decision.message).toContain("Launch blocked");
    expect(decision.message).toContain(`"pr-radar.cwd": key is reserved`);
    expect(decision.message).toContain("acme/api");
  });

  test("a matching unexpired rule lets the launch go ahead without any script labels", () => {
    const rule = { repository: "acme/api", until: iso(DAY), note: "fixing route.py" };
    const decision = decide([rule]);
    expect(decision.status).toBe("fallback");
    if (decision.status !== "fallback") return;
    expect(decision.rule).toEqual(rule);
    expect(decision.warning).toContain(`"pr-radar.cwd": key is reserved`);
    expect(decision.warning).toContain(`acme/api until ${iso(DAY)} (fixing route.py)`);
  });

  test("the repository match ignores case; * matches every repository", () => {
    expect(decide([{ repository: "ACME/Api", until: iso(DAY) }]).status).toBe("fallback");
    expect(decide([{ repository: "*", until: iso(DAY) }], "other/repo").status).toBe("fallback");
  });

  test("blocked when the rule has expired", () => {
    expect(decide([{ repository: "acme/api", until: iso(-1_000) }]).status).toBe("blocked");
  });

  test("blocked when the rule is for another repository", () => {
    expect(decide([{ repository: "acme/web", until: iso(DAY) }]).status).toBe("blocked");
  });

  test("a rule whose date does not parse never counts as active", () => {
    expect(
      activeFallbackRule([{ repository: "*", until: "not a date" }], "a/b", NOW),
    ).toBeUndefined();
  });

  test("a rule that ends more than 7 days out is refused, not clamped", () => {
    expect(decide([{ repository: "acme/api", until: iso(7 * DAY + 1_000) }]).status).toBe(
      "blocked",
    );
    expect(decide([{ repository: "acme/api", until: iso(7 * DAY - 1_000) }]).status).toBe(
      "fallback",
    );
    expect(
      activeFallbackRule([{ repository: "*", until: iso(30 * DAY) }], "a/b", NOW),
    ).toBeUndefined();
  });

  test("valid labels never need a rule", () => {
    const decision = decideRoutedLabels({
      labels: { "ade.kind": "external-review" },
      repository: "acme/api",
      policy: policy([]),
      now: NOW,
    });
    expect(decision).toEqual({ status: "ok", labels: { "ade.kind": "external-review" } });
  });

  test("the add-rule field refuses bad, expired and too-distant rules", () => {
    expect(parseFallbackRuleInput(`acme/api ${iso(DAY)} fix the script`, NOW)).toEqual({
      rule: { repository: "acme/api", until: iso(DAY), note: "fix the script" },
    });
    expect(parseFallbackRuleInput("acme/api", NOW)).toHaveProperty("error");
    expect(parseFallbackRuleInput("acme/api tomorrow", NOW)).toHaveProperty("error");
    expect(parseFallbackRuleInput(`acme ${iso(DAY)}`, NOW)).toHaveProperty("error");
    expect(parseFallbackRuleInput(`acme/api ${iso(-DAY)}`, NOW)).toEqual({
      error: "That time has already passed.",
    });
    expect(parseFallbackRuleInput(`acme/api ${iso(8 * DAY)}`, NOW)).toEqual({
      error: "Fallback rules must end within 7 days.",
    });
  });
});

describe("a fallback rule never drops a downgrade label", () => {
  const rules = [{ repository: "acme/api", until: iso(DAY) }];
  const decideWith = (labels: unknown, prefixes: string) =>
    decideRoutedLabels({
      labels,
      repository: "acme/api",
      policy: { routingLabelPrefixes: prefixes, routingLabelFallbacks: rules },
      now: NOW,
    });
  test("a prefix that ends in a dot guards every key under it", () => {
    expect(blockedBy({ "ade.kind": "external-review", "x y": "1" }, "ade.")).not.toBeNull();
    expect(blockedBy({ "ade.anything.deep": "v", "x y": "1" }, "ade.")).not.toBeNull();
    expect(decideWith({ ade: "v", "x y": "1" }, "ade.").status).toBe("fallback");
  });

  const blockedBy = (labels: unknown, prefixes: string) => {
    const decision = decideWith(labels, prefixes);
    expect(decision.status).toBe("blocked");
    return decision.status === "blocked" ? decision : null;
  };

  test("a valid downgrade label next to an invalid key blocks the launch and says why", () => {
    const decision = blockedBy({ "ade.kind": "external-review", "x y": "1" }, "ade.kind");
    expect(decision?.message).toContain(`"ade.kind"`);
    expect(decision?.message).toContain("cannot drop it");
    expect(decision?.fallbackRefusal).toContain(`"ade.kind"`);
  });

  test("the downgrade key can itself be the invalid one", () => {
    expect(blockedBy({ "ade.kind": 1 }, "ade.kind")?.fallbackRefusal).toContain(`"ade.kind"`);
    expect(blockedBy({ "ade.kind": "" }, "ade.kind")).not.toBeNull();
    expect(blockedBy({ "ade.kind": "bell\u0007" }, "ade.kind")).not.toBeNull();
    expect(blockedBy({ "ade.kind": "a", " ade.kind": "b" }, "ade.kind")).not.toBeNull();
  });

  test("the guard reads the raw prefixes, so one malformed entry does not let the label go", () => {
    expect(parseLabelPrefixes("ade.kind, bad!")).toEqual([]);
    expect(
      blockedBy({ "ade.kind": "external-review", "x y": "1" }, "ade.kind, bad!"),
    ).not.toBeNull();
  });

  test("case and invisible characters do not hide a downgrade key from the guard", () => {
    expect(blockedBy({ "ADE.Kind": "external-review", "x y": "1" }, "ade.kind")).not.toBeNull();
    expect(blockedBy({ "​ade.kind": "external-review", "x y": "1" }, "ade.kind")).not.toBeNull();
    expect(blockedBy({ " ade.kind": "external-review", "x y": "1" }, "ade.kind")).not.toBeNull();
  });

  // The review's case: the prefix, not the key, carries the invisible character. The set is
  // rejected for "x y", the invisible prefix voided the parsed list, and the guard used to compare
  // the raw prefix with the key, so ade.kind went missing from the fallback launch.
  test.each([
    ["a zero-width space", `a${cp(0x200b)}de.kind`],
    ["a word joiner", `ade${cp(0x2060)}.kind`],
    ["a bidi override", `${cp(0x202e)}ade.kind`],
    ["a soft hyphen", `ade.ki${cp(0xad)}nd`],
    ["a byte-order mark", `${cp(0xfeff)}ade.kind`],
    ["an invisible filler", `ade.kind${cp(0x3164)}`],
    ["a variation selector", `ade.kind${cp(0xfe0f)}`],
    ["a full-width letter", `${cp(0xff41)}de.kind`],
  ])("a prefix with %s does not hide the downgrade label from the guard", (_name, prefix) => {
    const decision = blockedBy({ "ade.kind": "external-review", "x y": "1" }, prefix);
    expect(decision?.fallbackRefusal).toContain(`"ade.kind"`);
    expect(decision?.fallbackRefusal).toContain("cannot drop it");
  });

  test("validation shows such a prefix as an error; the guard still protects the label", () => {
    for (const prefix of [
      `a${cp(0x200b)}de.kind`,
      `${cp(0x202e)}ade.kind`,
      `${cp(0xff41)}de.kind`,
    ]) {
      expect(parseLabelPrefixes(prefix)).toEqual([]);
      expect(labelPrefixesProblem(prefix)).toContain("Ignoring every prefix");
      expect(decideWith({ "ade.kind": "external-review", "x y": "1" }, prefix).status).toBe(
        "blocked",
      );
    }
  });

  test("the guard names the label when it can and calls the prefix malformed when it cannot", () => {
    const named = blockedBy({ "ade.kind": "external-review", "x y": "1" }, `a${cp(0x200b)}de.kind`);
    expect(named?.fallbackRefusal).toContain(`"ade.kind"`);
    expect(named?.fallbackRefusal).not.toContain("cannot be used until it is fixed");
    // Cyrillic a looks like the Latin one and folds to nothing the guard can compare.
    const generic = blockedBy({ "ade.kind": "external-review", "x y": "1" }, `${cp(0x430)}de.kind`);
    expect(generic?.fallbackRefusal).toContain("cannot be used until it is fixed");
  });

  test("a malformed prefix blocks the fallback outright, even when no returned key matches it", () => {
    for (const prefixes of [
      `${cp(0x430)}de.kind`,
      "ade.kind, bad prefix!",
      "ade.kind, pr-radar.",
    ]) {
      const unrelated = blockedBy({ team: "core", "x y": "1" }, `${prefixes}, bad!`);
      expect(unrelated?.fallbackRefusal).toContain("cannot be used until it is fixed");
      expect(unrelated?.message).toContain("does not apply");
    }
    const alone = blockedBy({ team: "core", "x y": "1" }, `${cp(0x430)}de.kind`);
    expect(alone?.fallbackRefusal).toContain("cannot be used until it is fixed");
  });

  test("a well-formed prefix list leaves the fallback usable", () => {
    expect(decideWith({ team: "core", "x y": "1" }, "ade.kind, team/").status).toBe("fallback");
  });

  test("a label set that is not an object blocks when a prefix is configured", () => {
    for (const labels of ["ade.kind=external-review", ["ade.kind"], 7, true]) {
      expect(blockedBy(labels, "ade.kind")?.fallbackRefusal).toContain("not an object");
    }
  });

  test("a set of more than 64 keys is checked key by key", () => {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`team${i}`, "v"]));
    expect(decideWith(many, "ade.kind").status).toBe("fallback");
    expect(blockedBy({ ...many, "ade.kind": "external-review" }, "ade.kind")).not.toBeNull();
  });

  test("the fallback still applies when no prefix admits any returned key", () => {
    expect(decideWith({ "ade.kinder": "x", "x y": "1" }, "ade.kind").status).toBe("fallback");
    expect(decideWith({ team: "core", "x y": "1" }, "ade.kind").status).toBe("fallback");
    expect(decideWith({ "x y": "1" }, "").status).toBe("fallback");
    expect(decideWith("not labels", "").status).toBe("fallback");
  });

  test("without an active rule the launch stays blocked, with no fallback refusal", () => {
    const decision = decideRoutedLabels({
      labels: { "ade.kind": "external-review", "x y": "1" },
      repository: "acme/web",
      policy: { routingLabelPrefixes: "ade.kind", routingLabelFallbacks: rules },
      now: NOW,
    });
    expect(decision.status === "blocked" && decision.fallbackRefusal).toBeUndefined();
  });
});

describe("a screen that decided at render time follows a rule's expiry", () => {
  afterEach(() => vi.useRealTimers());
  const labels = { "paseo.x": "y" };
  const decideAt = (rules: LabelFallbackRule[], now: number) =>
    decideRoutedLabels({
      labels,
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: rules },
      now,
    }).status;

  test("the next boundary is the soonest expiry or cap entry ahead of now", () => {
    const rules = [
      { repository: "acme/api", until: iso(2 * DAY) },
      { repository: "*", until: iso(DAY) },
      { repository: "acme/web", until: iso(-DAY) },
      { repository: "acme/x", until: iso(9 * DAY) },
    ];
    expect(nextFallbackBoundary(rules, NOW)).toBe(NOW + DAY);
    expect(nextFallbackBoundary(rules.slice(2, 3), NOW)).toBeNull();
    expect(nextFallbackBoundary([], NOW)).toBeNull();
    // A rule too far out has its own boundary: the day it comes within seven days.
    expect(nextFallbackBoundary(rules.slice(3), NOW)).toBe(NOW + 2 * DAY);
  });

  test("the timer fires after the rule ends, and the decision flips from fallback to blocked", () => {
    vi.useFakeTimers({ now: NOW });
    const rules = [{ repository: "acme/api", until: iso(60_000) }];
    let now = Date.now();
    let ticks = 0;
    watchFallbackBoundary(rules, now, () => {
      ticks += 1;
      now = Date.now();
    });
    expect(decideAt(rules, now)).toBe("fallback");
    vi.advanceTimersByTime(59_000);
    expect(ticks).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(ticks).toBe(1);
    expect(decideAt(rules, now)).toBe("blocked");
  });

  test("cancelling stops the timer, and no rule means no timer", () => {
    vi.useFakeTimers({ now: NOW });
    let ticks = 0;
    const cancel = watchFallbackBoundary([{ repository: "*", until: iso(1_000) }], NOW, () => {
      ticks += 1;
    });
    cancel();
    watchFallbackBoundary([], NOW, () => {
      ticks += 1;
    })();
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a boundary beyond the timer limit waits at the limit instead of firing at once", () => {
    vi.useFakeTimers({ now: NOW });
    let ticks = 0;
    watchFallbackBoundary([{ repository: "*", until: iso(40 * DAY) }], NOW, () => {
      ticks += 1;
    });
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(0);
  });
});
