# Shared Browser streaming design

This document describes the media and input contracts maintained by the plugin.
User-facing controls and installation are documented in [README](README.md).
[Remote-control research](REMOTE_BROWSER_RESEARCH.md) records the primary-source
comparisons behind the input design.

## Transport and ownership

Desktop, web and Android clients use Chromium tab capture, a realtime WebCodecs encoder,
and bounded encoded-packet reads over authenticated Paseo RPC. The receiver
decodes into a retained canvas. Android uses the host-owned `EncodedVideo` surface;
its bridge acknowledges explicit canvas draws before input authority is admitted.
Other native clients and clients without a usable decoder use JPEG. This is encoded video, not WebRTC or a push subscription; it
shares the reliable connection and relay used by Paseo.

`server/native-video-extension.ts` materializes the immutable bundled capture
helper in the runtime's private IPC directory. The helper has tabCapture and
debugger permissions, but no content scripts, web-accessible resources, site
message handlers, or network host permissions. It captures the exact retained
workspace tab, never a title-selected window or arbitrary desktop.

`server/native-video-capture.ts` owns the helper target, track, encoder cohorts
and encoded buffers. `server/agent-browser-runtime.ts` binds that ownership to
the exact native page attachment and emulation. `server/browser-policy.ts`
checks viewer lifetime and the browser generations before admitting packets.
`client/use-browser-video.ts` owns viewing retries and presentation authority;
`client/browser-video-decoder.ts` owns codec queues and frame disposal.

Every acquisition waits for the complete target or viewport transition and any
pending native cleanup. Expired, detached or hidden viewers cannot revive media
ownership through a late reply. Encoder cohorts retire after two seconds without
active reads. JPEG capture follows actual image demand and retires after three
seconds without demand; attaching a viewer or reading video does not renew it.

## Resource limits and backpressure

Encoded packets are limited to 2 MiB. A reply contains at most 32 packets and
4 MiB of encoded payload. Source and decoder queues are independently bounded.
Video waits are at most 500 milliseconds and run outside ordered input and
workspace mutation lanes. Socket media admission leaves capacity for controls;
heartbeat uses a separately bounded lane so a slow page command cannot expire
the bridge. Buffered socket lines resume draining after admitted work completes.

At most three bitrate/frame-rate cohorts share a track. A new profile cannot
evict a healthy peer encoder. Capacity exhaustion returns an explicit reason
and uses JPEG while a bounded viewing retry waits for capacity. Source-image
skips do not break already encoded delta dependencies. Actual encoded-output
loss suppresses dependent deltas until a keyframe restores the chain.

The receiver feeds a bounded FIFO as the native decoder makes progress, rather
than resetting it because a normal reply contains more than four pictures. A
new retained keyframe allows a delayed viewer to skip obsolete encoded backlog.
Old decoder callbacks are generation-fenced and their frames closed. The last
paint remains visible during catch-up. Feature-detected native byte/base64
conversion avoids intermediate binary strings; exact fallback conversion is
retained for older clients.

## Presentation and input are separate contracts

Initial human input requires decoded and painted geometry. Admission binds the
controller, viewer, workspace, runtime, bridge, native attachment, document and
viewport. Subsequent presses, motion, keyboard and releases use an ordered
channel without waiting for a newly decoded image after every event. A human
click may reach the page ahead of the remote display, as in remote desktop.
Agent commands retain strict fresh-frame targeting.

A visible frame is not automatically an actionable receipt. Delayed reads may
continue painting within the same source and geometry while retaining their
original input revision. Initial-admission waiters wake only for actionable
pixels. A document or viewport transition, controller loss, cancellation,
disconnect, hidden panel or uncertain mutation invalidates admission. Native
binding checks its expected generation after attachment and cleanup awaits.

Press/release, key and text transitions remain ordered; only compatible motion
can coalesce without crossing a transition. Pointer capture and teardown release
held state. The four-second idle channel closure releases native keys/buttons;
a reopen can reuse only the exact acknowledged human admission. No published
or uncertain input is replayed after a timeout.

Video can retain its last painted canvas across an ordinary input or document
transition without retaining input authority. Viewer, runtime, bridge and
viewport replacement clear that source. The 2.5-second stalled-paint watchdog
requests image fallback but holds the canvas until a current JPEG actually
decodes. A revision guards that handoff against late images and React commits.

Source timestamps remain Chromium capture timestamps. Arrival time never makes
queued, duplicate, backwards or missing source timestamps fresh. JPEG admission
uses a one-second source age and bounded native clock tolerance. Navigation
clears cached JPEGs and queued video before admitting replacement pixels.

## Quality and geometry

