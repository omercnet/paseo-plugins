import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopFooter } from "../client/footer";
import { Dial, Sparkline } from "../client/gauge";
import { TopScreen } from "../client/screen";
import { Sessions } from "../client/sessions";
import { useUsage } from "../client/usage";
import type { Session } from "../shared/usage";

vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: "SidebarRow" }));
vi.mock("../client/gauge", () => ({ Dial: () => null, Sparkline: () => null }));
vi.mock("../client/usage", () => ({ SCREEN_ID: "usage", useUsage: vi.fn() }));

const theme = {
  colors: {
    surface0: "s0",
    surface1: "s1",
    surface2: "s2",
    border: "border",
    foreground: "fg",
    foregroundMuted: "muted",
    accent: "accent",
    accentForeground: "af",
    statusSuccess: "ok",
    statusWarning: "warn",
    statusDanger: "danger",
  },
};

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function elements(node: ReactNode, found: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as El;
    found.push(element);
    elements(element.props.children, found);
    elements(element.props.trailing as ReactNode, found);
  }
  return found;
}

function leafText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(leafText).join("");
  const element = node as El;
  return leafText(element.props.children) + leafText(element.props.trailing as ReactNode);
}

const session = (over: Partial<Session> = {}): Session => ({
  agentId: "5daca96a-8cc2-44fc",
  title: null,
  workspace: null,
  cores: 0.2,
  rss: 1024 ** 2,
  command: "node",
  processes: 1,
  heavy: false,
  ...over,
});

const usage = (over: object = {}) => ({
  cpu: 10,
  memory: 75,
  disk: 95,
  io: 1.5e6,
  history: [],
  totalMemory: 8 * 1024 ** 3,
  sessions: [],
  other: { cores: 0, rss: 0 },
  ...over,
});

function mockUsage(data: object | undefined, isError = false) {
  vi.mocked(useUsage).mockReturnValue({ data, isError } as never);
}

const footer = (over: Partial<PluginSidebarItemProps> = {}) =>
  TopFooter({
    theme,
    host: { id: "a", label: "Box A" },
    currentScreen: null,
    openScreen: vi.fn(),
    ...over,
  } as unknown as PluginSidebarItemProps);

const screen = (over: Partial<PluginScreenProps> = {}) =>
  TopScreen({
    theme,
    layout: { compact: false, platform: "web" },
    host: { id: "a", label: "Box A" },
    params: {},
    ...over,
  } as unknown as PluginScreenProps);

beforeEach(() => vi.mocked(useUsage).mockReset());

describe("sidebar footer", () => {
  it("shows each reading beside its icon, colored by how hot it is", () => {
    mockUsage(usage());
    const tree = footer();
    const icons = elements(tree).filter((el) => el.type === "Icon");
    expect(icons.map((icon) => icon.props.name)).toEqual([
      "Cpu",
      "MemoryStick",
      "HardDrive",
      "Gauge",
    ]);
    expect(icons.map((icon) => icon.props.color)).toEqual(["muted", "warn", "danger", "muted"]);
    expect(leafText(tree)).toBe("10%75%95%1.5M/s");
  });

  it("labels every reading in words, with the level spelled out for screen readers", () => {
    mockUsage(usage({ sessions: [session({ heavy: true })] }));
    const labels = elements(footer())
      .map((el) => el.props.accessibilityLabel)
      .filter(Boolean);
    expect(labels).toEqual([
      "1 heavy session",
      "CPU 10%",
      "Memory 75%, high",
      "Disk 95%, critical",
      "Disk I/O 1.5M/s",
    ]);
  });

  it("labels an unknown reading as unavailable, memory included", () => {
    mockUsage(usage({ cpu: null, memory: null, disk: null, io: null }));
    const tree = footer();
    expect(elements(tree).map((el) => el.props.accessibilityLabel)).toEqual(
      expect.arrayContaining([
        "CPU unavailable",
        "Memory unavailable",
        "Disk unavailable",
        "Disk I/O unavailable",
      ]),
    );
    expect(leafText(tree)).toBe("--------");
  });

  it("shows placeholders for a reading the host cannot give yet", () => {
    mockUsage(usage({ cpu: null, disk: null, io: null }));
    expect(leafText(footer())).toBe("--75%----");
  });

  it("shows nothing but the host while loading, and says so when it cannot be reached", () => {
    mockUsage(undefined);
    expect(leafText(footer())).toBe("");
    mockUsage(undefined, true);
    expect(leafText(footer())).toBe("unavailable");
  });

  it("flags a failed refresh without hiding the last readings", () => {
    mockUsage(usage(), true);
    expect(leafText(footer())).toBe("unavailable10%75%95%1.5M/s");
  });

  it("counts heavy sessions, and shows no flame when none are heavy or the host cannot tell", () => {
    const heavyCount = (count: number) => {
      mockUsage(usage({ sessions: Array.from({ length: count }, () => session({ heavy: true })) }));
      const found = elements(footer());
      const flame = found.find((el) => el.props.name === "Flame");
      // The count is the text beside the flame, in the same row.
      const row = found.find(
        (el) => Array.isArray(el.props.children) && el.props.children.includes(flame),
      );
      return flame ? leafText(row?.props.children as ReactNode) : null;
    };
    expect(heavyCount(2)).toBe("2");
    expect(heavyCount(12)).toBe("12");

    for (const sessions of [[session()], [], null]) {
      mockUsage(usage({ sessions }));
      expect(elements(footer()).some((el) => el.props.name === "Flame")).toBe(false);
    }
  });

  it("follows the host it is given and opens the Top screen when pressed", () => {
    mockUsage(usage());
    const openScreen = vi.fn();
    const row = footer({ host: { id: "b", label: "Box B" }, openScreen });
    expect(useUsage).toHaveBeenLastCalledWith("b");
    expect(row.props.label).toBe("Box B");
    expect(row.props.active).toBe(false);
    (row.props.onPress as () => void)();
    expect(openScreen).toHaveBeenCalledWith({ screenId: "usage" });
    expect(footer({ currentScreen: { screenId: "usage" } } as never).props.active).toBe(true);
  });
});

