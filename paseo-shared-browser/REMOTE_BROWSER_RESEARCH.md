# Shared Browser: established remote-control designs and dropped-click research

Research date: 2026-10-03 (America/Toronto).
Status: continuous human input implemented. Network and native-phone latency require separate measurement.

## Recommendation

Use the established remote-control input model for the human pane: an ordered
input channel owned by the current controller and browser geometry, independent
of individual video frames. Retain explicit screenshot/frame targeting for
agent commands. Fix the demonstrated visual-frame/input-frame waiter mismatch
as part of that separation, rather than adding longer capture waits.

Evaluate native browser WebRTC media from the existing tab-capture track next.
Compare it against a binary stream carried through Paseo's authenticated relay.
Select by measured interaction latency, clarity and relay compatibility, not
by assuming WebRTC solves input policy or guarantees sharper text.

Continuous human input intentionally allows normal presses without requiring
pixels captured after the preceding press. A remote display can
lag the page, as in ordinary remote desktop. Keep controller, exact target,
geometry, visibility, replacement-page and disconnect fences. Do not silently
change agent screenshot-targeting semantics or replay clicks after timeouts.

## Demonstrated failure path matching the reported error

The preceding human channel inherited frame-target rules from discrete browser
automation. Every new mouse/touch press needs a decoded targeting receipt.
After non-hover input the server clears recent receipts and imposes a
post-input capture-time floor. The client also invalidates its input revision.
This creates a required trip through capture, transport, decode and React
presentation between successive independent presses.

A second, narrower mismatch is demonstrated in the production panel:

1. The rapid-input fix allows a delayed read to paint if its source, document
   and geometry remain current. This preserves video continuity.
2. That paint retains its old input revision and correctly cannot authorize a
   new press.
3. The canvas input hook's waiter watches a changed *visible* frame ID instead
   of a changed actionable targeting receipt.
4. It wakes, the queue finds no current targeting authority, and emits
   `A current decoded frame is required for a new press.`

A disposable mounted React/Query reproduction used the real panel and a DOM
mouse-down. It produced that exact error, sent zero gesture updates, and kept
Video visible. This confirms a rejected unsent press, not proof of a lost
published native click. The reproduction did not access the live browser.
Fixing only its waiter would avoid premature rejection but retain deliberate
frame-per-press delays. Increasing the four-second wait would not remove that
coupling.

Relevant local owners:

- `client/browser.tsx`: passes visible decoded frame identity to the canvas hook.
- `client/use-browser-video.ts`: permits same-source visual continuity but
  retains the original read revision for input authority.
- `client/use-browser-canvas-input.ts`: resolves waiters when visible frame ID changes.
- `client/browser-input-queue.ts`: awaits targeting receipts and each gesture RPC.
- `server/browser-policy.ts`: requires recent press targets, clears receipts
  after input, and applies the source-clock floor.

The failure description records the behavior before continuous admission was
implemented. The current implementation separates presentation from initial
input admission and is covered by the mounted panel fixtures.

## Established implementations

These are primary-source findings. They describe the reviewed paths, not a
claim that every project is free of race conditions or input bugs.

