/** Real React/Query writes and menu events, without runtime or browser processes. */
const assert = require("node:assert/strict");
const { test, after, afterEach } = require("node:test");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const dep = createRequire(join(process.env.SHARED_BROWSER_MOUNTED_TOOLING_ROOT, "package.json"));
const { JSDOM } = dep("jsdom");
const dom = new JSDOM('<div id="root"></div>');
Object.assign(global, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = dep("react");
const { createRoot } = dep("react-dom/client");
const { QueryClient, QueryClientProvider } = dep("@tanstack/react-query");
const { useBrowserCaptureDensity } = require(
  join(process.env.SHARED_BROWSER_MOUNTED_OUTPUT, "density.cjs"),
);
const { BrowserCaptureDensityControls } = require(
  join(process.env.SHARED_BROWSER_MOUNTED_OUTPUT, "density-ui.cjs"),
);
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
let completed = 0;
afterEach(() => completed++);
async function fixture() {
  const root = createRoot(document.getElementById("root"));
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  let result, resolve, reject;
  let identity = "host/workspace-a";
  let viewerToken = "viewer",
    controlToken = "control";
  let state = {
    status: "ready",
    controller: "self",
    captureScale: 1,
    viewport: { width: 1280, height: 800 },
    sessionId: "session",
    navigationGeneration: 2,
    viewportGeneration: 3,
    devicePresetId: "desktop-chrome",
  };
  const calls = [],
    success = [],
    errors = [];
  let bumps = 0;
  function Probe() {
    result = useBrowserCaptureDensity({
      identity: JSON.stringify([identity, viewerToken, controlToken]),
      current: () => ({
        state,
        context: {
          viewerToken,
          controlToken,
          expected: {
            sessionId: state.sessionId,
            navigationGeneration: state.navigationGeneration,
            viewportGeneration: state.viewportGeneration,
          },
        },
      }),
      change: async (request) => {
        calls.push(request);
        return new Promise((ok, fail) => {
          resolve = ok;
          reject = fail;
        });
      },
      beforeChange: () => bumps++,
      onSuccess: (value) => success.push(value),
      onError: (value) => errors.push(value),
    });
    return React.createElement(BrowserCaptureDensityControls, {
      theme: { colors: {} },
      density: state.captureScale,
      viewport: state.viewport,
      disabled: state.controller !== "self" || result.pending,
      onChange: result.select,
    });
  }
  const render = async () =>
    React.act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
      await wait();
    });
  await render();
  return {
    calls,
    success,
    errors,
    get result() {
      return result;
    },
    get bumps() {
      return bumps;
    },
    async update(change) {
      if (change.identity) identity = change.identity;
      if (change.viewerToken) viewerToken = change.viewerToken;
      if (change.controlToken) controlToken = change.controlToken;
      state = { ...state, ...change.state };
      await render();
    },
    async click(density) {
      await React.act(async () => {
        document.querySelector(`[aria-label="Capture density: ${density}×"]`).click();
        await wait();
      });
    },
    async resolve() {
      await React.act(async () => {
        resolve({ state: { ...state, captureScale: 2 } });
        await wait();
      });
    },
    async reject() {
      await React.act(async () => {
        reject(new Error("uncertain"));
        await wait();
      });
    },
    async dispose() {
      await React.act(async () => root.unmount());
      client.clear();
    },
  };
}
test("density uses the actual capture state and sends one exact controller write without presets", async () => {
  const f = await fixture();
  try {
    await f.click(2);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], {
      viewerToken: "viewer",
      controlToken: "control",
      expected: { sessionId: "session", navigationGeneration: 2, viewportGeneration: 3 },
      density: 2,
    });
    assert.equal(f.bumps, 1);
    await f.click(2);
    assert.equal(f.calls.length, 1);
    await f.resolve();
    assert.equal(f.success.length, 1);
    await f.update({ state: { captureScale: 2, devicePresetId: "desktop-chrome" } });
    assert.equal(
      document.querySelector('[aria-label="Capture density: 2×"]').getAttribute("aria-selected"),
      "true",
    );
    await f.click(2);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.dispose();
  }
});
test("observer and oversized CSS refuse retained handlers, while exact boundary remains enabled", async () => {
  const f = await fixture();
  try {
    const retained = f.result.select;
    await f.update({ state: { controller: "other" } });
    retained(2);
    await f.click(2);
    assert.equal(f.calls.length, 0);
    await f.update({ state: { controller: "self", viewport: { width: 1281, height: 800 } } });
    retained(2);
    assert.equal(f.calls.length, 0);
    assert.match(document.body.textContent, /1280 or less/);
    assert.equal(document.querySelector('[aria-label="Capture density: 2×"]').disabled, true);
    await f.update({ state: { viewport: { width: 1280, height: 1281 } } });
    assert.equal(document.querySelector('[aria-label="Capture density: 2×"]').disabled, true);
    await f.update({ state: { viewport: { width: 1280, height: 1280 } } });
    assert.equal(document.querySelector('[aria-label="Capture density: 2×"]').disabled, false);
  } finally {
    await f.dispose();
  }
});
test("a retained old-host density callback and pending old reply cannot mutate the replacement scope", async () => {
  const f = await fixture();
  try {
    const retained = f.result.select;
    await f.click(2);
    await f.update({ identity: "host/workspace-b" });
    retained(2);
    await f.resolve();
    assert.equal(f.calls.length, 1);
    assert.equal(f.success.length, 0);
  } finally {
    await f.dispose();
  }
});
test("an uncertain density error surfaces once without retry", async () => {
  const f = await fixture();
  try {
    await f.click(2);
    await f.reject();
    await wait();
    assert.equal(f.calls.length, 1);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, /uncertain/);
  } finally {
    await f.dispose();
  }
});
test("late old-viewer reply is suppressed and a retained callback cannot send after token replacement", async () => {
  const f = await fixture();
  try {
    const retained = f.result.select;
    await f.click(2);
    await f.update({ viewerToken: "replacement", controlToken: "new-control" });
    retained(2);
    await f.resolve();
    assert.equal(f.calls.length, 1);
    assert.equal(f.success.length, 0);
  } finally {
    await f.dispose();
  }
});
test("unmount suppresses late settlement and retained density callbacks", async () => {
  const f = await fixture();
  const retained = f.result.select;
  await f.click(2);
  await f.dispose();
  retained(1);
  await f.resolve();
  assert.equal(f.calls.length, 1);
  assert.equal(f.success.length, 0);
});
after(() => {
  writeFileSync(
    join(process.env.SHARED_BROWSER_MOUNTED_OUTPUT, "completed.json"),
    JSON.stringify({ completed }),
    { mode: 0o600 },
  );
  dom.window.close();
});
