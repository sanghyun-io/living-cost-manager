import { writeFileSync, existsSync } from "node:fs";

const commitSha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commitSha ?? "")) {
  throw new Error("Pass the full verified build commit SHA");
}
if (!existsSync("apps/web/out/index.html")) throw new Error("Build the static frontend first");
writeFileSync("apps/web/out/release-meta.json", JSON.stringify({
  commit: commitSha,
  commitSha,
  releaseId: `lcm-${commitSha}`
}) + "\n");
