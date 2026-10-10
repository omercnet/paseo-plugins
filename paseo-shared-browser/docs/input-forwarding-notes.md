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

Native phone typing has no live software-keyboard relay: it is unverified on
physical devices. Native and compact-web layouts offer a visible Compose draft
inserted once by an explicit Done. Phone hardware shortcuts are unsupported.

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
are never replayed. Discrete MCP input requires a frame under five seconds old
at initial admission. An admitted operation retains its exact control,
document, frame revision, viewport, runtime and bridge context through compound
release; elapsed frame age alone cannot turn a published click into a stale
failure. Native idle expiry and unknown outcomes remain separate failures, and
neither grants replay. This is a different path from the human pane's ordered
gesture channel.

Capture reconciles document metadata before and after obtaining pixels. Changed
identity or failed metadata refuses the capture before issuing authority. Its
deadline still starts when the pixels are received, so metadata latency cannot
extend the five-second observation window or return an already expired token.

## Evidence and remaining acceptance

Actual isolated Chromium checks cover trusted typing, Unicode, repeat, shortcuts,
focus traversal, Ctrl+click and held-key cleanup. Mounted DOM checks cover IME,
AltGraph, Option insertion, paste and control replacement. Native phone Compose
has no physical-device software-keyboard acceptance. Human pane scrollbar dragging was confirmed.

Deterministic policy fixtures cover delayed capture validation, document and
attachment changes, control expiry and unknown publication. Actual native
fixtures confirm an admitted operation can exceed five seconds in total while
retaining the separate native idle limit; idle expiry releases once and grants
no replay.

Headless Linux Chromium can lack pointer/hover media even when mouse events work.
Opt-in private Xvfb support is documented separately in README.

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
