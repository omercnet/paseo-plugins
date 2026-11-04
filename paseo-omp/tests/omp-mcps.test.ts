import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  callbackUrl,
  OmpMcps,
  parseMcpList,
  readAuthOutput,
  readConnectionCheck,
  reportsFailure,
} from "../server/omp-mcps";
import { OmpMcpNameSchema, OmpMcpTargetSchema } from "../shared/omp-mcps";

// The fake omp is a shebang script, which Windows cannot run as `omp`; the pure rules below stay
// covered everywhere.
const ON_WINDOWS = process.platform === "win32";

// What omp 18.13.1 prints for `/mcp reauth` in rpc mode, in order.
const AUTH_URL =
  "https://auth.example.test/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&state=s3cret";
const AUTH_BLOCK = `\u2501\u2501\u2501 OAuth Authorization Required \u2501\u2501\u2501\nOpening your browser to authorize. If it did not open:\n${AUTH_URL}\n\nEnter code ABCD`;

describe("reading omp's printed text", () => {
  test("lists one server per line and skips anything else", () => {
    const text = [
      "docs | http | enabled | https://mcp.example.test [user]",
      "context | stdio | disabled | node [project]",
      "something omp printed that is not a server",
    ].join("\n");

    expect(parseMcpList(text)).toEqual([
      {
        name: "docs",
        transport: "http",
        state: "enabled",
        target: "https://mcp.example.test",
        source: "user",
      },
      { name: "context", transport: "stdio", state: "disabled", target: "node", source: "project" },
    ]);
  });

  test("a server with a space in its name is still listed", () => {
    const rows = parseMcpList(
      "docs | http | enabled | https://a.test [user]\nteam docs | http | enabled | https://b.test/team [user]",
    );
    expect(rows.map((row) => row.name)).toEqual(["docs", "team docs"]);
  });

  test("a name that could be read as a flag is listed but never acted on", () => {
    const [row] = parseMcpList("--scope | http | enabled | https://x.test [user]");
    expect(row?.name).toBe("--scope");
    expect(OmpMcpNameSchema.safeParse("--scope").success).toBe(false);
    expect(OmpMcpNameSchema.safeParse("team docs").success).toBe(false);
  });

  test("a failure is read from the words omp uses, never from a quoted server name", () => {
    expect(reportsFailure('Failed to add server: Server "a" already exists')).toBe(true);
    expect(reportsFailure('Connection to "a" failed: HTTP 401')).toBe(true);
    expect(reportsFailure('Server "a" not found in user or project config.')).toBe(true);
    expect(reportsFailure("Unknown option: name")).toBe(true);
    expect(reportsFailure('Server "failed-server" disabled (user config).')).toBe(false);
    expect(reportsFailure('Added MCP server "invalid-looking" (user).')).toBe(false);
  });

  test("a reauth omp refuses to start ends the command instead of hanging", () => {
    const disabled = 'Server "docs" is disabled. Run /mcp enable docs first.';
    const noAuth = "Server connection succeeded without OAuth; reauthorization is not required.";
    expect(readAuthOutput(disabled).kind).toBe("failed");
    expect(readAuthOutput(noAuth).kind).toBe("failed");
    expect(readAuthOutput("Exchanging authorization code for tokens...").kind).toBe("progress");
  });

  test("a test's tool names are not read as a failure", () => {
    expect(readConnectionCheck('Server "docs" connected (1 tools).\n  - invalid')).toBe(
      "connected",
    );
    expect(readConnectionCheck('Server "docs" connected (2 tools).\n  - failed\n  - failure')).toBe(
      "connected",
    );
  });

  test("the sign-in page and its hint come out of the authorization block", () => {
    expect(readAuthOutput(AUTH_BLOCK)).toEqual({
      kind: "url",
      url: AUTH_URL,
      instructions: "Enter code ABCD",
    });
  });

  test("the first progress lines do not end an authorization", () => {
    expect(readAuthOutput('Reauthorizing "a"... opening your browser (5 minute timeout).')).toEqual(
      {
        kind: "progress",
      },
    );
    expect(readAuthOutput("Waiting for browser authentication...")).toEqual({ kind: "progress" });
  });

  test("success, failure and cancellation end it", () => {
    expect(readAuthOutput('\u2713 Reauthorized "a" (user config). Server reconnected.').kind).toBe(
      "done",
    );
    expect(readAuthOutput('Failed to reauthorize server "a": denied').kind).toBe("failed");
    expect(readAuthOutput('Reauthorization cancelled for "a".').kind).toBe("failed");
  });

  test("a server whose name contains a failure word does not end its own sign-in", () => {
    for (const name of ["cancel-tools", "failed-server", "invalid-looking"]) {
      const progress = `Reauthorizing "${name}"\u2026 opening your browser (5 minute timeout).`;
      expect(readAuthOutput(progress).kind).toBe("progress");
    }
  });
});

