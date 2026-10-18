// Runner-side (Mac Mini) orchestrator for the gated API deploy job.
//
// Talks to the OCI host ONLY through the existing `gamja-oci` SSH config
// (owner account, pinned user-known-hosts file — no new credentials, keys
// never leave the host, nothing is copied into GitHub). Remote behaviour is
// performed by scripts/ci/api/deploy-host.sh whose bytes are installed from
// this exact SHA checkout and hash-verified before any op runs (source
// pinning). This process never reads secret VALUES: the production env file
// is referenced by path inside the helper's `docker --env-file` only.
//
// Ops are fail-closed: helper exit != 0 aborts immediately (the workflow job
// fails; nothing downstream runs; the next attempt re-CLASSIFIES live state —
// it never blind-replays a mutation).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync,
} from "node:fs";
import { join } from "node:path";

import {
  MIGRATION, PROD, SHA_RE, IMAGE_NAME,
} from "./constants.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const need = (n) => {
  const v = flag(n);
  if (v === undefined) fail(`missing --${n}`);
  return v;
};
function fail(msg) {
  console.error(`api-deploy: ${msg}`);
  process.exit(1);
}
function sha256File(f) {
  return createHash("sha256").update(readFileSync(f)).digest("hex");
}
function dieSha(v, name = "sha") {
  if (!SHA_RE.test(String(v))) fail(`${name} must be exact 40-hex`);
  return v;
}
const BIN = {
  ssh: process.env.LCM_SSH_BIN ?? "ssh",
  scp: process.env.LCM_SCP_BIN ?? "scp",
  curl: process.env.LCM_CURL_BIN ?? "curl",
  opskv: process.env.OPS_KV_BIN ?? "opskv",
};
function spawn(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: opts.encoding ?? "utf8", ...opts });
  if (r.error) fail(`${bin} unavailable: ${r.error.message}`);
  return r;
}
// One remote helper op. stdout = whitelisted status line only.
function helperOp(op, sha, extraArgs = []) {
  const runId = need("run");
  const attempt = need("attempt");
  const args = ["-o", "BatchMode=yes", PROD.host,
    "sudo", "bash",
    `${PROD.backupsRoot}/actions-${runId}-${attempt}-${sha.slice(0, 12)}/deploy-host.sh`,
    op, "--sha", sha, "--run", runId, "--attempt", attempt, ...extraArgs];
  const r = spawn(BIN.ssh, args);
  const out = (r.stdout || "").trim();
  if (r.status !== 0) {
    console.error(`helper ${op} exit=${r.status}`);
    // Whitelisted single-line echo of the helper's status record only.
    if (out) console.error(out.split("\n").pop());
    fail(`remote op ${op} halted — no downstream action, no blind retry`);
  }
  console.log(out.split("\n").pop() ?? `op=${op} result=ok`);
  return out;
}

if (cmd === "install-helper") {
  const sha = dieSha(need("sha"));
  const runId = need("run");
  const attempt = need("attempt");
  const src = new URL("./deploy-host.sh", import.meta.url).pathname;
  if (!existsSync(src)) fail("helper source missing from checkout");
  const localSha = sha256File(src);
  const dir = `${PROD.backupsRoot}/actions-${runId}-${attempt}-${sha.slice(0, 12)}`;
  const remote = `${dir}/deploy-host.sh`;
  // mkdir receipts (0700) then stream exact bytes over ssh stdin, no scp of
  // loose files, then verify hash before first execution.
  const mk = spawn(BIN.ssh, ["-o", "BatchMode=yes", PROD.host,
    "sudo", "bash", "-c",
    `install -d -m 700 ${JSON.stringify(dir)}`]);
  if (mk.status !== 0) fail("cannot create receipts directory");
  const put = spawn(BIN.ssh, ["-o", "BatchMode=yes", PROD.host,
    "sudo", "bash", "-c",
    `umask 077 && cat > ${JSON.stringify(remote)} && chmod 0500 ${JSON.stringify(remote)}`],
  { input: readFileSync(src), encoding: null });
  if (put.status !== 0) fail("cannot install helper");
  const chk = spawn(BIN.ssh, ["-o", "BatchMode=yes", PROD.host,
    "sudo", "sha256sum", remote]);
  const remoteSha = String(chk.stdout || "").trim().split(/\s+/)[0];
  if (chk.status !== 0 || remoteSha !== localSha) {
    fail(`helper hash mismatch (${remoteSha}) — refusing to execute unpinned bytes`);
  }
  helperOp("install-check", sha);
  console.log(`install-helper: ok sha256=${localSha}`);
  process.exit(0);
}

if (cmd === "preflight") {
  const sha = dieSha(need("sha"));
  helperOp("preflight", sha);
  process.exit(0);
}

if (cmd === "ensure-rollback") {
  const sha = dieSha(need("sha"));
  helperOp("ensure-rollback", sha);
  process.exit(0);
}

if (cmd === "send-archive") {
  const sha = dieSha(need("sha"));
  const metaFile = need("metadata");
  const archive = need("archive");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  if (meta.sha !== sha) fail("metadata sha mismatch");
  if (!/^sha256:[0-9a-f]{64}$/.test(meta.imageId)) fail("metadata imageId malformed");
  if (meta.migrationSqlSha256 !== MIGRATION.sqlSha256) fail("metadata migration hash mismatch");
  const got = sha256File(archive);
  if (got !== meta.archiveSha256) fail("local archive hash mismatch — refusing transfer");
  const runId = need("run");
  const attempt = need("attempt");
  const remote = `${PROD.backupsRoot}/actions-${runId}-${attempt}-${sha.slice(0, 12)}/image.tar.gz`;
  const st = spawn(BIN.ssh, ["-o", "BatchMode=yes", PROD.host,
    "sudo", "bash", "-c",
    `umask 077 && cat > ${JSON.stringify(remote)}`],
  { input: readFileSync(archive), maxBuffer: 4 * 1024 * 1024 * 1024 });
  if (st.status !== 0) fail("archive transfer failed");
  helperOp("load-image", sha, ["--image-id", meta.imageId, "--archive-sha", got]);
  process.exit(0);
}

