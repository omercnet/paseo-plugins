import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  listOmpSettingsWithDependencies,
  type OmpSettingsDependencies,
  parseOmpSettingsList,
  updateOmpSettingsWithDependencies,
} from "../server/omp-settings";
import {
  categorizeOmpSetting,
  formatOmpSettingLabel,
  OMP_SETTING_DESCRIPTIONS,
  type OmpBashRule,
  OmpModelSelectorSchema,
  orderOmpToolSettings,
  updateOmpSettings,
} from "../shared/omp-settings";

describe("OMP settings inventory", () => {
  test("preserves typed values while withholding credential-shaped values", () => {
    const catalog = parseOmpSettingsList({
      "retry.enabled": {
        value: true,
        type: "boolean",
        description: "Retry failed requests",
      },
      "auth.broker.token": {
        value: "must-not-cross-the-rpc-boundary",
        type: "string",
        description: "",
      },
      "images.urls.credentials": {
        redacted: true,
        type: "record",
        description: "",
      },
      unsupported: { value: true, type: "mystery" },
    });

    expect(catalog).toEqual({
      droppedCount: 1,
      settings: [
        {
          path: "retry.enabled",
          value: true,
          type: "boolean",
          description: "Retry failed requests",
        },
        {
          path: "auth.broker.token",
          redacted: true,
          configured: true,
          type: "string",
          description: "",
        },
        {
          path: "images.urls.credentials",
          redacted: true,
          type: "record",
          description: "",
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("must-not-cross-the-rpc-boundary");
  });

  test("rejects a non-object document", () => {
    expect(() => parseOmpSettingsList([])).toThrow("invalid settings document");
  });

  test("groups representative settings into OMP navigation categories", () => {
    expect(categorizeOmpSetting("theme.dark")).toBe("appearance");
    expect(categorizeOmpSetting("retry.maxRetries")).toBe("model");
    expect(categorizeOmpSetting("compaction.enabled")).toBe("context");
    expect(categorizeOmpSetting("mcp.notifications")).toBe("tools");
    expect(categorizeOmpSetting("task.maxConcurrency")).toBe("tasks");
    expect(categorizeOmpSetting("providers.fetch")).toBe("providers");
    expect(categorizeOmpSetting("setupVersion")).toBe("general");
  });

  test("groups the spending cap fields into their own Budget category", () => {
    expect(categorizeOmpSetting("session.warnCost")).toBe("budget");
    expect(categorizeOmpSetting("session.maxCost")).toBe("budget");
  });

  test("describes the cap fields OMP lists without text, and keeps OMP's own text elsewhere", () => {
    const catalog = parseOmpSettingsList({
      "session.maxCost": { type: "number", description: "" },
      "retry.enabled": { type: "boolean", description: "From OMP" },
    });

    const [maxCost, retry] = catalog.settings;
    expect(maxCost).toEqual({
      path: "session.maxCost",
      type: "number",
      description: OMP_SETTING_DESCRIPTIONS["session.maxCost"],
    });
    expect(retry?.description).toBe("From OMP");
  });

  test("replaces OMP's own description for a setting with Paseo wording", () => {
    const catalog = parseOmpSettingsList({
      "secrets.enabled": { value: true, type: "boolean", description: "Obfuscate secrets" },
    });

    const [secrets] = catalog.settings;
    expect(secrets?.description).toBe(OMP_SETTING_DESCRIPTIONS["secrets.enabled"]);
    expect(secrets?.description).not.toContain("Obfuscate secrets");
  });

  test("files every optional-tool switch under Tools, whichever prefix it used to match", () => {
    for (const path of [
      "github.enabled",
      "security.enabled",
      "generate_image.enabled",
      "speechgen.enabled",
      "computer.enabled",
      "lsp.enabled",
      "debug.enabled",
      "ida.enabled",
      "checkpoint.enabled",
      "task.isolation.enabled",
      "magicKeywords.enabled",
    ]) {
      expect(categorizeOmpSetting(path)).toBe("tools");
      expect(formatOmpSettingLabel(path)).not.toBe("Enabled");
    }
    expect(categorizeOmpSetting("bash.patterns")).toBe("tools");
    expect(categorizeOmpSetting("bash.maxTimeout")).not.toBe("tools");
    expect(categorizeOmpSetting("lsp.requestTimeout")).toBe("files");
    expect(categorizeOmpSetting("task.maxConcurrency")).toBe("tasks");
  });

  test("lists enabled tool switches first, then disabled ones, then the other tool settings", () => {
    const setting = (path: string, value: unknown) => ({
      path,
      type: "boolean" as const,
      description: "",
      value,
    });
    const ordered = orderOmpToolSettings([
      setting("tools.approvalMode", "yolo"),
      setting("github.enabled", false),
      setting("checkpoint.enabled", true),
      setting("github.cache.enabled", true),
      setting("lsp.enabled", true),
    ]).map((entry) => entry.path);

    expect(ordered).toEqual([
      "lsp.enabled",
      "checkpoint.enabled",
      "github.enabled",
      "tools.approvalMode",
      "github.cache.enabled",
    ]);
  });

  test("formats dotted camel-case paths as readable labels", () => {
    expect(formatOmpSettingLabel("providers.streamIdleTimeoutSeconds")).toBe(
      "Stream Idle Timeout Seconds",
    );
  });

  test("accepts selectors through 513 UTF-8 bytes", () => {
    const selector = `p/${"m".repeat(511)}`;
    expect(selector).toHaveLength(513);
    expect(OmpModelSelectorSchema.safeParse(selector).success).toBe(true);
    expect(OmpModelSelectorSchema.safeParse(`${selector}x`).success).toBe(false);

    const multibyteBoundary = `p/${"é".repeat(255)}x`;
    expect(OmpModelSelectorSchema.safeParse(multibyteBoundary).success).toBe(true);
    expect(OmpModelSelectorSchema.safeParse(`${multibyteBoundary}y`).success).toBe(false);
  });
});

describe("OMP scalar settings updates", () => {
  function harness(initial: Record<string, unknown> = {}) {
    const values: Record<string, { value: unknown; type: string; description: string }> = {
      "retry.enabled": { value: true, type: "boolean", description: "" },
      temperature: { value: 0.5, type: "number", description: "" },
      personality: { value: "default", type: "enum", description: "" },
      modelRoles: { value: { default: "openai/gpt-5" }, type: "record", description: "" },
      "retry.fallbackChains": { value: {}, type: "record", description: "" },
      cycleOrder: { value: ["smol", "default"], type: "array", description: "" },
      "task.agentModelOverrides": { value: {}, type: "record", description: "" },
      "task.agentServiceTierOverrides": { value: {}, type: "record", description: "" },
      "task.agentPrewalk": { value: {}, type: "record", description: "" },
      "task.agentAdvisor": { value: {}, type: "record", description: "" },
      "task.disabledAgents": { value: ["user-agent"], type: "array", description: "" },
      "tools.approval": { value: {}, type: "record", description: "" },
      "bash.patterns": { value: [], type: "array", description: "" },
      "tools.restrictedFolders": { value: [], type: "array", description: "" },
    };
    for (const [path, value] of Object.entries(initial)) values[path].value = value;
    const commands: string[][] = [];
    const dependencies: OmpSettingsDependencies = {
      async resolveExecutable() {
        return "/fake/omp";
      },
      async runConfig(_executable, args) {
        commands.push([...args]);
        const serializedValue = args.at(-1);
        if (args[0] === "set" && args[1] === "temperature" && serializedValue === "99") {
          return {
            outcome: "exited",
            stdout: "",
            truncated: false,
            exitCode: 1,
            signal: null,
            spawnErrorCode: null,
            cleanupFailed: false,
          };
        }
        if (args[0] === "set" && args[1] && serializedValue !== undefined) {
          const setting = values[args[1]];
          if (setting) {
            setting.value =
              setting.type === "boolean"
                ? serializedValue === "true"
                : setting.type === "number"
                  ? Number(serializedValue)
                  : setting.type === "array" || setting.type === "record"
                    ? JSON.parse(serializedValue)
                    : serializedValue;
          }
        }
        if (args[0] === "reset" && args[1] === "retry.enabled") values[args[1]].value = false;
        return {
          outcome: "exited",
          stdout: args[0] === "list" ? JSON.stringify(values) : "",
          truncated: false,
          exitCode: 0,
          signal: null,
          spawnErrorCode: null,
          cleanupFailed: false,
        };
      },
      async validateProjectConfig() {
        return {
          outcome: "exited",
          stdout: "{}",
          truncated: false,
          exitCode: 0,
          signal: null,
          spawnErrorCode: null,
          cleanupFailed: false,
        };
      },
    };
    return { commands, dependencies };
  }
  test("applies validated scalar sets and resets against one revision", async () => {
    const { commands, dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [
          { operation: "set", path: "personality", value: "concise" },
          { operation: "reset", path: "retry.enabled" },
        ],
      },
      dependencies,
    );

    expect(result.conflict).toBe(false);
    expect(result.appliedPaths).toEqual(["personality", "retry.enabled"]);
    expect(commands).toContainEqual(["set", "personality", "--json", "--", "concise"]);
    expect(commands).toContainEqual(["reset", "retry.enabled"]);
  });

  test("serializes each typed routing setting through native config set and reset", async () => {
    const { commands, dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [
          { operation: "set", path: "modelRoles", value: { default: "azure/gpt-5.6-sol" } },
          {
            operation: "set",
            path: "retry.fallbackChains",
            value: {
              default: [],
              review: ["openai/gpt-5-mini", "anthropic/claude-opus-5:high"],
            },
          },
          { operation: "set", path: "cycleOrder", value: ["default", "smol", "slow"] },
          {
            operation: "set",
            path: "task.agentModelOverrides",
            value: { reviewer: ["@review", "openai/gpt-5"] },
          },
          {
            operation: "set",
            path: "task.agentServiceTierOverrides",
            value: { reviewer: "priority" },
          },
          { operation: "set", path: "task.agentPrewalk", value: { reviewer: "@smol" } },
          { operation: "set", path: "task.agentAdvisor", value: { reviewer: "on" } },
          { operation: "set", path: "task.disabledAgents", value: ["scout", "sonic"] },
        ],
      },
      dependencies,
    );

    expect(result.conflict).toBe(false);
    expect(commands).toContainEqual([
      "set",
      "modelRoles",
      "--json",
      "--",
      JSON.stringify({ default: "azure/gpt-5.6-sol" }),
    ]);
    expect(commands).toContainEqual([
      "set",
      "retry.fallbackChains",
      "--json",
      "--",
      JSON.stringify({
        default: [],
        review: ["openai/gpt-5-mini", "anthropic/claude-opus-5:high"],
      }),
    ]);
    expect(commands).toContainEqual([
      "set",
      "task.agentModelOverrides",
      "--json",
      "--",
      JSON.stringify({ reviewer: ["@review", "openai/gpt-5"] }),
    ]);
    expect(commands).toContainEqual([
      "set",
      "cycleOrder",
      "--json",
      "--",
      JSON.stringify(["default", "smol", "slow"]),
    ]);
    expect(commands).toContainEqual([
      "set",
      "task.agentServiceTierOverrides",
      "--json",
      "--",
      JSON.stringify({ reviewer: "priority" }),
    ]);
    expect(commands).toContainEqual([
      "set",
      "task.agentPrewalk",
      "--json",
      "--",
      JSON.stringify({ reviewer: "@smol" }),
    ]);
    expect(commands).toContainEqual([
      "set",
      "task.agentAdvisor",
      "--json",
      "--",
      JSON.stringify({ reviewer: "on" }),
    ]);
    expect(commands).toContainEqual([
      "set",
      "task.disabledAgents",
      "--json",
      "--",
      JSON.stringify(["scout", "sonic"]),
    ]);

    const reset = await updateOmpSettingsWithDependencies(
      {
        revision: result.catalog.revision ?? "",
        changes: [{ operation: "reset", path: "modelRoles" }],
      },
      dependencies,
    );
    expect(reset.appliedPaths).toEqual(["modelRoles"]);
    expect(commands).toContainEqual(["reset", "modelRoles"]);
  });

  test("rejects malformed routing input before a config mutation can execute", async () => {
    expect(
      updateOmpSettings.input.safeParse({
        revision: "revision",
        changes: [{ operation: "set", path: "modelRoles", value: { "bad role": "openai/gpt-5" } }],
      }).success,
    ).toBe(false);
    expect(
      updateOmpSettings.input.safeParse({
        revision: "revision",
        changes: [
          {
            operation: "set",
            path: "retry.fallbackChains",
            value: { default: Array.from({ length: 17 }, () => "openai/gpt-5") },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      updateOmpSettings.input.safeParse({
        revision: "revision",
        changes: [{ operation: "set", path: "cycleOrder", value: ["default", "default"] }],
      }).success,
    ).toBe(false);
    expect(
      updateOmpSettings.input.safeParse({
        revision: "revision",
        changes: [{ operation: "set", path: "task.disabledAgents", value: ["scout", "scout"] }],
      }).success,
    ).toBe(false);

    const { commands, dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [{ operation: "set", path: "modelRoles", value: { default: "bad selector" } }],
      } as never,
      dependencies,
    );
    expect(result.failed?.path).toBe("modelRoles");
    expect(commands.filter(([operation]) => operation === "set" || operation === "reset")).toEqual(
      [],
    );
  });

  test("writes tool policy rules in the order given and refuses values OMP would not honor", async () => {
    const rules: OmpBashRule[] = [
      { match: "git push --force*", approval: "deny" },
      { match: "git push*", approval: "prompt" },
      { match: "npm test*", approval: "allow" },
    ];
    const { commands, dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [
          { operation: "set", path: "bash.patterns", value: rules },
          { operation: "set", path: "tools.approval", value: { eval: "prompt", bash: "deny" } },
          { operation: "set", path: "tools.restrictedFolders", value: ["~/secrets"] },
        ],
      },
      dependencies,
    );

    expect(result.failed).toBeUndefined();
    expect(commands).toContainEqual([
      "set",
      "bash.patterns",
      "--json",
      "--",
      JSON.stringify(rules),
    ]);
    expect(commands).toContainEqual([
      "set",
      "tools.approval",
      "--json",
      "--",
      JSON.stringify({ eval: "prompt", bash: "deny" }),
    ]);
    const change = (path: string, value: unknown) =>
      updateOmpSettings.input.safeParse({
        revision: "revision",
        changes: [{ operation: "set", path, value }],
      }).success;
    expect(change("tools.approval", { bash: "ask" })).toBe(false);
    expect(change("tools.approval", { "bad tool": "deny" })).toBe(false);
    expect(change("bash.patterns", [{ match: "", approval: "deny" }])).toBe(false);
    expect(change("bash.patterns", [{ match: "ls", approval: "block" }])).toBe(false);
    expect(change("bash.patterns", [{ match: "ls", approval: "deny", extra: 1 }])).toBe(false);
    expect(change("tools.restrictedFolders", ["~/a", "~/a"])).toBe(false);
  });

  test("replaces the whole project bash rule list and leaves the global list alone", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-policy-"));
    const { commands, dependencies } = harness();
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const rules: OmpBashRule[] = [{ match: "rm -rf*", approval: "deny" }];
      const written = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "bash.patterns", value: rules }],
        },
        dependencies,
      );

      expect(written.appliedPaths).toEqual(["bash.patterns"]);
      expect(await readFile(join(cwd, ".omp", "config.yml"), "utf8")).toContain("rm -rf*");
      expect(commands.filter(([operation]) => operation === "set")).toEqual([]);

      const reset = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: written.catalog.revision ?? "",
          changes: [{ operation: "reset", path: "bash.patterns" }],
        },
        dependencies,
      );
      expect(reset.appliedPaths).toEqual(["bash.patterns"]);
      expect(await readFile(join(cwd, ".omp", "config.yml"), "utf8")).not.toContain("rm -rf*");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("writes only the project's own tool approvals because a project record merges with the user's", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-approval-"));
    const { dependencies } = harness({ "tools.approval": { bash: "deny", eval: "prompt" } });
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      expect(listed.settings.find((entry) => entry.path === "tools.approval")?.userValue).toEqual({
        bash: "deny",
        eval: "prompt",
      });
      const written = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [
            {
              operation: "set",
              path: "tools.approval",
              value: { bash: "deny", eval: "allow", lsp: "deny" },
            },
          ],
        },
        dependencies,
      );
      expect(written.failed).toBeUndefined();
      const text = await readFile(join(cwd, ".omp", "config.yml"), "utf8");
      expect(text).toContain("lsp: deny");
      expect(text).toContain("eval: allow");
      expect(text).not.toContain("bash");

      const unchanged = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: written.catalog.revision ?? "",
          changes: [
            {
              operation: "set",
              path: "tools.approval",
              value: { bash: "deny", eval: "prompt" },
            },
          ],
        },
        dependencies,
      );
      expect(unchanged.failed).toBeUndefined();
      expect(await readFile(join(cwd, ".omp", "config.yml"), "utf8")).not.toContain("approval");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("applies a project tool approval that matches the user's when the project file has no tools section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-approval-same-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    await writeFile(join(cwd, ".omp", "config.yml"), "personality: concise\n");
    const { dependencies } = harness({ "tools.approval": { bash: "deny" } });
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const result = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "tools.approval", value: { bash: "deny" } }],
        },
        dependencies,
      );

      expect(result.failed).toBeUndefined();
      expect(await readFile(join(cwd, ".omp", "config.yml"), "utf8")).toBe(
        "personality: concise\n",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("refuses a project tool approval write when the user-level approvals cannot be read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-approval-fail-"));
    const { dependencies } = harness({ "tools.approval": { bash: "deny" } });
    const failingLookup: OmpSettingsDependencies = {
      ...dependencies,
      async runConfig(executable, args, directory) {
        if (directory === tmpdir()) {
          return {
            outcome: "exited",
            stdout: "",
            truncated: false,
            exitCode: 1,
            signal: null,
            spawnErrorCode: null,
            cleanupFailed: false,
          };
        }
        return dependencies.runConfig(executable, args, directory);
      },
    };
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, failingLookup);
      const result = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [
            { operation: "set", path: "tools.approval", value: { bash: "deny", lsp: "deny" } },
          ],
        },
        failingLookup,
      );

      expect(result.failed?.path).toBe("tools.approval");
      expect(result.appliedPaths).toEqual([]);
      await expect(readFile(join(cwd, ".omp", "config.yml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects stale revisions before running mutations", async () => {
    const { commands, dependencies } = harness();
    const result = await updateOmpSettingsWithDependencies(
      { revision: "stale", changes: [{ operation: "set", path: "personality", value: "x" }] },
      dependencies,
    );

    expect(result.conflict).toBe(true);
    expect(commands.filter(([operation]) => operation !== "list" && operation !== "path")).toEqual(
      [],
    );
  });

  test("reports the first failed change after preserving applied paths", async () => {
    const { dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [
          { operation: "set", path: "personality", value: "concise" },
          { operation: "set", path: "temperature", value: 99 },
        ],
      },
      dependencies,
    );

    expect(result.appliedPaths).toEqual(["personality"]);
    expect(result.failed).toEqual({
      path: "temperature",
      message: "OMP rejected this setting change.",
    });
  });

  test("creates and removes validated workspace overrides without global mutations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    await writeFile(join(cwd, ".omp", "config.yml"), "personality: concise\n");
    const { commands, dependencies } = harness();
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      expect(listed.path).toBe(join(cwd, ".omp", "config.yml"));
      expect(
        listed.settings.find((setting) => setting.path === "personality")?.workspaceOverride,
      ).toBe(true);
      const written = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "retry.enabled", value: false }],
        },
        dependencies,
      );

      expect(written.appliedPaths).toEqual(["retry.enabled"]);
      const writtenText = await readFile(join(cwd, ".omp", "config.yml"), "utf8");
      expect(writtenText).toContain("personality: concise");
      expect(writtenText).toContain("enabled: false");
      expect(
        written.catalog.settings.find((setting) => setting.path === "retry.enabled")
          ?.workspaceOverride,
      ).toBe(true);

      const reset = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: written.catalog.revision ?? "",
          changes: [{ operation: "reset", path: "personality" }],
        },
        dependencies,
      );
      expect(reset.appliedPaths).toEqual(["personality"]);
      expect(await readFile(join(cwd, ".omp", "config.yml"), "utf8")).not.toContain("personality");
      expect(
        commands.filter(([operation]) => operation === "set" || operation === "reset"),
      ).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("writes the whole disabled-agents list to the project file so user entries do not return", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    const { commands, dependencies } = harness();
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const written = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "task.disabledAgents", value: ["scout", "sonic"] }],
        },
        dependencies,
      );
      expect(written.appliedPaths).toEqual(["task.disabledAgents"]);
      const text = await readFile(join(cwd, ".omp", "config.yml"), "utf8");
      expect(text).toContain("disabledAgents");
      expect(text).toContain("scout, sonic");
      expect(text).not.toContain("user-agent");
      expect(commands.filter(([operation]) => operation === "set")).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the project file unchanged when OMP rejects an override", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    const path = join(cwd, ".omp", "config.yml");
    await writeFile(path, "personality: concise\n");
    const { dependencies } = harness();
    dependencies.validateProjectConfig = async () => ({
      outcome: "exited",
      stdout: "",
      truncated: false,
      exitCode: 1,
      signal: null,
      spawnErrorCode: null,
      cleanupFailed: false,
    });
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const result = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "personality", value: "invalid" }],
        },
        dependencies,
      );
      expect(result.failed?.message).toBe("OMP rejected the workspace configuration change.");
      expect(await readFile(path, "utf8")).toBe("personality: concise\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reports a conflict when the project file changes during validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    const path = join(cwd, ".omp", "config.yml");
    await writeFile(path, "personality: concise\n");
    const { dependencies } = harness();
    dependencies.validateProjectConfig = async () => {
      await writeFile(path, "personality: external\n");
      return {
        outcome: "exited",
        stdout: "{}",
        truncated: false,
        exitCode: 0,
        signal: null,
        spawnErrorCode: null,
        cleanupFailed: false,
      };
    };
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const result = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "personality", value: "ours" }],
        },
        dependencies,
      );
      expect(result.conflict).toBe(true);
      expect(await readFile(path, "utf8")).toBe("personality: external\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test.skipIf(process.platform === "win32")(
    "rejects symlinked workspace configuration without replacing it",

    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
      await mkdir(join(cwd, ".omp"), { recursive: true });
      const target = join(cwd, "shared.yml");
      const path = join(cwd, ".omp", "config.yml");
      await writeFile(target, "personality: concise\n");
      await symlink(target, path);
      const { dependencies } = harness();
      try {
        const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
        const result = await updateOmpSettingsWithDependencies(
          {
            cwd,
            revision: listed.revision ?? "",
            changes: [{ operation: "set", path: "personality", value: "other" }],
          },
          dependencies,
        );
        expect(result.failed?.message).toContain("Symlinked workspace OMP configuration");
        expect(await readFile(target, "utf8")).toBe("personality: concise\n");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
