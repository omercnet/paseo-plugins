# Shared Browser

A Paseo plugin that runs one real Chromium browser per workspace on the daemon host and shares that
exact live session with every connected Paseo client. Version 1.0 replaces the previous browser
runtime in place with a plugin-owned, pinned `agent-browser` runtime; existing installations keep
the `shared-browser` plugin ID and upgrade without installing a second plugin.

This is not URL synchronization and not a second browser with copied cookies. Every viewer and
eligible workspace agent acts on the same running page, DOM, navigation state, and login state.
Many viewers can watch; human control remains server-authoritative and takes priority over agent
input.

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
- The plugin owns `agent-browser` version `0.37.1`, its IPC directory, and the Chromium executable.
  It strips inherited `AGENT_BROWSER_*` variables and sets `AGENT_BROWSER_SOCKET_DIR`,
  `AGENT_BROWSER_IDLE_TIMEOUT_MS=0`, `AGENT_BROWSER_STREAM_PORT=0`, and
  `AGENT_BROWSER_NO_AUTO_DIALOG=1` itself.
- Frames stream from Chromium through CDP `Page.startScreencast`, with a bounded screenshot fallback.
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
On Paseo 0.9 and 0.10 the built-in OMP adapter rejects external MCP servers, so OMP agents are left
unchanged. Pi agents continue to receive the adapter, but they require Pi's optional MCP support to
launch it.

The injected MCP server exposes exactly these tools: `shared_browser_status`,
`shared_browser_capture`, `shared_browser_acquire_control`, `shared_browser_release_control`,
`shared_browser_navigate`, `shared_browser_input`, and `shared_browser_viewport`. It does not
expose arbitrary CDP commands, JavaScript or page evaluation, browser profile access, or filesystem
access.

Each adapter launch receives an opaque credential bound to its workspace. It cannot use that
credential to operate another workspace's browser. Agent input follows human-priority control: an
agent cannot force a takeover while a human viewer holds control. The human must release control or
the lease must expire before agent input can proceed.

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
  and a vertical-dots browser actions menu. Icon controls expose their action name
  as a hover tooltip on desktop/web and retain native accessibility labels.
- Custom viewports support 320 to 2560 pixels wide and 480 to 2560 pixels high. Applying one
  changes only the dimensions; the active profile's mobile mode, touch, user agent and capture
  density are kept. Invalid sizes
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
- Quality choices Low, Medium and High request JPEG quality 40, 65 and 85 respectively (Medium is the default).
  Detailed large views use more bandwidth; frames reduce quality further only if they
  exceed the 800 KB frame limit. Preferences persist on the connected Paseo host.
- Captures refresh after input. A stalled screencast falls back to a fresh screenshot instead
  of indefinitely showing an old image.
- Captures use individual JPEG frames. The transport label identifies streamed
  frames or screenshot fallback. Encoded video and source caching are separate
  transport work.
- Actual JPEG dimensions must match the selected capture resolution before a frame is accepted.
  The fallback captures the complete visible viewport, preserves scroll position, and accounts
  for device pixel ratio and capture scale so inputs still use the original layout coordinates.
- The last decoded frame stays visible while its replacement loads, with native image fading
  disabled. Input targets the displayed frame, and obsolete image callbacks cannot replace it.
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
- On native phones and compact web layouts, **Compose text** in the Browser menu opens a visible
  local draft. **Done** inserts it once into the focused page field; it requires human control and
  is dropped if control or the page changes. There is no live software-keyboard relay. Phone
  keyboard behavior still needs physical-device testing.
- While the Resolution and quality dialog or a toolbar menu is open, canvas input is not
  forwarded and held gestures are cancelled.
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
- Downloads, uploads, clipboard synchronization, media permissions, extensions, native passkeys,
  and platform authenticators are not exposed by this plugin.
- Browser navigation uses the daemon OS user's network access, including local development servers.
  It is therefore a trusted-agent capability; this plugin deliberately does not apply a blanket
  loopback or RFC1918 navigation ban.

## Develop

```bash
bun install
bun run typecheck
bun run check
bun run test:unit
PASEO_HOME="$(mktemp -d)" bun run prepare:runtime
```

Treat the default Paseo daemon and profile as live user state. Use an isolated
`PASEO_HOME` for runtime preparation and tests; do not run development lifecycle
commands against the default daemon. Keep the prepared home available for smoke
tests so they can resolve its runtime assets.

`PASEO_HOME=<prepared-test-home> bun run test:smoke` launches the configured real Chromium runtime and exercises two viewers,
control handoff, reconnect, stale-frame rejection, viewport changes, device emulation, profile
persistence, and archive teardown.

Release Please maintains the version, changelog, component tag, and GitHub release from
Conventional Commits in the monorepo.

Both the Paseo daemon and app must satisfy the version range in `paseo-plugin.json`.
The upstream 0.9, 0.10 and stable 0.11 ranges and the tested `0.11.0-beta.3` allowance
are retained. The sidebar entry appears only on clients that expose its API.
The client surface uses React Native primitives and works in desktop, web, iOS,
and Android Paseo clients.

A wheel capture can finish decoding after input revoked its frame token. The server
returns a known non-admission receipt before creating a new channel; the canvas waits
for another decoded frame before admitting that still-unsent gesture. Recovery allows
up to three admission attempts within one four-second decoded-frame wait budget.
Published input, unknown outcomes, expired leases, and replaced contexts are never retried.
