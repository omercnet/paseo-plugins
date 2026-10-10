/** Minimal public RN leaf mapping for the opt-in density DOM fixture. */
const { createRequire } = require("node:module");
const { join } = require("node:path");
const dependency = createRequire(
  join(process.env.SHARED_BROWSER_MOUNTED_TOOLING_ROOT, "package.json"),
);
const React = dependency("react");
exports.View = ({ children }) => React.createElement("div", null, children);
exports.Text = ({ children }) => React.createElement("span", null, children);
exports.Pressable = (props) =>
  React.createElement(
    "button",
    {
      disabled: props.disabled,
      "aria-label": props.accessibilityLabel,
      "aria-selected": props.accessibilityState?.selected,
      onClick: props.onPress,
    },
    props.children,
  );
exports.StyleSheet = { create: (styles) => styles };
