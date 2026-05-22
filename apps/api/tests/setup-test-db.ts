import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

execFileSync("pnpm", ["prisma", "migrate", "reset", "--force", "--skip-generate", "--skip-seed"], {
  cwd: rootDir,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl
  },
  shell: process.platform === "win32",
  stdio: "inherit"
});
