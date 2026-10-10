/** Actual React/Query lifecycle assertions; run scripts/test-image-capture-mounted.mjs. */
const assert = require("node:assert/strict");
const { test, after, afterEach } = require("node:test");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
let completed = 0;
afterEach(() => {
  completed += 1;
});
const { createRequire } = require("node:module");
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
const { QueryClient, QueryClientProvider, focusManager } = dep("@tanstack/react-query");
const { useBrowserImageCapture } = require(
  join(process.env.SHARED_BROWSER_MOUNTED_OUTPUT, "capture.cjs"),
);
const { useBrowserViewerRecovery } = require(
  join(process.env.SHARED_BROWSER_MOUNTED_OUTPUT, "recovery.cjs"),
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expired = Object.assign(new Error("Request failed: Viewer token is invalid or expired"), {
  code: "handler_error",
});
async function fixture({ healthy = false, authority = healthy, blocked = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const root = createRoot(document.getElementById("root"));
  let token = "viewer-a",
    videoRefreshes = 0,
    result = null,
    resolve = null,
    reattach = 0,
    error = null,
    errorToken = null;
  const calls = [];
  function Probe() {
    result = useBrowserImageCapture({
      viewerToken: token,
      quality: "maximum",
      activeInput: true,
      videoOwnsPresentation: healthy,
      hasVideoPresentation: () => authority,
      refreshVideo: () => videoRefreshes++,
      mutationEpoch: () => 1,
      knownFrame: () => null,
      capture: async (input) => {
        calls.push(input);
        if (blocked)
          await new Promise((done) => {
            resolve = done;
          });
        return { state: { status: "ready" }, frame: null };
      },
    });
    useBrowserViewerRecovery({
      identity: "host/workspace",
      viewerToken: token,
      failedViewerToken: errorToken,
      captureError: error,
      pending: false,
      reconnect: () => {
        reattach++;
      },
    });
    return React.createElement("span", null, result.query.fetchStatus);
  }
  const render = async () =>
    React.act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
      await wait(1);
    });
  await render();
  return {
    calls,
    get result() {
      return result;
    },
    get videoRefreshes() {
      return videoRefreshes;
    },
    get reattach() {
      return reattach;
    },
    async update(next) {
      if ("healthy" in next) healthy = next.healthy;
      if ("authority" in next) authority = next.authority;
      if ("token" in next) token = next.token;
      if ("error" in next) error = next.error;
      if ("errorToken" in next) errorToken = next.errorToken;
      await render();
    },
    async settle() {
      blocked = false;
      await React.act(async () => {
        resolve?.();
        await wait(1);
      });
    },
    async delay(ms) {
      await React.act(async () => wait(ms));
    },
    async dispose() {
      await React.act(async () => root.unmount());
      client.clear();
    },
  };
}
test("actual query suppresses JPEG100 polling/focus/gesture refresh while video owns presentation, then resumes fallback", async () => {
  const f = await fixture({ healthy: true });
  try {
    await f.delay(1650);
    assert.equal(f.calls.length, 0);
    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      for (let i = 0; i < 8; i++) f.result.refreshCapture();
      f.result.retryFrameCapture();
      await wait(10);
    });
    assert.equal(f.calls.length, 0);
    assert.equal(f.videoRefreshes, 8);
    await f.update({ healthy: false, authority: false });
    await f.delay(150);
    assert.ok(f.calls.length >= 2);
    assert.ok(f.calls.every((value) => value.quality === "maximum"));
  } finally {
    await f.dispose();
  }
});
test("a pre-commit video authority receipt fences an already queued image query", async () => {
  const f = await fixture({ healthy: false, authority: true });
  try {
    await React.act(async () => {
      await f.result.query.refetch({ cancelRefetch: false });
      f.result.refreshCapture();
      f.result.retryFrameCapture();
    });
    await f.delay(150);
    assert.equal(f.calls.length, 0);
    await f.update({ authority: false });
    await f.delay(150);
    assert.ok(f.calls.length >= 1);
  } finally {
    await f.dispose();
  }
});
test("an in-flight JPEG refresh cannot schedule a follow-up after video paints", async () => {
  const f = await fixture({ blocked: true });
  try {
    assert.equal(f.calls.length, 1);
    await React.act(async () => f.result.refreshCapture());
    await f.update({ healthy: true, authority: true });
    await f.settle();
    await f.delay(350);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.dispose();
  }
});
test("old-scope follow-up is discarded and unmount stops periodic image work", async () => {
  const f = await fixture({ blocked: true });
  try {
    await React.act(async () => f.result.refreshCapture());
    await f.update({ token: "viewer-b", healthy: true, authority: true });
    await f.settle();
    await f.delay(150);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.dispose();
  }
  await React.act(async () => wait(200));
  assert.equal(f.calls.length, 1);
});
test("video expiry can reattach viewing once without waiting for a disabled image query; old-token errors cannot recover replacement", async () => {
  const f = await fixture({ healthy: true });
  try {
    await f.update({ error: expired, errorToken: "viewer-a" });
    assert.equal(f.reattach, 1);
    assert.equal(f.calls.length, 0);
    await f.update({ error: expired, errorToken: "viewer-a" });
    assert.equal(f.reattach, 1);
    await f.update({ token: "viewer-b" });
    assert.equal(f.reattach, 1);
    await f.update({ errorToken: "viewer-b" });
    assert.equal(f.reattach, 2);
  } finally {
    await f.dispose();
  }
});

test("retained refresh callbacks cannot restart image work after panel unmount", async () => {
  const f = await fixture();
  const refresh = f.result.refreshCapture,
    retry = f.result.retryFrameCapture;
  await f.dispose();
  const count = f.calls.length;
  await React.act(async () => {
    refresh();
    retry();
    await wait(150);
  });
  assert.equal(f.calls.length, count);
  assert.equal(f.videoRefreshes, 0);
});

after(() => {
  writeFileSync(
    join(process.env.SHARED_BROWSER_MOUNTED_OUTPUT, "completed.json"),
    JSON.stringify({ completed }),
    { mode: 0o600 },
  );
  focusManager.setFocused(undefined);
  dom.window.close();
});
