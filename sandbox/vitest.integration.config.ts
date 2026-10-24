import { defineConfig } from "vitest/config";

// Real Docker: builds the runtime image on first use, then starts and removes real containers.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.itest.ts"],
    testTimeout: 5 * 60_000,
    hookTimeout: 20 * 60_000,
    fileParallelism: false,
  },
});
