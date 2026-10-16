import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Bound concurrent DOM environments on shared development/CI machines.
    // Keep the existing per-test timeout and all assertions unchanged.
    maxWorkers: 2,
    setupFiles: ["./vitest.setup.ts"]
  }
});
