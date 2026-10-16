// Release gate for the LCM self-hosted CI/CD pipeline.
//
// Subcommands:
//   write   --out-dir <dir> --info <file> [--sha s] [--run-id n] [--attempt n]
//           CI artifact step: compute a deterministic content digest of the
//           static export and write build-info.json (defaults read the
//           GITHUB_SHA / GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT env).
//   gate    --target-sha <sha> --runs <file|->  [--expect-name n]
//           Deploy verify-ci step: consume the real JSON body of
//           GET /repos/{o}/{r}/actions/runs?event=push&head_sha=… and select
//           an eligible CI run. Rules (fixture-tested, NOT string grep):
//             * entries must match expected workflow name, event push,
//               head_branch main, head_sha == target,
//             * per run id keep only the max run_attempt,
//             * the latest attempt of EVERY matching run id must be
//               status=completed conclusion=success (a newer failed re-run
//               invalidates an older success),
//             * at least one eligible run; emit the newest as
//               {runId, runAttempt} on stdout for the deploy job.
//   verify  --dir <artifactRoot> --sha <sha> --run-id <n> --attempt <n>
//           Deploy step: load <dir>/build-info.json, require it matches the
//           target SHA, the gated run id/attempt, the expected workflow
//           identity, and recompute the digest of <dir>/out to detect any
//           tampering between CI completion and deploy.
//
// Exit 0 on success (gate prints a one-line JSON to stdout), 1 on any
// rejection with a specific reason on stderr. No secrets are read or printed.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const EXPECTED = {
  repo: "sanghyun-io/living-cost-manager",
  workflowName: "CI (Mac Mini self-hosted)",
  event: "push",
  branch: "main",
};
const DIGEST_ALGO = "sha256-files-v1";
const SHA_RE = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

function fail(msg) {
  console.error(`release-gate: ${msg}`);
  process.exit(1);
}

// Deterministic digest: sort files by POSIX-relative path, hash each file,
// then hash the concatenated "sha  path\n" lines.
export function digestDir(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push(relative(dir, p));
    }
  };
  walk(dir);
  files.sort();
  const lines = files.map((rel) => {
    const h = createHash("sha256");
    h.update(readFileSync(join(dir, rel)));
    return `${h.digest("hex")}  ${rel}\n`;
  });
  const outer = createHash("sha256");
  outer.update(lines.join(""));
  return { digest: outer.digest("hex"), fileCount: files.length };
}

function readRuns(arg) {
  const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  const parsed = JSON.parse(raw);
  const runs = Array.isArray(parsed) ? parsed : parsed?.workflow_runs;
  if (!Array.isArray(runs)) fail("runs input is not a JSON array or {workflow_runs:[...]}");
  return runs;
}

export function selectCiRun(runs, targetSha, expected = EXPECTED) {
  if (!SHA_RE.test(targetSha)) throw new Error(`target sha is not 40 hex: ${targetSha}`);
  const matching = runs.filter((r) =>
    r && r.name === expected.workflowName && r.event === expected.event &&
    r.head_branch === expected.branch && r.head_sha === targetSha);
  if (matching.length === 0) throw new Error(`no workflow run for repo-scoped CI on ${expected.branch}@${targetSha}`);
  const byRun = new Map();
  for (const r of matching) {
    const id = r.run_id ?? r.id;
    if (typeof id !== "number") throw new Error(`run entry without numeric run id`);
    const attempt = r.run_attempt ?? 1;
    const cur = byRun.get(id);
    if (!cur || attempt > (cur.run_attempt ?? 1)) byRun.set(id, r);
  }
  for (const [id, r] of byRun) {
    if (r.status !== "completed" || r.conclusion !== "success") {
      throw new Error(`run ${id} latest attempt ${r.run_attempt} is ${r.status}/${r.conclusion ?? "inconclusive"} — CI did not end SUCCESS for ${targetSha}`);
    }
  }
  const newest = [...byRun.entries()].sort((a, b) => b[0] - a[0])[0];
  return { runId: newest[0], runAttempt: newest[1].run_attempt ?? 1, headSha: newest[1].head_sha };
}

