import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyAutoRouting, type LaunchDeps, launchNewAgent } from "../client/launch";
import type { RadarRow } from "../client/radar";
import type { StartAgentLaunchRequest } from "../client/start-agent-modal";
import contribute from "../index.server";
import { decideRoutedLabels, RoutedLabelsBlockedError } from "../shared/routed-labels";
import {
  migratePrRadarSettings,
  type PrRadarSettings,
  PrRadarSettingsSchema,
} from "../shared/settings";
import { type RoutingScriptResult, runRoutingScript } from "../shared/viewer-scope";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1_000;
// Invisible and look-alike characters are built from code points, so the source shows what it tests.
const cp = (codePoint: number) => String.fromCodePoint(codePoint);

function row(overrides: Partial<RadarRow> = {}): RadarRow {
  return {
    id: "acme/api#42",
    number: 42,
    url: "https://github.com/acme/api/pull/42",
    title: "Fix checkout",
    repository: "acme/api",
    baseRefName: "main",
    headRefName: "fix/checkout",
    isDraft: false,
    author: "mallory",
    authorKind: "human",
    isSecurity: false,
    comments: 0,
    labels: [],
    changes: [],
    linkedIssues: [],
    cwdTag: "CWD-WORKTREE",
    hasLocalPlace: true,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksStatus: "success",
    reviewDecision: "approved",
    checks: [],
    workspaceIds: [],
    localProjectRoot: "/work/api",
    workspaceNames: [],
    agents: [],
    ownership: "mine",
    reviewRequestedFromMe: false,
    bucket: "waiting",
    reason: "",
    activityAt: null,
    refreshedAt: null,
    ...overrides,
  };
}

interface Launch {
  opened: string[];
  prepared: string[];
  created: { labels: Record<string, string>; title: string }[];
  deps: LaunchDeps;
}

// A launch fake that records what reaches Paseo: the workspace it opens and the agent it creates.
function fakeLaunch(settings: PrRadarSettings): Launch {
  const launch: Launch = {
    opened: [],
    prepared: [],
    created: [],
    deps: {
      paseo: {
        workspaces: {
          open: async (cwd) => {
            launch.opened.push(cwd);
            return {
              agents: {
                create: async (options) => {
                  launch.created.push({ labels: options.labels, title: options.title });
                  return { id: "agent-1" };
                },
              },
            };
          },
        },
        config: {
          get: async () => ({
            config: { agentProfiles: [{ name: "Model Router", provider: "claude" }] },
          }),
        },
      },
      prepareCwd: async (input) => {
        launch.prepared.push(input.repository);
        return { cwd: "/work/api-pr-42", cwdTag: "CWD-WORKTREE" };
      },
      policy: settings,
      now: () => NOW,
    },
  };
  return launch;
}

interface Outcome {
  launch: Launch;
  launched: boolean;
  message: string;
}

function settingsWith(values: Partial<PrRadarSettings> = {}): PrRadarSettings {
  return PrRadarSettingsSchema.parse({ routingLabelPrefixes: "ade.", ...values });
}

function request(
  overrides: StartAgentLaunchRequest["overrides"],
  extra: Partial<StartAgentLaunchRequest> = {},
) {
  return {
    row: row(),
    targetDir: null,
    cwdMode: "CWD-WORKTREE" as const,
    worktreeName: null,
    profileName: "Model Router",
    overrides,
    ...extra,
  } satisfies StartAgentLaunchRequest;
}

async function run(
  launch: Launch,
  start: StartAgentLaunchRequest,
): Promise<Pick<Outcome, "launched" | "message">> {
  try {
    const result = await launchNewAgent(launch.deps, start);
    return { launched: true, message: result.message };
  } catch (error) {
    if (!(error instanceof RoutedLabelsBlockedError)) throw error;
    return { launched: false, message: error.message };
  }
}

