# Shared Browser

A Paseo plugin that runs one real Chromium browser per workspace on the daemon host and shares its
pages with connected Paseo clients and workspace agents. Version 1.0 replaces the previous browser
runtime in place with a plugin-owned, pinned `agent-browser` runtime; existing installations keep
the `shared-browser` plugin ID and upgrade without installing a second plugin.

Each browser tab is a real page in the same Chromium profile, so tabs share site logins and cookies.
Each client and agent selects a tab independently. Viewers of the same tab share its live page,
navigation and control state. Human control remains server-authoritative and takes priority over
agent input on that tab.

## Demo

https://github.com/user-attachments/assets/37d09fff-0750-440d-983d-426150b0724d

## Screenshots

Both PNGs show the same isolated Chromium session from a dedicated Paseo test daemon. They were
captured at 2× pixel density after browser DevTools verified the rendered page contained no private
organization names.

### Wide desktop

![Shared Browser showing the same live Paseo page to two viewers on desktop](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/paseo-shared-browser/docs/images/shared-browser-wide.png)

### Compact client

![Shared Browser controls and the same canonical browser viewport on a compact client](https://raw.githubusercontent.com/omercnet/paseo-plugins/main/paseo-shared-browser/docs/images/shared-browser-compact.png)

## Runtime model

- The plugin server runs beside the Paseo daemon and starts one `agent-browser` session and Chromium
  process per open browser workspace. Browser execution, profiles, IPC, and network access are on the
  daemon host, not on the viewing phone, browser, or desktop app.
- A workspace can have up to eight tabs. Each tab has its own page, capture stream, viewport and
  controller. Selecting a tab affects only the selecting viewer or agent. Closing a tab removes it
  for every participant viewing it; the last tab stays open until the browser is closed.
- Viewers can select a browser action while observing. A dialog offers control, names the current
  controller when a takeover is needed, and continues the selected action after control is granted.
  Closing a tab or browser still requires its own confirmation. Actions that need a fresh frame wait
  for one before sending input.
- The plugin owns `agent-browser` version `0.38.2`, its IPC directory, and the Chromium executable.
  It strips inherited `AGENT_BROWSER_*` variables and sets `AGENT_BROWSER_SOCKET_DIR`,
  `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`, `AGENT_BROWSER_STREAM_PORT=0`, and
  `AGENT_BROWSER_NO_AUTO_DIALOG=1` itself.
- Desktop/web clients with usable WebCodecs and Android apps with the host video renderer
  receive encoded workspace-tab video. Other native and unsupported clients receive JPEG frames from CDP `Page.startScreencast` or bounded screenshots.
  Remote input supports mouse hover, wheel scrolling, continuous dragging, native touch pan/pinch,
  tap, double-tap, right-click, text, and special keys.
- Device presets for Desktop Chrome, iPhone 15 Pro, Pixel 7, and iPad Pro 11 change Chromium's
  viewport, device pixel ratio, touch behavior, platform, and user agent. A phone can view and
  control the shared browser, but the rendered browser remains Chromium. An iPhone preset is mobile
  emulation, not WebKit, iOS, or real Safari.

## Lifetime and persistence

The browser runtime is held by a detached supervisor rather than by a particular Paseo client or
plugin subprocess. Closing a panel, disconnecting a client, or losing the plugin bridge invalidates
that client's viewer/control tokens but does not immediately close Chromium. A replacement plugin
bridge can reclaim the existing workspace runtime. If no bridge reconnects, the supervisor closes
all orphaned runtimes after a 120-second grace period. A missed heartbeat fences the old bridge after
30 seconds; the bridge sends heartbeats every 10 seconds.

The browser actions menu has **Close shared browser**. After confirmation,
it stops that workspace's Chromium process and ends every viewer and agent connection to it, even
when their panels are active. Background reconnects cannot reopen a deliberately closed browser.
A person can select the prominent **Open shared browser** button in the closed panel to start a new runtime with the
retained profile. Closing the browser does not remove saved cookies or site data.

Each workspace gets a private profile under
`$PASEO_HOME/plugin-data/shared-browser/profiles/<workspace-id-sha256>`. Cookies and site login state
therefore survive viewer disconnects, plugin reloads, and Chromium process restarts while that
directory remains intact. Profiles are local to one daemon host: they are not synchronized between
hosts or Paseo clients, do not use a personal Chrome or Safari profile, and are not portable across
arbitrary Chromium versions.

When Paseo emits `workspace.archived` while the plugin server is active, the plugin fences that
workspace, expires its viewers and controller, and closes its browser runtime, including a runtime
whose creation raced the archive. The profile directory is retained. Archive events missed while
the plugin bridge is disconnected are not replayed or reconciled by the plugin; the orphan grace
still closes the runtime, but retained profile data must be removed manually if it is no longer
wanted.

## Install

Enable trusted plugins on the target Paseo daemon, then install from npm:

```bash
paseo plugin install npm:@omercnet/paseo-shared-browser
paseo plugin ls
```

When Paseo acquires the npm package, it runs the `npm run prepare:runtime` build hook automatically. The
hook installs the pinned browser runtime, builds both `supervisor.cjs` and `shared-browser-mcp.cjs`
under a versioned directory in `$PASEO_HOME/plugin-data/shared-browser`, then atomically updates the
`runtime-current` pointer. Existing processes keep using their immutable runtime during an update.

The build requires Node.js 24 or newer and npm on the daemon host. On Linux x64, macOS, and
Windows, runtime preparation installs and stages the platform's Chrome for Testing distribution. On
Linux ARM64, where that download is unavailable, the installer automatically uses native Chromium
from `/usr/bin/chromium`. Install a non-Snap Chromium build with the system package manager before
adding the plugin. Set `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE` to an absolute path when Chromium
is installed elsewhere. The plugin does not emulate x64 Chromium on Linux.

On Windows, the upstream installer retains its Chrome download cache under the OS user profile.
Before upgrading the plugin on Windows, close active Shared Browser sessions and stop the Paseo
daemon; Windows does not allow the installer to replace runtime executables that are still running.

Open a workspace, search the Command Center for **Open Shared Browser**, or tap the **Shared
Browser** composer pill while a workspace session is open. On Paseo 0.11 or newer, a **Shared
Browser (n)** row in the sidebar footer appears while browser sessions are open; it lists them and
jumps to the chosen workspace's browser panel.

## Agent MCP access

The plugin automatically injects its stdio MCP adapter only when a new, non-internal agent is
created with a provider that accepts external MCP servers. Agents that already exist, resumed
sessions, imported sessions, and Paseo's internal agents are not modified. Paseo's built-in OMP
provider accepts session MCP servers from Paseo 0.11, so new OMP agents receive the adapter there.
Pi agents also receive the adapter, but require Pi's optional MCP support to
launch it.

The injected MCP server exposes `shared_browser_status`, `shared_browser_capture`,
`shared_browser_device`, `shared_browser_acquire_control`, `shared_browser_release_control`,
`shared_browser_navigate`, `shared_browser_input`, `shared_browser_viewport`,
`shared_browser_tabs`, `shared_browser_tab_open`, `shared_browser_tab_select`, and
`shared_browser_tab_close`. It does not
expose arbitrary CDP commands, JavaScript or page evaluation, browser profile access, or filesystem
access.

Each adapter launch receives an opaque credential bound to its workspace. It cannot use that
credential to operate another workspace's browser. Agent input follows human-priority control: an
agent cannot force a takeover while a human viewer holds control of the same tab. The human must
release control or the lease must expire before agent input can proceed on that tab.

The provider launches the stdio adapter on the Paseo daemon host, beside the daemon-owned browser
runtime. Web, desktop, and mobile clients never own or host the adapter or Chromium, and a client
disconnect does not close or reset either process.

## Runtime environment overrides

The plugin recognizes only these deployment overrides:

| Variable                                    | Meaning                                                                                                                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_HOME`                                | Paseo data root. Defaults to `~/.paseo`; browser runtime, supervisor IPC, and profiles live below `plugin-data/shared-browser`.                                                                                                                                       |
| `PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY` | Absolute path to the pinned `agent-browser` executable. Defaults to the active runtime's `node_modules/.bin/agent-browser` (`agent-browser.exe` on Windows). |
| `PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE`  | Absolute path to Chromium. Defaults to the active runtime's `chromium/chrome` (`chrome.exe` on Windows). On Linux ARM64, installation automatically links `/usr/bin/chromium`; use this override for another compatible, non-Snap location. |
| `PASEO_SHARED_BROWSER_CHROMIUM_ARGS`        | Optional Chromium arguments passed through the managed runtime. Intended for host requirements such as `--no-sandbox` in an already-isolated CI runner; do not disable the browser sandbox on a general-purpose host.                                                 |

User-supplied `AGENT_BROWSER_*` variables are deliberately ignored.

## Controls

- Toolbar: back, forward, reload, address bar, a combined monitor menu, mobile emulation toggle
  and a vertical-dots browser actions menu. The controller can close the shared browser from that
  menu after confirmation. Icon controls expose their action name
  as a hover tooltip on desktop/web and retain native accessibility labels.
- Custom viewports support 320 to 2560 pixels wide and 480 to 2560 pixels high. Invalid sizes
  show their error inside the device dialog; a successful Apply closes it.
- Desktop presets also include 1280 × 800 (16:10) and 1280 × 1280 (1:1).
- Pixel 7 (high resolution) keeps the same 412 × 839 phone layout and input coordinates,
  with a sharper 824 × 1678 capture.
- Desktop presets include 1920 × 1080 and 2560 × 1440 (16:9), 1920 × 1200 and
  2560 × 1600 (16:10), and 1920 × 1920 and 2560 × 2560 (1:1).
- Desktop choices use height names such as 720p, 1080p, 1200p and 1440p, with
  dimensions shown alongside. Square choices name their width explicitly.
  The 1440-wide choices are 1440 × 810, 1440 × 900 and 1440 × 1440.
- The Resolution and quality menu groups desktop choices by 16:9, 16:10 and 1:1,
  then mobile. Each group sorts by width. Filled stars mark favorites; the monitor
  menu provides favorites in that same grouped order and access to the full
  resolution and quality list.
- Monitor and browser actions open compact anchored menus rather than dialogs. Menus stay
  within the pane, scroll long lists, and dismiss with an outside press, Escape or native Back.
- The monitor menu offers **Fit to panel** (default) and **Actual size (100%)**. Actual size
  uses browser layout pixels, not the larger JPEG dimensions of sharper phone captures.
  This choice affects only the current viewer, without resizing the shared browser.
  Desktop local scrollbars reveal overflow while wheel events on a controlled frame go to
  the remote page. Phone viewers can pan while observing; controlling sends swipes to the
  page instead. Fitting images stay centered without empty scroll ranges; a scrollbar on
  one axis does not force one on the other. Returning to Fit resets local offsets without
  reloading the page or image.
- Desktop and web clients with WebCodecs play genuine encoded tab video (H264 when supported,
  otherwise VP8). The trusted bundled helper captures the exact workspace tab, not a screenshot
  loop or title-selected window. Android uses Paseo's host-owned WebView canvas and retains native
  touch controls. It requires an Android app rebuilt with the `EncodedVideo` plugin SDK API and
  a System WebView supporting the stream codec. Other native apps and clients without usable
  video decoding keep the existing JPEG fallback.
- The monitor menu's resolution and quality list separates JPEG quality (70%, 90%, 95%,
  or 100%), video bitrate (2, 5, 12, or 24 Mbps), and video frame rate (15, 30, or 60 FPS).
  Defaults remain JPEG95 and 12 Mbps at 30 FPS. Old saved quality choices keep their
  corresponding video bitrate when upgraded. These are encoder targets, not measured
  bandwidth or guaranteed frame rates. Large JPEGs may reduce quality to stay within
  the existing 4 MiB frame bound. Preferences persist on the connected Paseo host.
  Capture density is a separate 1x/2x option for the controller. It raises real source
  pixel detail without changing page size, input mode, or user agent. The 2x option
  requires both page dimensions to be 1280 or less; larger pages keep 1x rather than
  being resized. It can increase processing and bandwidth substantially. Quality
  changes do not navigate or reload the shared page.
- Video packets travel through the existing authenticated Paseo RPC connection, including its
  relay. No extra video port or unauthenticated media server is opened. This is encoded video
  delivered in bounded request/reply batches, not WebRTC or a custom push subscription.
- Animated native capture supports a source ceiling of 60 frames per second. Ordinary
  frames follow each encoder's requested rate; a recovery keyframe can use the next
  eligible frame without waiting for that interval. Quiet tabs produce genuine frames
  around once per second; repeated packets never acquire a newer source capture timestamp.
  At most three bitrate/frame-rate cohorts share one source. Changing quality never evicts
  another active cohort. If all three are occupied, another profile uses JPEG fallback
  and retries video after 2.5 seconds while visible. Hiding or unmounting cancels
  that viewing-only retry; the soft error clears after a fresh video frame paints.
  Idle encoders release their buffers and codecs after two seconds without an active read;
  when no video consumer remains, the native track and helper also close. A returning video
  viewer can reacquire the source safely. Higher rates/bitrates and multiple encoders cost
  more host CPU and bandwidth; pixel density and the host's native codecs also affect cost.
- Hidden documents, page-cache suspension, inactive native AppState and panel unmount stop
  this viewer's video reads and release decoding resources. Resuming requests a fresh
  keyframe. One already-issued bounded RPC may finish, but cannot restore old input authority.
  Video remains video when the page is quiet; no idle still-image overlay or static-page
  polling is used. Keyframes restore decoding after a gap but do not make video lossless.
- Initial human control requires decoded and painted geometry. Once admitted,
  the controller's ordered input channel continues while video catches up.
  A click may reach a page ahead of the displayed image, as in remote desktop.
  Agent commands retain strict fresh-frame targeting. Document, viewport,
  runtime, bridge and controller changes invalidate the human admission. Dropped packets recover at a keyframe rather
  than decoding a broken delta chain. Video reads wait outside the input queues.
- If no fresh video is painted for 2.5 seconds, the viewer revokes video input authority and
  requests JPEG fallback and a fresh keyframe. The retained video remains visible
  until a current image has decoded, so a delayed fallback cannot flash an older view. Decoder/capture failures also retain
  fallback. The Video, CDP and fallback labels describe the displayed transport.
- JPEG captures refresh after input. A stalled screencast falls back to a fresh screenshot.
  Healthy painted video suppresses redundant JPEG polling and focus captures. Media
  reads use source generations without repeatedly querying page metadata inside
  the control queue; ordinary status checks still reconcile navigation state.
  Shared JPEG screencasting starts on image demand and stops after three seconds
  without demand. Phone/image viewers and agent captures restart it lazily;
  video reads alone do not keep it running. An image fallback after retirement
  may wait for stream startup or use the existing screenshot fallback.
  Repeated reads of the exact cached JPEG send metadata only; image source age still expires
  within one second. The last decoded image remains visible while its replacement loads.
- Reconnecting or switching browser tabs restores the selected device viewport, capture density,
  touch and user agent before accepting new frames.
- Actual video and JPEG dimensions must match the selected capture resolution before a frame is accepted.
  The fallback captures the complete visible viewport, preserves scroll position, and accounts
  for device pixel ratio and capture scale so inputs still use the original layout coordinates.
- The last decoded frame stays visible while its replacement loads, with native image fading
  disabled. Initial human admission and agent commands use the painted frame;
  admitted human input retains its qualified geometry while pixels catch up.
  Obsolete image callbacks cannot replace the displayed frame.
- Status row: session state, viewer count, controller, and lease expiry.
- Returning after viewer expiry reattaches viewing once automatically while preserving the
  page. Expired control is cleared; take control again to send input. Expected expiry is not
  shown as an action failure; a failed reattachment still offers manual retry.
- Clicking a link or submitting a form may navigate before its input reply arrives. A completed
  input returns the new viewing state without a false failure or repeating the action.
  Replaced controls, targets and uncertain sends remain rejected.
- Human control: **Take control**, **Release**, and **Take over** for explicit handoff. Agent MCP
  calls have no forced-takeover operation.
- With control, mouse movement forwards real hover effects and standard browser cursor changes.
  Automatic cursors resolve selectable text to an I-beam while respecting explicit
  cursor styles and non-selectable areas.
  Wheel scrolling stays inside the browser canvas; held drags update before release. Leaving the
  canvas clears remote hover, while dragging beyond its edges still releases the held button.
- Hidden Linux browsers use an authenticated private virtual display when `/usr/bin/Xvfb`
  is already installed. This supplies native desktop pointer/hover capabilities after switching
  back from phone mode. It opens no visible window or TCP listener, changes no host display
  settings, and adds about 25 MiB of framebuffer memory per workspace plus server overhead.
  The owned display is stopped with its browser. Other platforms, missing Xvfb, or a fully
  cleaned display-startup failure retain the existing launch behavior; headless Linux may
  still lack media-query-gated hover. The plugin does not install Xvfb automatically.
- Native touch forwards active fingers continuously, including pan and pinch on desktop and mobile
  presets. Physical mouse buttons and double clicks retain their natural actions; touch never
  changes into a synthetic mouse gesture.
  Losing control, changing page or resizing cancels held input; old contacts must lift before a
  fresh touch can target the replacement page. No uncertain input is replayed after a failure.
- Desktop viewports show native scrollbars. Dragging a scrollbar thumb scrolls the page
  continuously before release. Wheel scrolling and touch panning remain available;
  mobile emulation retains its normal mobile scrollbar behavior.
- Click the controlled canvas to type directly on desktop and web. Shortcuts, repeat,
  modifier clicks and committed composition text are forwarded; other Paseo inputs stay local.
- The address-bar Browser menu contains a Send keys submenu and reconnect actions. On desktop,
  keys open beside the menu; on compact screens, Back returns to the parent menu. Extra keys
  are no longer shown below the canvas or in a separate dialog.
- On native phones, Keyboard in that menu opens the software keyboard for basic live typing
  and Backspace
  without a visible text box. Autocorrection is disabled. Compose opens an explicit local
  draft for IME text, inserted once with Done. Native hardware shortcuts are not supported
  by this software-keyboard relay. Extra keys remain available in the Send keys submenu.
- Local plain-text paste is forwarded; remote copy/cut are not synchronized to the local clipboard.
- The address-bar mobile toggle changes shared emulation while preserving the current display
  dimensions and capture density. Choose a resolution explicitly to change the display.
  Your device default applies the first time you take control, never while observing, and
  also preserves the current display. Narrow desktop layouts do not count as phones.
- The mobile address field keeps a full text line with compact padding. Read-only addresses
  stay legible while observing; taking control is still required to edit or navigate.
- Mode changes preserve the current page and unsaved fields. Sites that select layouts only
  at page load may need an explicit Reload. There are no click, swipe or scroll mode controls.

## Security boundary

- Paseo plugins are trusted, unsandboxed code. The plugin server, detached supervisor,
  `agent-browser`, Chromium, and other processes running as the daemon OS user share one trust
  boundary and can reach that user's files, processes, credentials, and network.
- Supervisor IPC uses a user-private Unix socket on Linux and macOS or an installation-specific
  named pipe on Windows, plus a token file under Paseo's user data root for every connection. On
  Windows, file privacy relies on the ACL inherited from `PASEO_HOME`; custom locations must remain
  private to the daemon user. `agent-browser` uses loopback TCP for its command and stream services
  on Windows, so Windows support assumes a trusted single-user host; these services are not an
  isolation boundary between local OS users.
- `agent-browser` IPC metadata and workspace profile directories are owner-only on POSIX systems.
  The plugin rejects a non-loopback CDP endpoint.
- Viewer and control tokens coordinate clients already paired to the same Paseo daemon. Plugin RPC
  callbacks expose no authenticated caller identity, so these human-viewer tokens are a workflow
  safeguard, not an authorization boundary. The stdio MCP adapter separately uses an
  opaque, workspace-bound credential.
- The bundled trusted video helper has tabCapture/debugger access to capture the exact workspace
  tab. It exposes no content scripts, site messages, network host permissions or web-accessible
  resources. User-supplied extensions and page media permissions remain unavailable.
- Downloads, uploads, clipboard synchronization, native passkeys and platform authenticators
  are not exposed by this plugin.
- Browser navigation uses the daemon OS user's network access, including local development servers.
  It is therefore a trusted-agent capability; this plugin deliberately does not apply a blanket
  loopback or RFC1918 navigation ban.

## Develop

Follow the repository's `AGENTS.md`. Runtime verification must use an isolated
Paseo home, never the default daemon, active plugin installation, or signed-in
profile. Run dependency installation from the monorepo root, then the following
checks from `paseo-shared-browser`:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run check
bun run test:unit
```

The `test:tabs` native check requires explicit
`PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY` and
`PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE` paths. It creates and cleans up its own
temporary Paseo home and browser profile.

`node scripts/test-image-capture-mounted.mjs --tooling-root /path/to/test-workspace`
opt-in checks the real React/React Query image scheduling and viewing recovery hooks
in JSDOM. The tooling workspace must already provide compatible React, react-dom,
jsdom, React Query and esbuild. The plugin intentionally does not add these DOM test
dependencies or install missing packages. Omitting `--tooling-root` uses this
checkout if its dependencies include them. The command owns and removes temporary
hook bundles; it never launches or accesses a browser/runtime or profile.
For reproducible mounted checks, create a disposable tooling workspace with
React and react-dom 19.1.0 (matching this repository's React version), jsdom
30.1.1, React Query 5.102.3 and esbuild 0.28.2. jsdom requires Node 24.15 or
newer on the supported Node 24 line. These are test-only dependencies, not
plugin runtime dependencies. For example:

```bash
npm install --prefix /tmp/shared-browser-dom-tools --ignore-scripts --no-save \
  react@19.1.0 react-dom@19.1.0 jsdom@30.1.1 \
  @tanstack/react-query@5.102.3 esbuild@0.28.2
node scripts/test-image-capture-mounted.mjs --tooling-root /tmp/shared-browser-dom-tools
node scripts/test-panel-video-mounted.mjs --tooling-root /tmp/shared-browser-dom-tools --fixture settlement
```

The panel fixture also accepts `handoff`, `rapid`, `continuous` and `admission`.
Run each variant for changes to media handoff or input policy. The `settlement`
fixture checks late replies across viewer and controller replacement. Delete
the tooling directory when done.

Use the same command with `--fixture density` for six mounted controller/density
menu regressions, including observer bounds, same-workspace token replacement,
unmount and no retry after an uncertain write.

Prepare runtime assets with an explicit temporary `PASEO_HOME` before either
browser gate. Keep that directory outside the default Paseo home. For example,
on POSIX systems:

```bash
export PASEO_HOME="$(mktemp -d -t shared-browser-verification-XXXXXX)"
bun run prepare:runtime
bun run test:smoke
bun run test:video
```

Remove the temporary directory after verification. On Windows, use a new
explicit temporary directory in `$env:PASEO_HOME` instead. Tests manage their
own browser teardown; do not run daemon lifecycle commands against the default
host to recover a test failure.

`bun run test:smoke` launches the configured real Chromium runtime and exercises two viewers,
control handoff, reconnect, stale-frame rejection, viewport changes, device emulation, profile
persistence, and archive teardown.

`bun run test:video` is an optional real video gate. It reads prepared Chromium/CLI assets,
then creates its own temporary Paseo home, browser profile, Unix socket and local fixture pages.
It checks the production video decoder and canvas at 1280x800, sharp Pixel and 2560x2560,
including all four corner markers. It never uses the live browser. This gate requires usable
WebCodecs/tab capture and the local runtime assets; it is separate from unit tests.
Linux CI requires Xvfb and runs this video gate without skipping unsupported
capture. macOS and Windows run the image/browser smoke; their native video
hardware and remote-network performance require separate qualification. CI also
runs the actual Paseo compiler on both plugin entries.

Release Please maintains the version, changelog, component tag, and GitHub release from
Conventional Commits in the monorepo.

Both the Paseo daemon and app must satisfy the version range in `paseo-plugin.json`.
Paseo 0.11 is required; the tested `0.11.0-beta.3` prerelease is also allowed.
Earlier releases are not advertised because the plugin uses the 0.11 SDK contract. The client surface uses React Native primitives
and works in desktop, web, iOS, and Android Paseo clients.

For an initial, not-yet-admitted channel, a wheel capture can finish decoding
after input revoked its frame token. The server
returns a known non-admission receipt before creating a new channel; the canvas waits
for another decoded frame before admitting that still-unsent gesture. Recovery allows
up to three admission attempts within one four-second decoded-frame wait budget.
Published input, unknown outcomes, expired leases, and replaced contexts are never retried.


## Maintainer references

[Streaming design](STREAMING_DESIGN.md) documents media ownership, resource
bounds, input admission and recovery. [Remote-control research](REMOTE_BROWSER_RESEARCH.md)
records primary-source comparisons and the trade-offs behind continuous human
input. These describe the implementation's guarantees, not a promise of a
particular frame rate or remote-network latency.
