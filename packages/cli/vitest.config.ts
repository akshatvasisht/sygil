import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Use forked child processes instead of worker threads so tests that call
    // process.chdir() (scheduler, integration) work correctly.
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