describe("Top screen", () => {
  it("reads the host it is shown for", () => {
    mockUsage(usage());
    const tree = screen({ host: { id: "b", label: "Box B" } });
    expect(useUsage).toHaveBeenLastCalledWith("b");
    expect(leafText(tree)).toContain("Box B");
  });

  it("says in words whether usage is live, and shows no value for an unknown memory", () => {
    const statusLabel = () =>
      elements(screen())
        .map((el) => el.props.accessibilityLabel)
        .find((label) => typeof label === "string" && label.startsWith("Usage"));
    mockUsage(undefined);
    expect(statusLabel()).toBe("Usage loading");
    mockUsage(usage({ memory: null }));
    expect(statusLabel()).toBe("Usage live");
    const memory = elements(screen()).find((el) => el.type === Dial && el.props.label === "MEMORY");
    expect([memory?.props.value, memory?.props.text]).toEqual([null, "--"]);
    mockUsage(usage(), true);
    expect(statusLabel()).toBe("Usage unavailable");
  });

  it("gives each dial its reading, with a placeholder for an unknown one", () => {
    mockUsage(usage({ cpu: null }));
    const dials = elements(screen()).filter((el) => el.type === Dial);
    expect(dials.map((dial) => [dial.props.label, dial.props.value, dial.props.text])).toEqual([
      ["CPU", null, "--"],
      ["MEMORY", 75, "75%"],
      ["DISK", 95, "95%"],
    ]);
  });

  it("shows the real I/O peak, however small, and only the graph scale has a floor", () => {
    const peakFor = (io: Array<number | null>, live: number | null = null) => {
      mockUsage(
        usage({
          io: live,
          history: io.map((value) => ({ cpu: 0, memory: 0, disk: 0, io: value })),
        }),
      );
      const tree = screen();
      const scale = elements(tree).find((el) => el.type === Sparkline && el.props.scale !== 100);
      return [leafText(tree).match(/peak [^\s]*?\/s|peak --/)?.[0], scale?.props.scale];
    };
    expect(peakFor([500_000])).toEqual(["peak 500K/s", 1_000_000]);
    expect(peakFor([0])).toEqual(["peak 0/s", 1_000_000]);
    expect(peakFor([1_000_000])).toEqual(["peak 1.0M/s", 1_000_000]);
    expect(peakFor([3_000_000, 200])).toEqual(["peak 3.0M/s", 3_000_000]);
    expect(peakFor([null])).toEqual(["peak --", 1_000_000]);
    expect(peakFor([])).toEqual(["peak --", 1_000_000]);
  });

  it("counts the live reading toward the peak, since history lags it by up to ten seconds", () => {
    mockUsage(usage({ io: 3_000_000, history: [{ cpu: 0, memory: 0, disk: 0, io: 500_000 }] }));
    expect(leafText(screen())).toContain("peak 3.0M/s");
  });

  it("gives each graph its own history, oldest first", () => {
    mockUsage(
      usage({
        history: [
          { cpu: 1, memory: 40, disk: 90, io: 5 },
          { cpu: 2, memory: 41, disk: 91, io: 6 },
        ],
      }),
    );
    const graphs = elements(screen()).filter((el) => el.type === Sparkline);
    expect(graphs.map((graph) => graph.props.values)).toEqual([
      [1, 2],
      [40, 41],
      [90, 91],
      [5, 6],
    ]);
  });

  it("explains an unreachable host, and shows no session list until there is data", () => {
    mockUsage(undefined, true);
    const tree = screen();
    expect(leafText(tree)).toContain("Usage is unavailable");
    expect(elements(tree).some((el) => el.type === Sessions)).toBe(false);
  });

  it("opens an agent from a session only where the app can navigate", () => {
    mockUsage(usage());
    const withoutNavigation = elements(screen()).find((el) => el.type === Sessions);
    expect(withoutNavigation?.props.onOpenAgent).toBeUndefined();

    const openAgent = vi.fn();
    const navigation = { openAgent, openWorkspace: vi.fn() };
    const withNavigation = elements(screen({ navigation } as never)).find(
      (el) => el.type === Sessions,
    );
    const open = withNavigation?.props.onOpenAgent as ((id: string) => void) | undefined;
    open?.("a1");
    expect(openAgent).toHaveBeenCalledWith({ agentId: "a1" });
  });
});

