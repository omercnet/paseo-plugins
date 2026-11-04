import { randomUUID } from "node:crypto";
import type { OmpLoginStep } from "../shared/omp-accounts";
import {
  type OmpMcpAction,
  type OmpMcpAddResult,
  type OmpMcpAuth,
  type OmpMcpCheck,
  type OmpMcpServer,
  OmpMcpServerSchema,
  type OmpMcpsView,
} from "../shared/omp-mcps";
import type { OmpStore } from "../shared/omp-store";
import { SerialMutationQueue } from "./mutation-queue";
import {
  isOpen,
  OmpAccountsError,
  type OmpCommand,
  OmpRpcProcess,
  publicMessage,
  resolveCommand,
  storeKey,
} from "./omp-accounts";

const SLASH_TIMEOUT_MS = 60_000;
/** omp answers a prompt before some commands print; it prints nothing for others. */
const OUTPUT_GRACE_MS = 2_000;
/** omp gives up on a browser authorization after five minutes. */
const AUTH_TIMEOUT_MS = 6 * 60_000;
const FINISHED_AUTH_TTL_MS = 10 * 60_000;
/** Listing starts an omp process, so a quick re-read (a poll, a reopened tab) reuses the last one. */
const LIST_TTL_MS = 30_000;
const CALLBACK_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** `/mcp list` prints one `name | transport | state | target [source]` line per server. */
const LIST_LINE = /^([^|]+?) \| ([^|]+?) \| ([^|]+?) \| (.*) \[([^\]]*)\]$/u;
const EMPTY_LIST = /^No MCP servers/iu;

export function parseMcpList(text: string): OmpMcpServer[] {
  return text.split("\n").flatMap((line) => {
    const match = LIST_LINE.exec(line.trim());
    if (!match) return [];
    const [, name, transport, state, target, source] = match;
    const parsed = OmpMcpServerSchema.safeParse({ name, transport, state, target, source });
    return parsed.success ? [parsed.data] : [];
  });
}

/** omp reports a failed command only in its text; quoted server names are not read as words. */
export function reportsFailure(text: string): boolean {
  return /\b(?:fail(?:ed|ure)|not found|unknown option|invalid)\b|\busage:/iu.test(
    text.replace(/"[^"]*"/gu, ""),
  );
}

/**
 * Reads the status line of `/mcp test`. Only the first line says how the connection went: the lines
 * after it list tool names, which can be any word, including "failed". A 401 means something is
 * there and wants a sign-in; any other failure means nothing there is a working MCP server.
 */
export function readConnectionCheck(text: string): OmpMcpCheck {
  const status = text.trim().split("\n")[0] ?? "";
  if (/\bHTTP 401\b/u.test(status)) return "needs-authorization";
  return status === "" || reportsFailure(status) ? "failed" : "connected";
}

/** What one line of `/mcp reauth` output means for the authorization it belongs to. */
export type AuthOutput =
  | { kind: "url"; url: string; instructions: string | null }
  | { kind: "progress" }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

const AUTH_URL = /https?:\/\/\S+/u;

/** omp's own terminal message for a reauth that was canceled; a server may be named "cancel-tools". */
const OMP_AUTH_ENDED = /^Reauthorization cancelled for /u;
/** Terminal answers omp prints for a reauth it will not start; they end the command like a failure. */
const OMP_AUTH_REFUSAL = /is disabled\. Run \/mcp enable|reauthorization is not required/iu;

/**
 * omp's rpc mode sends no `open_url` request for a reauthorization: the page address, the result
 * and every progress line arrive as printed text.
 */
export function readAuthOutput(text: string): AuthOutput {
  const printed = text.trim();
  const url = printed.includes("OAuth Authorization Required") ? AUTH_URL.exec(printed)?.[0] : null;
  if (url) {
    const instructions = printed.slice(printed.indexOf(url) + url.length).trim();
    return { kind: "url", url, instructions: instructions || null };
  }
  if (printed.startsWith("\u2713")) return { kind: "done", message: printed };
  if (reportsFailure(printed) || OMP_AUTH_ENDED.test(printed) || OMP_AUTH_REFUSAL.test(printed)) {
    return { kind: "failed", message: printed };
  }
  return { kind: "progress" };
}

