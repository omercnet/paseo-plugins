import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { decodePuzzleDeck } from "../client/game/curated";
import { REMOTE_PUZZLE_GROUPS, type RemotePuzzleGroup } from "../server/curated-manifest";
import { createPuzzleDeckLoader } from "../server/puzzle-catalog";

const EXPECTED_PUZZLE_COUNT = 97_184;
const PINNED_GIST_REVISION = "4f3e565c2805a709a5121c5617bdd6f327a2ecd8";

function fixtureGroup() {
  const size = 5;
  const regionBytes = Math.ceil((size * size) / 2);
  const recordBytes = 2 + regionBytes + size;
  const bytes = new Uint8Array(recordBytes);
  bytes[1] = 1;
  let offset = 2;
  for (let cell = 0; cell < size * size; cell += 2) {
    const first = Math.floor(cell / size);
    const second = Math.floor(Math.min(cell + 1, size * size - 1) / size);
    bytes[offset++] = (first << 4) | second;
  }
  bytes.set([0, 2, 4, 1, 3], offset);
  const data = Buffer.from(bytes).toString("base64");
  const manifest: RemotePuzzleGroup = {
    size,
    difficulty: "easy",
    count: 1,
    recordBytes,
    sha256: createHash("sha256").update(data).digest("hex"),
    url: "https://example.test/5-easy.b64",
  };
  return { data, manifest };
}

describe("remote curated puzzle corpus", () => {
  test("pins every curated group and expected puzzle count", () => {
    const groups = Object.values(REMOTE_PUZZLE_GROUPS);
    expect(groups).toHaveLength(40);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(EXPECTED_PUZZLE_COUNT);
    expect(new Set(groups.map((group) => group.url)).size).toBe(40);
    for (const group of groups) {
      expect(group.url).toContain(PINNED_GIST_REVISION);
      expect(group.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("loads, verifies, caches, and decodes a remote deck", async () => {
    const { data, manifest } = fixtureGroup();
    const fetcher = vi.fn(
      async () =>
        new Response(`${data}\n`, {
          status: 200,
          headers: { "content-length": String(data.length + 1) },
        }),
    );
    const load = createPuzzleDeckLoader(fetcher as typeof fetch, { "5-easy": manifest });

    const encoded = await load({ size: 5, difficulty: "easy" });
    const deck = decodePuzzleDeck(encoded);
    expect(deck.puzzles).toHaveLength(1);
    expect(deck.puzzles[0]).toMatchObject({ id: "queens-5x5-easy-1", size: 5 });
    expect(deck.solutions[deck.puzzles[0].id]).toEqual([0, 7, 14, 16, 23]);

    await load({ size: 5, difficulty: "easy" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("rejects a payload that fails integrity verification", async () => {
    const { manifest } = fixtureGroup();
    const fetcher = vi.fn(async () => new Response("tampered", { status: 200 }));
    const load = createPuzzleDeckLoader(fetcher as typeof fetch, { "5-easy": manifest });

    await expect(load({ size: 5, difficulty: "easy" })).rejects.toThrow("integrity check");
  });
});