describe("sessions list", () => {
  const sessions = (list: Session[] | null, other = { cores: 0, rss: 0 }, onOpenAgent?: never) =>
    Sessions({ theme, sessions: list, other, onOpenAgent });

  it("says why there is no list on a host that cannot attribute processes", () => {
    expect(leafText(sessions(null))).toContain("needs a Linux host");
  });

  it("says when no agent is running anything", () => {
    expect(leafText(sessions([]))).toContain("No agent is running anything right now");
  });

  it("names the session, its workspace, what is running, and what it costs", () => {
    const tree = sessions([
      session({
        title: "Fix login",
        workspace: "main",
        command: "rustc",
        cores: 2.04,
        rss: 2.5 * 1024 ** 3,
        heavy: true,
      }),
    ]);
    const text = leafText(tree);
    expect(text).toContain("Fix login");
    expect(text).toContain("main · rustc");
    expect(text).toContain("2.0 cores");
    expect(text).toContain("2.5G");
    expect(elements(tree).some((el) => el.props.name === "Flame")).toBe(true);
  });

  it("falls back to a short agent id when the title is unknown, and omits a missing workspace", () => {
    const text = leafText(sessions([session({ workspace: null, command: "node" })]));
    expect(text).toContain("Agent 5daca96a");
    expect(text).not.toContain("·");
  });

  it("treats a blank title like a missing one", () => {
    expect(leafText(sessions([session({ title: "" })]))).toContain("Agent 5daca96a");
  });

  it("keeps a very long title on one line", () => {
    const tree = sessions([session({ title: "x".repeat(500) })]);
    const title = elements(tree).find((el) => el.type === "Text" && leafText(el).startsWith("xxx"));
    expect(title?.props.numberOfLines).toBe(1);
  });

  it("shows load that is not from any agent even when no agent is running anything", () => {
    const text = leafText(sessions([], { cores: 0.4, rss: 1024 ** 3 }));
    expect(text).toContain("No agent is running anything right now");
    expect(text).toContain("Everything else");
  });

  it("accounts for load that is not from any agent, only when there is some", () => {
    const some = leafText(sessions([session()], { cores: 0.4, rss: 1024 ** 3 }));
    expect(some).toContain("Everything else");
    expect(some).toContain("0.4 cores · 1.0G");
    expect(leafText(sessions([session()]))).not.toContain("Everything else");
    expect(leafText(sessions(null, { cores: 1, rss: 1 }))).not.toContain("Everything else");
  });

  it("opens the agent when pressed, and is not pressable without somewhere to go", () => {
    const onOpenAgent = vi.fn();
    const row = elements(sessions([session()], undefined, onOpenAgent as never)).find(
      (el) => el.type === "Pressable",
    );
    const press = row?.props.onPress as (() => void) | undefined;
    press?.();
    expect(onOpenAgent).toHaveBeenCalledWith("5daca96a-8cc2-44fc");

    const inert = elements(sessions([session()])).find((el) => el.type === "Pressable");
    expect(inert?.props.disabled).toBe(true);
  });
});
