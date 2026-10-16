// CI test runner wrapper: vitest with a bounded worker count on the shared
// Mac Mini host (maxWorkers=2 by default; policy: host resource courtesy, not
// isolation). Avoids editing per-package app scripts/manifests.
//
// Usage: node scripts/ci/run-workspace-vitest.mjs <pkg-dir> [setup-command args...]
// Example: node scripts/ci/run-workspace-vitest.mjs apps/api tsx tests/setup-test-db.ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [pkgDir, ...setupArgs] = process.argv.slice(2);
if (!pkgDir) {
  console.error("usage: run-workspace-vitest.mjs <pkg-dir> [setup cmd args...]");
  process.exit(2);
}

const maxWorkers = process.env.LCM_CI_MAX_WORKERS ?? "2";

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`failed to spawn ${cmd}: ${result.error.message}`);
    process.exit(result.error.code ?? 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const pkgCwd = path.join(root, pkgDir);
if (setupArgs.length > 0) {
  // Setup commands run through pnpm exec so package-local bins (tsx 등) resolve.
  run("pnpm", ["exec", ...setupArgs], pkgCwd);
}
run("pnpm", ["exec", "vitest", "run", `--maxWorkers=${maxWorkers}`], pkgCwd);