for (const op of ["backup", "rehearse", "migrate", "promote", "verify"]) {
  if (cmd === op) {
    helperOp(op, dieSha(need("sha")));
    process.exit(0);
  }
}

if (cmd === "fetch-backup-copy") {
  // Off-host verified copy of the fresh dump onto the runner workspace,
  // 0600, NEVER uploaded as an artifact (customer financial rows stay in
  // protected operator storage, not GitHub artifact storage).
  const sha = dieSha(need("sha"));
  const runId = need("run");
  const attempt = need("attempt");
  const outDir = need("out-dir");
  const dir = `${PROD.backupsRoot}/actions-${runId}-${attempt}-${sha.slice(0, 12)}`;
  const manifest = spawn(BIN.ssh, ["-o", "BatchMode=yes", PROD.host,
    "sudo", "cat", `${dir}/backup.manifest`]);
  if (manifest.status !== 0) fail("cannot read backup manifest");
  const get = (k) => (manifest.stdout.match(new RegExp(`^${k}=([^\\s]+)$`, "m")) ?? [])[1];
  const dump = get("dump");
  const wantSha = get("sha256");
  const wantBytes = Number(get("bytes"));
  if (!dump || !/^[A-Za-z0-9._-]+$/.test(dump)) fail("manifest dump name invalid");
  if (!/^[0-9a-f]{64}$/.test(String(wantSha))) fail("manifest sha malformed");
  if (!Number.isInteger(wantBytes) || wantBytes <= 0 || wantBytes > 1024 * 1024 * 1024) {
    fail("manifest bytes invalid");
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const local = join(outDir, dump);
  const stream = spawn(BIN.ssh, ["-o", "BatchMode=yes", PROD.host,
    "sudo", "cat", `${dir}/${dump}`], { encoding: null, maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (stream.status !== 0) fail("backup stream failed");
  writeFileSync(local, stream.stdout, { mode: 0o600 });
  chmodSync(local, 0o600);
  if (statSync(local).size !== wantBytes) { rmSync(local, { force: true }); fail("offhost copy size drift"); }
  if (sha256File(local) !== wantSha) { rmSync(local, { force: true }); fail("offhost copy sha mismatch"); }
  console.log(`fetch-backup-copy: ok bytes=${wantBytes} verified_offhost=true artifact=false`);
  process.exit(0);
}

if (cmd === "cleanup-copy") {
  const dir = need("out-dir");
  if (!dir.startsWith("/") || dir === "/") fail("out-dir must be an absolute path under the workspace");
  rmSync(dir, { recursive: true, force: true });
  console.log("cleanup-copy: ok");
  process.exit(0);
}

if (cmd === "verify-public") {
  dieSha(need("sha"));
  const url = PROD.publicHealthUrl;
  let last = "";
  for (let i = 0; i < 10; i++) {
    const r = spawn(BIN.curl, ["-fsS", "--max-time", "10", url]);
    if (r.status === 0) {
      last = (r.stdout || "").trim();
      try {
        const j = JSON.parse(last);
        if (j.commitSha === flag("sha")) {
          console.log("verify-public: ok identity=match");
          process.exit(0);
        }
      } catch { /* identity not parseable yet */ }
    }
    spawnSync("sleep", ["15"]);
  }
  // Print at most a fixed-shape summary (never raw bodies).
  fail(`verify-public: identity mismatch/unreachable after bounded retries last_ok=${last ? "true" : "false"}`);
}

if (cmd === "register-opskv") {
  // Update the EXISTING opskv key /living-cost-manager/production/BACKEND_IMAGE
  // (kind config) to the new compose reference, CAS on expected-version from
  // `opskv show`. Value delivered via a 0600 temp file, never argv. Runs only
  // after verify + verify-public success.
  const sha = dieSha(need("sha"));
  const path = "/living-cost-manager/production/BACKEND_IMAGE";
  const show = spawn(BIN.opskv, ["show", path]);
  if (show.status !== 0) fail("opskv show failed — refusing blind set");
  let version;
  try {
    const j = JSON.parse(show.stdout);
    version = String(j.version ?? j.data?.version ?? "");
  } catch { version = ""; }
  if (!/^[0-9]+$/.test(version)) fail("opskv version unparseable");
  const ref = `${IMAGE_NAME(sha)}`; // compose reference == pinned candidate tag
  const tmpDir = need("tmp-dir");
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const vf = join(tmpDir, "backend-image.value");
  writeFileSync(vf, ref + "\n", { mode: 0o600 });
  const set = spawn(BIN.opskv, ["set", "--expected-version", version,
    "--kind", "config", "--value-file", vf, path]);
  rmSync(vf, { force: true });
  if (set.status !== 0) fail(`opskv CAS set failed (version drift?) exit=${set.status}`);
  console.log(`register-opskv: ok path=${path} from_version=${version} ref=tag-pinned`);
  process.exit(0);
}

fail(`unknown command ${cmd}`);