/**
 * The address omp's local callback server should be asked for, from what the person pasted: the
 * full redirect URL, or just the authorization code. Only omp's own loopback redirect is ever
 * called, whatever was pasted.
 */
export function callbackUrl(authorizationUrl: string, pasted: string): URL | null {
  const params = new URL(authorizationUrl).searchParams;
  const redirect = params.get("redirect_uri");
  if (!redirect) return null;
  const target = new URL(redirect);
  if (!LOOPBACK_HOSTS.includes(target.hostname)) return null;
  const input = pasted.trim();
  if (URL.canParse(input)) {
    const given = new URL(input);
    return given.origin === target.origin && given.pathname === target.pathname ? given : null;
  }
  target.searchParams.set("code", input);
  const state = params.get("state");
  if (state) target.searchParams.set("state", state);
  return target;
}

/** One slash command in a short-lived bare omp rpc session; returns what it printed. */
async function runSlash(command: OmpCommand, line: string): Promise<string> {
  const printed: string[] = [];
  const first = Promise.withResolvers<void>();
  const rpc = new OmpRpcProcess(command, {
    onOutput: (text) => {
      printed.push(text);
      first.resolve();
    },
  });
  try {
    await rpc.request({ type: "prompt", message: line }, SLASH_TIMEOUT_MS);
    const grace = setTimeout(first.resolve, OUTPUT_GRACE_MS);
    await first.promise;
    clearTimeout(grace);
    return printed.join("\n");
  } finally {
    rpc.close();
  }
}

function actionResult(printed: string, action: string): { ok: boolean; message: string } {
  const message = printed.trim();
  if (message === "") return { ok: false, message: `omp gave no answer to /mcp ${action}` };
  // Only the status line counts; `/mcp test` lists tool names on the lines after it.
  return { ok: !reportsFailure(message.split("\n")[0] ?? ""), message };
}

interface AuthState {
  id: string;
  storeKey: string;
  name: string;
  step: OmpLoginStep;
  url: string | null;
  instructions: string | null;
  codePrompt: string | null;
  message: string | null;
  process: OmpRpcProcess | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  endedAt: number | null;
}

function toAuth(auth: AuthState): OmpMcpAuth {
  return {
    id: auth.id,
    name: auth.name,
    step: auth.step,
    url: auth.url,
    instructions: auth.instructions,
    codePrompt: auth.codePrompt,
    message: auth.message,
  };
}

/**
 * Lists, adds, toggles, tests and removes OMP's MCP servers and runs their OAuth sign-in, all
 * through OMP's own `/mcp` commands so the files it writes stay the ones it reads.
 */
export class OmpMcps {
  private readonly auths = new Map<string, AuthState>();
  private readonly listings = new Map<string, { servers: OmpMcpServer[]; at: number }>();
  /** Bumped by every change, so a listing that began before one cannot be stored after it. */
  private generation = 0;
  /** One config write at a time, so each one edits the file the previous one wrote. */
  private readonly writes = new SerialMutationQueue();

  async list(store: OmpStore | undefined, refresh: boolean): Promise<OmpMcpsView> {
    const key = storeKey(store);
    const auths = [...this.auths.values()].filter((auth) => auth.storeKey === key).map(toAuth);
    let command: OmpCommand;
    try {
      command = await resolveCommand();
    } catch (error) {
      return { installed: false, servers: [], auths, error: publicMessage(error) };
    }
    const cached = this.listings.get(key);
    if (cached && !refresh && Date.now() - cached.at < LIST_TTL_MS) {
      return { installed: true, servers: cached.servers, auths, error: null };
    }
    try {
      const began = this.generation;
      const printed = await runSlash(command, "/mcp list");
      const servers = parseMcpList(printed);
      if (servers.length === 0 && printed.trim() !== "" && !EMPTY_LIST.test(printed.trim())) {
        throw new OmpAccountsError("omp's MCP list is not in a format this plugin can read");
      }
      if (began === this.generation) this.listings.set(key, { servers, at: Date.now() });
      return { installed: true, servers, auths, error: null };
    } catch (error) {
      return { installed: true, servers: [], auths, error: publicMessage(error) };
    }
  }

