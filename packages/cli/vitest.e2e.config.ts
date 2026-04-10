import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: ["src/e2e/**/*.e2e.test.ts"],
    testTimeout: 30_000,
  },
});
