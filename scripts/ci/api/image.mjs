// Mac Mini-side API image lifecycle for the LCM Actions pipeline:
//   capacity → build → synthetic health test → save archive (+metadata) → verify
//
// Safety properties (behaviour-tested in pipeline.test.ts):
//   - uses ONLY the already-running colima context; OCI is runtime only
//   - never starts/reconfigures/resets/prunes the shared engine; owned
//     resources have run/attempt/full-SHA names and labels, plus fresh-absence
//     receipts; teardown never prunes or deletes preexisting image IDs
//   - the candidate image is health-tested against a synthetic Docker network
//     marked --internal with NO published host ports and a throwaway database;
//     the production DB is never reachable from this step (and synthetic
//     secrets are generated fresh per run, never printed)
//   - archive is `docker save <immutable image ID>` (not a mutable tag);
//     metadata binds run id/attempt/SHA/image ID/migration SQL SHA and says
//     explicitly that these digests are NOT OCI registry RepoDigests
import { spawnSync } from "node:child_process";
import {validateMetadata} from './metadata.mjs';
import {lifecycle} from './build-profile.mjs';
import {streamArchive} from './archive-stream.mjs';
import {BASE,verifyBase,canonical} from './runtime-overlay.mjs';
import { randomBytes, createHash } from "node:crypto";
import {
  mkdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
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
    fail(`child failed (exit ${r.status})`);
  }
  return r;
}
function docker(args, opts = {}) {
  if(!builder)fail('builder context required');
  builder.owned();builder.engine();
  if(args[0]==='exec')args=[args[0],builder.check('container',args[1]),...args.slice(2)];
  return run("docker", [...builder.dockerArgs(),...args], {...opts,env:builder.dockerEnv()});
}
function dieUnlessSha(v, name = "sha") {
  if (!SHA_RE.test(String(v))) fail(`${name} must be an exact 40-hex SHA`);
  return v;
}

// ---- capacity --------------------------------------------------------------
// Host physical floor+recovery is reserved ONCE. Guest logical headroom is a
// separate task estimate and operational reserve, not a duplicate physical floor.
let builder;
try {
  // Archive verification is hash/metadata-only on the native deploy job; the
  // builder is already deleted. Actual image checks happen on OCI before use.
  if(cmd!=='verify-archive') {
    builder=lifecycle();builder.owned();
    if(flag('sha')!==undefined && flag('sha')!==builder.id.sha)fail('source identity mismatch');
    if(['build','synthetic','archive'].includes(cmd)) {
      if(argv.includes('--profile-worker'))builder.worker();
      else {await builder.runImage(argv);console.log('api-image: monitored operation ok');process.exit(0);}
    }
  }
}catch{fail('owned builder or capacity budget not met');}
function capacity() {try {builder.capacity();console.log('capacity: stage forecast admitted; physical floor=15GiB, recovery=1GiB; guest operational reserve=2GiB');}catch{fail('capacity budget not met');}}
if (cmd === 'capacity') { capacity(); process.exit(0); }

// ---- build ------------------------------------------------------------------
const sha = dieUnlessSha(need("sha"));
const imageName = builder?.tags.runtime ?? IMAGE_NAME(sha);
const short = sha.slice(0, 12);
const SYN = builder?.names;
const labelArgs=Object.entries(builder?.labels??{}).flatMap(([k,v])=>['--label',`${k}=${v}`]);
let probeCount=0;
function probe(args,opts={}) {
 const name=`${SYN.probe}-${++probeCount}`;builder.intent('container',name);
 return docker(['run','--rm','--name',name,...labelArgs,...args],opts);
}
if(cmd==='baseline') {
 const j=builder.owned();if(j.plan.profile!=='verified-runtime-overlay')fail('overlay base mode');capacity();
 const dir=join(builder.job,'scratch/base-import');
 try {
  if(!j.plan.localBase){
   builder.markStage('base-transfer');
   run(process.execPath,[new URL('./deploy.mjs',import.meta.url).pathname,'fetch-runtime-base','--sha',sha,'--run',builder.id.run,'--attempt',builder.id.attempt,'--out-dir',dir]);
   const m=verifyBase(JSON.parse(readFileSync(join(dir,'metadata.json'),'utf8')));if(m.auditSha256!==j.baseMetadata.auditSha256||m.archiveBytes>Math.ceil(j.baseMetadata.accountingBytes*1.1))fail('base transfer drift');
   builder.markStage('base-import');docker(['load','-i',join(dir,'base.tar.gz')]);
  }
  builder.aliasBase();
  builder.markStage('base-audit');
  const audit=JSON.parse(probe(['--network','none','--read-only','-i','--entrypoint','node',builder.baseTag,'-','audit'],{input:readFileSync(join(builder.job,'context/bundle/tools/runtime-overlay.cjs'))}).stdout);
  if(canonical(audit)!==canonical(j.baseMetadata.audit))fail('loaded baseline version or safety mismatch');
 } finally {
  // Only own code-image transfer, never the retained OCI rollback archive.
  const {rmSync}=await import('node:fs');if(!j.plan.localBase)rmSync(dir,{recursive:true,force:true});
 }
 builder.done('baseline');process.exit(0);
}

