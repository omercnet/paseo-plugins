// @vitest-environment happy-dom
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QuotaPopover } from "../client/quota-popover";
import { getOmpSessionModelProvider, type OmpQuota } from "../shared/quota";

// The agent as Paseo reports it, and the provider its live session names (null once it ends).
const agent = vi.hoisted(() => ({
  status: "idle",
  sessionProvider: null as string | null,
  asked: 0,
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => ({ provider: "omp-plugin", model: "omp:model:opaque", status: agent.status }),
  usePaseo: () => ({}),
  useRpc: (definition: unknown) => async () => {
    if (definition === getOmpSessionModelProvider) {
      agent.asked += 1;
      return { provider: agent.sessionProvider };
    }
    return { quotas: [quota("anthropic"), quota("openai-codex")], accounts: [] };
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
