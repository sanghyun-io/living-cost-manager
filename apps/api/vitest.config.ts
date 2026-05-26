import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // API tests share a single Postgres test schema (lcm_test) and clean up rows
    // in afterEach. Running test files in parallel lets one file's cleanup delete
    // another file's fixtures mid-run, so force sequential file execution.
    fileParallelism: false
  }
});