  /**
   * omp's reauthorization copies the server's config when it starts and may write it back when the
   * browser step ends, which would undo a change made in between. So a server with a sign-in open
   * is left alone until that sign-in ends; another client's change is refused here, not hidden.
   */
  async run(
    store: OmpStore | undefined,
    name: string,
    action: OmpMcpAction,
  ): Promise<{ ok: boolean; message: string }> {
    const command = await resolveCommand();
    // `remove` defaults to the project in omp's working directory; this plugin only manages the
    // user's own file.
    const line =
      action === "remove" ? `/mcp remove ${name} --scope user` : `/mcp ${action} ${name}`;
    const printed = await this.writes.run(async () => {
      // Checked here, in the queue, not before it: a sign-in registered while this change waited
      // for its turn must still stop it.
      if (action !== "test" && this.hasOpenAuth(store, name)) {
        throw new OmpAccountsError(`Finish or cancel the sign-in for ${name} before changing it`);
      }
      return runSlash(command, line);
    });
    this.invalidate();
    return actionResult(printed, action);
  }

  /** `target` was validated by the contract: one URL token, or a command line after `--`. */
  async add(name: string, target: string): Promise<OmpMcpAddResult> {
    const command = await resolveCommand();
    const remote = /^https?:\/\//iu.test(target);
    const line = remote
      ? `/mcp add ${name} --scope user --url ${target}`
      : `/mcp add ${name} --scope user -- ${target}`;
    const printed = await this.writes.run(() => runSlash(command, line));
    this.invalidate();
    const added = actionResult(printed, "add");
    if (!added.ok) return { ...added, check: null };
    return this.check(command, name, added.message);
  }

  /** `/mcp add` never connects, so a mistyped address is only found by testing it. */
  private async check(command: OmpCommand, name: string, added: string): Promise<OmpMcpAddResult> {
    let tested: string;
    try {
      tested = (await runSlash(command, `/mcp test ${name}`)).trim();
    } catch (error) {
      const message = `${added} The connection check could not run: ${publicMessage(error)}`;
      return { ok: true, message, check: null };
    }
    const check = readConnectionCheck(tested);
    if (check === "connected") return { ok: true, message: `${added} ${tested}`, check };
    if (check === "needs-authorization") {
      return { ok: true, message: `${added} It needs a sign-in: use Authorize.`, check };
    }
    const reason = tested === "" ? "omp gave no answer" : tested;
    const advice =
      "Its connection check failed, so this may not be a working MCP server. Check the address.";
    return { ok: true, message: `${added} ${advice} omp said: ${reason}`, check };
  }

  async startAuth(store: OmpStore | undefined, name: string): Promise<OmpMcpAuth> {
    const command = await resolveCommand();
    // Registered in the write queue: a change already running finishes before omp copies the
    // server's config, and every later change finds this sign-in open and is refused.
    const auth = await this.writes.run(async () => this.register(store, name));
    void this.runAuth(auth, command);
    return toAuth(auth);
  }

  private register(store: OmpStore | undefined, name: string): AuthState {
    // OAuth callbacks listen on fixed local ports, so only one authorization runs at a time.
    for (const other of this.auths.values()) {
      if (isOpen(other.step)) {
        this.settle(other, "canceled", "A newer authorization replaced this one");
      }
    }
    for (const [id, auth] of this.auths) {
      if (auth.endedAt !== null && Date.now() - auth.endedAt > FINISHED_AUTH_TTL_MS) {
        this.auths.delete(id);
      }
    }
    const auth: AuthState = {
      id: randomUUID(),
      storeKey: storeKey(store),
      name,
      step: "starting",
      url: null,
      instructions: null,
      codePrompt: null,
      message: null,
      process: null,
      timer: undefined,
      endedAt: null,
    };
    this.auths.set(auth.id, auth);
    return auth;
  }

