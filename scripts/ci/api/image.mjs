// Mac Mini-side API image lifecycle for the LCM Actions pipeline:
//   capacity → build → synthetic health test → save archive (+metadata) → verify
//
// Safety properties (behaviour-tested in pipeline.test.ts):
//   - runs ONLY on the Mac Mini CI engine; the OCI host is runtime/deploy only
//   - never starts/reconfigures/resets/prunes the shared engine; owned
//     resources use exact `lcm-ci-*` names keyed by the 40-hex SHA and are
//     removed by teardown; no global prune, no other-container contact
//   - the candidate image is health-tested against a synthetic Docker network
//     marked --internal with NO published host ports and a throwaway database;
//     the production DB is never reachable from this step (and synthetic
//     secrets are generated fresh per run, never printed)
//   - archive is `docker save <immutable image ID>` (not a mutable tag);
//     metadata binds run id/attempt/SHA/image ID/migration SQL SHA and says
//     explicitly that these digests are NOT OCI registry RepoDigests
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUDGET, IMAGE_NAME, MIGRATION, SHA_RE, PROD,
} from "./constants.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const need = (n) => {
  const v = flag(n);
  if (!v) fail(`missing --${n}`);
  return v;
};
function fail(msg) {
  console.error(`api-image: ${msg}`);
  process.exit(1);
}
function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    const err = String(r.stderr || "").split("\n")[0].slice(0, 200);
    fail(`${bin} ${args[0]} failed (exit ${r.status}): ${err}`);
  }
  return r;
}
function docker(args, opts = {}) {
  return run("docker", args, opts);
}
function dieUnlessSha(v, name = "sha") {
  if (!SHA_RE.test(String(v))) fail(`${name} must be an exact 40-hex SHA`);
  return v;
}

// ---- capacity --------------------------------------------------------------
// Host capacity 25 GiB measured 2026-10-19; policy floor 15 GiB is never
// lowered here. Required headroom = peak*1.2 + recovery reserve.
function gibFree(dir) {
  const r = run("df", ["-k", dir]);
  const availK = Number(r.stdout.split("\n")[1]?.split(/\s+/)[3]);
  if (!Number.isFinite(availK) || availK <= 0) fail("cannot measure free space");
  return availK / 1024 / 1024;
}
if (cmd === "capacity") {
  const needGib =
    BUDGET.mac.buildPeakGib * 1.2 + BUDGET.mac.reserveGib + BUDGET.mac.floorGib;
  const free = gibFree(process.env.HOME ?? tmpdir());
  console.log(
    `capacity: free=${free.toFixed(1)}GiB required>=${needGib.toFixed(1)}GiB ` +
      `(floor ${BUDGET.mac.floorGib} + peak ${BUDGET.mac.buildPeakGib}*1.2 + reserve ${BUDGET.mac.reserveGib})`,
  );
  if (free < needGib) fail("capacity budget not met — refusing heavy writes");
  process.exit(0);
}

// ---- build ------------------------------------------------------------------
const sha = dieUnlessSha(need("sha"));
const imageName = IMAGE_NAME(sha);
const short = sha.slice(0, 12);
const SYN = {
  net: `lcm-ci-net-${short}`,
  pg: `lcm-ci-pg-${short}`,
  api: `lcm-ci-api-${short}`,
};

if (cmd === "build") {
  docker(["build", "-f", "apps/api/Dockerfile", "--platform", "linux/arm64",
    "--build-arg", `RELEASE_SHA=${sha}`, "-t", imageName, "."]);
  const info = JSON.parse(docker(["image", "inspect", imageName]).stdout)[0];
  const label = info.Config?.Labels?.["org.opencontainers.image.revision"];
  if (label !== sha) fail(`image revision label mismatch: ${label}`);
  if (info.Os !== "linux" || info.Architecture !== "arm64")
    fail(`platform ${info.Os}/${info.Architecture} != linux/arm64 (OCI host is aarch64)`);
  console.log(`built ${imageName} imageID=${info.Id}`);
  process.exit(0);
}

if (cmd === "image-id") {
  console.log(JSON.parse(docker(["image", "inspect", imageName]).stdout)[0].Id);
  process.exit(0);
}