describe("a new server's connection check", () => {
  // Each text is what omp 18.13.1 printed for `/mcp test` against that kind of address.
  test("an address nothing answers on is a failure", () => {
    const failures = [
      'Connection to "a" failed: ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
      'Connection to "a" failed: getaddrinfo ENOTFOUND no-such-host.invalid',
      'Connection to "a" failed: HTTP 404: nope',
      `Connection to "a" failed: JSON Parse error: Unrecognized token '<'`,
      "",
    ];
    for (const text of failures) expect(readConnectionCheck(text)).toBe("failed");
  });

  test("a 401 means a server that wants a sign-in, not a broken one", () => {
    const text =
      'Connection to "a" failed: HTTP 401: Missing Authorization header\n [WWW-Authenticate: Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"]';
    expect(readConnectionCheck(text)).toBe("needs-authorization");
  });

  test("a server that connects passes", () => {
    expect(readConnectionCheck('Server "a" connected (3 tools).')).toBe("connected");
  });
});

describe("the callback omp is asked for", () => {
  test("a pasted redirect URL is handed over as it is", () => {
    const pasted = "http://localhost:3000/callback?code=abc&state=s3cret";
    expect(callbackUrl(AUTH_URL, pasted)?.href).toBe(pasted);
  });

  test("a bare code is sent with the state omp's page address carries", () => {
    const target = callbackUrl(AUTH_URL, " abc ");
    expect(target?.href).toBe("http://localhost:3000/callback?code=abc&state=s3cret");
  });

  test("a pasted address for another host, port or path is refused", () => {
    expect(callbackUrl(AUTH_URL, "http://evil.test/callback?code=abc")).toBeNull();
    expect(callbackUrl(AUTH_URL, "http://localhost:4000/callback?code=abc")).toBeNull();
    expect(callbackUrl(AUTH_URL, "http://localhost:3000/admin?code=abc")).toBeNull();
  });

  test("a page address whose redirect leaves this machine is never called", () => {
    const remote = AUTH_URL.replace("localhost%3A3000", "evil.test");
    expect(callbackUrl(remote, "abc")).toBeNull();
    expect(callbackUrl(remote, "http://evil.test/callback?code=abc")).toBeNull();
  });
});

describe("a server to add", () => {
  test("a URL cannot carry extra flags", () => {
    expect(OmpMcpTargetSchema.safeParse("https://mcp.example.test/mcp").success).toBe(true);
    expect(OmpMcpTargetSchema.safeParse("https://x.test --scope project").success).toBe(false);
  });

  test("a URL with a quote is refused rather than stored altered, but a command may quote", () => {
    expect(OmpMcpTargetSchema.safeParse("https://x.test/mcp?tenant=o'brien").success).toBe(false);
    expect(OmpMcpTargetSchema.safeParse("https://x.test/mcp?tenant=o%27brien").success).toBe(true);
    expect(OmpMcpTargetSchema.safeParse('node "my server.js"').success).toBe(true);
  });

  test("a command line is one line", () => {
    expect(OmpMcpTargetSchema.safeParse("npx -y some-server").success).toBe(true);
    expect(OmpMcpTargetSchema.safeParse("node a.js\n/mcp remove b").success).toBe(false);
  });
});

