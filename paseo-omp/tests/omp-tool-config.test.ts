import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveReadOmpToolConfig, resolveWriteOmpToolConfig } from "../server/omp-tool-config";
import { validateOmpToolConfig, warnOmpToolConfig } from "../shared/omp-tool-config";

describe("validating lsp.json and dap.json before they are written", () => {
  test("accepts the wrapped and the flat shape OMP reads", () => {
    const server = { command: "my-lsp", fileTypes: [".xyz"], rootMarkers: [".git"] };
    expect(validateOmpToolConfig("lsp", JSON.stringify({ servers: { mine: server } }))).toEqual([]);
    expect(validateOmpToolConfig("lsp", JSON.stringify({ mine: server }))).toEqual([]);
    expect(validateOmpToolConfig("lsp", JSON.stringify({ idleTimeoutMs: 300000 }))).toEqual([]);
    expect(
      validateOmpToolConfig("lsp", JSON.stringify({ servers: { pylsp: { disabled: true } } })),
    ).toEqual([]);
    expect(
      validateOmpToolConfig("dap", JSON.stringify({ adapters: { mine: { command: "dap" } } })),
    ).toEqual([]);
  });

  test("names every value OMP would ignore", () => {
    expect(validateOmpToolConfig("lsp", "{")).toEqual([expect.stringContaining("Not valid JSON")]);
    expect(validateOmpToolConfig("lsp", "[]")).toEqual(["The file must hold a JSON object"]);
    expect(
      validateOmpToolConfig("lsp", JSON.stringify({ servers: { a: { args: "--stdio" } } })),
    ).toEqual([expect.stringContaining("a.args")]);
    expect(
      validateOmpToolConfig("lsp", JSON.stringify({ servers: { a: { resolvedCommand: "x" } } })),
    ).toEqual([expect.stringContaining("owned by OMP")]);
    expect(validateOmpToolConfig("lsp", JSON.stringify({ idleTimeoutMs: "soon" }))).toEqual([
      expect.stringContaining("idleTimeoutMs"),
    ]);
    expect(
      validateOmpToolConfig("dap", JSON.stringify({ adapters: { a: { command: 3 } } })),
    ).toEqual([expect.stringContaining("a.command")]);
    expect(
      validateOmpToolConfig(
        "dap",
        JSON.stringify({ adapters: { a: { command: "d", connectMode: "pipe" } } }),
      ),
    ).toEqual([expect.stringContaining("a.connectMode")]);
  });

  test("accepts a flat dap.json map and a wrapped one with sibling entries", () => {
    expect(validateOmpToolConfig("dap", JSON.stringify({ a: { command: "d" } }))).toEqual([]);
    expect(
      validateOmpToolConfig(
        "dap",
        JSON.stringify({ adapters: { a: { command: "d" } }, b: { command: "e" } }),
      ),
    ).toEqual([]);
  });

  test("rejects a wrapper mixed with flat entries, which OMP silently drops", () => {
    const text = JSON.stringify({ servers: { a: { disabled: true } }, b: { disabled: true } });
    expect(validateOmpToolConfig("lsp", text)).toEqual([expect.stringContaining("Do not mix")]);
  });
});

describe("definitions OMP would drop", () => {
  const warnings = (value: unknown) => warnOmpToolConfig("lsp", JSON.stringify(value));

  test("warns about a new server that lacks what OMP needs, but not about overrides", () => {
    expect(warnings({ servers: { mine: { command: "x" } } })).toEqual([
      expect.stringContaining("mine is not a built-in server"),
    ]);
    expect(warnings({ mine: { disabled: true } })).toHaveLength(1);
    expect(warnings({ servers: { pylsp: { disabled: true } } })).toEqual([]);
    expect(
      warnings({
        servers: { mine: { command: "x", fileTypes: [".x"], rootMarkers: [".git"] } },
      }),
    ).toEqual([]);
    expect(
      warnings({ servers: { mine: { command: "x", extensionToLanguage: { ".x": "x" } } } }),
    ).toEqual([]);
    expect(
      warnOmpToolConfig("dap", JSON.stringify({ adapters: { mine: { command: "d" } } })),
    ).toEqual([]);
    const dap = (value: unknown) => warnOmpToolConfig("dap", JSON.stringify(value));
    expect(dap({ adapters: { gdb: { args: ["-i", "dap"] } } })).toEqual([]);
    expect(dap({ adapters: { gdb: { args: [] } }, mine: { command: "d" } })).toEqual([
      expect.stringContaining("OMP ignores mine because adapters is present"),
    ]);
    expect(dap({ adapters: { mine: { args: ["x"] } } })).toEqual([
      expect.stringContaining("mine is not a built-in adapter"),
    ]);
  });
});