The menu separates JPEG quality (70, 90, 95 or 100), video bitrate (2, 5, 12 or
24 Mbps), frame rate (15, 30 or 60 FPS), source density and local Fit/Actual size.
These are encoder targets, not measured bandwidth or guaranteed frame rates.
JPEG 100 remains lossy and its byte budget can lower actual quality. Video
keyframes repair decoder dependencies; they do not restore RGB detail reduced
by the native capture's colour sampling. No lossless idle overlay or static-page
comparison loop is used.

Capture density is independently controller-authorized at 1x or 2x. It preserves
CSS dimensions, input mode, user agent and preset identity. Physical dimensions
must each remain at most 2560, so 2x is unavailable above 1280 on either CSS axis.
Rendering DPR is raised to at least the selected density while a genuine phone
DPR is retained. Explicit preset changes retain their established density reset
behavior; mode-only changes retain it. Returned state reports actual density.

Encoded and decoded dimensions match the requested viewport and density. Chromium
YUV capture rounds odd physical dimensions down to even sizes. Only that exact
one-pixel alignment is resampled by the encoder to the requested size, preserving
page layout, capture density and source timing. Other dimension mismatches remain
terminal. Odd-sized 1x captures can use VP8 when H.264 rejects those dimensions;
2x Pixel 7 capture remains 824 by 1678.

## Failure and navigation recovery

Source-wide startup, stopped-track and reset failures retire through the native
stop barrier even while reads continue. Acquisition has a three-second monotonic
cooldown starting when failure is admitted, and cleanup independently blocks
replacement. An encoder-cohort failure does not retire healthy peers. Dimension
failure is permanent for the current attachment and viewport configuration;
polling or navigation cannot repeatedly restart it. A configuration change can
recover without weakening exact geometry.

Navigation observes its matching main-frame commit before dispatch, then waits
for the command acknowledgement and document commit, not DOMContentLoaded. Full
navigation matches its loader; same-document navigation matches root frame and
URL. A download acknowledgement retains the document. One bounded metadata read
follows commit. Attachment recovery and held-state cleanup have separate budgets.
An uncertain navigation is not replayed.

Transient video read failures revoke input authority and use bounded viewing
backoff. Exhaustion stops reads. Ordinary pointer/image refresh cannot rearm that
retry; successful navigation may queue one recovery after cooldown. Decoder
failures are terminal for that playback attempt. Expired viewers reattach through
the existing viewing recovery, never by replaying a mutation or taking control.

Diagnostics record redacted operation categories, elapsed duration and safe CDP
method names, with rate limits. They must not record URLs, text, credentials,
viewer/control tokens, media payloads, SDP or per-frame successes. A screenshot
failure together with navigation-history/layout timeouts indicates a broader
runtime failure; successful cached metadata is not proof of page preservation.

## Verification

Follow the isolated workflow in [README](README.md). Unit regressions cover
packet bounds, frame authority, viewer expiry, transition races, socket admission,
source cleanup, codec queues and geometry. The opt-in native video gate captures
an actual tab and decodes through the production receiver at desktop, sharp phone
and large square sizes, checking all four corners and batched final-frame paint.
It also distinguishes real 2x source rendering from rescaling a 1x image.

Mounted panel checks require the explicitly supplied tooling workspace described
in README. Handoff, rapid-input, continuous-input and admission fixtures exercise
React/React Query settlement and DOM events. They do not prove phone IME behavior,
physical-input latency, human-pane rendering or performance through a live relay.
A successful MCP image capture establishes server image delivery only.

## WebRTC follow-up

WebRTC could move media off the ordered RPC connection and avoid base64 expansion.
Authenticated RPC can carry bounded offer/answer/ICE signaling. Native-phone image
fallback would remain. Local proof alone cannot qualify remote networking: Paseo's
relay is not a TURN service, and WSL/NAT clients may require configured TURN,
short-lived credentials, traffic limits and operational ownership.

An owned native-track proof produced correct full-frame geometry and local ICE
playback. Exact correlation between a presented RTP frame and its authenticated
source timestamp remains unqualified. Arrival time must not stand in for capture
time. An alternative data channel can retain existing source-stamped packets but
needs bounded fragmentation, incomplete-packet expiry, backpressure and keyframe
recovery. Neither alternative is shipped.

Measure RPC and candidate WebRTC paths over the actual LAN and relay topology:
time to first frame, source-to-presentation latency, text readability, scrolling,
CPU, bandwidth, recovery and stalled-network behavior. See the
[WebRTC specification](https://www.w3.org/TR/webrtc/),
[TURN guidance](https://webrtc.org/getting-started/turn-server),
[video presentation callbacks](https://wicg.github.io/video-rvfc/) and
[encoded transforms](https://www.w3.org/TR/webrtc-encoded-transform/).