interface Scenario {
  servers: { name: string; transport: string; enabled: boolean; target: string }[];
  /** `/mcp list` prints this instead of the servers. */
  listRaw?: string;
  /** omp exits right after printing the sign-in page. */
  crashAfterUrl?: boolean;
  /** What `/mcp test <name>` prints; a server not listed here connects. */
  tests?: Record<string, string>;
  /** `/mcp list` reads the servers, writes this file, then waits before it prints. */
  slowList?: string;
  /** The sign-in callback answers with a redirect to this address. */
  redirectTo?: string;
  /** `/mcp test` kills omp before it answers. */
  crashOnTest?: boolean;
  /** Enable and disable log a `done` line and answer only after a delay. */
  slowMutation?: boolean;
  /** Every slash command is appended here, one per line. */
  logFile: string;
  stateFile: string;
  /** Where the fake writes its pid when it starts an authorization. */
  pidFile: string;
}

/** A scripted `omp --mode rpc` with the output shapes of `/mcp` and a real loopback callback. */
function fakeOmp(scenario: Scenario): string {
  return `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const http = require("node:http");
const S = ${JSON.stringify(scenario)};
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("omp/fake"); process.exit(0); }
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const out = (text) => print({ type: "command_output", text });
const state = () => JSON.parse(fs.readFileSync(S.stateFile, "utf8"));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  fs.appendFileSync(S.logFile, request.message + "\\n");
  const tokens = request.message.split(" ");
  const sub = tokens[1];
  const name = tokens[2];
  const ack = () => print({ type: "response", id: request.id, success: true, data: { agentInvoked: false } });
  const servers = state();
  if (sub === "list") {
    const text = S.listRaw !== undefined ? S.listRaw : servers.length === 0 ? "No MCP servers configured." : servers.map((s) => s.name + " | " + s.transport + " | " + (s.enabled ? "enabled" : "disabled") + " | " + s.target + " [user]").join("\\n");
    const answer = () => { out(text); ack(); };
    if (S.slowList) { fs.writeFileSync(S.slowList, "read"); setTimeout(answer, 1500); } else answer();
    return;
  }
  if (sub === "add") {
    if (servers.some((s) => s.name === name)) { out('Failed to add server: Server "' + name + '" already exists'); return ack(); }
    const url = tokens.indexOf("--url");
    const command = tokens.indexOf("--");
    servers.push(url > 0 ? { name, transport: "http", enabled: true, target: tokens[url + 1] } : { name, transport: "stdio", enabled: true, target: tokens.slice(command + 1).join(" ") });
    fs.writeFileSync(S.stateFile, JSON.stringify(servers));
    out('Added MCP server "' + name + '" (user).');
    return ack();
  }
  if (sub === "test") {
    if (S.crashOnTest) process.exit(1);
    out(S.tests && S.tests[name] !== undefined ? S.tests[name] : 'Server "' + name + '" connected (0 tools).');
    return ack();
  }
  if (sub === "remove") {
    fs.writeFileSync(S.stateFile, JSON.stringify(servers.filter((s) => s.name !== name)));
    out('Removed server "' + name + '" from user config.');
    return ack();
  }
  if (sub === "enable" || sub === "disable") {
    const apply = () => {
      fs.writeFileSync(S.stateFile, JSON.stringify(servers.map((s) => s.name === name ? { ...s, enabled: sub === "enable" } : s)));
      if (S.slowMutation) fs.appendFileSync(S.logFile, "done " + request.message + "\\n");
      out('Server "' + name + '" ' + sub + "d.");
      ack();
    };
    if (S.slowMutation) setTimeout(apply, 800); else apply();
    return;
  }
  if (sub === "reauth") {
    ack();
    out('Reauthorizing "' + name + '"... opening your browser (5 minute timeout).');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (S.redirectTo) { res.writeHead(302, { location: S.redirectTo }); res.end(); return; }
      if (url.searchParams.get("code") === "good" && url.searchParams.get("state") === "s3cret") {
        res.writeHead(200); res.end("ok");
        out('\\u2713 Reauthorized "' + name + '" (user config). Server reconnected.');
      } else { res.writeHead(500); res.end("bad"); }
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(S.pidFile, String(process.pid));
      const redirect = encodeURIComponent("http://127.0.0.1:" + server.address().port + "/callback");
      out("\\u2501\\u2501\\u2501 OAuth Authorization Required \\u2501\\u2501\\u2501\\nOpening your browser to authorize. If it did not open:\\nhttps://auth.example.test/authorize?redirect_uri=" + redirect + "&state=s3cret\\n\\nEnter code ABCD");
      out("Waiting for browser authentication...");
      if (S.crashAfterUrl) setTimeout(() => process.exit(1), 100);
    });
  }
});
`;
}