  /**
   * Finishes an authorization whose browser could not reach this host: omp's callback server is
   * local, so the pasted redirect URL or code is handed to it from here.
   */
  async submitCode(authId: string, code: string): Promise<OmpMcpAuth> {
    const auth = this.auths.get(authId);
    if (!auth?.process || !isOpen(auth.step)) {
      throw new OmpAccountsError("This authorization is no longer running. Start it again");
    }
    const target = auth.url ? callbackUrl(auth.url, code) : null;
    if (!target) {
      throw new OmpAccountsError(
        "That is not the address omp is waiting for. Paste the full address from the browser's address bar, or the code",
      );
    }
    auth.step = "verifying";
    auth.message = null;
    let accepted: boolean;
    try {
      // A redirect would leave omp's loopback address, which the pasted text may not name.
      const response = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      accepted = response.ok;
    } catch {
      if (auth.step === "verifying") auth.step = "waiting";
      throw new OmpAccountsError("omp is no longer listening for the sign-in. Start it again");
    }
    // omp prints the result once its callback server has the code; that moves the step on.
    if (!accepted && auth.step === "verifying") {
      auth.step = "waiting";
      auth.message = "omp did not accept that. Paste the full address or the code again";
    }
    return toAuth(auth);
  }

  cancelAuth(authId: string): OmpMcpAuth | null {
    const auth = this.auths.get(authId);
    if (!auth) return null;
    if (isOpen(auth.step)) this.settle(auth, "canceled", "Authorization was canceled");
    return toAuth(auth);
  }

  private hasOpenAuth(store: OmpStore | undefined, name: string): boolean {
    const key = storeKey(store);
    return [...this.auths.values()].some(
      (auth) => auth.storeKey === key && auth.name === name && isOpen(auth.step),
    );
  }

  private invalidate(): void {
    this.generation += 1;
    this.listings.clear();
  }

  stop(): void {
    for (const auth of this.auths.values()) {
      if (isOpen(auth.step)) this.settle(auth, "canceled", null);
    }
  }

  private async runAuth(auth: AuthState, command: OmpCommand): Promise<void> {
    try {
      const rpc = new OmpRpcProcess(command, {
        onOutput: (text) => this.onOutput(auth, text),
        onExit: () => this.settle(auth, "failed", "omp stopped before the authorization finished"),
      });
      if (!isOpen(auth.step)) {
        rpc.close();
        return;
      }
      auth.process = rpc;
      auth.timer = setTimeout(
        () => this.settle(auth, "failed", "Authorization timed out"),
        AUTH_TIMEOUT_MS,
      );
      // omp acknowledges at once; how the authorization ended arrives later as printed text.
      await rpc.request({ type: "prompt", message: `/mcp reauth ${auth.name}` });
    } catch (error) {
      if (isOpen(auth.step)) this.settle(auth, "failed", publicMessage(error));
    }
  }

  /**
   * A saved login does not make the address right: a server at the wrong path still fails its
   * test. Say so here, where "You're signed in" would otherwise be followed by a failing Test.
   */
  private async confirmSignIn(auth: AuthState, signedIn: string): Promise<void> {
    auth.step = "verifying";
    auth.codePrompt = null;
    let tested: string;
    try {
      tested = (await runSlash(await resolveCommand(), `/mcp test ${auth.name}`)).trim();
    } catch (error) {
      const reason = publicMessage(error);
      const message = `${signedIn} The login is saved, but the connection check could not run: ${reason}`;
      this.settle(auth, "failed", message);
      return;
    }
    if (readConnectionCheck(tested) === "connected") {
      this.settle(auth, "done", `${signedIn} ${tested}`);
      return;
    }
    const reason = tested === "" ? "omp gave no answer" : tested;
    this.settle(
      auth,
      "failed",
      `Signed in and the login is saved, but ${auth.name} still fails its connection check, so the server address may be wrong. omp said: ${reason}`,
    );
  }

  private onOutput(auth: AuthState, text: string): void {
    if (!isOpen(auth.step)) return;
    const output = readAuthOutput(text);
    if (output.kind === "url") {
      auth.url = output.url;
      auth.instructions = output.instructions;
      auth.codePrompt = "Paste the address from the browser, or the code";
      auth.step = "waiting";
    } else if (output.kind === "done") {
      this.invalidate();
      void this.confirmSignIn(auth, output.message);
      return;
    } else if (output.kind === "failed") {
      this.settle(auth, "failed", output.message);
    }
  }

  private settle(auth: AuthState, step: OmpLoginStep, message: string | null): void {
    if (!isOpen(auth.step)) return;
    clearTimeout(auth.timer);
    auth.step = step;
    auth.message = message;
    auth.codePrompt = null;
    auth.endedAt = Date.now();
    auth.process?.close();
    auth.process = null;
  }
}