describe("reading and writing lsp.json and dap.json", () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omp-tool-config-"));
    project = join(root, "project");
    await mkdir(project, { recursive: true });
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    for (const name of [
      "PASEO_OMP_AGENT_DIR",
      "OMP_AGENT_DIR",
      "OMP_PROFILE",
      "PI_PROFILE",
      "PI_CONFIG_DIR",
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  test("creates the user file in the agent directory and the project file under .omp", async () => {
    const empty = await resolveReadOmpToolConfig({ kind: "lsp" });
    expect(empty).toMatchObject({ path: join(root, "agent", "lsp.json"), exists: false, text: "" });

    const text = '{ "servers": { "pylsp": { "disabled": true } } }';
    const saved = await resolveWriteOmpToolConfig({ kind: "lsp", revision: empty.revision, text });
    expect(saved).toMatchObject({ outcome: "saved", warnings: [] });
    expect(await readFile(join(root, "agent", "lsp.json"), "utf8")).toBe(`${text}\n`);

    expect((await resolveReadOmpToolConfig({ kind: "lsp" })).revision).toBe(saved.revision);

    const incomplete = await resolveWriteOmpToolConfig({
      kind: "lsp",
      revision: saved.revision,
      text: '{ "servers": { "mine": { "command": "x" } } }',
    });
    expect(incomplete.outcome).toBe("saved");
    expect(incomplete.warnings).toEqual([expect.stringContaining("mine")]);

    const projectEmpty = await resolveReadOmpToolConfig({ kind: "dap", cwd: project });
    const projectSaved = await resolveWriteOmpToolConfig({
      kind: "dap",
      cwd: project,
      revision: projectEmpty.revision,
      text: '{ "adapters": { "a": { "command": "d" } } }',
    });
    expect(projectSaved.outcome).toBe("saved");
    expect((await stat(join(project, ".omp", "dap.json"))).isFile()).toBe(true);
  });

  test("writes nothing when the text is invalid or the file changed since it was read", async () => {
    const path = join(root, "agent", "lsp.json");
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(path, '{ "idleTimeoutMs": 1 }\n');
    const current = await resolveReadOmpToolConfig({ kind: "lsp" });

    const invalid = await resolveWriteOmpToolConfig({
      kind: "lsp",
      revision: current.revision,
      text: '{ "servers": { "a": { "args": 1 } } }',
    });
    expect(invalid.outcome).toBe("invalid");
    expect(invalid.errors).toEqual([expect.stringContaining("a.args")]);

    await writeFile(path, '{ "idleTimeoutMs": 2 }\n');
    const stale = await resolveWriteOmpToolConfig({
      kind: "lsp",
      revision: current.revision,
      text: '{ "idleTimeoutMs": 3 }',
    });
    expect(stale.outcome).toBe("conflict");
    expect(await readFile(path, "utf8")).toBe('{ "idleTimeoutMs": 2 }\n');
  });

  test("refuses an oversized save in bytes and a symlinked project folder", async () => {
    const empty = await resolveReadOmpToolConfig({ kind: "lsp" });
    const multibyte = `{ "servers": { "a": { "settings": { "x": "${"\u00e9".repeat(140_000)}" } } } }`;
    expect(multibyte.length).toBeLessThan(256 * 1024);
    const large = await resolveWriteOmpToolConfig({
      kind: "lsp",
      revision: empty.revision,
      text: multibyte,
    });
    expect(large.outcome).toBe("invalid");

    const real = join(root, "real-omp");
    await mkdir(real, { recursive: true });
    await symlink(real, join(project, ".omp"));
    await expect(resolveReadOmpToolConfig({ kind: "lsp", cwd: project })).rejects.toThrow(
      "symlinked",
    );
    await expect(
      resolveWriteOmpToolConfig({ kind: "lsp", cwd: project, revision: "", text: "{}" }),
    ).rejects.toThrow("symlinked");
  });

  test("lists sibling variants OMP also merges and refuses a symlinked file", async () => {
    await mkdir(join(project, ".omp"), { recursive: true });
    await writeFile(join(project, ".omp", "lsp.yaml"), "servers: {}\n");
    expect((await resolveReadOmpToolConfig({ kind: "lsp", cwd: project })).otherFiles).toEqual([
      "lsp.yaml",
    ]);

    await writeFile(join(root, "elsewhere.json"), "{}");
    await symlink(join(root, "elsewhere.json"), join(project, ".omp", "lsp.json"));
    await expect(resolveReadOmpToolConfig({ kind: "lsp", cwd: project })).rejects.toThrow(
      "symlinked",
    );
  });
});