let directory: string;
let logFile: string;
let stateFile: string;
let pidFile: string;
let previousCommand: string | undefined;
const created: OmpMcps[] = [];

async function install(overrides: Partial<Scenario> = {}): Promise<OmpMcps> {
  const script = join(directory, "omp");
  const scenario: Scenario = { servers: [], logFile, stateFile, pidFile, ...overrides };
  await writeFile(stateFile, JSON.stringify(scenario.servers));
  await writeFile(script, fakeOmp(scenario));
  await chmod(script, 0o755);
  process.env.OMP_COMMAND = script;
  const mcps = new OmpMcps();
  created.push(mcps);
  return mcps;
}

async function calls(): Promise<string[]> {
  const text = await readFile(logFile, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

// An authorization is driven by a real child process's output and `OmpMcps` exposes no event for
// it, so fake timers cannot advance it; polling the observable state is the only signal.
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 25);
    await tick.promise;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-omp-mcps-"));
  logFile = join(directory, "calls.log");
  stateFile = join(directory, "servers.json");
  pidFile = join(directory, "auth.pid");
  previousCommand = process.env.OMP_COMMAND;
});

afterEach(async () => {
  for (const mcps of created.splice(0)) mcps.stop();
  if (previousCommand === undefined) delete process.env.OMP_COMMAND;
  else process.env.OMP_COMMAND = previousCommand;
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(ON_WINDOWS)("servers", () => {
  const docs = { name: "docs", transport: "http", enabled: true, target: "https://docs.test" };

  test("lists what omp prints, and says so when omp is missing or unreadable", async () => {
    const mcps = await install({ servers: [docs] });
    expect(await mcps.list(undefined, false)).toMatchObject({
      installed: true,
      servers: [{ name: "docs", transport: "http", state: "enabled", source: "user" }],
      error: null,
    });

    const empty = await install();
    expect(await empty.list(undefined, false)).toMatchObject({ servers: [], error: null });

    const unreadable = await install({ listRaw: "MCP v2 table\n=== nothing ===" });
    const view = await unreadable.list(undefined, false);
    expect(view.servers).toEqual([]);
    expect(view.error).toContain("not in a format");

    process.env.OMP_COMMAND = join(directory, "does-not-exist");
    expect(await new OmpMcps().list(undefined, false)).toMatchObject({
      installed: false,
      servers: [],
    });
  });

  test("a second read reuses the listing until it is refreshed or a change is made", async () => {
    const mcps = await install({ servers: [docs] });
    await mcps.list(undefined, false);
    await mcps.list(undefined, false);
    expect(await calls()).toEqual(["/mcp list"]);

    await mcps.list(undefined, true);
    expect(await calls()).toEqual(["/mcp list", "/mcp list"]);

    await mcps.run(undefined, "docs", "disable");
    const view = await mcps.list(undefined, false);
    expect(view.servers[0]?.state).toBe("disabled");
  });

  test("adds a remote server by URL and a local one by command, in the user file", async () => {
    const mcps = await install();
    expect(await mcps.add("docs", "https://docs.test/mcp")).toMatchObject({ ok: true });
    expect(await mcps.add("local", "node server.js --port 1")).toMatchObject({ ok: true });

    expect(await calls()).toEqual([
      "/mcp add docs --scope user --url https://docs.test/mcp",
      "/mcp test docs",
      "/mcp add local --scope user -- node server.js --port 1",
      "/mcp test local",
    ]);
    const view = await mcps.list(undefined, false);
    expect(view.servers.map((server) => [server.name, server.transport, server.target])).toEqual([
      ["docs", "http", "https://docs.test/mcp"],
      ["local", "stdio", "node server.js --port 1"],
    ]);
  });

  test("a new server that answers is reported as connected", async () => {
    const mcps = await install();
    const result = await mcps.add("docs", "https://docs.test/mcp");
    expect(result).toMatchObject({ ok: true, check: "connected" });
    expect(result.message).toContain("connected");
  });

  test("an address that is not an MCP server is still added, with a warning to check it", async () => {
    const refused = 'Connection to "typo" failed: ECONNREFUSED: Unable to connect.';
    const mcps = await install({ tests: { typo: refused } });

    const result = await mcps.add("typo", "https://typo.test/mcp");

    expect(result).toMatchObject({ ok: true, check: "failed" });
    expect(result.message).toContain("Check the address");
    expect(result.message).toContain("ECONNREFUSED");
    expect((await mcps.list(undefined, false)).servers.map((server) => server.name)).toEqual([
      "typo",
    ]);
  });

  test("a server that wants a sign-in is pointed at Authorize, not called broken", async () => {
    const unauthorized =
      'Connection to "docs" failed: HTTP 401: Missing Authorization header\n [WWW-Authenticate: Bearer]';
    const mcps = await install({ tests: { docs: unauthorized } });

    const result = await mcps.add("docs", "https://docs.test/mcp");

    expect(result).toMatchObject({ ok: true, check: "needs-authorization" });
    expect(result.message).toContain("Authorize");
    expect(result.message).not.toContain("Check the address");
  });

  test("a refused add reports omp's reason and tests nothing", async () => {
    const mcps = await install({ servers: [docs] });
    const result = await mcps.add("docs", "https://other.test");
    expect(result).toMatchObject({ ok: false, check: null });
    expect(result.message).toContain("already exists");
    expect((await calls()).some((call) => call.startsWith("/mcp test"))).toBe(false);
  });

  test("removal stays in the user file and the listing follows", async () => {
    const mcps = await install({ servers: [docs] });
    expect(await mcps.run(undefined, "docs", "remove")).toMatchObject({ ok: true });
    expect(await calls()).toEqual(["/mcp remove docs --scope user"]);
    expect((await mcps.list(undefined, false)).servers).toEqual([]);
  });

  test("a server with a space in its name is still listed by the plugin", async () => {
    const spaced = {
      name: "team docs",
      transport: "http",
      enabled: true,
      target: "https://t.test",
    };
    const mcps = await install({ servers: [docs, spaced] });
    const view = await mcps.list(undefined, false);
    expect(view.servers.map((server) => server.name)).toEqual(["docs", "team docs"]);
  });

  test("tool names that look like failures do not fail a test or an add that connected", async () => {
    const listing = 'Server "x" connected (2 tools).\n  - invalid\n  - failed';
    const mcps = await install({ servers: [docs], tests: { docs: listing, other: listing } });
    expect(await mcps.run(undefined, "docs", "test")).toMatchObject({ ok: true });
    expect(await mcps.add("other", "https://other.test")).toMatchObject({
      ok: true,
      check: "connected",
    });
  });

  test("a listing that began before a change is not kept after it", async () => {
    const marker = join(directory, "listing-read");
    const mcps = await install({ servers: [docs], slowList: marker });
    const stale = mcps.list(undefined, true);
    await until(
      () =>
        readFile(marker, "utf8").then(
          () => true,
          () => false,
        ),
      (read) => read,
    );

    await mcps.run(undefined, "docs", "disable");
    await stale;

    expect((await mcps.list(undefined, false)).servers[0]?.state).toBe("disabled");
  });
});

describe.skipIf(ON_WINDOWS)("authorization", () => {
  const docs = { name: "docs", transport: "http", enabled: true, target: "https://docs.test" };

  async function begin(mcps: OmpMcps) {
    const started = await mcps.startAuth(undefined, "docs");
    const waiting = await until(
      async () => (await mcps.list(undefined, false)).auths.find((a) => a.id === started.id),
      (auth) => auth?.step !== "starting",
    );
    return { id: started.id, waiting };
  }

  async function step(mcps: OmpMcps, id: string) {
    return (await mcps.list(undefined, false)).auths.find((auth) => auth.id === id);
  }

  test("waits on the sign-in page instead of finishing at the first line omp prints", async () => {
    const mcps = await install({ servers: [docs] });
    const { waiting } = await begin(mcps);

    expect(waiting).toMatchObject({
      step: "waiting",
      name: "docs",
      instructions: "Enter code ABCD",
    });
    expect(waiting?.url).toContain("https://auth.example.test/authorize");
    expect(waiting?.codePrompt).not.toBeNull();
  });

  test("a pasted redirect URL reaches omp's callback and finishes the sign-in", async () => {
    const mcps = await install({ servers: [docs] });
    const { id, waiting } = await begin(mcps);
    const callback = new URL(new URL(waiting?.url ?? "").searchParams.get("redirect_uri") ?? "");

    await mcps.submitCode(id, `${callback.origin}/callback?code=good&state=s3cret`);
    const done = await until(
      () => step(mcps, id),
      (auth) => auth?.step === "done",
    );

    expect(done).toMatchObject({ step: "done", url: waiting?.url });
    expect(done?.message).toContain("Reauthorized");
    const pid = Number(await readFile(pidFile, "utf8"));
    await until(
      () => alive(pid),
      (running) => !running,
    );
    expect(alive(pid)).toBe(false);
  });

  test("a bare code finishes it too", async () => {
    const mcps = await install({ servers: [docs] });
    const { id } = await begin(mcps);

    await mcps.submitCode(id, "good");
    const done = await until(
      () => step(mcps, id),
      (auth) => auth?.step === "done",
    );
    expect(done?.step).toBe("done");
  });

  test("a saved login on a server that still fails its test is said plainly, not as signed in", async () => {
    const gateway =
      'Connection to "docs" failed: HTTP 403: {"message":"Missing Authentication Token"}';
    const mcps = await install({ servers: [docs], tests: { docs: gateway } });
    const { id } = await begin(mcps);

    await mcps.submitCode(id, "good");
    const failed = await until(
      () => step(mcps, id),
      (auth) => auth?.step === "failed",
    );

    expect(failed?.message).toContain("login is saved");
    expect(failed?.message).toContain("address may be wrong");
    expect(failed?.message).toContain("Missing Authentication Token");
    expect(await calls()).toContain("/mcp test docs");
  });

  test("a code omp does not accept leaves the sign-in open to try again", async () => {
    const mcps = await install({ servers: [docs] });
    const { id } = await begin(mcps);

    const after = await mcps.submitCode(id, "wrong");

    expect(after).toMatchObject({ step: "waiting" });
    expect(after.message).toContain("did not accept");
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(true);
  });

  test("an address that is not omp's callback is refused before anything is called", async () => {
    const mcps = await install({ servers: [docs] });
    const { id } = await begin(mcps);

    await expect(mcps.submitCode(id, "http://evil.test/callback?code=good")).rejects.toThrow(
      "not the address",
    );
    expect((await step(mcps, id))?.step).toBe("waiting");
  });

  test("closing the dialog stops omp so it frees its callback port", async () => {
    const mcps = await install({ servers: [docs] });
    const { id } = await begin(mcps);
    const pid = Number(await readFile(pidFile, "utf8"));

    expect(mcps.cancelAuth(id)).toMatchObject({ step: "canceled" });
    await until(
      () => alive(pid),
      (running) => !running,
    );
    expect(alive(pid)).toBe(false);
  });

  test("omp dying mid-authorization fails it rather than leaving it waiting", async () => {
    const mcps = await install({ servers: [docs], crashAfterUrl: true });
    const { id } = await begin(mcps);

    const failed = await until(
      () => step(mcps, id),
      (auth) => auth?.step === "failed",
    );
    expect(failed).toMatchObject({ step: "failed" });
    expect(failed?.message).toContain("stopped");
  });

  test("a server with a sign-in open is not changed until the sign-in ends", async () => {
    const other = { name: "other", transport: "http", enabled: true, target: "https://other.test" };
    const mcps = await install({ servers: [docs, other] });
    const { id } = await begin(mcps);

    await expect(mcps.run(undefined, "docs", "disable")).rejects.toThrow("sign-in for docs");
    await expect(mcps.run(undefined, "docs", "remove")).rejects.toThrow("sign-in for docs");
    expect(await mcps.run(undefined, "docs", "test")).toMatchObject({ ok: true });
    expect(await mcps.run(undefined, "other", "disable")).toMatchObject({ ok: true });
    expect(
      (await calls()).filter(
        (call) => call === "/mcp disable docs" || call === "/mcp remove docs --scope user",
      ),
    ).toEqual([]);

    mcps.cancelAuth(id);
    expect(await mcps.run(undefined, "docs", "disable")).toMatchObject({ ok: true });
  });

  test("a change and a sign-in started together never run at the same time", async () => {
    const mcps = await install({ servers: [docs], slowMutation: true });

    const [change] = await Promise.allSettled([
      mcps.run(undefined, "docs", "disable"),
      mcps.startAuth(undefined, "docs"),
    ]);
    const log = await until(calls, (lines) => {
      const reauthStarted = lines.includes("/mcp reauth docs");
      return (
        reauthStarted && (lines.includes("done /mcp disable docs") || change.status === "rejected")
      );
    });

    // omp copies the config when a reauth starts; that must not happen while a change is running.
    if (log.includes("/mcp disable docs")) {
      expect(log.indexOf("/mcp reauth docs")).toBeGreaterThan(
        log.indexOf("done /mcp disable docs"),
      );
    } else {
      expect(change.status).toBe("rejected");
    }
  });

  test("a sign-in only locks the server in its own store", async () => {
    const mcps = await install({ servers: [docs] });
    await begin(mcps);

    const result = await mcps.run({ agentDir: "/tmp/another-store" }, "docs", "disable");

    expect(result).toMatchObject({ ok: true });
  });

  test("a saved login whose connection check cannot run is reported, not called signed in", async () => {
    const mcps = await install({ servers: [docs], crashOnTest: true });
    const { id } = await begin(mcps);

    await mcps.submitCode(id, "good");
    const failed = await until(
      () => step(mcps, id),
      (auth) => auth?.step === "failed",
    );

    expect(failed?.message).toContain("login is saved");
    expect(failed?.message).toContain("could not run");
  });

  test("a callback that answers with a redirect is not followed", async () => {
    const hits: string[] = [];
    const elsewhere = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.end("elsewhere");
    });
    const listening = Promise.withResolvers<void>();
    elsewhere.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    const address = elsewhere.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const mcps = await install({ servers: [docs], redirectTo: `http://127.0.0.1:${port}/steal` });
      const { id } = await begin(mcps);

      await expect(mcps.submitCode(id, "good")).rejects.toThrow("no longer listening");

      expect(hits).toEqual([]);
    } finally {
      elsewhere.close();
    }
  });

  test("a newer authorization replaces the one still open", async () => {
    const mcps = await install({ servers: [docs] });
    const first = await begin(mcps);
    const second = await begin(mcps);

    expect((await step(mcps, first.id))?.step).toBe("canceled");
    expect((await step(mcps, second.id))?.step).toBe("waiting");
  });
});
