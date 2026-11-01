import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// The image cache lives under PASEO_HOME; never let a test write into the user's ~/.paseo.
const home = mkdtempSync(join(tmpdir(), "paseo-omp-test-home-"));
process.env.PASEO_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
