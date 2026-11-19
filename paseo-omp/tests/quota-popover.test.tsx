// @vitest-environment happy-dom
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QuotaPopover } from "../client/quota-popover";
import type { OmpQuota, OmpSessionAccount } from "../shared/quota";

const recorded = vi.hoisted(() => ({
  quotas: [] as OmpQuota[],
  logins: [] as OmpSessionAccount[],
  sent: [] as Array<{ agentId: string; text: string }>,
  sendArgs: [] as unknown[][],
  status: "idle" as string,
  // The agent's live record when it differs from the rendered one (a turn started since render).
  liveStatus: null as string | null,
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => ({ provider: "omp", model: "anthropic/example", status: recorded.status }),
  useRpc: () => vi.fn(),
  usePaseo: () => ({
    agents: {
      ref: (agentId: string) => ({
        current: () => ({ status: recorded.liveStatus ?? recorded.status }),
        send: async (...args: unknown[]) => {
          recorded.sendArgs.push(args);
          recorded.sent.push({ agentId, text: String(args[0]) });
        },
      }),
    },
  }),
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: () => null }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data:
      options.queryKey[1] === "session-accounts"
        ? { accounts: recorded.logins }
        : { quotas: recorded.quotas },
    isLoading: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("react-native", () => ({
  View: (props: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    style?: Record<string, unknown>;
  }) => (
    <div
      role={props.accessibilityRole === "header" ? "heading" : undefined}
      data-accessibility-label={props.accessibilityLabel}
    >
      {props.children}
    </div>
  ),
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.disabled ? undefined : props.onPress}
    >
      {props.children}
    </button>
  ),
}));

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