| System | Input and display relationship | What is reusable | Cost of adopting the whole system |
| --- | --- | --- | --- |
| Chrome DevTools screencast | CDP events use decoded screen scale/offset; ordinary input does not wait for a new image after each event. | Closest source reference for our CDP coordinate mapping, modifiers, click count and drag geometry. | Frontend depends on DevTools SDK and UI, so importing the whole panel is inappropriate. |
| noVNC | Connection/view-only gates and framebuffer coordinates govern pointer sends; render flushing is separate. | Mature keyboard, cursor, gesture and RFB client code. | Requires an RFB/VNC server and normally a WebSocket gateway, replacing our tab-capture/CDP backend. |
| KasmVNC | Connected/view-only input is separate from its bounded asynchronous display queue. | Browser fork and media queue patterns. | Full use adds an Xvnc backend and protocol extensions; browser core is MPL-2.0, server GPLv2. |
| Apache Guacamole | Input sends are tunnel/session based; display flush and sync acknowledge rendering separately. | Standalone JavaScript client and input/display primitives. | Full use adds guacd plus a supported remote desktop backend and authenticated tunnel integration. |
| Selkies | Current design defaults to WebSocket/WebCodecs; WebRTC is optional. Human input is separately sequenced and gated by controller/token state. | Closest architectural reference for bounded streaming, input ordering, workers and WebCodecs. | Full runtime adds Linux display capture/input, Python and Rust media components. |
| Neko | WebRTC browser streaming with current host ownership and overlay-to-remote coordinate mapping. | Strong reference for shared control, native cursor and media/data separation. | Complete system adds a containerized desktop, Go/GStreamer/X11 and its room/session model. |
| Epic Pixel Streaming | Mouse handlers check video readiness, then send structured events; no decoded-frame ID on each press. | MIT TypeScript input/coordinate and WebRTC player references. | Complete player and server speak Unreal-specific signaling/messages, not our CDP protocol. |
| Chromium remoting | Host event dispatch validates incoming event fields and injects them, with event timing separate from display rendering. | Reference for input ordering, held-state cleanup and transport backpressure. | Chromium remoting is a substantial native subsystem, not a small embeddable Node library. |

### Closest reference: Chrome DevTools

In the inspected screencast, image load updates screen scale/offset. Mouse and
wheel handlers forward through `InputModel`; input does not invalidate that
mapping until another image arrives. A drag retains its starting vertical
mapping until release. Profiling/inactive-target overlays can block input.
This is readiness and mapping, not an after-every-input freshness protocol.

