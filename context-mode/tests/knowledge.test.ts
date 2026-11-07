import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test } from "vitest";
import { createContextModeKnowledgeHandlers } from "../server/knowledge";
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

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-context-mode-knowledge-")));
  temporaryDirectories.push(directory);
  return directory;
}

/** A stdio MCP server exposing the 9 v2 tools; every call echoes what it received. */
const FAKE_SERVER = `
const readline = require("node:readline");
const tools = ["ctx_execute", "ctx_batch", "ctx_index", "ctx_search", "ctx_resume", "ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge"];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  if (request.method === "initialize") {
    reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "context-mode", version: "dev" } });
  } else if (request.method === "tools/list") {
    reply({ tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
  } else if (request.method === "tools/call") {
    const text = JSON.stringify({
      name: request.params.name,
      arguments: request.params.arguments,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      dataDir: process.env.CONTEXT_MODE_DATA_DIR,
    });
    reply({ content: [{ type: "text", text }] });
  }
});
`;

async function fakeContextMode() {
  const directory = await temporaryDirectory();
  const path = join(directory, process.platform === "win32" ? "context-mode.cjs" : "context-mode");
  await writeFile(path, `#!/usr/bin/env node\n${FAKE_SERVER}\n`);
  if (process.platform !== "win32") await chmod(path, 0o755);
  const launch =
    process.platform === "win32"
      ? { program: process.execPath, args: [path] }
      : { program: path, args: [] };
  return { state: "found" as const, path, source: "settings" as const, launch };
}

function settingsHandle(
  values: ContextModeSettings = ContextModeSettingsSchema.parse({}),
): PluginSettings<typeof contextModeSettings.schema> {
  return {
    read: async () => ({ status: "ready", revision: "test", values }),
    subscribe: () => () => {},
  };
}

const found = {
  state: "found" as const,
  path: "/bin/context-mode",
  source: "settings" as const,
  launch: { program: "/bin/context-mode", args: [] },
};

