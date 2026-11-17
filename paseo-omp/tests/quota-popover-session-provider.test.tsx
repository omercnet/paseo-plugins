// @vitest-environment happy-dom
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QuotaPopover } from "../client/quota-popover";
import {
  getOmpSessionModelProvider,
  listOmpSessionAccounts,
  type OmpQuota,
  type OmpSessionAccount,
} from "../shared/quota";

// The agent as Paseo reports it, the provider its live session names (null once it ends), and the
// logins its session lists.
const agent = vi.hoisted(() => ({
  provider: "omp-plugin",
  model: "omp:model:opaque",
  status: "idle",
  sessionProvider: null as string | null,
  asked: 0,
  logins: [] as OmpSessionAccount[],
  // When set, the session-account answer waits for it, as a slow server would.
  accountsGate: null as Promise<void> | null,
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => ({ provider: agent.provider, model: agent.model, status: agent.status }),
  usePaseo: () => ({}),
  useRpc: (definition: unknown) => async () => {
    if (definition === getOmpSessionModelProvider) {
      agent.asked += 1;
      return { provider: agent.sessionProvider };
    }
    if (definition === listOmpSessionAccounts) {
      const answer = agent.logins;
      if (agent.accountsGate) await agent.accountsGate;
      return { accounts: answer };
    }
    return { quotas: [quota("anthropic"), quota("openai-codex")] };
  },
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: () => null }));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  Pressable: (props: { children?: ReactNode }) => <button type="button">{props.children}</button>,
}));

function quota(provider: string): OmpQuota {
  return {
    provider,
    accountKey: provider,
    limitId: "weekly",
    email: null,
    accountId: null,
    accountService: null,
    accountHost: null,
    plan: null,
    organization: null,
    label: "Usage",
    windowLabel: "Weekly",
    usedFraction: 0.5,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  };
}

const props: PluginButtonContentProps = {
  context: "agent",
  workspaceId: "synthetic-workspace",
  agentId: "synthetic-agent",
  host: { id: "synthetic-host", label: "Test host" },
  layout: { compact: false, platform: "web" },
  close() {},
  theme: {
    colors: {
      surface0: "#111111",
      surface1: "#222222",
      surface2: "#333333",
      border: "#444444",
      foreground: "#eeeeee",
      foregroundMuted: "#aaaaaa",
      accent: "#008800",
      accentForeground: "#ffffff",
      statusSuccess: "#008800",
      statusWarning: "#aa8800",
      statusDanger: "#aa0000",
    },
  },
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

// Settings that relocate OMP's store; none may reach a test from the runner's environment.
const OMP_LOCATION_ENV = [
  "OMP_AGENT_DIR",
  "OMP_PROFILE",
  "PASEO_OMP_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const name of OMP_LOCATION_ENV) vi.stubEnv(name, undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Re-renders the open popover, as Paseo does when the agent's status changes. */
async function show(status: string, sessionProvider: string | null) {
  agent.status = status;
  agent.sessionProvider = sessionProvider;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QuotaPopover {...props} />
      </QueryClientProvider>,
    );
  });
}

const currentProvider = () => container.textContent?.includes("CURRENT PROVIDER") ?? false;

test("asks the live session for its provider when it starts or resumes while the popover is open", async () => {
  // Opened on a closed agent: no live session to ask, nothing to name.
  await show("closed", null);
  await act(async () => {});
  expect(agent.asked).toBe(0);
  expect(currentProvider()).toBe(false);

  // The same model resumes: the popover asks and marks the provider.
  await show("idle", "anthropic");
  await vi.waitFor(() => expect(currentProvider()).toBe(true));
  expect(agent.asked).toBe(1);

  // The session ends: the earlier answer is not kept and nothing is asked.
  await show("closed", null);
  await vi.waitFor(() => expect(currentProvider()).toBe(false));
  expect(agent.asked).toBe(1);
});

test("does not show the previous session's login in use once the agent's status changes", async () => {
  // A bundled omp agent names its provider in the model string; its logins come from OMP's pin.
  agent.provider = "omp";
  agent.model = "anthropic/example";
  const login = (active: boolean): OmpSessionAccount => ({
    credentialId: 2,
    label: "lee@example.invalid (Example Team)",
    active,
    onlyLogin: false,
    quotaAccountKeys: ["anthropic"],
  });
  try {
    agent.logins = [login(true)];
    await show("idle", null);
    await vi.waitFor(() => expect(container.textContent).toContain("IN USE"));

    // The session closed and its pin expired: the open popover must not keep the old mark.
    agent.logins = [login(false)];
    await show("closed", null);
    await vi.waitFor(() => expect(container.textContent).not.toContain("IN USE"));

    // A new session resumes in the same status: React Query holds the earlier idle answer, but
    // while the new answer is still on its way the previous session's mark stays hidden.
    const gate = Promise.withResolvers<void>();
    agent.accountsGate = gate.promise;
    await show("idle", null);
    await act(async () => {});
    expect(container.textContent).not.toContain("IN USE");
    gate.resolve();
    await act(async () => {});
    expect(container.textContent).not.toContain("IN USE");
  } finally {
    agent.provider = "omp-plugin";
    agent.model = "omp:model:opaque";
    agent.logins = [];
    agent.accountsGate = null;
  }
});

/** Lets queued query results reach the screen before asserting that something is absent. */
async function settle() {
  await act(async () => {
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 50);
    await delay.promise;
  });
}

test("never shows an answer requested before the status changed, even when it lands after", async () => {
  agent.provider = "omp";
  agent.model = "anthropic/example";
  const login = (active: boolean): OmpSessionAccount => ({
    credentialId: 2,
    label: "lee@example.invalid (Example Team)",
    active,
    onlyLogin: false,
    quotaAccountKeys: ["anthropic"],
  });
  try {
    // The first session's request is held: it will answer that its login is in use.
    const earlier = Promise.withResolvers<void>();
    agent.logins = [login(true)];
    agent.accountsGate = earlier.promise;
    await show("idle", null);
    await act(async () => {});

    // That session closes and a new one resumes in the same status; the new answer arrives.
    agent.accountsGate = null;
    agent.logins = [login(false)];
    await show("closed", null);
    await show("idle", null);
    await settle();
    expect(container.textContent).not.toContain("IN USE");

    // The earlier request finally lands; it belongs to the old session and changes nothing.
    earlier.resolve();
    await settle();
    expect(container.textContent).not.toContain("IN USE");
  } finally {
    agent.provider = "omp-plugin";
    agent.model = "omp:model:opaque";
    agent.logins = [];
    agent.accountsGate = null;
  }
});
