import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "../server/store";

const temporary = async () =>
  join(await mkdtemp(join(tmpdir(), "sandbox-store-")), "data", "state.json");

test("state is private to the daemon user", async () => {
  const path = await temporary();
  await new Store(path).update((draft) => {
    draft.credentials.A = { value: "secret", savedAt: "now" };
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
});

test("concurrent updates all land and survive a restart", async () => {
  const path = await temporary();
  const store = new Store(path);
  await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      store.update((draft) => {
        draft.credentials[`K${n}`] = { value: String(n), savedAt: "now" };
      }),
    ),
  );
  expect(Object.keys((await new Store(path).read()).credentials)).toHaveLength(20);
});

test("an unreadable file is reported and left alone, never replaced by an empty state", async () => {
  const path = await temporary();
  const store = new Store(path);
  await store.update((draft) => {
    draft.credentials.A = { value: "secret", savedAt: "now" };
  });
  await writeFile(path, "{ not json");
  const fresh = new Store(path);
  await expect(fresh.read()).rejects.toThrow("unreadable");
  await expect(fresh.update(() => undefined)).rejects.toThrow("unreadable");
  expect(await readFile(path, "utf8")).toBe("{ not json");
});
