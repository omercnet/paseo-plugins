import { describe, expect, test } from "vitest";
import { validatedHttpUrl } from "../shared/external-url";

describe("external URL validation", () => {
  test.each(["javascript:alert(1)", "file:///tmp/secret", "/relative", "invalid"])(
    "rejects unsafe external URL %s before opening",
    (url) => {
      expect(() => validatedHttpUrl(url)).toThrow("Only absolute HTTP(S) URLs are supported.");
    },
  );
});