function cmdWrite(a) {
  const outDir = resolve(a["out-dir"] ?? fail("--out-dir required"));
  const info = resolve(a.info ?? fail("--info required"));
  const sha = a.sha ?? process.env.GITHUB_SHA ?? fail("no sha (arg or GITHUB_SHA)");
  const runId = Number(a["run-id"] ?? process.env.GITHUB_RUN_ID ?? fail("no run-id"));
  const attempt = Number(a.attempt ?? process.env.GITHUB_RUN_ATTEMPT ?? fail("no attempt"));
  if (!SHA_RE.test(sha)) fail(`sha is not 40 hex: ${sha}`);
  if (!Number.isInteger(runId) || runId <= 0) fail(`bad run id ${runId}`);
  if (!Number.isInteger(attempt) || attempt <= 0) fail(`bad run attempt ${attempt}`);
  const { digest, fileCount } = digestDir(outDir);
  const buildInfo = {
    schema: "lcm-release-build-info/v1",
    commitSha: sha,
    runId,
    runAttempt: attempt,
    workflow: EXPECTED.workflowName,
    event: EXPECTED.event,
    branch: EXPECTED.branch,
    repo: EXPECTED.repo,
    digestAlgo: DIGEST_ALGO,
    digest,
    fileCount,
    outDirName: outDir.split("/").pop(),
  };
  mkdirSync(dirname(info), { recursive: true });
  writeFileSync(info, JSON.stringify(buildInfo, null, 2) + "\n");
  console.log(`wrote ${info} (files=${fileCount})`);
}

function cmdGate(a) {
  const sha = a["target-sha"] ?? fail("--target-sha required");
  const runs = readRuns(a.runs ?? "-");
  let selected;
  try {
    selected = selectCiRun(runs, sha);
  } catch (e) {
    fail(e.message);
  }
  process.stdout.write(JSON.stringify(selected) + "\n");
}

function cmdVerify(a) {
  const dir = resolve(a.dir ?? fail("--dir required"));
  const sha = a.sha ?? fail("--sha required");
  const runId = Number(a["run-id"] ?? fail("--run-id required"));
  const attempt = Number(a.attempt ?? fail("--attempt required"));
  const infoPath = join(dir, "build-info.json");
  let info;
  try {
    info = JSON.parse(readFileSync(infoPath, "utf8"));
  } catch (e) {
    fail(`cannot read ${infoPath}: ${e.message}`);
  }
  if (info.schema !== "lcm-release-build-info/v1") fail(`unexpected schema ${info.schema}`);
  if (info.repo !== EXPECTED.repo) fail(`build-info repo mismatch: ${info.repo}`);
  if (info.workflow !== EXPECTED.workflowName) fail(`build-info workflow mismatch: ${info.workflow}`);
  if (info.event !== EXPECTED.event) fail(`build-info event mismatch: ${info.event}`);
  if (info.branch !== EXPECTED.branch) fail(`build-info branch mismatch: ${info.branch}`);
  if (info.commitSha !== sha) fail(`build-info SHA ${info.commitSha} != deploy SHA ${sha}`);
  if (info.runId !== runId) fail(`build-info runId ${info.runId} != gated runId ${runId}`);
  if (info.runAttempt !== attempt) fail(`build-info attempt ${info.runAttempt} != gated attempt ${attempt}`);
  const outDir = join(dir, info.outDirName ?? "out");
  const { digest, fileCount } = digestDir(outDir);
  if (digest !== info.digest) fail(`artifact content digest mismatch (tampered or corrupted between CI and deploy)`);
  if (fileCount !== info.fileCount) fail(`artifact file count mismatch: ${fileCount} != ${info.fileCount}`);
  console.log(`verified artifact: sha=${sha} run=${runId}/${attempt} files=${fileCount}`);
}

const [, , sub, ...rest] = process.argv;
const args = parseArgs(rest);
if (sub === "write") cmdWrite(args);
else if (sub === "gate") cmdGate(args);
else if (sub === "verify") cmdVerify(args);
else {
  console.error("usage: release-gate.mjs {write|gate|verify} [options]");
  process.exit(2);
}
