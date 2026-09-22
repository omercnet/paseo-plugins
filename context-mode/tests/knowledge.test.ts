import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test } from "vitest";
import { contextModeEnvironmentFor, createContextModeKnowledgeHandlers } from "../server/knowledge";
import { callContextModeTool } from "../server/mcp-process";
import {
  FetchAndIndexInputSchema,
  IndexPathInputSchema,
  KnowledgeToolResultSchema,
  PurgeKnowledgeInputSchema,
  SearchKnowledgeInputSchema,
} from "../shared/knowledge";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  type contextModeSettings,
} from "../shared/settings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function executable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-context-mode-knowledge-"));
  temporaryDirectories.push(directory);
  const path = join(directory, process.platform === "win32" ? "context-mode.cjs" : "context-mode");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

function launch(program: string) {
  return process.platform === "win32"
    ? { program: process.execPath, args: [program] }
    : { program, args: [] };
}

function settingsHandle(
  values: ContextModeSettings,
): PluginSettings<typeof contextModeSettings.schema> {
  return {
    read: async () => ({ status: "ready", revision: "test", values }),
    subscribe: () => () => {},
  };
}

describe("knowledge RPC contracts", () => {
  test("accepts bounded search input and rejects unknown providers or excess results", () => {
    expect(
      SearchKnowledgeInputSchema.parse({
        provider: "codex",
        projectPath: "/repo",
        queries: ["cache invalidation"],
      }),
    ).toEqual({
      provider: "codex",
      projectPath: "/repo",
      queries: ["cache invalidation"],
      limit: 3,
      sort: "relevance",
    });
    expect(
      SearchKnowledgeInputSchema.safeParse({
        provider: "unknown",
        projectPath: "/repo",
        queries: ["cache"],
      }).success,
    ).toBe(false);
    expect(
      SearchKnowledgeInputSchema.safeParse({
        provider: "codex",
        projectPath: "/repo",
        queries: ["cache"],
        limit: 11,
      }).success,
    ).toBe(false);
    expect(
      SearchKnowledgeInputSchema.safeParse({
        provider: "codex",
        projectPath: "/repo",
        queries: ["x".repeat(1_025)],
      }).success,
    ).toBe(false);
  });

  test("bounds returned tool output", () => {
    const result = {
      provider: "codex",
      output: "x".repeat(192 * 1_024),
      completedAt: "2026-09-20T12:00:00.000Z",
    };
    expect(KnowledgeToolResultSchema.safeParse(result).success).toBe(true);
    expect(
      KnowledgeToolResultSchema.safeParse({ ...result, output: `${result.output}x` }).success,
    ).toBe(false);
  });

  test("requires absolute paths and absolute HTTP(S) URLs", () => {
    expect(
      IndexPathInputSchema.safeParse({
        provider: "omp",
        projectPath: "/repo",
        path: "/repo/docs",
      }).success,
    ).toBe(true);
    expect(
      IndexPathInputSchema.safeParse({
        provider: "omp",
        projectPath: "/repo",
        path: "docs/spec.md",
      }).success,
    ).toBe(false);
    expect(
      FetchAndIndexInputSchema.safeParse({
        provider: "claude",
        projectPath: "/repo",
        url: "https://example.com/docs",
      }).success,
    ).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "//example.com/docs"]) {
      expect(
        FetchAndIndexInputSchema.safeParse({ provider: "claude", projectPath: "/repo", url })
          .success,
      ).toBe(false);
    }
  });

  test("purge requires literal confirmation and exactly one explicit scope", () => {
    expect(
      PurgeKnowledgeInputSchema.safeParse({
        provider: "pi",
        projectPath: "/repo",
        confirm: true,
        scope: "project",
      }).success,
    ).toBe(true);
    expect(
      PurgeKnowledgeInputSchema.safeParse({
        provider: "pi",
        projectPath: "/repo",
        confirm: true,
        scope: "session",
        sessionId: "session-1",
      }).success,
    ).toBe(true);
    for (const input of [
      { provider: "pi", projectPath: "/repo", confirm: false, scope: "project" },
      { provider: "pi", projectPath: "/repo", confirm: true },
      { provider: "pi", projectPath: "/repo", confirm: true, scope: "session" },
      {
        provider: "pi",
        projectPath: "/repo",
        confirm: true,
        scope: "project",
        sessionId: "session-1",
      },
    ]) {
      expect(PurgeKnowledgeInputSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("provider storage isolation", () => {
  test("uses separate provider roots instead of a merged store", () => {
    expect(contextModeEnvironmentFor("claude", "/home/test", {})).toEqual({
      CONTEXT_MODE_PLATFORM: "claude-code",
      CONTEXT_MODE_DIR: join("/home/test", ".claude", "context-mode"),
    });
    expect(contextModeEnvironmentFor("omp-plugin", "/home/test", {})).toEqual({
      CONTEXT_MODE_PLATFORM: "omp",
      CONTEXT_MODE_DIR: join("/home/test", ".omp", "context-mode"),
    });
    expect(contextModeEnvironmentFor("cursor", "/home/test", {})).toEqual({
      CONTEXT_MODE_PLATFORM: "cursor",
      CONTEXT_MODE_DIR: join("/home/test", ".cursor", "context-mode"),
    });
    expect(contextModeEnvironmentFor("codex", "/home/test", { CODEX_HOME: "/srv/codex" })).toEqual({
      CONTEXT_MODE_PLATFORM: "codex",
      CONTEXT_MODE_DIR: join("/srv/codex", "context-mode"),
    });
    expect(
      contextModeEnvironmentFor("opencode", "/home/test", {
        CONTEXT_MODE_DATA_DIR: "/srv/context-data",
      }),
    ).toEqual({
      CONTEXT_MODE_PLATFORM: "opencode",
      CONTEXT_MODE_DIR: join(resolve("/srv/context-data"), "context-mode"),
    });
  });
});

describe("knowledge handlers", () => {
  test("sends typed arguments and provider scope through MCP", async () => {
    const calls: Array<{
      name: string;
      arguments_: unknown;
      platform: string | undefined;
      cwd: string | undefined;
      strictFetch: string | undefined;
    }> = [];
    const settings = ContextModeSettingsSchema.parse({});
    const handlers = createContextModeKnowledgeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T12:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: { program: "/bin/context-mode", args: [] },
      }),
      callTool: async (_launch, name, arguments_, dependencies) => {
        calls.push({
          name,
          arguments_,
          platform: dependencies.env?.CONTEXT_MODE_PLATFORM,
          cwd: dependencies.cwd,
          strictFetch: dependencies.env?.CTX_FETCH_STRICT,
        });
        return "indexed";
      },
    });

    await handlers.search({
      provider: "codex",
      projectPath: "/repo",
      queries: ["cache invalidation"],
      limit: 3,
      sort: "relevance",
    });

    await expect(
      handlers.indexPath({
        provider: "copilot",
        projectPath: "/repo",
        path: "/repo/docs",
        source: "docs",
        maxFiles: 50,
      }),
    ).resolves.toEqual({
      provider: "copilot",
      output: "indexed",
      completedAt: "2026-09-20T12:00:00.000Z",
    });
    await handlers.fetchAndIndex({
      provider: "pi",
      projectPath: "/repo",
      url: "https://example.com/docs",
      source: "web-docs",
      force: false,
    });
    await handlers.purge({
      provider: "omp",
      projectPath: "/repo",
      confirm: true,
      scope: "project",
    });
    expect(calls).toEqual([
      {
        name: "ctx_search",
        arguments_: { queries: ["cache invalidation"], limit: 3, sort: "relevance" },
        platform: "codex",
        cwd: "/repo",
        strictFetch: undefined,
      },
      {
        name: "ctx_index",
        arguments_: { path: "/repo/docs", source: "docs", maxFiles: 50 },
        platform: "copilot-cli",
        cwd: "/repo",
        strictFetch: undefined,
      },
      {
        name: "ctx_fetch_and_index",
        arguments_: {
          url: "https://example.com/docs",
          source: "web-docs",
          force: false,
        },
        platform: "pi",
        cwd: "/repo",
        strictFetch: "1",
      },
      {
        name: "ctx_purge",
        arguments_: { confirm: true, scope: "project" },
        platform: "omp",
        cwd: "/repo",
        strictFetch: undefined,
      },
    ]);
  });

  test("guards purge again at the handler boundary", async () => {
    let calls = 0;
    const handlers = createContextModeKnowledgeHandlers(
      settingsHandle(ContextModeSettingsSchema.parse({})),
      {
        resolveBinary: async () => ({
          state: "found",
          path: "/bin/context-mode",
          source: "path",
          launch: { program: "/bin/context-mode", args: [] },
        }),
        callTool: async () => {
          calls += 1;
          return "purged";
        },
      },
    );
    await expect(
      handlers.purge({ provider: "codex", confirm: false, scope: "project" } as never),
    ).rejects.toThrow("exact confirmation");
    await expect(
      handlers.purge({
        provider: "codex",
        confirm: true,
        scope: "project",
        sessionId: "ambiguous",
      } as never),
    ).rejects.toThrow("exactly one scope");
    expect(calls).toBe(0);
  });

  test("serializes typed tool arguments into tools/call", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "1.0.169" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(request.params) }] } }));
});
`);
    const output = await callContextModeTool(launch(binary), "ctx_search", {
      queries: ["alpha", "beta"],
      limit: 4,
    });
    expect(JSON.parse(output)).toEqual({
      name: "ctx_search",
      arguments: { queries: ["alpha", "beta"], limit: 4 },
    });
  });
});
