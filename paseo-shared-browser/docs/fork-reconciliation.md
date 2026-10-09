# Shared Browser interaction and display integration

This document records the contracts behind the interaction and display changes
on the Shared Browser 1.2 runtime. Installation and controls are documented in
[README](../README.md). Input caveats and primary sources are documented in
[input-forwarding-notes](input-forwarding-notes.md).

## Upstream contracts retained

- Reuse upstream contained-image pointer mapping. CSS coordinates remain
  independent of device pixel ratio and capture density.
- Retain the discrete-input frame epoch gate and viewport-resync checks. A
  malformed or superseded capture cannot trigger emulation recovery.
- Preserve sidebar and MCP integration, plugin identity, catalog dependencies
  and package version. Release Please continues to own release metadata.
- Require the SDK generation used by upstream's sidebar and server APIs:
  stable Paseo 0.11 and the explicitly tested 0.11.0-beta.3 allowance.

## Input and presentation ownership

Human input uses ordered gesture channels. Motion can coalesce only without
crossing a press, release, key or text transition. Ownership loss, page changes
and viewport replacement cancel held state. No published action is replayed
when its acknowledgement is uncertain. Agent commands remain fresh-frame bound.

A decoded image and its targeting receipt settle together. Late image loads
cannot replace a newer paint. Cached pixels may avoid a redundant payload only
under matching runtime, bridge, navigation, viewport and quality authority;
source age and input invalidation still apply.

Fit and Actual size are local viewer choices. Actual size uses CSS dimensions,
not sharper image dimensions. Overflow is measured independently per axis, and
container geometry changes cancel active gestures. Observing phone users can
pan locally; controlling phone users send their gestures to the remote page.

Shared emulation changes preserve viewport dimensions. Device defaults apply
only on first human control, so an observer cannot resize another user's page.
Native-phone composition is explicitly committed rather than applied as remote
caret edits when the operating system changes a local draft.

## Linux hover capability

Headless Chromium may report no desktop pointer/hover capability even after
touch emulation is disabled. When Xvfb is available, an owned private display
supplies genuine desktop capability without reloading the document on mode
changes. It uses authenticated abstract Unix transport and disables TCP and
pathname listeners. The display is stopped with its browser. Other platforms
or missing Xvfb retain existing launch behavior.

## Verification boundaries

Run the suite, formatting, TypeScript and real browser smoke from the active
checkout. Use the isolated runtime workflow in README. Test profiles, runtime
assets and credentials must never enter the source tree.

Unit fixtures cover input ordering, frame authority and local geometry. Owned
Chromium fixtures cover native input and display lifecycle. These checks do not
establish physical-phone software keyboard behavior or latency through every
network topology; those require direct device observation.
