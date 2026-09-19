import { describe, expect, test, vi } from "vitest";
import { selectExternalUrlOpener, validatedHttpUrl } from "../shared/external-url";

describe("external URL opening", () => {
  test("uses Paseo 0.9 opening when the host provides it", async () => {
    const paseo = vi.fn(async () => {});
    const linking = vi.fn(async () => {});

    await selectExternalUrlOpener(paseo, linking)(validatedHttpUrl("https://example.com/docs"));

    expect(paseo).toHaveBeenCalledWith("https://example.com/docs");
    expect(linking).not.toHaveBeenCalled();
  });

  test("falls back to React Native Linking when the platform opener is unavailable", async () => {
    const linking = vi.fn(async () => {});

    await selectExternalUrlOpener(undefined, linking)(validatedHttpUrl("http://example.com/auth"));

    expect(linking).toHaveBeenCalledWith("http://example.com/auth");
  });

  test.each(["javascript:alert(1)", "file:///tmp/secret", "/relative", "invalid"])(
    "rejects unsafe external URL %s before opening",
    (url) => {
      expect(() => validatedHttpUrl(url)).toThrow("Only absolute HTTP(S) URLs are supported.");
    },
  );
});