if (cmd === "build") {
  capacity();
  const overlay=builder.owned();if(overlay.plan.profile==='verified-runtime-overlay'){
   if(!overlay.completed.includes('baseline'))fail('base not verified');
   builder.markStage('overlay-apply-generate');builder.intent('image',imageName);
   docker(['buildx','build','--builder','default','--load','--platform','linux/arm64','--network','none','--pull=false','-f',join(builder.job,'context/Dockerfile'),'--build-arg',`VERIFIED_BASE=${builder.baseTag}`,'--build-arg',`RELEASE_SHA=${sha}`,'--build-arg',`LCM_BASE_IMAGE_ID=${BASE.imageId}`,'--build-arg',`LCM_BUNDLE_SHA=${overlay.bundleManifest.bundleSha256}`,'--build-arg',`LCM_DEPENDENCY_PROOF_SHA=${overlay.bundleManifest.dependencyProof.sha256}`,...labelArgs,'-t',imageName,join(builder.job,'context')]);
   builder.recordOutput('runtime');
   probe(['--network','none',imageName,'node','/opt/lcm-overlay-verify.cjs','verify-installed']);
   builder.done('runtime');process.exit(0);
  }
  const j=builder.owned(),context=join(builder.job,'context'),df=join(context,'apps/api/Dockerfile');
  const common=['build','-f',df,'--platform','linux/arm64','--pull=false','--progress','plain','--build-arg',`RELEASE_SHA=${sha}`,'--build-arg','BUILDKIT_INLINE_CACHE=1',...labelArgs,'--label',`org.opencontainers.image.revision=${sha}`,'--label',`lcm-ci-input=${j.evidence.inventory.inputKey}`];
  builder.intent('image',builder.tags.build);
  docker([...common,...(j.cacheFrom?['--cache-from',j.cacheFrom]:[]),'--target','build','-t',builder.tags.build,context]);
  builder.recordOutput('build');builder.done('linux-build');
  capacity();builder.image('build');builder.intent('image',imageName);
  docker([...common,'--cache-from',builder.tags.build,'-t',imageName,context]);
  builder.recordOutput('runtime');builder.done('runtime');
  const info = builder.image('runtime');
  const label = info.Config?.Labels?.["org.opencontainers.image.revision"];
  if (label !== sha) fail(`image revision label mismatch: ${label}`);
  if (info.Os !== "linux" || info.Architecture !== "arm64")
    fail(`platform ${info.Os}/${info.Architecture} != linux/arm64 (OCI host is aarch64)`);
  console.log(`built ${imageName} imageID=${info.Id}`);
  process.exit(0);
}

if (cmd === "image-id") {
  console.log(builder.image('runtime').Id);
  process.exit(0);
}

// ---- synthetic health test ----------------------------------------------------
// Own resources only; every step wrapped by teardown on failure.
function teardown() {
  builder.cleanupSynthetic();
}
if (cmd === "teardown") {
  teardown();
  console.log("teardown: owned lcm-ci resources removed (idempotent)");
  process.exit(0);
}

function mkTmp() {
  const base = join(builder.job,'scratch');
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
  capacity();
  builder.intent('network',SYN.net);
  docker(["network", "create", "--internal",...labelArgs, SYN.net]);
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
  builder.intent('container',SYN.pg);
  docker(["run", "-d", "--name", SYN.pg, "--network", builder.check('network',SYN.net),
    "--network-alias", SYN.pg, "--env-file", pgEnv,
    ...labelArgs,'--memory','256m', builder.owned().evidence.pgRef]);
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
  const mig = probe(["--network", builder.check('network',SYN.net), imageName,
    "sh", "-c", "ls prisma/migrations | grep -c '^20'"]);
  const migCount = Number(mig.stdout.trim());
  if (!Number.isFinite(migCount) || migCount < 12) fail(`image has ${mig.stdout.trim()} migrations (<12)`);
  const sqlHash = probe(['--network','none', imageName, "sha256sum",
    `${MIGRATION.dir}/${MIGRATION.sqlFile}`]).stdout.trim().split(/\s+/)[0];
  if (sqlHash !== MIGRATION.sqlSha256) fail("planning migration SQL hash in image != pinned source hash");

  // 2) full migrate deploy on the throwaway DB (proves the baked client+CLI work)
  builder.markStage('synthetic-migrate');probe(["--env-file", appEnv, "--network", builder.check('network',SYN.net), imageName,
    "sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma"]);
  if(builder.owned().plan.profile==='verified-runtime-overlay'){builder.markStage('synthetic-planning');probe(['--env-file',appEnv,'--network',builder.check('network',SYN.net),imageName,'node','/opt/lcm-overlay-verify.cjs','smoke']);}

  // 3) boot + health identity check (internal network only; no host port map)
  builder.markStage('synthetic-health');builder.intent('container',SYN.api);
  docker(["run", "-d", "--name", SYN.api, "--network", builder.check('network',SYN.net),
    "--env-file", appEnv,...labelArgs,'--memory','512m', imageName]);
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
  const pgBytes=Number(docker(['exec',SYN.pg,'du','-sk','/var/lib/postgresql/data']).stdout.trim().split(/\s+/)[0])*1024;
  if(!Number.isFinite(pgBytes)||pgBytes<=0||pgBytes>builder.owned().plan.parts.syntheticPG)fail('synthetic PG footprint cap');
  teardown();
  builder.done('synthetic');
  console.log(`synthetic: ok (migrations=${migCount} health=${health.commitSha} release=${health.releaseId})`);
  process.exit(0);
}

