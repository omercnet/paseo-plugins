import { describe, expect, it } from "vitest";
import { createComposeSession } from "./browser-compose-session";

function fixture(accept = true) {
  const auth = { enabled: true, ownershipKey: "page-1" };
  const inserted: string[] = [];
  let cancels = 0;
  const session = createComposeSession({
    authority: () => auth,
    composeText: (text) => {
      if (accept) inserted.push(text);
      return accept;
    },
    cancelInput: () => {
      cancels += 1;
    },
  });
  return { auth, inserted, session, cancels: () => cancels };
}

describe("compose session", () => {
  it("cancels held input on open and inserts a committed draft exactly once", () => {
    const f = fixture();
    f.session.open();
    expect(f.cancels()).toBe(1);
    expect(f.session.commit("héllo 日本語")).toBe(true);
    expect(f.session.commit("héllo 日本語")).toBe(false);
    expect(f.inserted).toEqual(["héllo 日本語"]);
  });

  it("refuses commit after control or page ownership changes and never borrows the new one", () => {
    const f = fixture();
    f.session.open();
    f.auth.ownershipKey = "page-2";
    expect(f.session.commit("stale")).toBe(false);
    f.auth.ownershipKey = "page-1";
    f.auth.enabled = false;
    expect(f.session.commit("no control")).toBe(false);
    f.auth.enabled = true;
    expect(f.inserted).toEqual([]);
    f.session.close();
    expect(f.session.commit("closed")).toBe(false);
  });

  it("keeps the draft reviewable when the queue rejects it and does not commit empty drafts", () => {
    const f = fixture(false);
    f.session.open();
    expect(f.session.commit("x")).toBe(false);
    expect(f.session.owner()).toBe("page-1");
    expect(f.session.commit("")).toBe(false);
  });

  it("does not forward a rapid second press while insertion is in flight", () => {
    const f = fixture();
    let second: boolean | undefined;
    const s = createComposeSession({
      authority: () => f.auth,
      composeText: (text) => {
        second = s.commit(text);
        f.inserted.push(text);
        return true;
      },
      cancelInput: () => undefined,
    });
    s.open();
    expect(s.commit("once")).toBe(true);
    expect(second).toBe(false);
    expect(f.inserted).toEqual(["once"]);
  });
});
