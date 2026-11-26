import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "../shared/browser";

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  render: () => {},
  dirty: false,
}));

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] =
          typeof next === "function"
            ? (next as (previous: unknown) => unknown)(hooks.slots[index])
            : next;
        hooks.dirty = true;
      },
    ];
  },
  useCallback: (callback: unknown) => {
    hooks.index++;
    return callback;
  },
  useMemo: (factory: () => unknown) => {
    hooks.index++;
    return factory();
  },
  useEffect: () => {
    hooks.index++;
  },
  useLayoutEffect: () => {
    hooks.index++;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  AppState: {},
  useWindowDimensions: () => ({ scale: 1 }),
  View: "View",
  Text: "Text",
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Modal: {}, Icon: "Icon" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => vi.fn(),
  useTabState: (_tab: unknown, _schema: unknown, fallback: unknown) => [fallback, vi.fn()],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
  useQuery: (options: { queryKey: string[] }) => {
    const data =
      options.queryKey[1] === "attach" ? { viewerToken: "v".repeat(32), state } : { tabs: [] };
    return { data, error: null, isPending: false, isFetching: false, refetch: vi.fn() };
  },
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("./browser-tabs", () => ({ BrowserTabs: "BrowserTabs" }));
vi.mock("./browser-chrome", () => ({
  ChromeIconButton: "ChromeIconButton",
  ControlButton: "ControlButton",
  CanvasPlaceholder: "CanvasPlaceholder",
  ErrorNotice: "ErrorNotice",
  Field: "Field",
}));
vi.mock("./browser-compose-controls", () => ({ ComposeTextControls: "ComposeTextControls" }));
vi.mock("./browser-toolbar-menu", () => ({
  BrowserToolbarMenu: "BrowserToolbarMenu",
  BrowserMenuItem: "BrowserMenuItem",
  BrowserMenuHeading: "BrowserMenuHeading",
  BrowserMenuSeparator: "BrowserMenuSeparator",
}));
vi.mock("./browser-control-dialog", () => ({ BrowserControlDialog: "BrowserControlDialog" }));
vi.mock("./browser-frame-image", () => ({ BrowserFrameImage: "BrowserFrameImage" }));
vi.mock("./browser-canvas-viewport", () => ({ BrowserCanvasViewport: "BrowserCanvasViewport" }));
vi.mock("./browser-video-surface", () => ({ BrowserVideoSurface: null }));
vi.mock("./browser-resolution-picker", () => ({ BrowserResolutionPicker: null }));
vi.mock("./use-browser-video", () => ({
  useBrowserVideo: () => ({
    supported: false,
    active: false,
    error: null,
    errorViewerToken: null,
    refresh: vi.fn(),
    retry: vi.fn(),
    front: null,
    frontRef: { current: null },
  }),
}));
vi.mock("./use-browser-image-capture", () => ({
  useBrowserImageCapture: () => ({
    query: { data: undefined, error: null, isPending: true, isFetching: false },
    refreshCapture: vi.fn(),
    retryFrameCapture: vi.fn(),
  }),
}));
vi.mock("./use-browser-canvas-input", () => ({ useBrowserCanvasInput: () => ({}) }));
vi.mock("./use-resolution-favorites", () => ({
  useResolutionFavorites: () => ({ favoritePresetIds: [] }),
}));

import { SharedBrowserPanel } from "./browser";

const props = {
  theme: { colors: new Proxy({}, { get: () => "#777" }) },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "android" },
  workspaceId: "workspace",
  tab: {},
} as PluginWorkspacePanelProps;
const state = {} as BrowserState;
let tree: ReturnType<typeof SharedBrowserPanel>;
function render(platform: "android" | "web" = "android") {
  props.layout.platform = platform;
  hooks.index = 0;
  hooks.dirty = false;
  tree = SharedBrowserPanel(props);
}

type TestElement = ReactElement<Record<string, unknown>>;
function typeName(type: unknown) {
  return typeof type === "function" ? type.name : type;
}

function find(node: unknown, label: string, type?: string) {
  const matches: Array<Record<string, unknown>> = [];
  const stack: unknown[] = [node];
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    const element = current as TestElement;
    const name = typeof element.type === "function" ? element.type.name : element.type;
    if (
      (element.props.label === label || element.props.accessibilityLabel === label) &&
      (!type || name === type)
    )
      matches.push(element.props);
    const submenu = element.props.submenu as { children?: unknown } | undefined;
    stack.unshift(element.props.children, submenu?.children);
  }
  return matches[0] ?? null;
}

beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
});

describe("native compose toolbar action", () => {
  it("is present on native and not on web", () => {
    render("android");
    expect(find(tree, "Compose text", "ChromeIconButton")).toMatchObject({
      icon: "Pencil",
      touchTarget: true,
    });
    render("web");
    expect(find(tree, "Compose text", "ChromeIconButton")).toBeNull();
  });
  it("uses the same handler in the native toolbar and menu", () => {
    render("android");
    const toolbar = find(tree, "Compose text", "ChromeIconButton");
    expect(toolbar?.onPress).toBeTypeOf("function");
    const browserMenu = find(tree, "Browser menu", "ChromeIconButton");
    if (typeof browserMenu?.onPress !== "function") throw new Error("Missing browser menu handler");
    browserMenu.onPress();
    render("android");
    const menu = find(tree, "Compose text", "BrowserMenuItem");
    expect(find(tree, "Compose text", "ChromeIconButton")?.onPress).toBe(menu?.onPress);
  });
});