// ---- archive ------------------------------------------------------------------
if (cmd === "archive") {
  capacity();
  const out = need("out");
  const metaOut = need("metadata");
  const image = builder.image('runtime');
  const imageId = image.Id;
  if (image.Os !== 'linux' || image.Architecture !== 'arm64' || image.Config?.Labels?.['org.opencontainers.image.revision'] !== sha) fail('image identity mismatch');
  builder.markStage('archive-stream');const streamed=await streamArchive({imageId,out,maxBytes:Math.min(BUDGET.oci.maxArchiveBytes,builder.owned().plan.archiveCap),log:join(builder.job,'archive-private.log'),dockerPrefix:builder.dockerArgs(),env:builder.dockerEnv()});
  const bytes=streamed.bytes,archiveSha=streamed.sha256;
  const meta = {
    buildKind:builder.owned().plan.profile==='verified-runtime-overlay'?'runtime-overlay':'full-linux-build',
    schema: "lcm-api-archive-v1",
    note: "imageId/archiveSha256 are docker content/archive digests, NOT OCI RepoDigests; re-pullability of the registry image is not established",
    repo: "sanghyun-io/living-cost-manager",
    workflowPath: ".github/workflows/ci.yml",
    sha,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    imageId,
    imageBytes: image.Size,
    platform: "linux/arm64",
    releaseShaLabel: sha,
    migrationName: MIGRATION.name,
    migrationSqlSha256: MIGRATION.sqlSha256,
    archivePath: out.split("/").pop(),
    archiveBytes: bytes,
    archiveSha256: archiveSha,
    createdAt: new Date().toISOString(),
  };
  if(meta.buildKind==='runtime-overlay'){const j=builder.owned();Object.assign(meta,{baselineImageId:BASE.imageId,baselineSource:BASE.source,dependencyProofSha256:j.bundleManifest.dependencyProof.sha256,bundleSha256:j.bundleManifest.bundleSha256,baselineSafetySha256:j.baseMetadata.auditSha256,overlayRecipeSha256:j.bundleManifest.files.find(f=>f.path==='Dockerfile').sha256});}
  try { validateMetadata(meta, sha); } catch { fail('metadata identity invalid'); }
  writeFileSync(metaOut, JSON.stringify(meta, null, 2) + "\n");
  // Preserve unique small digest evidence even if artifact upload later fails;
  // lifecycle cleanup removes bulk scratch/VM, never this job's proof journal.
  writeFileSync(join(builder.job,'archive-metadata.json'),JSON.stringify(meta)+'\n',{mode:0o600,flag:'wx'});
  builder.done('archive');
  console.log(`archive: bytes=${bytes} sha256=${archiveSha.slice(0, 16)}… imageID=${imageId.slice(7, 19)}…`);
  process.exit(0);
}

if (cmd === "verify-archive") {
  const metaFile = need("metadata");
  const archive = need("archive");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  try { validateMetadata(meta, sha); } catch { fail('metadata binding invalid'); }
  if (meta.sha !== sha) fail("metadata sha mismatch");
  if (!SHA_RE.test(meta.sha) || !/^sha256:[0-9a-f]{64}$/.test(meta.imageId)) fail("metadata malformed");
  if (meta.migrationSqlSha256 !== MIGRATION.sqlSha256) fail("metadata migration hash != pinned source hash");
  const bytes = statSync(archive).size;
  if (bytes !== meta.archiveBytes) fail(`archive size ${bytes} != metadata ${meta.archiveBytes}`);
  const h = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (h !== meta.archiveSha256) fail("archive sha256 mismatch — refusing downstream docker load");
  console.log('verify-archive: ok (hash/metadata only; OCI load verifies actual image)');
  process.exit(0);
}

fail(`unknown command ${cmd}`);
