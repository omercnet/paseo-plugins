/** Public RN/SDK leaf doubles; production panel, Query, queue and input listeners stay real. */
const React = require(
  require("node:path").join(globalThis.panelFixtureToolingRoot, "node_modules/react"),
);
const Native = {
  Platform: { OS: "web" },
  AppState: {
    currentState: "active",
    addEventListener() {
      return { remove() {} };
    },
  },
  PanResponder: {
    create(callbacks) {
      return { panHandlers: callbacks };
    },
  },
};
const flat = (style) =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flat)) : (style ?? {});
const rnStyle = (style) => {
  const out = { display: "flex", flexDirection: "column", ...flat(style) };
  for (const key of ["elevation", "paddingHorizontal", "paddingVertical", "marginVertical"])
    delete out[key];
  return out;
};
const assign = (ref, value) => {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
};
const View = React.forwardRef((props, ref) => {
  const local = React.useRef(null);
  const callback = React.useCallback(
    (node) => {
      local.current = node;
      if (node) {
        node.measureInWindow = (cb) =>
          node.querySelector(":scope > button") ? cb(740, 8, 28, 28) : cb(0, 0, 800, 600);
        node.scrollTo = (opts) => {
          node.scrollLeft = opts.x ?? node.scrollLeft;
          node.scrollTop = opts.y ?? node.scrollTop;
        };
        node.getScrollableNode = () => node;
      }
      assign(ref, node);
    },
    [ref],
  );
  React.useLayoutEffect(() => {
    props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 600 } } });
  }, [props.onLayout]);
  return React.createElement(
    "div",
    {
      ref: callback,
      role: props.accessibilityRole,
      "aria-label": props.accessibilityLabel,
      "data-kind": "view",
      style: rnStyle(props.style),
    },
    props.children,
  );
});
const Pressable = React.forwardRef((props, ref) =>
  React.createElement(
    "button",
    {
      ref,
      role: props.accessibilityRole,
      "aria-label": props.accessibilityLabel,
      "aria-expanded": props.accessibilityState?.expanded,
      "aria-disabled": props.accessibilityState?.disabled,
      "aria-selected": props.accessibilityState?.selected,
      disabled: props.disabled,
      onClick: props.onPress,
      onFocus: props.onFocus,
      onBlur: props.onBlur,
      tabIndex: props.focusable === false ? -1 : undefined,
      style: rnStyle(
        typeof props.style === "function" ? props.style({ pressed: false }) : props.style,
      ),
    },
    props.children,
  ),
);
const ScrollView = React.forwardRef((props, ref) =>
  React.createElement(
    View,
    { ref, style: props.style, "data-kind": "scroll" },
    React.createElement(
      "div",
      { "data-kind": "scroll-content", style: rnStyle(props.contentContainerStyle) },
      props.children,
    ),
  ),
);
const Text = (props) =>
  React.createElement(
    "span",
    {
      role: props.accessibilityRole,
      "aria-label": props.accessibilityLabel,
      style: rnStyle(props.style),
    },
    props.children,
  );
const TextInput = React.forwardRef((props, ref) =>
  React.createElement("input", {
    ref,
    "aria-label": props.accessibilityLabel,
    value: props.value ?? "",
    readOnly: true,
    placeholder: props.placeholder,
  }),
);
const Modal = (props) =>
  props.open ? React.createElement("section", { "aria-label": props.title }, props.children) : null;
Modal.Content = View;
const query = {
  data: undefined,
  isPending: false,
  isError: false,
  error: null,
  refetch: async () => ({}),
};
const rpc = async () => ({});
module.exports = {
  ...Native,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Modal,
  Image: View,
  ActivityIndicator: View,
  StyleSheet: {
    create: (s) => s,
    absoluteFillObject: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  },
  Icon: ({ name }) => React.createElement("i", { "data-icon": name }),
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  defineRpc: (d) => d,
  defineSettings: (d) => d,
  useRpc: () => rpc,
  useQuery: () => query,
  useMutation: () => ({ isPending: false, mutate: () => {}, mutateAsync: rpc }),
  useSettings: () => ({
    status: "ready",
    values: { favoritePresetIds: [], captureQuality: "high" },
    revision: "r1",
    saving: false,
    saveError: null,
    save: async () => true,
    reload: async () => {},
    reset: async () => true,
  }),
};