function quota(accountKey: string, limitId: string, usedFraction: number): OmpQuota {
  return {
    provider: "anthropic",
    accountKey,
    limitId,
    email: "same@example.invalid",
    accountId: null,
    accountService: null,
    accountHost: null,
    plan: null,
    organization: null,
    label: "Usage",
    windowLabel: "Weekly",
    usedFraction,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  recorded.quotas = [];
  recorded.logins = [];
  recorded.sent = [];
  recorded.status = "idle";
  recorded.liveStatus = null;
  recorded.sendArgs = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(rows: OmpQuota[]) {
  recorded.quotas = rows;
  await act(() => root.render(<QuotaPopover {...props} />));
}

function heading(name: string): Element {
  const node = [...container.querySelectorAll('[role="heading"]')].find((element) =>
    element.textContent?.includes(name),
  );
  if (!node) throw new Error(`Missing account heading: ${name}`);
  return node;
}

function text(value: string): Element {
  const node = [...container.querySelectorAll("span")].find(
    (element) => element.textContent === value,
  );
  if (!node) throw new Error(`Missing text: ${value}`);
  return node;
}

describe("quota popover reconciliation", () => {
  test("keeps same-email accounts distinct when usage reorders them and one disappears", async () => {
    await render([quota("a", "weekly", 0.9), quota("b", "weekly", 0.2)]);
    const firstAccount = heading("same@example.invalid · Account 1").parentElement;
    const secondAccount = heading("same@example.invalid · Account 2").parentElement;
    expect(firstAccount).not.toBe(secondAccount);

    await render([quota("a", "weekly", 0.1), quota("b", "weekly", 0.8)]);
    expect(heading("same@example.invalid · Account 1").parentElement).toBe(firstAccount);
    expect(heading("same@example.invalid · Account 2").parentElement).toBe(secondAccount);
    expect(firstAccount?.contains(text("10%"))).toBe(true);
    expect(secondAccount?.contains(text("80%"))).toBe(true);

    await render([quota("a", "weekly", 0.1)]);
    expect(heading("same@example.invalid").parentElement).toBe(firstAccount);
    expect(secondAccount?.isConnected).toBe(false);
    expect(container.textContent).not.toContain("80%");
  });

  test("keeps identically named limits distinct through reordering and deletion", async () => {
    await render([quota("a", "first", 0.9), quota("a", "second", 0.2)]);
    const firstLimit = text("90%");
    const secondLimit = text("20%");

    await render([quota("a", "first", 0.1), quota("a", "second", 0.8)]);
    expect(text("10%")).toBe(firstLimit);
    expect(text("80%")).toBe(secondLimit);

    await render([quota("a", "first", 0.1)]);
    expect(text("10%")).toBe(firstLimit);
    expect(secondLimit.isConnected).toBe(false);
    expect(container.textContent).not.toContain("80%");
  });

  test("shows plan and organization badges beside the account name", async () => {
    await render([
      {
        ...quota("a", "weekly", 0.4),
        plan: "self_serve_business_prolite",
        organization: "Example Team",
      },
    ]);
    const name = heading("same@example.invalid");
    expect(name.contains(text("Business"))).toBe(true);
    expect(name.contains(text("Example Team"))).toBe(true);
    expect(name.getAttribute("data-accessibility-label")).toBe(
      "same@example.invalid · Business · Example Team",
    );
  });

  test("marks the account this session uses and switches to another from its heading", async () => {
    recorded.logins = [
      {
        credentialId: 3,
        label: "same@example.invalid",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: ["a"],
      },
      { credentialId: 5, label: "other", active: true, onlyLogin: false, quotaAccountKeys: ["b"] },
    ];
    await render([
      quota("a", "weekly", 0.9),
      { ...quota("b", "weekly", 0.2), email: "b@x.invalid" },
    ]);

    const inUse = heading("b@x.invalid");
    expect(inUse.contains(text("IN USE"))).toBe(true);
    // The account in use leads its provider even though the other one has more usage.
    expect(
      inUse.compareDocumentPosition(heading("same@example.invalid")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector('[aria-label="Use b@x.invalid for this session"]')).toBeNull();

    const other = heading("same@example.invalid");
    const button = other.querySelector(
      '[aria-label="Use same@example.invalid for this session"]',
    ) as HTMLButtonElement;
    expect(button.textContent).toBe("Switch");
    // Two clicks before the popover re-renders send one pin, not two.
    await act(async () => {
      button.click();
      button.click();
    });
    expect(recorded.sent).toEqual([
      { agentId: "synthetic-agent", text: "/session pin OAuth credential #3" },
    ]);
  });

  test("disables Switch while the agent runs a turn, so it cannot interrupt it", async () => {
    recorded.logins = [
      {
        credentialId: 3,
        label: "a@x.invalid",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: ["a"],
      },
      {
        credentialId: 5,
        label: "b@x.invalid",
        active: true,
        onlyLogin: false,
        quotaAccountKeys: ["b"],
      },
    ];
    const rows = [
      { ...quota("a", "weekly", 0.9), email: "a@x.invalid" },
      { ...quota("b", "weekly", 0.2), email: "b@x.invalid" },
    ];
    const button = () =>
      container.querySelector(
        '[aria-label="Use a@x.invalid for this session"]',
      ) as HTMLButtonElement;

    for (const status of ["running", "initializing"]) {
      recorded.status = status;
      await render(rows);
      expect(button().disabled).toBe(true);
      await act(async () => button().click());
      expect(recorded.sent).toEqual([]);
    }

    // A turn that started after the render: the button still looks enabled, but nothing is sent.
    recorded.status = "idle";
    recorded.liveStatus = "running";
    await render(rows);
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(recorded.sent).toEqual([]);

    recorded.liveStatus = null;
    await act(async () => button().click());
    expect(recorded.sent).toEqual([
      { agentId: "synthetic-agent", text: "/session pin OAuth credential #3" },
    ]);
    // No send options: Paseo's default for a busy agent is to interrupt, so none is chosen here.
    expect(recorded.sendArgs).toEqual([["/session pin OAuth credential #3"]]);
  });

  test("labels a provider's only login without a Switch button or an IN USE claim", async () => {
    recorded.logins = [
      {
        credentialId: 8,
        label: "same@example.invalid",
        active: false,
        onlyLogin: true,
        quotaAccountKeys: ["a"],
      },
    ];
    await render([quota("a", "weekly", 0.3)]);

    const only = heading("same@example.invalid");
    expect(only.contains(text("ONLY LOGIN"))).toBe(true);
    expect(container.textContent).not.toContain("IN USE");
    expect(container.querySelector('[aria-label$="for this session"]')).toBeNull();
  });

  test("shows an unnamed account's state below its limits, where it has no heading", async () => {
    const unnamed = { ...quota("a", "weekly", 0.3), email: null };
    const login = {
      credentialId: 8,
      label: "OAuth credential #8",
      active: false,
      onlyLogin: true,
      quotaAccountKeys: ["a"],
    };

    recorded.logins = [login];
    await render([unnamed]);
    expect(container.querySelector('[role="heading"]')).toBeNull();
    expect(text("ONLY LOGIN")).toBeTruthy();
    expect(container.querySelector('[aria-label$="for this session"]')).toBeNull();

    recorded.logins = [{ ...login, active: true, onlyLogin: false }];
    await render([unnamed]);
    expect(text("IN USE")).toBeTruthy();
    expect(container.textContent).not.toContain("ONLY LOGIN");
  });

  test("still names a login OMP uses when no recorded usage is its own", async () => {
    const login = {
      credentialId: 8,
      label: "OAuth credential #8",
      active: true,
      onlyLogin: false,
      quotaAccountKeys: [],
    };
    recorded.logins = [login];
    await render([{ ...quota("a", "weekly", 0.3), email: "a@x.invalid" }]);

    const named = heading("OAuth credential #8");
    expect(named.contains(text("IN USE"))).toBe(true);
    expect(text("No recorded usage matches this login.")).toBeTruthy();
    // The usage row it cannot claim stays unmarked, with nothing to switch to.
    expect(heading("a@x.invalid").textContent).not.toContain("IN USE");
    expect(container.querySelector('[aria-label$="for this session"]')).toBeNull();

    // The only stored login is named the same way, also when the provider has no usage at all.
    recorded.logins = [{ ...login, active: false, onlyLogin: true }];
    await render([]);
    expect(heading("OAuth credential #8").contains(text("ONLY LOGIN"))).toBe(true);

    // Another unlinked login is neither in use nor the only one, so it adds nothing.
    recorded.logins = [{ ...login, active: false }];
    await render([]);
    expect(container.textContent).not.toContain("OAuth credential #8");
  });
});