Reviewed pinned source:
[InputModel](https://github.com/ChromeDevTools/devtools-frontend/blob/ae714aac9f0a7c8683fa4dff5a7dcaf55c233ad4/front_end/panels/screencast/InputModel.ts),
[ScreencastView](https://github.com/ChromeDevTools/devtools-frontend/blob/ae714aac9f0a7c8683fa4dff5a7dcaf55c233ad4/front_end/panels/screencast/ScreencastView.ts).
Both carry Chromium's BSD-style source notice. Treat them as a reference or
carefully attributed small extraction, not an interchangeable frontend package.

### Rendering acknowledgements are not input admission

In released noVNC 1.7.0, pointer sends check connection and view-only state;
button handlers flush pending motion before a transition. The inbound render
flush path is separate. In Guacamole 1.6.0, mouse/key/touch sends use session
readiness and display scaling, while display flush/sync acknowledges rendered
operations. Neither reviewed send path demands a decoded frame token per press.
Guacamole touch availability still depends on the remote backend.

Primary sources:
[noVNC 1.7.0 RFB](https://github.com/novnc/noVNC/blob/63107bd06d9e1f6136ff21aeda8cd62cbf0d433e/core/rfb.js#L1172-L1225),
[Guacamole 1.6.0 client](https://github.com/apache/guacamole-client/blob/0537c89cd783681b986ff8f8c4e0b97ec6873371/guacamole-common-js/src/main/webapp/modules/Client.js#L328-L430),
[Guacamole JavaScript integration](https://guacamole.apache.org/doc/gug/guacamole-common-js.html).
An RFB fence or display sync is not our exact browser-document receipt policy;
copying a protocol component would not preserve that policy automatically.

KasmVNC's exact browser submodule similarly separates mouse sends from its
three-slot asynchronous frame queue, which can discard incomplete older display
frames. Its [input path](https://github.com/kasmtech/noVNC/blob/1746dfe9ed8084aee57b55c720ef00d4d7c26513/core/rfb.js#L2484-L2508)
and [display drop handling](https://github.com/kasmtech/noVNC/blob/1746dfe9ed8084aee57b55c720ef00d4d7c26513/core/display.js#L1146-L1223)
are useful references. The browser [MPL-2.0 license](https://github.com/kasmtech/noVNC/blob/1746dfe9ed8084aee57b55c720ef00d4d7c26513/LICENSE.txt)
and server [GPLv2 license](https://github.com/kasmtech/KasmVNC/blob/39b94e68ddc302dd896008b04a71e6115eb62d06/LICENSE.TXT)
are separate; adopting the full stack is a packaging/licensing choice.

### Input ordering is a separate contract

Selkies' reviewed WebRTC code uses an ordered input channel and a separate
unordered pointer channel, plus sequence checks. Its bounded 512-message input
queue can discard messages when overloaded. Neko's reviewed client sends
ordered reliable binary events, positions before button transitions, and checks
host ownership on the server. Neither path carries a per-click decoded-frame
ID. These are useful designs, not unconditional no-loss guarantees or proof of
our stronger document/geometry fencing.

Pinned primary sources:
[Selkies channels](https://github.com/selkies-project/selkies/blob/5927ca77b1fc31d43ebca096b2aa59e35bbb128f/src/selkies/webrtc_engine.py#L2536-L2564),
[Selkies input queue](https://github.com/selkies-project/selkies/blob/5927ca77b1fc31d43ebca096b2aa59e35bbb128f/src/selkies/webrtc_engine.py#L2030-L2075),
[Neko client transport](https://github.com/m1k1o/neko/blob/bdd0428a607ccfd22eebabc74b85ae17a4cb42d5/client/src/neko/base.ts#L187-L245),
[Neko controller gate](https://github.com/m1k1o/neko/blob/bdd0428a607ccfd22eebabc74b85ae17a4cb42d5/server/internal/webrtc/handler.go#L16-L100).

### Video readiness is not press freshness

Pixel Streaming's `isVideoReady()` checks the media element's `readyState > 0`.
Mouse-down/up/wheel then send normalized messages, without a last-decoded-frame
token. Its default data channel is ordered. This supports an established stream
being interactive while rendering catches up, not the stronger promise that a
press targets the pixels most recently captured after another press.

Reviewed pinned source:
[VideoPlayer](https://github.com/EpicGames/PixelStreamingInfrastructure/blob/85f15cb354c8ccbfa1e8f20d9600e4d75dbce492/Frontend/library/src/VideoPlayer/VideoPlayer.ts),
[hovering mouse controller](https://github.com/EpicGames/PixelStreamingInfrastructure/blob/85f15cb354c8ccbfa1e8f20d9600e4d75dbce492/Frontend/library/src/Inputs/MouseControllerHovering.ts),
[data channel](https://github.com/EpicGames/PixelStreamingInfrastructure/blob/85f15cb354c8ccbfa1e8f20d9600e4d75dbce492/Frontend/library/src/DataChannel/DataChannelController.ts).
Its [MIT infrastructure license](https://github.com/EpicGames/PixelStreamingInfrastructure/blob/85f15cb354c8ccbfa1e8f20d9600e4d75dbce492/LICENSE.md)
is distinct from licensing the Unreal Engine application.

## Design changes worth adopting

### Separate control readiness from frame targeting

Initial human channel admission should require a decoded current source and
geometry basis, as it does today. The channel should establish exact workspace/viewer/controller,
browser incarnation, target, document policy and CSS viewport mapping once.
Subsequent pointer/key transitions use ordered sequence numbers and that control
context. Video decoding may lag without revoking every independent press.
A viewer without control still cannot inject events.

Agent click tools retain their explicit frame receipts. Server authorization
must enforce the distinction; do not add a caller-selected flag that turns an
agent request into unchecked human input. A human session can require a
controller-owned admission token issued for the pane and its displayed geometry.

Maintain separate values for visible frame, actionable agent receipt and
human channel readiness. A visible old-read frame must neither invent an agent
receipt nor falsely resolve a wait for one. Renderer state should report video
stall separately from control ownership. A genuinely disconnected/frozen source
can disable new input under an explicit session policy; an ordinary view update
must not be treated as a disconnect.

### Preserve transitions; coalesce motion

Mouse down/up, key down/up, text commits, touch start/end and cancellation are
ordered transitions. Never drop one because the next video frame is pending.
Coalesce only compatible moves or wheel deltas within the same control context,
without crossing a press/release or document/viewport boundary. Flush preceding
motion before a transition so the press lands at the intended coordinates.

Held input needs pointer capture and a release path even when the pointer leaves
the pane. Blur, controller loss, teardown and rejected sequences release held
state. Double-click forwarding must not synthesize a duplicate press from both
DOM down/up and the `dblclick` callback.

### Do not turn input into a chain of network round trips

Our queue awaits each update RPC before sending the next. That is an additional
throughput limit even after frame coupling is removed. For an event stream whose
individual request/response round trip is R, that loop cannot exceed roughly
1/R acknowledged updates per second. This is a design inference, not a measured
relay RTT or observed throughput result.

Use a bounded ordered stream or bounded event batches, with sequence
acknowledgements, instead of waiting for a separate round trip after every key
and mouse transition. The server still serializes native injection. Disconnect
or uncertain publication terminates the channel; it never replays presses.
Queue pressure must release/cancel cleanly rather than accumulating seconds of
old clicks that later fire on a changed page.

## Streaming choices and actual reuse candidates

### A. Native WebRTC from the existing Chromium tab capture

The extension already owns an exact-tab `MediaStream`. A prototype can pass its
video track to `RTCPeerConnection`, display the receiver's media track in a
web-only adapter, and use existing authenticated Paseo RPC for signaling.
This would let the browser own media packetization, congestion response,
keyframe recovery and playout instead of our custom encoded packet reader.
This is a proposed fit, not a proved drop-in or a measured latency improvement.

The [tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
provides the capture primitive. WebRTC still needs authenticated negotiation,
viewer/controller fencing and source identity. Direct ICE paths may work on
LANs; remote relay users require TURN coverage for networks that cannot connect
peers. Paseo's current application relay is not automatically a TURN relay.
[WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server).

Start with browser-to-browser peers so no Node media engine is needed merely
for forwarding an existing browser track. Keep native phone JPEG fallback as
previously agreed. Test the current capture quality ceiling: RTP cannot recover
colour detail already lost before transmission.

### B. Binary WebSocket or SDK stream with WebCodecs

Selkies shows this is a viable primary design, not inherently a lesser fallback.
Its current [design](https://github.com/selkies-project/selkies/blob/5927ca77b1fc31d43ebca096b2aa59e35bbb128f/docs/design.md)
uses WebSockets by default and WebRTC optionally. Its [web client](https://docs.selkies.io/latest/components/web-client)
separates streaming/input and uses worker components. We should compare a binary
stream and bounded decode pipeline with native WebRTC under identical load.

Our current media is base64 in JSON RPC replies. Base64 represents three bytes
as four characters before JSON/envelope overhead. Removing that conversion and
request/response scheduling is a concrete optimization candidate; how much it
helps requires profiling. A binary stream needs Paseo authentication and remote
relay support, not an anonymously exposed localhost socket.

### C. Existing whole remote-desktop stack

Adopting noVNC, Guacamole, Selkies or Neko can replace substantial custom code.
They also replace substantial backend behavior: OS-level desktop capture/input,
new server dependencies, authentication wiring and browser lifecycle ownership.
They do not transparently preserve our exact-tab CDP operations, independent
native emulation, or agent screenshot contracts.

Benchmark Selkies and Neko in disposable containers if considering this route.
Do not migrate the user's profile into a new backend as a research shortcut.
An isolated integration would need to show it can retain workspace ownership,
agent tools and mobile fallback before choosing the whole-stack option.

Selkies' [licensing inventory](https://github.com/selkies-project/selkies/blob/5927ca77b1fc31d43ebca096b2aa59e35bbb128f/docs/licensing.md)
identifies MPL-2.0 project code and encoder-dependent components. Neko's
[license](https://github.com/m1k1o/neko/blob/bdd0428a607ccfd22eebabc74b85ae17a4cb42d5/LICENSE)
is Apache-2.0. Dependency and distribution obligations need separate review.

### Library shortlist

Current stable versions were read from the npm registry on the research date;
no dependency was installed. Recheck metadata before implementation.

| Candidate | Registry stable / license | Use and limitation |
| --- | --- | --- |
| `@novnc/novnc` | 1.7.0 / MPL-2.0 | Actual reusable RFB client; requires an RFB backend, not a CDP or WebRTC adapter. |
| Guacamole JavaScript client | Source module / Apache-2.0 | Reusable input/display/tunnel modules; full remote protocol needs a guacd/backend integration. |
| `simple-peer` | 9.11.1 / MIT | Browser peer/signaling convenience; does not implement remote input, capture, TURN deployment or our authorization. Its Node-style dependencies need SDK/bundling review. |
| `werift` | 0.24.4 / MIT | TypeScript Node WebRTC if a server terminates media; unnecessary for initial browser-to-browser capture. Published metadata says Node >=16; development README says >=22, so do not conflate them. |
| `node-datachannel` | 0.33.4 / MPL 2.0 | Native Node/libdatachannel media/data transport; adds native binary packaging and platform support work. |
| `@epicgames-ps/lib-pixelstreamingfrontend-ue5.8` | 0.1.2 / MIT | A real streaming frontend library, but its Unreal-specific message/signaling model makes it a reference rather than a natural whole import. |
| Pixelflux | Source/native component | Reusable Linux capture/encoder pipeline behind Selkies; Rust/Python and display capture differ from our current tab track. Encoder license depends on the build. |

Primary library sources:
[noVNC](https://github.com/novnc/noVNC),
[Guacamole client](https://github.com/apache/guacamole-client),
[simple-peer](https://github.com/feross/simple-peer),
[werift](https://github.com/shinyoshiaki/werift-webrtc),
[node-datachannel](https://github.com/murat-dogan/node-datachannel),
[Pixel Streaming](https://github.com/EpicGames/PixelStreamingInfrastructure),
[Pixelflux](https://github.com/selkies-project/pixelflux).

For Pixelflux, the default x264-enabled build carries GPL components; an
OpenH264 build can avoid that encoder dependency. Check the entire distribution
and license notices before redistribution, not just a top-level library name.

## Gotchas the references make concrete

- **Ordered input is separate from video.** Use reliable ordering for
  presses/releases and committed text. An unordered move channel would need
  sequence-aware reconciliation before any transition; do not introduce one
  merely because WebRTC permits it.
- **WebRTC still buffers.** `bufferedAmount`, channel size limits, ICE failure,
  playout/jitter and codec support remain real. Chromium's
  [data-stream adapter](https://chromium.googlesource.com/chromium/src/+/main/remoting/protocol/webrtc_data_stream_adapter.cc)
  uses its own send queue to avoid overrunning lower-layer buffering.
- **Resize mapping can race.** Use current CSS geometry, not JPEG pixel size or
  device pixel density. Reject old geometry on replacement, retain admitted
  drag coordinates through release, and qualify the first new mapping.
- **Stateful input must be cleaned up.** The pinned Pixel Streaming hovering
  controller retains window-level move/up handlers during drags, and documents
  a double-click release fix. These are evidence against assuming a library
  automatically makes all drag/press edge cases disappear.
- **Touch libraries differ.** noVNC's
  [pinch path](https://github.com/novnc/noVNC/blob/63107bd06d9e1f6136ff21aeda8cd62cbf0d433e/core/rfb.js#L1421-L1441)
  emulates Ctrl/wheel, rather than genuine CDP multi-contact touch. Guacamole
  1.6.0 has a [Touch module](https://github.com/apache/guacamole-client/blob/0537c89cd783681b986ff8f8c4e0b97ec6873371/guacamole-common-js/src/main/webapp/modules/Touch.js#L98-L185),
  but backend support and explicit cancellation still need checks. Reuse must
  preserve our required physical touch behavior, not substitute mouse emulation.
- **Phone text is not desktop keycodes.** Pixel Streaming's
  [release notes](https://github.com/EpicGames/PixelStreamingInfrastructure/releases)
  describe separate text-input/IME support. Preserve our agreed basic live text
  relay and commit complex IME with Done; do not replace it with keycode-only
  forwarding.
- **Native Paseo is a distinct client.** The current
  [plugin reference](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md)
  documents React Native primitives and host-provided imports, not a portable
  native WebRTC/video surface. A new native media API would require host work;
  web-only libraries must remain isolated from phone bundle evaluation.
- **A protocol is not an authorization policy.** Continuous human input accepts
  visual latency. Frame-targeted automation has a different targeting contract.
  Keep both explicit and test that neither can acquire the other's privileges.

## Implementation and follow-up plan

1. **Define input contracts.** Separate human controller-owned channels from
   frame-targeted agent commands. Specify document/geometry changes, suspension,
   queued transitions and cleanup in one shared policy, covering JPEG and video.
2. **Fix the demonstrated mismatch.** Frame waiters watch actionable admission,
   not merely newly painted pixels. Pin the production-panel reproduction even
   if human mode no longer normally needs those waits.
3. **Remove ordinary human press/frame coupling.** Establish geometry readiness
   on admission; retain native exact-target and controller checks. Normal
   same-document dialog/list changes and scrolling do not revoke the channel.
   Real document/viewport replacement cancels unsent old-context actions rather
   than deferring them onto new content.
4. **Measure current transport.** Record event-to-native acknowledgement and
   event-to-observed-pixel latency, queue depth, source/encode/read/decode/paint
   timings, resets, dropped frames and bytes. Keep clocks labelled by domain;
   one-way delay cannot be computed from unsynchronized host/client clocks.
5. **Prototype WebRTC and binary streaming in isolation.** Same tab, sizes,
   density, bitrate and interaction workload; include real large-view changes,
   cameras, loss, jitter, multiple viewers, LAN and actual Paseo relay paths.
6. **Choose reuse based on results.** Prefer native browser media APIs for the
   smallest initial WebRTC prototype; use libraries where they remove a real
   responsibility. Choose a whole remote-desktop stack only if the additional
   backend/packaging work beats retaining exact-tab capture and CDP control.
7. **Review and activate exact source.** Independent policy/ordering review,
   mounted DOM plus real browser tests, actual SDK/Hermes compile, and human
   desktop/phone acceptance. Leave changes uncommitted until requested.

### Required acceptance evidence

- Rapid clicks during a large same-document refresh publish each admitted
  down/up once, in order, without a decoded-frame error or duplicates.
- Typing, modifier combinations, double/right click, wheel, scrollbar drags and
  touch continue while video catches up.
- Controller loss, new target, actual document/viewport replacement, hidden
  client and disconnect release held state and fence old queued events.
- A denied/uncertain native press is never automatically retried on a new page.
- Agent stale-frame rejection still holds; agent requests cannot mint human
  admission authority.
- Video and native JPEG fallback use the same human control semantics.
- Actual pane measurements include latency percentiles and byte/CPU load;
  server captures alone are not evidence of host rendering or relay performance.
- Existing sign-in/workspace/profile ownership and current UI conventions remain
  unchanged by a transport selection.

## Research limits and handoff

Source review and a local production-panel reproduction were completed.
No candidate replacement system was installed, no live browser inputs were
sent, and no current streaming runtime was changed by this investigation.
The transport performance comparison remains work to perform, not a benchmark
result inferred from project descriptions. The current live improvement has
human confirmation, but the reported click rejection remains unresolved until
the approved input contract is implemented and verified.


## Implemented follow-up

The approved human-input change admits decoded geometry once and continues ordered presses,
keyboard, touch and motion independently of replacement video frames. Normal
idle closure can reopen the exact acknowledged geometry grant. Native admission
compares expected attachment/document generation after asynchronous cleanup
and page attachment, before binding, so an intervening same-URL reload refuses
input. Controller, viewer, page, viewport and uncertain-publication changes still
cancel the channel. Agent input retains fresh frame receipt checks.

The mounted production panel verifies five clicks with video decoding blocked,
then another after idle closure using the same acknowledged geometry. A separate
fixture proves that visual-only delayed frames cannot wake initial admission,
while actually actionable decoded publication can. Native tests cover page and
attachment replacement during admission awaits. These checks do not measure
human-pane relay latency. No WebRTC, RFB, guacd or new dependency was added in
this policy change; transport batching and media replacement remain follow-ups.