// Auto-launch: the routing result is applied to the defaults, with no preview.
async function viaAuto(settings: PrRadarSettings, routed: RoutingScriptResult): Promise<Outcome> {
  const launch = fakeLaunch(settings);
  const applied = applyAutoRouting({ settings, routed, profiles: [], row: row(), now: NOW });
  if (applied.status === "blocked") return { launch, launched: false, message: applied.message };
  const outcome = await run(
    launch,
    request(applied.overrides, {
      profileName: applied.profileName,
      routingWarning: applied.routingWarning,
    }),
  );
  return { launch, ...outcome };
}

// Start New Agent modal: the preview disables Launch when the labels are blocked; otherwise the
// request carries the routed labels as they came.
async function viaModal(settings: PrRadarSettings, routed: RoutingScriptResult): Promise<Outcome> {
  const launch = fakeLaunch(settings);
  const preview = decideRoutedLabels({
    labels: routed.labels,
    repository: row().repository,
    policy: settings,
    now: NOW,
  });
  if (preview.status === "blocked") return { launch, launched: false, message: preview.message };
  const outcome = await run(launch, request({ labels: routed.labels }));
  return { launch, ...outcome };
}

const PATHS = [
  ["auto-launch", viaAuto],
  ["start-agent modal", viaModal],
] as const;

