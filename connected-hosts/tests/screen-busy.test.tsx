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

type Props = Record<string, unknown> & { children?: unknown };
type El = { type?: unknown; props?: Props } | unknown[] | null | undefined | string;
type Component = (props: Props) => El;

function collect(
  node: El,
  match: (props: Props) => boolean,
  out: Array<{ type: Component; props: Props }> = [],
) {
  if (Array.isArray(node)) for (const child of node) collect(child as El, match, out);
  else if (node && typeof node === "object" && node.props) {
    if (match(node.props)) out.push(node as { type: Component; props: Props });
    collect(node.props.children as El, match, out);
  }
  return out;
}

function render() {
  state.index = 0;
  return ConnectedHostsScreen({
    theme: { colors: {} },
    layout: { compact: false },
    host: { label: "x" },
  } as unknown as PluginScreenProps) as El;
}

// Expand each HostCard, then each Action, down to the Pressable and read its disabled prop.
function rows() {
  return collect(render(), (props) => "host" in props).map((card) => {
    const actions = collect(
      card.type(card.props),
      (props) => "onPress" in props && "label" in props,
    );
    return {
      onToggle: card.props.onToggle as () => Promise<void>,
      disabled: actions.map((action) => {
        const [pressable] = collect(
          action.type(action.props),
          (props) => "accessibilityRole" in props,
        );
        return pressable.props.disabled;
      }),
    };
  });
}

describe("ConnectedHostsScreen busy tracking", () => {
  it("keeps a row disabled until its own action settles", async () => {
    const pending: Array<() => void> = [];
    state.update.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    state.rerender = () => {};

    const [a, b] = rows();
    expect(a.disabled).toEqual([false, false, false]);
    const runA = a.onToggle();
    const runB = b.onToggle();
    const disabled = () => rows().map((row) => row.disabled);
    expect(disabled()).toEqual([
      [true, true, true],
      [true, true, true],
    ]);

    pending[0]();
    await runA;
    expect(disabled()).toEqual([
      [false, false, false],
      [true, true, true],
    ]);

    pending[1]();
    await runB;
    expect(disabled()).toEqual([
      [false, false, false],
      [false, false, false],
    ]);
  });
});
