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
  workflowPath: ".github/workflows/ci.yml",
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

export function selectCiRun(runs, targetSha, meta, expected = EXPECTED) {
  if (!SHA_RE.test(targetSha)) throw new Error(`target sha is not 40 hex: ${targetSha}`);
  // Workflow identity is bound in code, not left to the caller:
  //  * meta must be the real GET /repos/{o}/{r}/actions/workflows/ci.yml body
  //    (fetched from the FIXED path route inside the workflow step),
  //  * meta.path must equal the expected workflow file exactly,
  //  * every run entry must carry workflow_id === meta.id — display `name`
  //    alone is attacker-influenceable (another workflow file with the same
  //    displayed name must NOT satisfy the gate).
  if (!meta || typeof meta !== "object") throw new Error("workflow metadata object required (--workflow-meta)");
  if (meta.path !== expected.workflowPath) throw new Error(`workflow metadata path ${JSON.stringify(meta.path)} != ${expected.workflowPath}`);
  if (!Number.isInteger(meta.id) || meta.id <= 0) throw new Error(`workflow metadata id invalid: ${meta.id}`);
  const matching = runs.filter((r) =>
    r && r.workflow_id === meta.id && r.name === expected.workflowName &&
    r.event === expected.event && r.head_branch === expected.branch && r.head_sha === targetSha);
  if (matching.length === 0) throw new Error(`no workflow run for ${expected.workflowPath} (id ${meta.id}) on ${expected.branch}@${targetSha}`);
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

function readJsonFile(arg, what) {
  const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${what} is not valid JSON: ${e.message}`);
  }
}

function cmdWrite(a) {
  const outDir = resolve(a["out-dir"] ?? fail("--out-dir required"));
  const info = resolve(a.info ?? fail("--info required"));
  const sha = a.sha ?? process.env.GITHUB_SHA ?? fail("no sha (arg or GITHUB_SHA)");
  const runId = Number(a["run-id"] ?? process.env.GITHUB_RUN_ID ?? fail("no run-id"));
  const attempt = Number(a.attempt ?? process.env.GITHUB_RUN_ATTEMPT ?? fail("no attempt"));
  const wfPath = a["workflow-path"] ?? fail("--workflow-path required (fixed source path of the CI workflow)");
  const wfIdRaw = a["workflow-id"];
  let wfId = null;
  if (wfIdRaw !== undefined && wfIdRaw !== "") {
    wfId = Number(wfIdRaw);
    if (!Number.isInteger(wfId) || wfId <= 0) fail(`bad workflow id ${wfIdRaw}`);
  }
  if (!SHA_RE.test(sha)) fail(`sha is not 40 hex: ${sha}`);
  if (!Number.isInteger(runId) || runId <= 0) fail(`bad run id ${runId}`);
  if (!Number.isInteger(attempt) || attempt <= 0) fail(`bad run attempt ${attempt}`);
  if (wfPath !== EXPECTED.workflowPath) fail(`workflow path ${wfPath} != ${EXPECTED.workflowPath}`);
  const { digest, fileCount } = digestDir(outDir);
  const buildInfo = {
    schema: "lcm-release-build-info/v1",
    commitSha: sha,
    runId,
    runAttempt: attempt,
    workflow: EXPECTED.workflowName,
    workflowId: wfId,
    workflowPath: wfPath,
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
  const runs = readJsonFile(a.runs ?? fail("--runs required"), "runs input");
  const runList = Array.isArray(runs) ? runs : runs?.workflow_runs;
  if (!Array.isArray(runList)) fail("runs input is not a JSON array or {workflow_runs:[...]}");
  if (!a["workflow-meta"]) fail("--workflow-meta required (GET /repos/{o}/{r}/actions/workflows/ci.yml body)");
  const meta = readJsonFile(a["workflow-meta"], "workflow meta input");
  let selected;
  try {
    selected = selectCiRun(runList, sha, meta);
  } catch (e) {
    fail(e.message);
  }
  process.stdout.write(JSON.stringify({ ...selected, workflowId: meta.id }) + "\n");
}

function cmdVerify(a) {
  const dir = resolve(a.dir ?? fail("--dir required"));
  const sha = a.sha ?? fail("--sha required");
  const runId = Number(a["run-id"] ?? fail("--run-id required"));
  const attempt = Number(a.attempt ?? fail("--attempt required"));
  const meta = readJsonFile(a["workflow-meta"] ?? fail("--workflow-meta required"), "workflow meta input");
  if (!meta || typeof meta !== "object" || meta.path !== EXPECTED.workflowPath) fail("workflow metadata path mismatch");
  if (!Number.isInteger(meta.id) || meta.id <= 0) fail(`workflow metadata id invalid: ${meta.id}`);
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
  if (info.workflowPath !== EXPECTED.workflowPath) fail(`build-info workflowPath mismatch: ${info.workflowPath}`);
  // workflowId cross-check when CI recorded one (CI cannot always know its
  // numeric workflow id; the gate step above is the mandatory id enforcement)
  if (info.workflowId !== null && info.workflowId !== undefined && info.workflowId !== meta.id) {
    fail(`build-info workflowId ${info.workflowId} != metadata ${meta.id}`);
  }
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
