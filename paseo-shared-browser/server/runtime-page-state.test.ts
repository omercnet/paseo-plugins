/** Fresh metadata reads overlap CDP latency but never accept mixed native identities. */
import { describe, expect, it } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

function fixture() {
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-state-profile",
    ipcDirectory: "/tmp/uncreated-state-ipc",
    session: "state-test",
  });
  const calls: string[] = [];
  const history = Promise.withResolvers<{
    currentIndex: number;
    entries: { url: string; title: string }[];
  }>();
  const metadata = Promise.withResolvers<{
    result: { value?: { url?: string; title?: string } };
  }>();
  const page = {
    send: (method: string) => {
      calls.push(method);
      return method === "Page.getNavigationHistory" ? history.promise : metadata.promise;
    },
  };
  const control = runtime as unknown as {
    page: typeof page;
    attachmentGeneration: number;
    documentGeneration: number;
    requirePage(): Promise<typeof page>;
  };
  control.page = page;
  control.requirePage = async () => page;
  return { runtime, control, page, calls, history, metadata };
}
const entries = [
  { url: "https://example.test/previous", title: "Previous" },
  { url: "https://example.test/current", title: "History title" },
];

describe("fresh parallel native page metadata", () => {
  it("starts both independent reads before either resolves and retains native history facts", async () => {
    const f = fixture();
    const pending = f.runtime.state();
    await Promise.resolve();
    expect(f.calls).toEqual(["Page.getNavigationHistory", "Runtime.evaluate"]);
    f.metadata.resolve({
      result: { value: { url: "https://example.test/current#hash", title: "Fresh title" } },
    });
    f.history.resolve({ currentIndex: 1, entries });
    expect(await pending).toMatchObject({
      url: "https://example.test/current#hash",
      title: "Fresh title",
      canGoBack: true,
      canGoForward: false,
    });
  });
  it("preserves existing native-history fallback when DOM values are absent", async () => {
    const f = fixture();
    const pending = f.runtime.state();
    f.metadata.resolve({ result: {} });
    f.history.resolve({ currentIndex: 0, entries });
    expect(await pending).toMatchObject({
      url: entries[0]!.url,
      title: "Previous",
      canGoBack: false,
      canGoForward: true,
    });
  });
  it("refuses document, attachment or page replacement during either pending observation", async () => {
    for (const kind of ["document", "attachment", "page"] as const) {
      const f = fixture();
      const pending = f.runtime.state();
      await Promise.resolve();
      if (kind === "document") f.control.documentGeneration++;
      if (kind === "attachment") f.control.attachmentGeneration++;
      if (kind === "page")
        f.control.page = { send: () => Promise.resolve({}) } as unknown as typeof f.page;
      f.history.resolve({ currentIndex: 1, entries });
      f.metadata.resolve({ result: { value: { title: "Obsolete document" } } });
      await expect(pending).rejects.toThrow("metadata changed");
    }
  });
  it("propagates failed native reads rather than reusing earlier metadata", async () => {
    for (const failed of ["history", "metadata"]) {
      const f = fixture();
      const pending = f.runtime.state();
      const refusal = expect(pending).rejects.toThrow("Read unavailable");
      if (failed === "history") f.history.reject(new Error("Read unavailable"));
      else f.history.resolve({ currentIndex: 1, entries });
      if (failed === "metadata") f.metadata.reject(new Error("Read unavailable"));
      else f.metadata.resolve({ result: {} });
      await refusal;
    }
  });
});
