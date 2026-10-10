/** Actual React Query + panel/input integration; no browser or daemon is accessed. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: {
    "tooling-root": { type: "string" },
    fixture: { type: "string", default: "handoff" },
    compact: { type: "boolean", default: false },
  },
});
if (
  ![
    "handoff",
    "rapid",
    "continuous",
    "admission",
    "settlement",
    "control-gate",
    "control-gate-takeover",
    "control-gate-stale",
    "tab-focus",
  ].includes(values.fixture)
)
  throw new Error("Unsupported panel fixture");
const toolingRoot = resolve(values["tooling-root"] ?? repository);
const tooling = createRequire(join(toolingRoot, "package.json"));
// Existing tooling is required; this fixture never installs dependencies.
globalThis.panelFixtureToolingRoot = toolingRoot;
const { build } = tooling("esbuild"),
  React = tooling("react"),
  { createRoot } = tooling("react-dom/client"),
  { JSDOM } = tooling("jsdom"),
  { QueryClient, QueryClientProvider } = tooling("@tanstack/react-query");
const out = await mkdtemp(join(tmpdir(), "panel-video-mounted-"));
const dom = new JSDOM('<div id="root"></div>', {
  url: "http://fixture.local",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const state = {
  sessionId: "s".repeat(32),
  tabId: "t".repeat(32),
  runtimeId: "r".repeat(32),
  bridgeEpoch: 1,
  navigationGeneration: 1,
  viewportGeneration: 1,
  status: "ready",
  url: "http://fixture.local/",
  title: "Fixture",
  viewport: { width: 1280, height: 800 },
  captureScale: 1,
  presetId: "desktop-1280x800",
  controller: values.fixture === "control-gate-takeover" ? "other" : "none",
  controllerLabel: values.fixture === "control-gate-takeover" ? "Agent fixture" : null,
  canGoBack: false,
  canGoForward: false,
};
const f = {
  state,
  reads: [],
  captures: [],
  imageLoads: [],
  calls: [],
  paint: null,
  decoderCreates: 0,
  decoderCloses: 0,
  draws: 0,
  token: "v".repeat(32),
  deferredBegins: [],
  deferAcquire: values.fixture === "settlement" || values.fixture === "control-gate-stale",
  acquireReplies: [],
  deferredNavigations: [],
  deferNavigation: false,
  deferBegin: false,
  staleBeginOnce: false,
  deferTabs: false,
  tabReplies: [],
  createdTabId: null,
};
globalThis.panelFixture = f;
const rpcCache = new Map();
f.rpc = (contract) => {
  if (!rpcCache.has(contract.name))
    rpcCache.set(contract.name, async (input) => {
      f.calls.push({ name: contract.name, input });
      if (contract.name === "shared-browser.attach") {
        if (values.fixture === "tab-focus" && input.tabId) {
          f.state = { ...f.state, tabId: input.tabId, sessionId: input.tabId };
        }
        return { viewerToken: f.token, state: { ...f.state } };
      }
      if (contract.name === "shared-browser.tabs.create") {
        f.createdTabId = "n".repeat(32);
        return { tabId: f.createdTabId };
      }
      if (contract.name === "shared-browser.tabs.list") {
        const result = {
          tabs: [
            {
              id: state.tabId,
              title: "Fixture",
              url: f.state.url,
              viewerCount: 1,
              controllerLabel: f.state.controllerLabel ?? null,
            },
            ...(f.createdTabId
              ? [
                  {
                    id: f.createdTabId,
                    title: "",
                    url: "about:blank",
                    viewerCount: 1,
                    controllerLabel: null,
                  },
                ]
              : []),
          ],
        };
        if (f.deferTabs) {
          return new Promise((resolve) => f.tabReplies.push({ result, resolve }));
        }
        return result;
      }
      if (contract.name === "shared-browser.video.read")
        return new Promise((resolve, reject) => f.reads.push({ input, resolve, reject }));
      if (contract.name === "shared-browser.capture")
        return new Promise((resolve) => f.captures.push({ input, resolve }));
      if (contract.name === "shared-browser.navigate" && f.deferNavigation)
        return new Promise((resolve, reject) => f.deferredNavigations.push({ resolve, reject }));
      if (contract.name === "shared-browser.control.acquire") {
        if (f.deferAcquire) return new Promise((resolve) => f.acquireReplies.push(resolve));
        f.state = { ...f.state, controller: "self" };
        return { state: f.state, controlToken: "c".repeat(32) };
      }
      if (contract.name === "shared-browser.gesture.begin") {
        if (f.deferBegin) return new Promise((resolve) => f.deferredBegins.push(resolve));
        if (f.staleBeginOnce) {
          f.staleBeginOnce = false;
          return { state: { ...f.state }, admission: "stale-frame" };
        }
        return { gestureId: "g".repeat(32), nextSequence: 1, state: { ...f.state } };
      }
      if (contract.name === "shared-browser.gesture.end")
        return { state: { ...f.state }, cursor: null };
      if (contract.name === "shared-browser.gesture.update")
        return {
          gestureId: "g".repeat(32),
          nextSequence: input.sequence + 1,
          state: { ...f.state },
          cursor: "pointer",
        };
      return { state: { ...f.state } };
    });
  return rpcCache.get(contract.name);
};
const native = await readFile(
  join(repository, "tests/fixtures/panel-video-native.fixture.cjs"),
  "utf8",
);
await writeFile(
  join(out, "sdk.cjs"),
  native +
    `\nmodule.exports.useRpc=c=>globalThis.panelFixture.rpc(c);module.exports.useSettings=()=>({status:'loading',saving:false});\nmodule.exports.Image=props=>{React.useEffect(()=>{globalThis.panelFixture.imageLoads.push(()=>props.onLoad?.())},[props.source?.uri]);return React.createElement('img',{'data-image':'yes',style:rnStyle(props.style),src:props.source?.uri})};\nmodule.exports.AppState.currentState='active';`,
);
await writeFile(
  join(out, "web.ts"),
  `export * from ${JSON.stringify(join(repository, "client/web"))};import {bindBrowserCanvasWeb as actualBind} from ${JSON.stringify(join(repository, "client/web"))};export function bindBrowserCanvasWeb(node:any,input:any,enabled:any,cursor:any){return actualBind(node,{...input,mouseDown(...args:any[]){const answer=input.mouseDown(...args);return answer}},enabled,cursor)}export function supportsBrowserVideo(){return true}export function bindBrowserVideoVisibility(_node:any,fn:any){fn(true);return()=>{}}export function createBrowserVideoEnvironment(node:any){globalThis.panelFixture.host=node;return{dispose(){},environment:{createDecoder(cb:any){globalThis.panelFixture.decoderCreates++;return{decodeQueueSize:0,configure(){},close(){globalThis.panelFixture.decoderCloses++},decode(chunk:any){cb.output({timestamp:chunk.timestamp,displayWidth:1280,displayHeight:800,close(){}})}}},createChunk:(x:any)=>x,decodeBase64:()=>new Uint8Array([0]),scheduleDraw(fn:any){globalThis.panelFixture.paint=fn;return()=>{}},draw(){globalThis.panelFixture.draws++}}}}`,
);
await build({
  entryPoints: [join(repository, "client/browser.tsx")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(out, "panel.cjs"),
  external: [
    tooling.resolve("react"),
    tooling.resolve("react/jsx-runtime"),
    tooling.resolve("@tanstack/react-query"),
  ],
  alias: {
    react: tooling.resolve("react"),
    "react/jsx-runtime": tooling.resolve("react/jsx-runtime"),
    "@tanstack/react-query": tooling.resolve("@tanstack/react-query"),
  },
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve(
          { filter: /^(react-native|@getpaseo\/plugin(?:\/client(?:\/react-native)?)?)$/ },
          () => ({ path: join(out, "sdk.cjs") }),
        );
        b.onResolve({ filter: /^\.\/web$/ }, () => ({ path: join(out, "web.ts") }));
      },
    },
  ],
});
const { SharedBrowserPanel } = createRequire(import.meta.url)(join(out, "panel.cjs"));
const root = createRoot(document.getElementById("root"));
const query = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const frame = (n) => ({
  streamId: "z".repeat(32),
  captureGeneration: 1,
  sequence: n,
  timestampUs: n * 1000,
  type: "key",
  codec: "vp8",
  width: 1280,
  height: 800,
  dataBase64: "AA==",
  capturedAt: new Date().toISOString(),
  frame: {
    frameId: String(n).padStart(32, "x"),
    sessionId: state.sessionId,
    runtimeId: state.runtimeId,
    captureEpoch: 1,
    navigationGeneration: 1,
    viewportGeneration: 1,
    width: 1280,
    height: 800,
    capturedAt: new Date().toISOString(),
  },
});
async function flush(ms = 0) {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
try {
  await React.act(async () =>
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: query },
        React.createElement(SharedBrowserPanel, {
          theme: { colors: new Proxy({}, { get: () => "#777" }) },
          host: { id: "fixture", label: "Fixture" },
          layout: { compact: values.compact, platform: "web" },
          workspaceId: "workspace",
        }),
      ),
    ),
  );
  await flush(30);
  await React.act(async () =>
    f.captures[0].resolve({
      state: { ...f.state },
      frame: {
        ...frame(0).frame,
        mimeType: "image/jpeg",
        transport: "cdp-screencast",
        dataBase64: "AA==",
        byteLength: 1,
      },
    }),
  );
  await flush(10);
  await React.act(async () => f.imageLoads.pop()());
  assert(f.reads.length > 0, "first video request");
  await React.act(async () =>
    f.reads[0].resolve({
      status: "ready",
      state: { ...f.state },
      streamId: "z".repeat(32),
      packets: [frame(1)],
    }),
  );
  await React.act(async () => f.paint());
  await flush(20);
  assert(document.body.textContent.includes("Video"), "video displayed");
  console.log("PASS full panel painted Video");
  if (values.fixture === "tab-focus") {
    f.deferTabs = true;
    await React.act(async () => {
      void query.refetchQueries({ queryKey: ["shared-browser", "tabs", "fixture", "workspace"] });
    });
    assert.equal(f.tabReplies.length, 1, "pre-creation list is still in flight");
    const create = document.querySelector('button[aria-label="New browser tab"]');
    assert(create && !create.disabled, "new tab action is available");
    await React.act(async () => create.click());
    await flush(30);
    const selected = () => document.querySelector('button[role="tab"][aria-selected="true"]');
    assert(selected()?.textContent.includes("about:blank"), "created tab immediately gains focus");
    const attachments = () => f.calls.filter((call) => call.name === "shared-browser.attach");
    assert.equal(attachments().at(-1).input.tabId, f.createdTabId);
    await React.act(async () => f.tabReplies[0].resolve(f.tabReplies[0].result));
    await flush(30);
    assert(selected()?.textContent.includes("about:blank"), "late old list cannot undo focus");
    const latest = f.tabReplies.at(-1);
    await React.act(async () => latest.resolve(latest.result));
    await flush(30);
    assert.equal(f.calls.filter((call) => call.name === "shared-browser.tabs.create").length, 1);
    assert.equal(attachments().length, 2, "selection attaches to the new page exactly once");
    assert.equal(attachments().at(-1).input.tabId, f.createdTabId);
    assert.equal(selected()?.getAttribute("aria-selected"), "true");
    console.log("PASS new tab retains focus across cached and delayed pre-creation tab lists");
  } else if (values.fixture.startsWith("control-gate")) {
    const reload = document.querySelector('button[aria-label="Reload"]');
    assert(reload && !reload.disabled, "observer can select Reload");
    await React.act(async () => reload.click());
    await flush(20);
    const dialog = document.querySelector('section[aria-label$="control?"]');
    assert(dialog, "control request dialog opens");
    const message = Array.from(dialog.querySelectorAll("span")).find((node) =>
      node.textContent.includes("Take control to reload the page"),
    );
    assert.equal(message?.style.textAlign, "left", "confirmation copy follows modal alignment");
    const actionRow = dialog.querySelector('button[aria-label="Cancel"]')?.parentElement;
    assert.equal(
      actionRow?.style.justifyContent,
      "flex-end",
      "confirmation actions align together",
    );
    assert.equal(f.calls.filter((call) => call.name === "shared-browser.navigate").length, 0);
    if (values.fixture === "control-gate-takeover") {
      assert(dialog.textContent.includes("Agent fixture"));
    }
    const confirm = dialog.querySelector('button[aria-label^="Take "]');
    assert(confirm, "dialog offers control");
    await React.act(async () => confirm.click());
    await flush(20);
    const acquire = f.calls.findLast((call) => call.name === "shared-browser.control.acquire");
    assert.equal(acquire.input.takeover, values.fixture === "control-gate-takeover");
    if (values.fixture === "control-gate-stale") {
      assert(f.reads[1], "next video state observation");
      f.state = { ...f.state, navigationGeneration: 2 };
      await React.act(async () =>
        f.reads[1].resolve({ status: "ready", state: { ...f.state }, streamId: null, packets: [] }),
      );
      await flush(30);
      await React.act(async () =>
        f.acquireReplies[0]({
          state: { ...f.state, controller: "self" },
          controlToken: "c".repeat(32),
        }),
      );
      await flush(30);
      assert.equal(f.calls.filter((call) => call.name === "shared-browser.navigate").length, 0);
      assert(f.calls.some((call) => call.name === "shared-browser.control.release"));
      console.log("PASS changed page cancels queued action and releases acquired control");
    } else {
      const navigations = f.calls.filter((call) => call.name === "shared-browser.navigate");
      assert.equal(navigations.length, 1, "clicked action continues exactly once");
      assert.equal(navigations[0].input.action.kind, "reload");
      assert.equal(navigations[0].input.controlToken, "c".repeat(32));
      console.log("PASS control dialog acquires then runs clicked action once");
    }
  } else {
    const control = document.querySelector('button[aria-label="Take control"]');
    assert(control, "take control");
    await React.act(async () => control.click());
    await flush(30);
    for (const label of ["Back", "Forward", "Reload", "Display options", "Browser menu"]) {
      const button = document.querySelector(`button[aria-label="${label}"]`);
      assert(button, `toolbar control ${label}`);
      assert.equal(
        button.getAttribute("title"),
        label,
        "icon-only controls expose native hover titles",
      );
    }
    if (values.fixture === "settlement") {
      // Real Query callback replacement: viewing recovery completes while a
      // published control acquisition is still awaiting its original reply.
      f.token = "n".repeat(32);
      await React.act(async () =>
        f.reads[1].reject(
          Object.assign(new Error("Viewer token is invalid or expired"), { code: "handler_error" }),
        ),
      );
      await flush(60);
      assert.equal(f.calls.filter((call) => call.name === "shared-browser.attach").length, 2);
      await React.act(async () =>
        f.acquireReplies[0]({
          state: { ...f.state, controller: "self" },
          controlToken: "c".repeat(32),
        }),
      );
      await flush(30);
      assert(
        !document.body.textContent.includes("You control"),
        "old acquire cannot restore control after viewer replacement",
      );
      assert.equal(
        f.calls.filter((call) => call.name === "shared-browser.control.acquire").length,
        1,
        "acquisition not replayed",
      );
      console.log("PASS replaced viewer rejects delayed acquisition token/state");

      // An initial acquire has no local control token. Observe another owner and
      // its later release on the same viewer, then deliver the old acquire reply.
      const pendingTake = document.querySelector('button[aria-label="Take control"]');
      await React.act(async () => pendingTake.click());
      await flush(20);
      f.state = { ...f.state, controller: "other", controllerLabel: "Another controller" };
      await React.act(async () =>
        f.reads
          .at(-1)
          .resolve({ status: "ready", state: { ...f.state }, streamId: null, packets: [] }),
      );
      await flush(60);
      assert(document.body.textContent.includes("Another controller controls"));
      f.state = { ...f.state, controller: "none", controllerLabel: undefined };
      await React.act(async () =>
        f.reads
          .at(-1)
          .resolve({ status: "ready", state: { ...f.state }, streamId: null, packets: [] }),
      );
      await flush(60);
      await React.act(async () =>
        f.acquireReplies[1]({
          state: { ...f.state, controller: "self" },
          controlToken: "c".repeat(32),
        }),
      );
      await flush(30);
      assert(
        !document.body.textContent.includes("You control"),
        "ownership ABA cannot restore old acquired lease",
      );
      console.log(
        "PASS newer ownership observations fence delayed acquire even after release to none",
      );

      const take = document.querySelector('button[aria-label="Take control"]');
      await React.act(async () => take.click());
      await flush(20);
      f.state = { ...f.state, controller: "self", controllerLabel: "This viewer" };
      await React.act(async () =>
        f.reads
          .at(-1)
          .resolve({ status: "ready", state: { ...f.state }, streamId: null, packets: [] }),
      );
      await flush(60);
      assert(document.querySelector('button[aria-label="Reacquire"]'));
      await React.act(async () =>
        f.acquireReplies[2]({ state: { ...f.state }, controlToken: "c".repeat(32) }),
      );
      await flush(30);
      assert(
        document.querySelector('button[aria-label="Release"]'),
        "own acquisition observed before its RPC reply still publishes the control token",
      );
      assert.equal(
        f.calls.filter((call) => call.name === "shared-browser.control.acquire").length,
        3,
        "observed acquisition not replayed",
      );
      console.log("PASS own acquisition observation preserves its delayed control receipt");

      // Explicit takeover has the same media-before-token ordering, but starts
      // from a competing controller rather than an unowned session.
      f.state = { ...f.state, controller: "other", controllerLabel: "Another controller" };
      await React.act(async () =>
        f.reads
          .at(-1)
          .resolve({ status: "ready", state: { ...f.state }, streamId: null, packets: [] }),
      );
      await flush(60);
      const takeover = document.querySelector('button[aria-label="Take over"]');
      assert(takeover);
      await React.act(async () => takeover.click());
      await flush(20);
      assert.equal(
        f.calls.findLast((call) => call.name === "shared-browser.control.acquire").input.takeover,
        true,
      );
      f.state = { ...f.state, controller: "self", controllerLabel: "This viewer" };
      await React.act(async () =>
        f.reads
          .at(-1)
          .resolve({ status: "ready", state: { ...f.state }, streamId: null, packets: [] }),
      );
      await flush(60);
      assert(document.querySelector('button[aria-label="Reacquire"]'));
      await React.act(async () =>
        f.acquireReplies[3]({ state: { ...f.state }, controlToken: "c".repeat(32) }),
      );
      await flush(30);
      assert(document.querySelector('button[aria-label="Release"]'));
      assert.equal(
        f.calls.filter((call) => call.name === "shared-browser.control.acquire").length,
        4,
        "takeover not replayed",
      );
      console.log("PASS own takeover observation preserves its delayed control receipt");

      f.deferNavigation = true;
      const reload = document.querySelector('button[aria-label="Reload"]');
      await React.act(async () => reload.click());
      await flush(20);
      assert.equal(f.deferredNavigations.length, 1);
      assert.equal(
        f.calls.findLast((call) => call.name === "shared-browser.navigate").input.controlToken,
        "c".repeat(32),
        "delayed acquisition token authorizes the next explicit navigation",
      );
      const oldNavigation = f.deferredNavigations[0];
      const menu = document.querySelector('button[aria-label="Browser menu"]');
      await React.act(async () => menu.click());
      await flush(20);
      f.token = "q".repeat(32);
      f.state = { ...f.state, controller: "none" };
      const reconnect = document.querySelector('[aria-label="Reconnect viewer"]');
      assert(reconnect);
      await React.act(async () => reconnect.click());
      await flush(60);
      assert.equal(f.calls.filter((call) => call.name === "shared-browser.attach").length, 3);
      await React.act(async () => oldNavigation.reject(new Error("Old navigation failed")));
      await flush(30);
      assert(
        !document.body.textContent.includes("Old navigation failed"),
        "old failure cannot contaminate replacement viewer",
      );
      assert(!document.querySelector('button[aria-label="Release"]'));
      assert.equal(
        f.calls.filter((call) => call.name === "shared-browser.navigate").length,
        1,
        "navigation not replayed",
      );
      console.log("PASS old navigation error cannot settle into reattached viewer");
      console.log("RESULT 5 full-panel mutation settlement cases passed");
    } else {
      await React.act(async () =>
        f.reads[1].resolve({
          status: "ready",
          state: { ...f.state },
          streamId: "z".repeat(32),
          packets: [frame(2)],
        }),
      );
      await React.act(async () =>
        f.reads[2].resolve({
          status: "ready",
          state: { ...f.state },
          streamId: "z".repeat(32),
          packets: [frame(3)],
        }),
      );
      await React.act(async () => f.paint());
      await flush(20);
      if (values.fixture === "continuous" || values.fixture === "admission") {
        const overlay = f.host.nextElementSibling;
        overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500 });
        const count = (name) =>
          f.calls.filter((call) => call.name === `shared-browser.gesture.${name}`).length;
        const pointer = async (type) => {
          await React.act(async () =>
            overlay.dispatchEvent(
              new dom.window.MouseEvent(type, {
                clientX: 200,
                clientY: 100,
                button: 0,
                bubbles: true,
                cancelable: true,
              }),
            ),
          );
          await flush(10);
        };
        f.deferBegin = values.fixture === "continuous";
        f.staleBeginOnce = values.fixture === "admission";
        await pointer("mousedown");
        assert.equal(count("begin"), 1);
        assert.equal(count("update"), 0);
        await React.act(async () =>
          f.reads[3].resolve({
            status: "ready",
            state: { ...f.state },
            streamId: "z".repeat(32),
            packets: [{ ...frame(4), type: "delta" }],
          }),
        );
        await React.act(async () => f.paint());
        await flush(20);
        assert.equal(count("update"), 0);
        assert.equal(count("begin"), 1, "old-read visual-only paint cannot wake initial admission");
        if (values.fixture === "admission") {
          await React.act(async () =>
            f.reads[4].resolve({
              status: "ready",
              state: { ...f.state },
              streamId: "z".repeat(32),
              packets: [{ ...frame(5), type: "delta" }],
            }),
          );
          await React.act(async () => f.paint());
          await flush(20);
          assert.equal(
            count("begin"),
            2,
            "actual current paint publication wakes initial admission",
          );
          assert.equal(count("update"), 1);
          await pointer("mouseup");
          assert.equal(count("update"), 2);
          assert(!document.body.textContent.includes("A current decoded frame is required"));
          console.log(
            "PASS initial stale admission waits through visual-only paint, then current paint admits exactly once",
          );
        } else {
          f.deferBegin = false;
          await React.act(async () =>
            f.deferredBegins[0]({
              gestureId: "g".repeat(32),
              nextSequence: 1,
              state: { ...f.state },
            }),
          );
          await flush(20);
          assert.equal(
            count("update"),
            1,
            "ACKed begin permits first edge despite old-read visual paint",
          );
          await pointer("mouseup");
          for (let i = 0; i < 4; i++) {
            await pointer("mousedown");
            await pointer("mouseup");
          }
          assert.equal(count("begin"), 1);
          assert.equal(count("update"), 10);
          assert.equal(count("end"), 0, "physical releases do not immediately close the channel");
          assert(
            f.calls
              .filter((call) => call.name === "shared-browser.gesture.update")
              .every((call) => !call.input.target),
          );
          assert(!document.body.textContent.includes("A current decoded frame is required"));
          assert(!document.body.textContent.includes("Waiting for frame"));
          console.log(
            "PASS five physical clicks, one admitted channel, ten native edges without another source frame",
          );
          const sink = overlay.querySelector('textarea[aria-label="Type in the shared browser"]');
          assert(sink, "actual keyboard focus sink");
          await React.act(async () => {
            sink.focus();
            sink.dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                key: "π",
                code: "KeyP",
                bubbles: true,
                cancelable: true,
              }),
            );
            sink.dispatchEvent(
              new dom.window.KeyboardEvent("keyup", {
                key: "π",
                code: "KeyP",
                bubbles: true,
                cancelable: true,
              }),
            );
            overlay.dispatchEvent(
              new dom.window.WheelEvent("wheel", {
                clientX: 200,
                clientY: 100,
                deltaY: 27,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await flush(20);
          assert.equal(count("update"), 13);
          assert.deepEqual(
            f.calls
              .filter((call) => call.name === "shared-browser.gesture.update")
              .slice(10)
              .map((call) => call.input.event.kind),
            ["key", "key", "scroll"],
          );
          assert.equal(count("begin"), 1, "keyboard and wheel share admitted geometry");
          const touch = async (type, points) => {
            const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, "touches", {
              value: points.map((id) => ({ identifier: id, clientX: 200 + id, clientY: 100 })),
            });
            await React.act(async () => overlay.dispatchEvent(event));
            await flush(10);
          };
          await touch("touchstart", [0]);
          await touch("touchstart", [0, 1]);
          await touch("touchend", [1]);
          await touch("touchend", []);
          await touch("touchstart", [2]);
          await touch("touchend", []);
          assert.equal(count("update"), 19);
          assert.equal(
            count("begin"),
            2,
            "empty mouse-to-touch transition reopens acknowledged geometry",
          );
          assert.equal(count("end"), 1, "empty modality change closes normally");
          assert.equal(
            f.calls.find((call) => call.name === "shared-browser.gesture.end").input.cancel,
            false,
          );
          console.log(
            "PASS actual keyboard/wheel and touch 1-to-2-to-1-to-0 plus repeat contact without another frame",
          );
          await flush(4100);
          assert.equal(count("end"), 2, "empty channel closes after four-second idle");
          await pointer("mousedown");
          await pointer("mouseup");
          assert.equal(
            count("begin"),
            3,
            "same-context ACKed geometry reopens after idle without new pixels",
          );
          assert.equal(count("update"), 21);
          assert(!document.body.textContent.includes("A current decoded frame is required"));
          console.log(
            "PASS blocked source read across idle reopens acknowledged geometry without dropped click",
          );
        }
        console.log(`RESULT ${values.fixture} mounted input cases passed`);
      } else if (values.fixture === "rapid") {
        const overlay = f.host.nextElementSibling;
        overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500 });
        const before = {
          creates: f.decoderCreates,
          closes: f.decoderCloses,
          keys: f.reads.filter((read) => read.input.requestKeyFrame).length,
          draws: f.draws,
        };
        for (let index = 0; index < 5; index++) {
          await React.act(async () => {
            overlay.dispatchEvent(
              new dom.window.MouseEvent("mousedown", {
                clientX: 200,
                clientY: 100,
                button: 0,
                bubbles: true,
                cancelable: true,
              }),
            );
            overlay.dispatchEvent(
              new dom.window.MouseEvent("mouseup", {
                clientX: 200,
                clientY: 100,
                button: 0,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await flush(5);
          const oldRead = f.reads.at(-1);
          await React.act(async () =>
            oldRead.resolve({
              status: "ready",
              state: { ...f.state },
              streamId: "z".repeat(32),
              packets: [{ ...frame(4 + index * 2), type: "delta" }],
            }),
          );
          await React.act(async () => f.paint());
          await flush(5);
          const currentRead = f.reads.at(-1);
          assert.notEqual(currentRead, oldRead);
          assert.equal(currentRead.input.afterSequence, 4 + index * 2);
          assert.equal(currentRead.input.requestKeyFrame, false);
          await React.act(async () =>
            currentRead.resolve({
              status: "ready",
              state: { ...f.state },
              streamId: "z".repeat(32),
              packets: [{ ...frame(5 + index * 2), type: "delta" }],
            }),
          );
          await React.act(async () => f.paint());
          await flush(5);
        }
        assert.equal(
          f.calls.filter((call) => call.name === "shared-browser.gesture.update").length,
          10,
        );
        assert.equal(f.decoderCreates - before.creates, 0);
        assert.equal(f.decoderCloses - before.closes, 0);
        assert.equal(f.reads.filter((read) => read.input.requestKeyFrame).length - before.keys, 0);
        assert.equal(f.draws - before.draws, 10);
        assert(!document.body.textContent.includes("Waiting for frame"));
        console.log(
          "PASS five rapid clicks: ten continued paints, zero codec resets or extra key requests",
        );
        console.log("RESULT rapid-input mounted case passed");
      } else {
        const overlay = f.host.nextElementSibling;
        assert(overlay, "input overlay");
        overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500 });
        await React.act(async () => {
          overlay.dispatchEvent(
            new dom.window.MouseEvent("mousedown", {
              clientX: 200,
              clientY: 100,
              button: 0,
              bubbles: true,
              cancelable: true,
            }),
          );
          overlay.dispatchEvent(
            new dom.window.MouseEvent("mouseup", {
              clientX: 200,
              clientY: 100,
              button: 0,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await flush(100);
        assert(
          f.calls.some((c) => c.name === "shared-browser.gesture.update"),
          "actual gesture update",
        );
        assert(document.body.textContent.includes("Video"));
        assert(!document.body.textContent.includes("Waiting for frame"));
        console.log("PASS full panel ordinary click immediate video hold");
        await flush(2800);
        assert(
          !document.body.textContent.includes("Waiting for frame"),
          "held video avoids first-frame loader",
        );
        assert.equal(f.host.style.opacity, "1");
        assert(document.body.textContent.includes("Updating video"));
        console.log("PASS full panel media gap retains pixels while requesting fallback");
        const updatesBeforePress = f.calls.filter(
          (call) => call.name === "shared-browser.gesture.update",
        ).length;
        await React.act(async () =>
          overlay.dispatchEvent(
            new dom.window.MouseEvent("mousedown", {
              clientX: 200,
              clientY: 100,
              button: 0,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await flush(10);
        assert.equal(
          f.calls.filter((call) => call.name === "shared-browser.gesture.update").length,
          updatesBeforePress + 1,
          "admitted channel continues despite visual-only held pixels",
        );
        const captured = f.captures.at(-1);
        assert.notEqual(captured, f.captures[0]);
        assert.equal(
          captured.input.knownFrameId,
          null,
          "handoff requires image bytes even if underlying JPEG matches",
        );
        const jpeg = (n, nav = 1) => ({
          ...frame(n).frame,
          navigationGeneration: nav,
          mimeType: "image/jpeg",
          transport: "cdp-screencast",
          dataBase64: nav === 1 ? "AQ==" : "Ag==",
          byteLength: 1,
        });
        await React.act(async () => captured.resolve({ state: { ...f.state }, frame: jpeg(4) }));
        await flush(10);
        assert.equal(f.host.style.opacity, "1", "JPEG reply is not paint");
        assert(!document.body.textContent.includes("Waiting for frame"));
        assert.equal(
          f.imageLoads.length,
          0,
          "capture before refused press cannot acquire a new epoch",
        );
        assert.equal(f.host.style.opacity, "1");
        await React.act(async () => {
          void query.invalidateQueries({ queryKey: ["shared-browser", "capture"] });
        });
        await flush(10);
        const replacement = f.captures.at(-1);
        assert.notEqual(replacement, captured);
        await React.act(async () => replacement.resolve({ state: { ...f.state }, frame: jpeg(4) }));
        await flush(10);
        assert(f.imageLoads.length);
        await React.act(async () => f.imageLoads.pop()());
        await flush(10);
        assert.equal(f.host.style.opacity, "0", "new JPEG painted before video retirement");
        assert(document.body.textContent.includes("CDP"));
        console.log("PASS actual JPEG decode hands off held video");
        await React.act(async () =>
          f.reads[3].resolve({
            status: "waiting",
            state: { ...f.state },
            streamId: null,
            packets: [],
          }),
        );
        await flush(60);
        await React.act(async () =>
          f.reads[4].resolve({
            status: "ready",
            state: { ...f.state },
            streamId: "z".repeat(32),
            packets: [frame(5)],
          }),
        );
        await React.act(async () => f.paint());
        await flush(20);
        assert.equal(f.host.style.opacity, "1");
        const beforeNavCaptures = f.captures.length;
        f.state = { ...f.state, navigationGeneration: 2, url: "http://fixture.local/#changed" };
        await React.act(async () =>
          f.reads[5].resolve({
            status: "reset",
            state: { ...f.state },
            streamId: null,
            packets: [],
          }),
        );
        await flush(60);
        assert.equal(f.host.style.opacity, "1");
        assert(!document.body.textContent.includes("Waiting for frame"));
        assert(document.body.textContent.includes("Video"));
        assert.equal(f.captures.length, beforeNavCaptures, "timely SPA reset never starts JPEG");
        const navPacket = frame(6);
        navPacket.frame.navigationGeneration = 2;
        await React.act(async () =>
          f.reads[6].resolve({
            status: "ready",
            state: { ...f.state },
            streamId: "z".repeat(32),
            packets: [navPacket],
          }),
        );
        await React.act(async () => f.paint());
        await flush(20);
        assert.equal(f.host.style.opacity, "1");
        assert.equal(f.captures.length, beforeNavCaptures);
        assert(!document.body.textContent.includes("Waiting for frame"));
        console.log("PASS SPA reset resumes native video without JPEG or first-frame loader");
        console.log("RESULT 5 full-panel mounted cases passed");
      }
    }
  }
} finally {
  await React.act(async () => root.unmount());
  query.clear();
  dom.window.close();
  await rm(out, { recursive: true, force: true });
}
