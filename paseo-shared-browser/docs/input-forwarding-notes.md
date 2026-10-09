# Input forwarding constraints and checks

The shared canvas forwards input only while its viewer owns control. Page state
survives display-mode changes. Control loss, focus loss, navigation and display
changes release held input against its original browser attachment. Never replay
an action whose publication or outcome is uncertain.

## Keyboard and text

Physical keys carry key/code, modifiers, repeat and press/release edges. Committed
text uses Chromium's separate insertion operation. Dead keys, AltGraph, Option
text and composition cannot be inferred reliably from a printable key alone.
The web relay uses DOM composition and insertion evidence to avoid duplicate or
lost text. Tab changes remote focus while the local relay keeps receiving keys.
Paseo inputs outside the focused canvas remain local.

Native phone typing uses an invisible TextInput with autocorrection disabled.
Only basic append/backspace operations are live. Complex IME text is composed
locally and inserted once with Done. React Native provides no portable explicit
composition-commit boundary; replacement diffs must not delete unknown remote
text. Android TextInput key callbacks do not expose the full hardware-key stream.
Phone hardware shortcuts therefore remain unverified and unsupported by this relay.

Local plain-text paste is forwarded. Copy/cut target the remote browser clipboard;
there is no remote-to-local clipboard synchronization. Browser and operating-system
reserved shortcuts may remain local. Global keyboard lock is not used.

## Mouse, touch and scrolling

Coordinates use the displayed image rectangle and CSS viewport, not image pixels
or device pixel ratio. Mouse movement carries both the held button and button
mask: native scrollbar dragging fails if movement reports button:none despite a
held left button. Hover, wheel and held drags use ordered continuous input.

Touch routes retain contact identities and cancel on ownership changes. Avoid
forwarding synthesized compatibility mouse events a second time. Canvas-scoped
non-passive listeners and touch-action control avoid scrolling the host while
allowing host controls outside the canvas to work normally.

Right-click forwards native page input and suppresses the local viewer context
menu. This does not guarantee that Chromium browser chrome context menus appear
in page screenshots. Native mouse dragging is distinct from HTML5 data-transfer
drag/drop; file-drop and cross-application drag payloads are not implemented.

A stale decoded frame can fail initial admission. Only confirmed unpublished
admission is refreshed and retried within one bounded budget. Published updates
are never replayed. Discrete MCP input retains its strict frame validation and is
a different path from the human pane's ordered gesture channel.

## Evidence and remaining acceptance

Actual isolated Chromium checks cover trusted typing, Unicode, repeat, shortcuts,
focus traversal, Ctrl+click and held-key cleanup. Mounted DOM checks cover IME,
AltGraph, Option insertion, paste and control replacement. Native phone relay
checks validate event routing and lifecycle, but do not replace physical-device
software-keyboard acceptance. Human pane scrollbar dragging was confirmed.

Headless Linux Chromium can lack pointer/hover media even when mouse events work.
When existing Xvfb is available, a private authenticated display supplies native
desktop mouse capabilities and survives touch-disable and CDP reconnect. Desktop
-> phone -> desktop preserves the current document and draft. Missing Xvfb retains
headless behavior; other operating systems are outside this verified correction.
Do not compensate by changing PrintStream styling or resetting the page per toggle.

## Primary references

- [Chromium Input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/): key/text and mouse/touch contracts.
- [Playwright input](https://playwright.dev/docs/input): drag/drop event sequencing and native input operations.
- [Playwright keyboard](https://playwright.dev/docs/api/class-keyboard): text insertion differs from physical keys.
- [React Native TextInput](https://reactnative.dev/docs/textinput): native text/key events and platform limitations.
- [W3C Pointer Events](https://www.w3.org/TR/pointerevents/): touch-action, cancellation and compatibility mouse events.
- [W3C UI Events](https://www.w3.org/TR/uievents/): key, code, modifiers and composition.
- [Keyboard API](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard_API): platform availability and reserved-key constraints.

These are engineering constraints, not evidence of the upstream author's reasons
for choosing the previous controls.
