import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  rerender: () => {},
  update: vi.fn(),
}));

vi.mock("react", async (importActual) => ({
  ...(await importActual<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const i = state.index++;
    state.slots[i] ??= initial;
    return [
      state.slots[i],
      (next: unknown) => {
        state.slots[i] =
          typeof next === "function" ? (next as (v: unknown) => unknown)(state.slots[i]) : next;
        state.rerender();
      },
    ];
  },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => ({ hosts: { update: state.update, remove: vi.fn() } }),
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  Icon: () => null,
  Modal: Object.assign(() => null, { Content: () => null }),
  ScrollView: () => null,
  TextInput: () => null,
  useToast: () => ({ show: vi.fn(), error: vi.fn() }),
}));
vi.mock("react-native", () => ({ Pressable: () => null, Text: () => null, View: () => null }));
vi.mock("../client/hosts", async (importActual) => ({
  ...(await importActual<typeof import("../client/hosts")>()),
  useHostDirectory: () => ({
    directory: {
      self: { label: "self" },
      hosts: [
        { registrationId: "a", enabled: true, metadata: {}, source: {} },
        { registrationId: "b", enabled: true, metadata: {}, source: {} },
      ],
    },
    error: null,
    retry: () => {},
  }),
}));

import { ConnectedHostsScreen } from "../client/screen";

type Props = { host?: { registrationId: string }; busy?: boolean; onToggle?: () => void };
type El = { props?: Props & { children?: unknown } } | unknown[] | null | undefined | string;

function cards(node: El, out: Props[] = []): Props[] {
  if (Array.isArray(node)) for (const child of node) cards(child as El, out);
  else if (node && typeof node === "object" && node.props) {
    if (node.props.host) out.push(node.props);
    cards(node.props.children as El, out);
  }
  return out;
}

function render() {
  state.index = 0;
  return cards(
    ConnectedHostsScreen({
      theme: { colors: {} },
      layout: { compact: false },
      host: { label: "x" },
    } as unknown as PluginScreenProps) as El,
  );
}

describe("ConnectedHostsScreen busy tracking", () => {
  it("keeps a row disabled until its own action settles", async () => {
    const pending: Array<() => void> = [];
    state.update.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    state.rerender = () => {};

    const [a, b] = render();
    const runA = a.onToggle?.();
    const runB = b.onToggle?.();
    const busy = () => render().map((card) => card.busy);
    expect(busy()).toEqual([true, true]);

    pending[0]();
    await runA;
    expect(busy()).toEqual([false, true]);

    pending[1]();
    await runB;
    expect(busy()).toEqual([false, false]);
  });
});
