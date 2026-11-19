import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A hang must fail the test, not the CI job.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