describe("knowledge RPC contracts", () => {
  test("search defaults to the worktree scope and rejects v1-only fields", () => {
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
      scope: "worktree",
      sort: "relevance",
    });
    const base = { provider: "codex", projectPath: "/repo", queries: ["cache"] };
    // "session" is unsearchable: every panel call runs in a fresh Context Mode session.
    for (const extra of [
      { limit: 3 },
      { contentType: "code" },
      { scope: "all" },
      { scope: "session" },
    ]) {
      expect(SearchKnowledgeInputSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    for (const provider of ["", "  ", "x".repeat(129)]) {
      expect(SearchKnowledgeInputSchema.safeParse({ ...base, provider }).success).toBe(false);
    }
    expect(SearchKnowledgeInputSchema.parse({ ...base, provider: " claude-work " }).provider).toBe(
      "claude-work",
    );
    expect(
      SearchKnowledgeInputSchema.safeParse({ ...base, queries: ["x".repeat(1_025)] }).success,
    ).toBe(false);
  });

  test("search pages are one cursor, offset or after", () => {
    const base = { provider: "codex", projectPath: "/repo", queries: ["cache"] };
    for (const page of [{ offset: 4 }, { after: 1793966330248 }]) {
      expect(SearchKnowledgeInputSchema.safeParse({ ...base, page }).success).toBe(true);
    }
    for (const page of [{ offset: 4, after: 5 }, { offset: -1 }, { offset: 1.5 }, {}]) {
      expect(SearchKnowledgeInputSchema.safeParse({ ...base, page }).success).toBe(false);
    }
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

  test("requires absolute paths and HTTP(S) URLs, and takes no source label or index options", () => {
    const scope = { provider: "claude", projectPath: "/repo" };
    expect(IndexPathInputSchema.safeParse({ ...scope, path: "/repo/docs" }).success).toBe(true);
    expect(IndexPathInputSchema.safeParse({ ...scope, path: "docs/spec.md" }).success).toBe(false);
    for (const extra of [{ maxFiles: 5 }, { source: "docs" }]) {
      expect(
        IndexPathInputSchema.safeParse({ ...scope, path: "/repo/docs", ...extra }).success,
      ).toBe(false);
    }
    expect(
      FetchAndIndexInputSchema.safeParse({ ...scope, url: "https://example.com/docs" }).success,
    ).toBe(true);
    for (const extra of [{ force: true }, { source: "docs" }]) {
      expect(
        FetchAndIndexInputSchema.safeParse({ ...scope, url: "https://example.com", ...extra })
          .success,
      ).toBe(false);
    }
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "//example.com/docs"]) {
      expect(FetchAndIndexInputSchema.safeParse({ ...scope, url }).success).toBe(false);
    }
  });

  test("purge requires literal confirmation and exactly one explicit scope", () => {
    const base = { provider: "codex", projectPath: "/repo", confirm: true };
    for (const input of [
      { ...base, scope: "project" },
      { ...base, scope: "session", sessionId: "session-1" },
      { ...base, scope: "source", source: "docs/notes.md" },
    ]) {
      expect(PurgeKnowledgeInputSchema.safeParse(input).success).toBe(true);
    }
    for (const input of [
      { ...base, confirm: false, scope: "project" },
      { ...base },
      { ...base, scope: "session" },
      { ...base, scope: "source", source: " " },
      { ...base, scope: "project", sessionId: "session-1" },
      { ...base, scope: "session", sessionId: "session-1", source: "docs" },
    ]) {
      expect(PurgeKnowledgeInputSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("knowledge handlers", () => {
  test("calls the v2 tools with exact arguments, agent id, project cwd and data dir", async () => {
    const projectPath = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const binary = await fakeContextMode();
    const handlers = createContextModeKnowledgeHandlers(settingsHandle(), {
      env: { CONTEXT_MODE_DATA_DIR: dataDir },
      resolveBinary: async () => binary,
    });
    const received = async (result: Promise<{ provider: string; output: string }>) =>
      JSON.parse((await result).output);

    const calls = [
      await received(
        handlers.search({
          provider: "codex",
          projectPath,
          queries: ["cache invalidation"],
          scope: "project",
          source: "docs",
          sort: "timeline",
          page: { after: 1793966330248 },
        }),
      ),
      await received(
        handlers.indexPath({
          provider: "copilot",
          projectPath,
          path: join(projectPath, "docs"),
        }),
      ),
      await received(
        handlers.fetchAndIndex({
          provider: "opencode",
          projectPath,
          url: "https://example.com/docs",
        }),
      ),
      await received(
        handlers.resume({ provider: "codex", projectPath, sessionId: "mcp:session-1" }),
      ),
      await received(
        handlers.purge({ provider: "claude", projectPath, confirm: true, scope: "project" }),
      ),
      await received(
        handlers.purge({
          provider: "claude",
          projectPath,
          confirm: true,
          scope: "session",
          sessionId: "mcp:session-1",
        }),
      ),
      await received(
        handlers.purge({
          provider: "claude",
          projectPath,
          confirm: true,
          scope: "source",
          source: "docs/notes.md",
        }),
      ),
    ];
    const expected = (name: string, arguments_: unknown, agent: string) => ({
      name,
      arguments: arguments_,
      argv: ["server", "--agent", agent],
      cwd: projectPath,
      dataDir,
    });
    expect(calls).toEqual([
      expected(
        "ctx_search",
        {
          queries: ["cache invalidation"],
          scope: "project",
          source: "docs",
          sort: "timeline",
          after: 1793966330248,
        },
        "codex",
      ),
      expected("ctx_index", { path: join(projectPath, "docs") }, "copilot-cli"),
      expected("ctx_index", { url: "https://example.com/docs" }, "opencode"),
      expected("ctx_resume", { session: "mcp:session-1" }, "codex"),
      expected("ctx_purge", { project: true }, "claude-code"),
      expected("ctx_purge", { session: "mcp:session-1" }, "claude-code"),
      expected("ctx_purge", { source: "docs/notes.md" }, "claude-code"),
    ]);
  });

  test("uses the real user data dir by default, never the probe store", async () => {
    const options: unknown[] = [];
    const handlers = createContextModeKnowledgeHandlers(settingsHandle(), {
      now: () => new Date("2026-09-20T12:00:00.000Z"),
      env: {},
      home: "/home/test",
      resolveBinary: async () => found,
      callTool: async (_launch, _name, _arguments, _dependencies, callOptions) => {
        options.push(callOptions);
        return "ok";
      },
    });
    await expect(
      handlers.search({
        provider: "claude",
        projectPath: "/repo",
        queries: ["q"],
        scope: "worktree",
        sort: "relevance",
      }),
    ).resolves.toEqual({
      provider: "claude",
      output: "ok",
      completedAt: "2026-09-20T12:00:00.000Z",
      next: null,
    });
    expect(options).toEqual([
      { platform: "claude-code", cwd: "/repo", dataDir: join("/home/test", ".context-mode") },
    ]);
  });

  test("returns the cursor of the next search page from the reply footer", async () => {
    const replies = [
      'Query "q":\na #0: x\nMore: ctx_search({queries:["q"], scope:"worktree", offset:4})',
      'Query "q":\na #0: x\nmore: ctx_search({queries:["q"], scope:"worktree", sort:"timeline", after:1793966330248})',
      'Query "q":\na #0: x',
    ];
    const handlers = createContextModeKnowledgeHandlers(settingsHandle(), {
      resolveBinary: async () => found,
      callTool: async () => replies.shift() ?? "",
    });
    const input = {
      provider: "codex",
      projectPath: "/repo",
      queries: ["q"],
      scope: "worktree" as const,
      sort: "relevance" as const,
    };
    const cursors = [
      (await handlers.search(input)).next,
      (await handlers.search(input)).next,
      (await handlers.search(input)).next,
    ];
    expect(cursors).toEqual([{ offset: 4 }, { after: 1793966330248 }, null]);
  });

  test("maps configured providers through extends and rejects unsupported ids", async () => {
    const options: unknown[] = [];
    const handlers = createContextModeKnowledgeHandlers(settingsHandle(), {
      env: {},
      home: "/home/test",
      resolveBinary: async () => found,
      callTool: async (_launch, _name, _arguments, _dependencies, callOptions) => {
        options.push(callOptions);
        return "ok";
      },
    });
    const paseo = {
      config: {
        get: async () => ({
          config: {
            providers: {
              "claude-work": {
                extends: "claude",
                env: { CONTEXT_MODE_DATA_DIR: "/srv/context-work" },
              },
              "cursor-work": { extends: "cursor" },
            },
          },
        }),
      },
    };
    const search = {
      projectPath: "/repo",
      queries: ["q"],
      scope: "worktree" as const,
      sort: "relevance" as const,
    };

    await expect(
      handlers.search({ provider: "claude-work", ...search }, { paseo }),
    ).resolves.toMatchObject({ provider: "claude-work" });
    expect(options).toEqual([
      { platform: "claude-code", cwd: "/repo", dataDir: "/srv/context-work" },
    ]);
    for (const provider of ["cursor", "pi", "omp", "omp-plugin", "cursor-work"]) {
      await expect(handlers.search({ provider, ...search }, { paseo })).rejects.toThrow(
        `does not support provider ${provider}`,
      );
    }
    await expect(handlers.search({ provider: "claude-work", ...search })).rejects.toThrow(
      "does not support provider claude-work",
    );
    expect(options).toHaveLength(1);
  });
});