describe.each(PATHS)("routed labels through %s", (_name, launchVia) => {
  test("an allowed-prefix label keeps its name and pr-radar.cwd stays authoritative", async () => {
    const outcome = await launchVia(settingsWith(), { labels: { "ade.kind": "external-review" } });
    expect(outcome.launched).toBe(true);
    expect(outcome.launch.created).toHaveLength(1);
    expect(outcome.launch.created[0]?.labels).toEqual({
      "ade.kind": "external-review",
      "pr-radar.cwd": "CWD-WORKTREE",
    });
  });

  test("a label outside the allowed prefixes is namespaced, also with an empty allow-list", async () => {
    const labels = { team: "core", "ade.kind": "external-review" };
    const partial = await launchVia(settingsWith(), { labels });
    expect(partial.launch.created[0]?.labels).toEqual({
      "pr-radar.route.team": "core",
      "ade.kind": "external-review",
      "pr-radar.cwd": "CWD-WORKTREE",
    });
    const none = await launchVia(settingsWith({ routingLabelPrefixes: "" }), { labels });
    expect(none.launch.created[0]?.labels).toEqual({
      "pr-radar.route.team": "core",
      "pr-radar.route.ade.kind": "external-review",
      "pr-radar.cwd": "CWD-WORKTREE",
    });
  });

  test("no labels launches with only pr-radar.cwd", async () => {
    const outcome = await launchVia(settingsWith(), {});
    expect(outcome.launch.created[0]?.labels).toEqual({ "pr-radar.cwd": "CWD-WORKTREE" });
  });

  test.each([
    [
      "a paseo.* key",
      { "paseo.parent-agent-id": "11111111-1111-4111-8111-111111111111" },
      "paseo.parent-agent-id",
    ],
    ["a bare pr-radar key", { "pr-radar": "x" }, "pr-radar"],
    ["a script-supplied pr-radar.cwd", { "pr-radar.cwd": "CWD-BASE" }, "pr-radar.cwd"],
    ["a control character", { "ade.kind": "external\u0007review" }, "ade.kind"],
    ["a C1 control", { "ade.kind": "external\u0085review" }, "ade.kind"],
    ["a bidi override in a value", { "ade.kind": "‮external-review" }, "ade.kind"],
    ["a zero-width character in a key", { "ade.ki​nd": "x" }, "ade.ki\\u{200B}nd"],
    ["a non-string value", { "ade.kind": 1 }, "ade.kind"],
    ["keys that collide after trimming", { "ade.kind": "a", " ade.kind": "b" }, "ade.kind"],
  ])("blocks the launch for %s and names the key", async (_label, labels, shownKey) => {
    const outcome = await launchVia(settingsWith(), { labels });
    expect(outcome.launched).toBe(false);
    expect(outcome.message).toContain("Launch blocked");
    expect(outcome.message).toContain(shownKey);
    expect(outcome.launch.prepared).toEqual([]);
    expect(outcome.launch.opened).toEqual([]);
    expect(outcome.launch.created).toEqual([]);
  });

  test("one bad label blocks every label, valid ones included", async () => {
    const outcome = await launchVia(settingsWith(), {
      labels: { "ade.kind": "external-review", "paseo.x": "y" },
    });
    expect(outcome.launched).toBe(false);
    expect(outcome.launch.created).toEqual([]);
  });

  test("a matching unexpired fallback rule launches without any script labels and warns", async () => {
    const settings = settingsWith({
      routingLabelFallbacks: [
        {
          repository: "acme/api",
          until: new Date(NOW + DAY).toISOString(),
          note: "fixing route.py",
        },
      ],
    });
    const outcome = await launchVia(settings, { labels: { team: "core", "paseo.x": "y" } });
    expect(outcome.launched).toBe(true);
    expect(outcome.launch.created[0]?.labels).toEqual({ "pr-radar.cwd": "CWD-WORKTREE" });
    expect(outcome.message).toContain(`"paseo.x": key is reserved`);
    expect(outcome.message).toContain("acme/api until");
    expect(outcome.message).toContain("fixing route.py");
  });

  test("an active fallback rule cannot drop a downgrade label: mixed and invalid-key sets", async () => {
    const settings = settingsWith({
      routingLabelPrefixes: "ade.kind",
      routingLabelFallbacks: [
        { repository: "acme/api", until: new Date(NOW + DAY).toISOString(), note: "fix" },
      ],
    });
    for (const labels of [
      { "ade.kind": "external-review", "paseo.x": "y" },
      { "ade.kind": 1 },
      "ade.kind=external-review",
    ]) {
      const outcome = await launchVia(settings, { labels });
      expect(outcome.launched).toBe(false);
      expect(outcome.message).toContain("cannot drop it");
      expect(outcome.launch.prepared).toEqual([]);
      expect(outcome.launch.opened).toEqual([]);
      expect(outcome.launch.created).toEqual([]);
    }
  });

  test("an active fallback rule cannot drop a label under a trailing-dot prefix", async () => {
    const settings = settingsWith({
      routingLabelFallbacks: [{ repository: "acme/api", until: new Date(NOW + DAY).toISOString() }],
    });
    const outcome = await launchVia(settings, {
      labels: { "ade.kind": "external-review", "x y": "1" },
    });
    expect(outcome.launched).toBe(false);
    expect(outcome.message).toContain("cannot drop it");
    expect(outcome.launch.created).toEqual([]);
  });

  test.each([
    ["an invisible character", `a${cp(0x200b)}de.kind`],
    ["a bidi override", `${cp(0x202e)}ade.kind`],
    ["a full-width letter", `${cp(0xff41)}de.kind`],
    // `\s` matches these, so a split on it cut the prefix in two valid ones (`a`, `de.kind`), and
    // neither protected ade.kind.
    ["a mid-word byte-order mark", `a${cp(0xfeff)}de.kind`],
    ["a mid-word no-break space", `a${cp(0xa0)}de.kind`],
    ["a mid-word line separator", `a${cp(0x2028)}de.kind`],
    ["a mid-word ideographic space", `a${cp(0x3000)}de.kind`],
    // Cyrillic a: no comparison sees through it, so the malformed prefix itself blocks the rule.
    ["a look-alike letter", `${cp(0x430)}de.kind`],
  ])(
    "an active fallback rule cannot drop a downgrade label when its prefix holds %s",
    async (_name, prefix) => {
      const settings = settingsWith({
        routingLabelPrefixes: prefix,
        routingLabelFallbacks: [
          { repository: "acme/api", until: new Date(NOW + DAY).toISOString() },
        ],
      });
      const outcome = await launchVia(settings, {
        labels: { "ade.kind": "external-review", "x y": "1" },
      });
      expect(outcome.launched).toBe(false);
      expect(outcome.message).toMatch(/cannot drop it|cannot be used until it is fixed/);
      expect(outcome.launch.prepared).toEqual([]);
      expect(outcome.launch.opened).toEqual([]);
      expect(outcome.launch.created).toEqual([]);
    },
  );

  test("an active fallback rule is refused while any Allowed label prefix is malformed", async () => {
    const settings = settingsWith({
      routingLabelPrefixes: `ade.kind, bad prefix!`,
      routingLabelFallbacks: [{ repository: "acme/api", until: new Date(NOW + DAY).toISOString() }],
    });
    const outcome = await launchVia(settings, { labels: { team: "core", "x y": "1" } });
    expect(outcome.launched).toBe(false);
    expect(outcome.message).toContain("cannot be used until it is fixed");
    expect(outcome.launch.created).toEqual([]);
  });

  test("an active fallback rule still launches when no returned key is a downgrade label", async () => {
    const settings = settingsWith({
      routingLabelPrefixes: "ade.kind",
      routingLabelFallbacks: [{ repository: "acme/api", until: new Date(NOW + DAY).toISOString() }],
    });
    const outcome = await launchVia(settings, { labels: { team: "core", "paseo.x": "y" } });
    expect(outcome.launched).toBe(true);
    expect(outcome.launch.created[0]?.labels).toEqual({ "pr-radar.cwd": "CWD-WORKTREE" });
  });

  test.each([
    ["expired", { repository: "acme/api", until: new Date(NOW - 1_000).toISOString() }],
    [
      "for another repository",
      { repository: "acme/web", until: new Date(NOW + DAY).toISOString() },
    ],
    [
      "more than 7 days out",
      { repository: "acme/api", until: new Date(NOW + 8 * DAY).toISOString() },
    ],
  ])("a fallback rule that is %s does not unblock the launch", async (_why, rule) => {
    const outcome = await launchVia(settingsWith({ routingLabelFallbacks: [rule] }), {
      labels: { "paseo.x": "y" },
    });
    expect(outcome.launched).toBe(false);
    expect(outcome.launch.created).toEqual([]);
  });
});