// ---- synthetic health test ----------------------------------------------------
// Own resources only; every step wrapped by teardown on failure.
function teardown() {
  for (const c of [SYN.api, SYN.pg]) {
    docker(["rm", "-f", "-v", c], { allowFail: true });
  }
  docker(["network", "rm", SYN.net], { allowFail: true });
  // owned env files + saved-archive staging live in the owned state dir
  const base = process.env.LCM_CI_API_STATE_DIR ?? join(tmpdir(), `lcm-ci-api-${short}`);
  if (base.includes(`lcm-ci-api-${short}`)) rmSync(base, { recursive: true, force: true });
}
if (cmd === "teardown") {
  teardown();
  console.log("teardown: owned lcm-ci resources removed (idempotent)");
  process.exit(0);
}

function mkTmp() {
  const base = process.env.LCM_CI_API_STATE_DIR ??
    join(tmpdir(), `lcm-ci-api-${short}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}
// ONE generated password for both the throwaway pg and the app URL; random
// per run, written only into 0600 env files, never printed. Files live in
// the owned state dir, removed by teardown.
const SYNTH_PW = randomBytes(24).toString("hex");

function synthEnvFile() {
  const dir = mkTmp();
  const file = join(dir, "env");
  const url = `postgresql://lcm_synth:${SYNTH_PW}@${SYN.pg}:5432/lcm_synth?schema=${PROD.dbSchema}`;
  const lines = [
    "NODE_ENV=production",
    "PORT=4000",
    "API_BASE_PATH=/v1",
    `JWT_SECRET=${randomBytes(32).toString("hex")}`,
    `DATABASE_URL=${url}`,
    "SERVICE_PAID_FEATURES_PUBLISHED=false",
  ];
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return { file, url };
}

if (cmd === "synthetic") {
  process.on("exit", teardown);
  teardown(); // clean any residue of an interrupted earlier attempt of THIS sha
  docker(["network", "create", "--internal", SYN.net]);
  const { file: pgEnv } = (() => {
    const dir = mkTmp();
    const f = join(dir, "pgenv");
    writeFileSync(f, [
      "POSTGRES_USER=lcm_synth",
      `POSTGRES_PASSWORD=${SYNTH_PW}`,
      "POSTGRES_DB=lcm_synth",
    ].join("\n") + "\n", { mode: 0o600 });
    return { dir, file: f };
  })();
  docker(["run", "-d", "--name", SYN.pg, "--network", SYN.net,
    "--network-alias", SYN.pg, "--env-file", pgEnv,
    "--label", `lcm-ci-owner=${sha}`, "postgres:16-alpine"]);
  // The postgres entrypoint runs a TEMPORARY server during initdb and shuts
  // it down before the real start — pg_isready alone races that window.
  // Require two consecutive successful SELECT 1 round-trips instead.
  let ready = 0;
  for (let i = 0; i < 90; i++) {
    const r = docker(["exec", SYN.pg, "psql", "-U", "lcm_synth", "-d", "lcm_synth",
      "-Atc", "SELECT 1"], { allowFail: true });
    if (r.status === 0 && r.stdout.trim() === "1") ready++; else ready = 0;
    if (ready >= 2) break;
    if (i === 89) fail("synthetic postgres never became stably ready");
    spawnSync("sleep", ["1"]);
  }
  docker(["exec", SYN.pg, "psql", "-U", "lcm_synth", "-d", "lcm_synth",
    "-c", `CREATE SCHEMA IF NOT EXISTS ${PROD.dbSchema}`]);

  const { file: appEnv } = synthEnvFile();
  // 1) image-bundled migration inventory + planning SQL hash equality
  const mig = docker(["run", "--rm", "--network", SYN.net, imageName,
    "sh", "-c", "ls prisma/migrations | grep -c '^20'"]);
  const migCount = Number(mig.stdout.trim());
  if (!Number.isFinite(migCount) || migCount < 12) fail(`image has ${mig.stdout.trim()} migrations (<12)`);
  const sqlHash = docker(["run", "--rm", imageName, "sha256sum",
    `${MIGRATION.dir}/${MIGRATION.sqlFile}`]).stdout.trim().split(/\s+/)[0];
  if (sqlHash !== MIGRATION.sqlSha256) fail("planning migration SQL hash in image != pinned source hash");

  // 2) full migrate deploy on the throwaway DB (proves the baked client+CLI work)
  docker(["run", "--rm", "--env-file", appEnv, "--network", SYN.net, imageName,
    "sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma"]);

  // 3) boot + health identity check (internal network only; no host port map)
  docker(["run", "-d", "--name", SYN.api, "--network", SYN.net,
    "--env-file", appEnv, "--label", `lcm-ci-owner=${sha}`, imageName]);
  let body = "";
  for (let i = 0; i < 60; i++) {
    const r = docker(["exec", SYN.api, "node", "-e",
      "fetch('http://127.0.0.1:4000/v1/health').then(x=>x.json().then(j=>console.log(JSON.stringify(j))))"],
      { allowFail: true });
    if (r.status === 0 && r.stdout.trim()) { body = r.stdout.trim(); break; }
    spawnSync("sleep", ["1"]);
    if (i === 59) fail("candidate API health never became ready");
  }
  const health = JSON.parse(body);
  if (health.commitSha !== sha) fail(`health commitSha ${health.commitSha} != ${sha}`);
  teardown();
  console.log(`synthetic: ok (migrations=${migCount} health=${health.commitSha} release=${health.releaseId})`);
  process.exit(0);
}

// ---- archive ------------------------------------------------------------------
if (cmd === "archive") {
  const out = need("out");
  const metaOut = need("metadata");
  const imageId = JSON.parse(docker(["image", "inspect", imageName]).stdout)[0].Id;
  const tmp = mkTmp();
  const plain = join(tmp, "image.tar");
  rmSync(plain, { force: true });
  rmSync(plain + ".gz", { force: true });
  docker(["save", "-o", plain, imageId]); // by immutable ID, never by tag
  const gz = join(tmp, "image.tar.gz");
  run("gzip", ["-n", plain]); // consumes plain, produces plain + ".gz"
  rmSync(plain, { force: true });
  const src = plain + ".gz";
  if (existsSync(out)) rmSync(out);
  // move into place (same filesystem expected; fall back to copy)
  try {
    run("mv", [src, out]);
  } catch {
    run("cp", [src, out]);
    rmSync(src);
  }
  const bytes = statSync(out).size;
  if (bytes > BUDGET.oci.maxArchiveBytes) fail(`archive ${bytes} exceeds budget`);
  const archiveSha = createHash("sha256").update(readFileSync(out)).digest("hex");
  const meta = {
    schema: "lcm-api-archive-v1",
    note: "imageId/archiveSha256 are docker content/archive digests, NOT OCI RepoDigests; re-pullability of the registry image is not established",
    repo: "sanghyun-io/living-cost-manager",
    workflowPath: ".github/workflows/ci.yml",
    sha,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    imageId,
    platform: "linux/arm64",
    releaseShaLabel: sha,
    migrationName: MIGRATION.name,
    migrationSqlSha256: MIGRATION.sqlSha256,
    archivePath: out.split("/").pop(),
    archiveBytes: bytes,
    archiveSha256: archiveSha,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(metaOut, JSON.stringify(meta, null, 2) + "\n");
  console.log(`archive: bytes=${bytes} sha256=${archiveSha.slice(0, 16)}… imageID=${imageId.slice(7, 19)}…`);
  process.exit(0);
}

if (cmd === "verify-archive") {
  const metaFile = need("metadata");
  const archive = need("archive");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  if (meta.sha !== sha) fail("metadata sha mismatch");
  if (!SHA_RE.test(meta.sha) || !/^sha256:[0-9a-f]{64}$/.test(meta.imageId)) fail("metadata malformed");
  if (meta.migrationSqlSha256 !== MIGRATION.sqlSha256) fail("metadata migration hash != pinned source hash");
  const bytes = statSync(archive).size;
  if (bytes !== meta.archiveBytes) fail(`archive size ${bytes} != metadata ${meta.archiveBytes}`);
  const h = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (h !== meta.archiveSha256) fail("archive sha256 mismatch — refusing downstream docker load");
  console.log("verify-archive: ok");
  process.exit(0);
}

fail(`unknown command ${cmd}`);
