import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["dist/**", "**/*.test.ts", "tests/**"],
      thresholds: {
        lines: 89,
        functions: 85,
      },
    },
  },
});