describe.each(PATHS)("settings saved by the label-only version, through %s", (_name, launchVia) => {
  // Version 2 documents carry no fallback field, so no rule is active after they load.
  test("they load with no rule and a rejected label set still blocks", async () => {
    const settings = PrRadarSettingsSchema.parse(
      migratePrRadarSettings({ routingLabelPrefixes: "ade." }),
    );
    expect(settings.routingLabelFallbacks).toEqual([]);
    const outcome = await launchVia(settings, {
      labels: { "ade.kind": "external-review", "paseo.x": "y" },
    });
    expect(outcome.launched).toBe(false);
    expect(outcome.launch.created).toEqual([]);
  });
});

describe("the launch refuses bad labels even from a caller that skipped its own check", () => {
  test("launchNewAgent throws before preparing a worktree", async () => {
    const launch = fakeLaunch(settingsWith());
    await expect(
      launchNewAgent(launch.deps, request({ labels: { "paseo.parent-agent-id": "x" } })),
    ).rejects.toBeInstanceOf(RoutedLabelsBlockedError);
    expect(launch.prepared).toEqual([]);
    expect(launch.created).toEqual([]);
  });
});

describe("boundary: the registered routing handler to the launched agent", () => {
  const dirs: string[] = [];
  const stops: (() => void | Promise<void>)[] = [];

  afterEach(async () => {
    // The plugin's cleanup ends a script that may still be running in one of these directories:
    // wait for it to finish before the directories go.
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function registeredRoute(script: string, settings: PrRadarSettings) {
    const handlers = new Map<
      string,
      (input: { payload: Record<string, unknown> }) => Promise<unknown>
    >();
    const server = {
      registerSettings: () => ({
        read: async () => ({ status: "ready", values: { ...settings, routingScriptPath: script } }),
      }),
      handle: (
        rpc: { name: string },
        handler: (input: { payload: Record<string, unknown> }) => Promise<unknown>,
      ) => {
        handlers.set(rpc.name, handler);
      },
    };
    stops.push(contribute(server as never));
    const handler = handlers.get(runRoutingScript.name);
    if (!handler) throw new Error("pr-radar.run-routing-script was not registered");
    return async () => runRoutingScript.output.parse(await handler({ payload: {} }));
  }

  function scriptPrinting(json: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pr-radar-labels-")));
    dirs.push(dir);
    const path = join(dir, "route.sh");
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${json}'\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("the cleanup the plugin returns ends a routing script that is still running", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pr-radar-stop-")));
    dirs.push(dir);
    const pidFile = join(dir, "pid.txt");
    const script = join(dir, "slow.sh");
    writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`);
    chmodSync(script, 0o755);
    const route = registeredRoute(script, settingsWith());
    const failure = expect(route()).rejects.toThrow(/shutting down/);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    await stops.pop()?.();
    await failure;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3_000 });
  });

  test("script labels reach the launched agent and pr-radar.cwd stays the workspace's own", async () => {
    const settings = settingsWith();
    const route = registeredRoute(
      scriptPrinting('{"labels":{"ade.kind":"external-review","team":"core"},"reason":"x"}'),
      settings,
    );
    const launch = fakeLaunch(settings);
    const applied = applyAutoRouting({
      settings,
      routed: await route(),
      profiles: [],
      row: row(),
      now: NOW,
    });
    expect(applied.status).toBe("launch");
    if (applied.status !== "launch") return;
    await launchNewAgent(launch.deps, request(applied.overrides));
    expect(launch.created).toHaveLength(1);
    expect(launch.created[0]?.labels).toEqual({
      "ade.kind": "external-review",
      "pr-radar.route.team": "core",
      "pr-radar.cwd": "CWD-WORKTREE",
    });
  });

  test("a script that tries to set pr-radar.cwd or a paseo.* label launches nothing", async () => {
    const settings = settingsWith();
    const route = registeredRoute(
      scriptPrinting('{"labels":{"pr-radar.cwd":"CWD-BASE","paseo.parent-agent-id":"x"}}'),
      settings,
    );
    const routed = await route();
    expect(routed.labels).toEqual({ "pr-radar.cwd": "CWD-BASE", "paseo.parent-agent-id": "x" });
    const launch = fakeLaunch(settings);
    const applied = applyAutoRouting({ settings, routed, profiles: [], row: row(), now: NOW });
    expect(applied.status).toBe("blocked");
    await expect(launchNewAgent(launch.deps, request({ labels: routed.labels }))).rejects.toThrow(
      /"pr-radar\.cwd": key is reserved.*"paseo\.parent-agent-id": key is reserved/,
    );
    expect(launch.created).toEqual([]);
  });

  test("a script labels value that is not a string map survives the handler and blocks the launch", async () => {
    const settings = settingsWith();
    const route = registeredRoute(
      scriptPrinting('{"model":"m","labels":{"ade.kind":1}}'),
      settings,
    );
    const routed = await route();
    expect(routed.model).toBe("m");
    expect(routed.labels).toEqual({ "ade.kind": 1 });
    const applied = applyAutoRouting({ settings, routed, profiles: [], row: row(), now: NOW });
    expect(applied).toMatchObject({ status: "blocked" });
    expect(applied.status === "blocked" && applied.message).toContain(
      `"ade.kind": value must be a string`,
    );
  });
});
