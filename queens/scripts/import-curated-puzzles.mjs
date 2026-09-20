import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://queensultimate.com/puzzles";
const SIZES = Array.from({ length: 10 }, (_, index) => index + 5);
const DIFFICULTIES = ["beginner", "easy", "medium", "hard"];
const CONCURRENCY = 12;

function chunkRanges(size, maxId) {
  const ranges = [];
  const addPhase = (first, last) => {
    for (let start = first; start <= last; start += 100) {
      ranges.push([start, Math.min(start + 99, last)]);
    }
  };
  if (size === 13) {
    addPhase(1, 2699);
    addPhase(2700, maxId);
  } else if (size === 14) {
    addPhase(1, 3437);
    addPhase(3438, maxId);
  } else {
    addPhase(1, maxId);
  }
  return ranges;
}

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return await response.text();
    if (attempt === 2) throw new Error(`${url} returned ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw new Error(`${url} failed`);
}

function parsePuzzle(line, expectedSize) {
  const parts = line.split(":");
  if (parts.length !== 7) throw new Error(`Malformed puzzle line: ${line.slice(0, 80)}`);
  const id = Number(parts[0]);
  const size = Number(parts[1]);
  const difficulty = parts[3].split("@")[0].toLowerCase();
  if (size !== expectedSize) throw new Error(`Size mismatch for ${id}`);

  const regions = new Uint8Array(size * size);
  regions.fill(255);
  const encodedRegions = parts[4].split("|");
  if (Number(encodedRegions[0]) !== size || encodedRegions.length !== size + 1) {
    throw new Error(`Region header mismatch ${size}-${id}`);
  }
  for (const encodedRegion of encodedRegions.slice(1)) {
    const match = /^(\d+)#(\d+)@(.+)$/.exec(encodedRegion);
    if (!match) throw new Error(`Malformed region ${size}-${id}`);
    const region = Number(match[1]);
    const indexes = match[3].split(",").map(Number);
    if (indexes.length !== Number(match[2])) throw new Error(`Region count mismatch ${size}-${id}`);
    for (const index of indexes) {
      if (index < 0 || index >= regions.length || regions[index] !== 255) {
        throw new Error(`Region coverage error ${size}-${id}`);
      }
      regions[index] = region;
    }
  }
  if (regions.some((region) => region === 255 || region >= size)) {
    throw new Error(`Incomplete regions ${size}-${id}`);
  }

  const solutionMask = parts[6];
  if (solutionMask.length !== size * size)
    throw new Error(`Solution length mismatch ${size}-${id}`);
  const solutionColumns = new Uint8Array(size);
  const usedColumns = new Set();
  const usedRegions = new Set();
  let previousColumn = -2;
  for (let row = 0; row < size; row += 1) {
    const columns = [];
    for (let column = 0; column < size; column += 1) {
      if (solutionMask[row * size + column] !== "0") columns.push(column);
    }
    if (columns.length !== 1) throw new Error(`Solution row mismatch ${size}-${id}`);
    const column = columns[0];
    const region = regions[row * size + column];
    if (
      usedColumns.has(column) ||
      usedRegions.has(region) ||
      Math.abs(column - previousColumn) <= 1
    ) {
      throw new Error(`Invalid solution ${size}-${id}`);
    }
    solutionColumns[row] = column;
    usedColumns.add(column);
    usedRegions.add(region);
    previousColumn = column;
  }
  return { id, size, difficulty, regions, solutionColumns };
}

const indexes = new Map();
for (const size of SIZES) {
  for (const difficulty of DIFFICULTIES) {
    const text = await fetchText(`${BASE_URL}/random-index/${size}x${size}-${difficulty}.json`);
    indexes.set(`${size}-${difficulty}`, JSON.parse(text));
  }
}

const jobs = [];
for (const size of SIZES) {
  const ids = DIFFICULTIES.flatMap((difficulty) => indexes.get(`${size}-${difficulty}`).puzzles);
  const maxId = Math.max(...ids);
  for (const [start, end] of chunkRanges(size, maxId)) {
    jobs.push({ size, url: `${BASE_URL}/puzzles-${size}x${size}-Q1-${start}-${end}.txt` });
  }
}

const puzzlesBySize = new Map();
let cursor = 0;
async function worker() {
  for (;;) {
    const job = jobs[cursor++];
    if (!job) return;
    const text = await fetchText(job.url);
    const puzzles = puzzlesBySize.get(job.size) ?? new Map();
    for (const line of text.trim().split(/\r?\n/)) {
      const puzzle = parsePuzzle(line, job.size);
      if (puzzles.has(puzzle.id)) throw new Error(`Duplicate puzzle ${job.size}-${puzzle.id}`);
      puzzles.set(puzzle.id, puzzle);
    }
    puzzlesBySize.set(job.size, puzzles);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const groups = {};
let total = 0;
for (const size of SIZES) {
  const puzzles = puzzlesBySize.get(size);
  const seen = new Set();
  for (const difficulty of DIFFICULTIES) {
    const ids = indexes.get(`${size}-${difficulty}`).puzzles;
    const regionBytes = Math.ceil((size * size) / 2);
    const recordBytes = 2 + regionBytes + size;
    const bytes = new Uint8Array(ids.length * recordBytes);
    ids.forEach((id, recordIndex) => {
      if (seen.has(id)) throw new Error(`Difficulty overlap ${size}-${id}`);
      seen.add(id);
      const puzzle = puzzles.get(id);
      if (!puzzle || puzzle.difficulty !== difficulty)
        throw new Error(`Missing curated puzzle ${size}-${id}`);
      let offset = recordIndex * recordBytes;
      bytes[offset++] = id >> 8;
      bytes[offset++] = id & 255;
      for (let cell = 0; cell < size * size; cell += 2) {
        bytes[offset++] = (puzzle.regions[cell] << 4) | (puzzle.regions[cell + 1] ?? 0);
      }
      bytes.set(puzzle.solutionColumns, offset);
    });
    groups[`${size}-${difficulty}`] = {
      size,
      difficulty,
      count: ids.length,
      recordBytes,
      data: Buffer.from(bytes).toString("base64"),
    };
    total += ids.length;
  }
  if (seen.size !== puzzles.size) throw new Error(`Unindexed puzzles for ${size}`);
}

const outputDirectory = path.resolve(process.argv[2] ?? "/tmp/queens-curated-gist");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const manifest = {};
for (const [key, group] of Object.entries(groups)) {
  const fileName = `${key}.b64`;
  await writeFile(path.join(outputDirectory, fileName), `${group.data}\n`);
  manifest[key] = {
    size: group.size,
    difficulty: group.difficulty,
    count: group.count,
    recordBytes: group.recordBytes,
    sha256: createHash("sha256").update(group.data).digest("hex"),
    fileName,
  };
}
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const gistId = process.env.QUEENS_GIST_ID;
const gistRevision = process.env.QUEENS_GIST_REVISION;
if ((gistId && !gistRevision) || (!gistId && gistRevision)) {
  throw new Error("QUEENS_GIST_ID and QUEENS_GIST_REVISION must be supplied together.");
}
if (gistId && gistRevision) {
  const gistOwner = process.env.QUEENS_GIST_OWNER ?? "omercnet";
  const lines = [
    'import type { PuzzleDifficulty } from "../shared/puzzle-catalog";',
    "",
    "/** Pinned, integrity-checked files in an unlisted GitHub Gist. */",
    "export type RemotePuzzleGroup = {",
    "  readonly size: number;",
    "  readonly difficulty: PuzzleDifficulty;",
    "  readonly count: number;",
    "  readonly recordBytes: number;",
    "  readonly sha256: string;",
    "  readonly url: string;",
    "};",
    "",
    "export const REMOTE_PUZZLE_GROUPS: Readonly<Record<string, RemotePuzzleGroup>> = {",
  ];
  for (const [key, entry] of Object.entries(manifest)) {
    lines.push(`  ${JSON.stringify(key)}: {`);
    lines.push(`    size: ${entry.size},`);
    lines.push(`    difficulty: ${JSON.stringify(entry.difficulty)},`);
    lines.push(`    count: ${entry.count},`);
    lines.push(`    recordBytes: ${entry.recordBytes},`);
    lines.push(`    sha256: ${JSON.stringify(entry.sha256)},`);
    lines.push(
      `    url: ${JSON.stringify(`https://gist.githubusercontent.com/${gistOwner}/${gistId}/raw/${gistRevision}/${entry.fileName}`)},`,
    );
    lines.push("  },");
  }
  lines.push("};", "");
  await writeFile(path.join(process.cwd(), "server", "curated-manifest.ts"), lines.join("\n"));
}
console.log(
  `Stored ${total} curated puzzles from ${jobs.length} source chunks in ${outputDirectory}.`,
);
