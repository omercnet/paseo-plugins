import { configDefaults, defineConfig } from "vitest/config";

// `*.e2e.test.ts` needs real Docker; `npm run test:e2e:local` runs it.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"] },
});
