// Behavioural tests for the LCM API pipeline scripts. Real bash/Node logic
// runs against fixture trees + PATH shims under a temp dir — no root, no
// docker engine, no network, no production paths. Mirrors the existing
// scripts/ci/runner kit-test architecture.
//
// Run (CI step, from apps/web): pnpm exec vitest run --root ../../scripts/ci/api
import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyCompare } from "./paths.mjs";
import { PROD, MIGRATION } from "./constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = HERE;
const FAKES = path.join(HERE, "tests", "fakes");
const REPO = path.resolve(API, "../../..");

const TEST_SHA = "b".repeat(40);
const CAND_ID = `sha256:${"c".repeat(64)}`;
const RUN = "39117161057";
const ATTEMPT = "1";
const SHA12 = TEST_SHA.slice(0, 12);
const OLD_REF = PROD.currentComposeImageRef;
const OLD_ID = PROD.currentImageId;
const NEW_TAG = `lcm-ci-api-${TEST_SHA}:candidate`;
const PENDING = MIGRATION.name;
const APPLIED11 = [
  "20260522000000_initial",
  "20260526000000_auth_hardening",
  "20260527120000_add_is_end_of_month",
  "20260528000000_add_workspace_sync_version",
  "20260529100000_add_push_subscription",
  "20260605000000_add_push_delivery",
  "20261003000000_billing_anchor_renewal",
  "20261006160000_budget_templates",
  "20261007120000_service_billing_foundation",
  "20261010000000_user_product_tour_state",
  "20261015120000_private_coaching_preferences",
].sort();
const DIRS12 = [...APPLIED11, PENDING].sort();
const DBPASS = "SENTINEL_DBPASS_4f2a";

beforeAll(() => {
  for (const f of fs.readdirSync(FAKES)) {
    fs.chmodSync(path.join(FAKES, f), 0o755);
  }
});

function composeText(backendRef: string) {
  return `services:
  backend:
    image: ${backendRef}
    container_name: livingcost-backend
    restart: unless-stopped
    env_file:
      - /opt/livingcost/api/.env
    networks:
      - lcnet
      - gamjadata
  cloudflared:
    image: cloudflare/cloudflared:2026.8.2
    container_name: livingcost-cloudflared
    depends_on:
      - backend
networks:
  lcnet:
  gamjadata:
    external:
      name: gamja-data_default
`;
}

type HostOpts = {
  compose?: string; // backend image ref variant
  extraState?: Record<string, string>; // file -> contents
  touchFlags?: string[]; // zero-byte state flags
  applied?: string[];
  dirs?: string[];
  imagesTsv?: string;
};
function makeHost(opts: HostOpts = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lcm-api-"));
  const fh = path.join(base, "host");
  const lcm = path.join(fh, "opt", "livingcost");
  const st = path.join(fh, "state");
  fs.mkdirSync(path.join(lcm, "api"), { recursive: true });
  fs.mkdirSync(path.join(lcm, "backups"), { recursive: true });
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(lcm, "docker-compose.yml"), opts.compose ?? composeText(OLD_REF));
  fs.writeFileSync(
    path.join(lcm, "api", ".env"),
    `DATABASE_URL=postgresql://livingcost:${DBPASS}@gamja-data-postgres:5432/livingcost?schema=lcm\nJWT_SECRET=${"j".repeat(40)}\nAPI_BASE_PATH=/living-cost-manager/v1\n`,
  );
  const def: Record<string, string> = {
    applied_txt: (opts.applied ?? APPLIED11).join("\n") + "\n",
    aborted_txt: "",
    tables: "24",
    migrows: "12",
    planning_present: "f",
    planning_zero: "t",
    cols_hash: "colsA",
    cons_hash: "consA",
    container_running: "true",
    container_image: OLD_ID,
    health_local: TEST_SHA,
    health_public: JSON.stringify({ ok: true, commitSha: TEST_SHA }),
    dump_bytes: "90867",
    rollback_bytes: "262144",
    archive_bytes: "1048576",
    image_size: "660000000",
    image_sql_sha: MIGRATION.sqlSha256,
    migration_dirs: (opts.dirs ?? DIRS12).join("\n") + "\n",
    load_tag: NEW_TAG,
    df_avail_k: "20000000",
    timer_active: "active",
    opskv_version: "2",
    opskv_show: JSON.stringify({ path: "/living-cost-manager/production/BACKEND_IMAGE", version: 2, value: "[HIDDEN]" }),
    images_tsv:
      `${OLD_REF}\t${OLD_ID}\ta2c7bd9af46d84dc88b2a36656c25949b57076b0\n` +
      `${NEW_TAG}\t${CAND_ID}\t${TEST_SHA}\n`,
    ...(opts.extraState ?? {}),
  };
  const w = (name: string, content: string) =>
    fs.writeFileSync(path.join(st, name), content);
  w("applied.txt", (opts.applied ?? APPLIED11).join("\n") + "\n");
  w("aborted.txt", def.aborted_txt);
  for (const [k, v] of Object.entries({
    tables: def.tables, migrows: def.migrows, planning_present: def.planning_present,
    planning_zero: def.planning_zero, cols_hash: def.cols_hash, cons_hash: def.cons_hash,
    container_running: def.container_running, container_image: def.container_image,
    health_local: def.health_local, health_public: def.health_public,
    dump_bytes: def.dump_bytes, rollback_bytes: def.rollback_bytes,
    archive_bytes: def.archive_bytes, image_size: def.image_size,
    image_sql_sha: def.image_sql_sha,
    migration_dirs: def.migration_dirs, load_tag: def.load_tag,
    df_avail_k: def.df_avail_k, timer_active: def.timer_active,
    opskv_version: def.opskv_version, opskv_show: def.opskv_show,
    "images.tsv": def.images_tsv,
    restore_tables: def.tables, restore_migrows: def.migrows,
  })) w(k.endsWith(".tsv") ? k : `${k}.txt`, v + "\n");
  for (const f of opts.touchFlags ?? []) w(f, "");
  // pre-stage receipts dir with the helper (as install-helper does)
  const rd = path.join(lcm, "backups", `actions-${RUN}-${ATTEMPT}-${SHA12}`);
  fs.mkdirSync(rd, { recursive: true });
  fs.copyFileSync(path.join(API, "deploy-host.sh"), path.join(rd, "deploy-host.sh"));
  return { base, fh, lcm, st, rd };
}

function helperEnv(fh: string) {
  return {
    ...process.env,
    PATH: `${FAKES}:${process.env.PATH}`,
    FAKE_HOST: fh,
    LCM_ROOT: path.join(fh, "opt", "livingcost"),
    LCM_HELPER_ALLOW_NONROOT_TEST: "1",
  };
}
function helper(fhObj: ReturnType<typeof makeHost>, op: string, extra: string[] = [], attempt = ATTEMPT) {
  const { fh, rd } = fhObj;
  void rd;
  const helperPath = path.join(
    fh, "opt/livingcost/backups", `actions-${RUN}-${attempt}-${SHA12}`, "deploy-host.sh",
  );
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.copyFileSync(path.join(API, "deploy-host.sh"), helperPath);
  return spawnSync("bash", [helperPath, op, "--sha", TEST_SHA, "--run", RUN, "--attempt", attempt, ...extra], {
    encoding: "utf8", env: helperEnv(fh), stdin: "ignore",
  });
}
function readCalls(fh: string) {
  const p = path.join(fh, "state", "calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

describe("host helper — argument & scope rejection", () => {
  it("rejects malformed sha (injection attempt)", () => {
    const h = makeHost();
    const helperPath = path.join(h.rd, "deploy-host.sh");
    const r = spawnSync("bash", [helperPath, "preflight", "--sha", `b; rm -rf /`, "--run", RUN, "--attempt", ATTEMPT],
      { encoding: "utf8", env: helperEnv(h.fh), stdin: "ignore" });
    expect(r.status).toBe(20);
    expect(r.stdout).toContain("sha-not-40hex");
  });
  it("rejects ops outside the allowlist without side effects", () => {
    const h = makeHost();
    const before = fs.readFileSync(path.join(h.lcm, "docker-compose.yml"));
    const r = helper(h, "DROP-TABLE");
    expect(r.status).toBe(20);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml")).equals(before)).toBe(true);
  });
  it("rejects a symlinked compose file", () => {
    const h = makeHost();
    const cf = path.join(h.lcm, "docker-compose.yml");
    const real = cf + ".real";
    fs.renameSync(cf, real);
    fs.symlinkSync(real, cf);
    const r = helper(h, "preflight");
    expect(r.status).toBe(20);
    expect(r.stdout).toContain("compose-is-symlink");
  });
});

describe("host helper — preflight CAS/identity", () => {
  it("classifies fresh production state", () => {
    const h = makeHost();
    const r = helper(h, "preflight");
    expect(r.status, r.stdout + "|" + r.stderr).toBe(0);
    expect(r.stdout).toContain("state=fresh tables=24");
    const pre = fs.readFileSync(path.join(h.rd, "preflight.json"), "utf8");
    expect(pre).toContain("reminder_timer=active");
  });
  it("halts when the compose ref drifted (stale prod identity, no overwrite)", () => {
    const h = makeHost({ compose: composeText("someone-elses-tag:v9") });
    const r = helper(h, "preflight");
    expect(r.status).toBe(21);
    expect(r.stdout).toContain("compose-cas-stale");
  });
  it("halts when the running container is not the pinned OLD image", () => {
    const h = makeHost({ extraState: { container_image: `sha256:${"9".repeat(64)}` } });
    const r = helper(h, "preflight");
    expect(r.status).toBe(21);
    expect(r.stdout).toContain("backend-image-id-stale");
  });
  it("halts on aborted migration rows (inspect, never blind-retry)", () => {
    const h = makeHost({ extraState: { aborted_txt: PENDING } });
    const r = helper(h, "preflight");
    expect(r.status).toBe(22);
    expect(r.stdout).toContain("aborted-migration-rows");
  });
  it("halts on an unexpected applied migration name", () => {
    const h = makeHost({ applied: [...APPLIED11, "20990101000000_rogue"].sort() });
    const r = helper(h, "preflight");
    expect(r.status).toBe(22);
    expect(r.stdout).toContain("unexpected-applied-migration");
  });
  it("halts below the capacity floor with zero writes", () => {
    const h = makeHost({ extraState: { df_avail_k: "1048576" } }); // 1 GiB < 4 GiB floor
    const before = fs.readFileSync(path.join(h.lcm, "docker-compose.yml"));
    const r = helper(h, "preflight");
    expect(r.status).toBe(24);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml")).equals(before)).toBe(true);
    expect(readCalls(h.fh)).not.toContain("pg_dump");
  });
});

describe("host helper — rollback archive", () => {
  it("creates once and reuses when identical+valid (no giant duplicates)", () => {
    const h = makeHost();
    const r1 = helper(h, "ensure-rollback");
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("rollback=created");
    const dir = path.join(h.lcm, "backups", "rollback");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(2);
    const tgz = path.join(dir, files.find((f) => f.endsWith(".tar.gz"))!);
    expect(fs.statSync(tgz).mode & 0o777).toBe(0o600);
    const r2 = helper(h, "ensure-rollback");
    expect(r2.stdout).toContain("rollback=reused");
    const saves = readCalls(h.fh).split("\n").filter((l) => l.startsWith("docker save")).length;
    expect(saves).toBe(1);
  });
  it("refuses an archive over budget", () => {
    const h = makeHost({ extraState: { image_size: String(4 * 1024 * 1024 * 1024) } });
    const r = helper(h, "ensure-rollback");
    expect(r.status).toBe(24);
    expect(r.stdout).toContain("rollback-image-over-budget");
    expect(readCalls(h.fh)).not.toContain("docker save"); // refused BEFORE heavy write
  });
});

describe("host helper — archive load + backup + rehearse", () => {
  const stageArchive = (h: ReturnType<typeof makeHost>) => {
    const arc = path.join(h.rd, "image.tar.gz");
    fs.writeFileSync(arc, "fake-archive-bytes");
    return arc;
  };
  const arcSha = (h: ReturnType<typeof makeHost>) =>
    createHash("sha256").update(fs.readFileSync(path.join(h.rd, "image.tar.gz"))).digest("hex");

  it("load-image refuses sha mismatch before docker load", () => {
    const h = makeHost();
    stageArchive(h);
    const r = helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", "f".repeat(64)]);
    expect(r.status).toBe(23);
    expect(readCalls(h.fh)).not.toContain("docker load");
  });
  it("load-image refuses an unexpected loaded image id", () => {
    const h = makeHost();
    stageArchive(h);
    const r = helper(h, "load-image", ["--image-id", `sha256:${"1".repeat(64)}`, "--archive-sha", arcSha(h)]);
    expect(r.status).toBe(23);
    expect(r.stdout).toContain("loaded-image-id-mismatch");
  });
  it("load-image accepts the ID-form of docker load (save-by-ID reality) and retags", () => {
    const h = makeHost({ touchFlags: ["load_id_form"] });
    stageArchive(h);
    const r = helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", arcSha(h)]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readCalls(h.fh)).toContain(`docker tag sha256:${"c".repeat(64)} ${NEW_TAG}`);
  });
  it("load-image refuses a foreign tag in tag-form loads", () => {
    const h = makeHost({ extraState: { load_tag: "someone-elses:tag" } });
    stageArchive(h);
    const r = helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", arcSha(h)]);
    expect(r.status).toBe(23);
    expect(r.stdout).toContain("loaded-tag-unexpected");
  });
  it("backup writes a bounded 0600 dump + manifest, compose untouched", () => {
    const h = makeHost();
    stageArchive(h);
    expect(helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", arcSha(h)]).status).toBe(0);
    const before = fs.readFileSync(path.join(h.lcm, "docker-compose.yml"));
    const r = helper(h, "backup");
    expect(r.status).toBe(0);
    const man = fs.readFileSync(path.join(h.rd, "backup.manifest"), "utf8");
    expect(man).toContain("bytes=90867");
    expect(man).toContain("tables=24");
    expect(man).toContain("mig_rows=12");
    const dump = man.match(/^dump=(.+)$/m)![1];
    const dm = fs.statSync(path.join(h.rd, dump));
    expect(dm.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml")).equals(before)).toBe(true);
  });
  it("failed pg_dump halts before any compose change", () => {
    const h = makeHost({ touchFlags: ["dump_fail"] });
    const r = helper(h, "backup");
    expect(r.status).toBe(25);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toContain(OLD_REF);
  });
  it("rehearse restores into an isolated temp db and drops it", () => {
    const h = makeHost();
    stageArchive(h);
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", arcSha(h)]);
    helper(h, "backup");
    const r = helper(h, "rehearse");
    expect(r.status).toBe(0);
    const created = fs.readFileSync(path.join(h.st, "createdb.log"), "utf8");
    const dropped = fs.readFileSync(path.join(h.st, "droppedb.log"), "utf8");
    expect(created).toMatch(/CREATE DATABASE lcm_rehearse_/);
    expect(dropped).toMatch(/DROP DATABASE IF EXISTS lcm_rehearse_/);
    expect(r.stdout).toContain("tempdb_dropped=true");
  });
  it("failed restore still cleans the temp db and halts", () => {
    const h = makeHost({ touchFlags: ["restore_fail"] });
    stageArchive(h);
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", arcSha(h)]);
    helper(h, "backup");
    const r = helper(h, "rehearse");
    expect(r.status).toBe(25);
    const dropped = fs.readFileSync(path.join(h.st, "droppedb.log"), "utf8");
    expect(dropped).toMatch(/DROP DATABASE IF EXISTS lcm_rehearse_/);
  });
  it("rehearse refuses a tampered backup before restoring", () => {
    const h = makeHost();
    stageArchive(h);
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", arcSha(h)]);
    helper(h, "backup");
    const man = fs.readFileSync(path.join(h.rd, "backup.manifest"), "utf8");
    const dump = man.match(/^dump=(.+)$/m)![1];
    fs.appendFileSync(path.join(h.rd, dump), "TAMPERED");
    const r = helper(h, "rehearse");
    expect(r.status).toBe(23);
    expect(fs.existsSync(path.join(h.st, "createdb.log"))).toBe(false);
  });
});

function fullFreshToMigrated(opts: HostOpts = {}) {
  const h = makeHost(opts);
  const arc = path.join(h.rd, "image.tar.gz");
  fs.writeFileSync(arc, "fake-archive-bytes");
  const asha = createHash("sha256").update(fs.readFileSync(arc)).digest("hex");
  for (const [op, extra] of [
    ["preflight", []], ["ensure-rollback", []],
    ["load-image", ["--image-id", CAND_ID, "--archive-sha", asha]],
    ["backup", []], ["rehearse", []], ["migrate", []],
  ] as const) {
    const r = helper(h, op, extra as string[]);
    const rej = path.join(h.rd, "pending-rejection.json");
    expect(
      r.status,
      `${op}: ${r.stdout}${r.stderr}${fs.existsSync(rej) ? " REJ:" + fs.readFileSync(rej, "utf8") : ""}`,
    ).toBe(0);
  }
  return { h, asha };
}

describe("host helper — migrate / promote / verify / rollback", () => {
  it("migrate rejects pending inventory with extra migrations (no auto-apply)", () => {
    const h = makeHost({ dirs: [...DIRS12, "20991231000000_not_approved"] });
    const arc = path.join(h.rd, "image.tar.gz");
    fs.writeFileSync(arc, "x");
    helper(h, "preflight");
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", createHash("sha256").update("x").digest("hex")]);
    const r = helper(h, "migrate");
    expect(r.status).toBe(22);
    expect(readCalls(h.fh)).not.toContain("migrate deploy");
  });
  it("migrate rejects a planning SQL hash that differs from the pinned source", () => {
    const h = makeHost({ extraState: { image_sql_sha: "0".repeat(64) } });
    const arc = path.join(h.rd, "image.tar.gz");
    fs.writeFileSync(arc, "x");
    helper(h, "preflight");
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", createHash("sha256").update("x").digest("hex")]);
    const r = helper(h, "migrate");
    expect(r.status).toBe(23);
    expect(readCalls(h.fh)).not.toContain("migrate deploy");
  });
  it("failed migrate halts with compose untouched + failure evidence", () => {
    const h = makeHost({ touchFlags: ["migrate_fail"] });
    const arc = path.join(h.rd, "image.tar.gz");
    fs.writeFileSync(arc, "x");
    helper(h, "preflight");
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", createHash("sha256").update("x").digest("hex")]);
    helper(h, "backup");
    helper(h, "rehearse");
    const before = fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8");
    const r = helper(h, "migrate");
    expect(r.status).toBe(26);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(h.rd, "migrate-failure.json"))).toBe(true);
  });
  it("promote refuses without rehearsal/backup evidence", () => {
    const h = makeHost();
    const arc = path.join(h.rd, "image.tar.gz");
    fs.writeFileSync(arc, "x");
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", createHash("sha256").update("x").digest("hex")]);
    const r = helper(h, "promote");
    expect(r.status).toBe(25);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toContain(OLD_REF);
  });
  it("promote halts on a concurrent compose edit (CAS race)", () => {
    const { h } = fullFreshToMigrated();
    fs.writeFileSync(path.join(h.lcm, "docker-compose.yml"), composeText("evil:latest"));
    const r = helper(h, "promote");
    expect(r.status).toBe(21); // classify: compose-cas-stale
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toContain("evil:latest");
  });
  it("failed compose-up auto-reverts to the OLD ref (service-level only)", () => {
    const { h } = fullFreshToMigrated({ touchFlags: ["compose_up_fail"] });
    const r = helper(h, "promote");
    expect(r.status).toBe(27);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toContain(OLD_REF);
  });
  it("full fresh happy path: migrate→promote→verify with additive-only DB effects", () => {
    const { h } = fullFreshToMigrated();
    expect(fs.readFileSync(path.join(h.st, "tables.txt"), "utf8").trim()).toBe("25");
    // promote: health identity matches
    const rp = helper(h, "promote");
    expect(rp.status, rp.stdout + rp.stderr).toBe(0);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toContain(NEW_TAG);
    expect(fs.readFileSync(path.join(h.st, "container_image.txt"), "utf8").trim()).toBe(CAND_ID);
    const rv = helper(h, "verify");
    expect(rv.status, rv.stdout + rv.stderr).toBe(0);
    expect(rv.stdout).toContain("tables=25");
    expect(rv.stdout).toContain("applied=12");
    // the ONLY destructive SQL verb ever executed is the rehearsal temp db
    const calls = readCalls(h.fh);
    expect(calls).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE /);
    expect((fs.readFileSync(path.join(h.st, "droppedb.log"), "utf8").match(/DROP DATABASE/g) ?? []).length).toBe(1);
  });
  it("verify fails when pre-existing structure or counts drifted", () => {
    const { h } = fullFreshToMigrated();
    helper(h, "promote");
    fs.writeFileSync(path.join(h.st, "cols_hash.txt"), "colsMUTATED\n");
    const r = helper(h, "verify");
    expect(r.status).toBe(28);
    expect(r.stdout).toContain("existing-columns-changed");
  });
  it("re-run after a partial failure classifies promote-only and completes", () => {
    // attempt 1 migrates but never promotes
    const h = makeHost();
    const arc = path.join(h.rd, "image.tar.gz");
    fs.writeFileSync(arc, "x");
    const asha = createHash("sha256").update(fs.readFileSync(arc)).digest("hex");
    helper(h, "preflight");
    helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", asha]);
    helper(h, "backup");
    helper(h, "rehearse");
    expect(helper(h, "migrate").status).toBe(0);
    // the post-migrate world: a fresh dump now contains 25 tables / 13 rows
    fs.writeFileSync(path.join(h.st, "restore_tables.txt"), "25\n");
    fs.writeFileSync(path.join(h.st, "restore_migrows.txt"), "13\n");
    // attempt 2: fresh receipts, state must be inspected — not blind-retried.
    // the re-run job re-loads its own artifact first (same run semantics).
    const r2 = helper(h, "preflight", [], "2");
    expect(r2.status, r2.stdout).toBe(0);
    expect(r2.stdout).toContain("state=promote-only");
    // attempt 2 stages its own copy of the run artifact (fresh receipts dir)
    const rd2 = path.join(h.lcm, "backups", `actions-${RUN}-2-${SHA12}`);
    fs.mkdirSync(rd2, { recursive: true });
    fs.copyFileSync(arc, path.join(rd2, "image.tar.gz"));
    expect(helper(h, "load-image", ["--image-id", CAND_ID, "--archive-sha", asha], "2").status).toBe(0);
    expect(helper(h, "backup", [], "2").status).toBe(0);
    expect(helper(h, "rehearse", [], "2").status).toBe(0);
    const rm = helper(h, "migrate", [], "2");
    expect(rm.stdout).toContain("migrate=skip-already-applied");
    expect(helper(h, "promote", [], "2").status).toBe(0);
    expect(helper(h, "verify", [], "2").status).toBe(0);
    // migrate deploy executed exactly once across both attempts
    const deploys = readCalls(h.fh).split("\n").filter((l) => l.includes("migrate deploy")).length;
    expect(deploys).toBe(1);
  });
  it("rollback-image reverts ONLY the service image and retains planning", () => {
    const { h } = fullFreshToMigrated();
    helper(h, "promote");
    helper(h, "verify");
    const r = helper(h, "rollback-image");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toContain(OLD_REF);
    expect(fs.readFileSync(path.join(h.st, "container_image.txt"), "utf8").trim()).toBe(OLD_ID);
    // data retention: planning migration stays applied, table stays present
    expect(fs.readFileSync(path.join(h.st, "applied.txt"), "utf8")).toContain(PENDING);
    expect(fs.readFileSync(path.join(h.st, "planning_present.txt"), "utf8").trim()).toBe("t");
    const calls = readCalls(h.fh);
    expect(calls).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|migrate deploy.*rollback|pg_restore.*promote/);
  });
  it("rollback-image refuses when the compose is not at the candidate state", () => {
    const h = makeHost();
    const r = helper(h, "rollback-image");
    expect(r.status).toBe(21);
  });
});

describe("host helper — secret hygiene", () => {
  it("the env-file password and dump row sentinels never reach stdout/stderr/calls/receipt texts", () => {
    const { h } = fullFreshToMigrated();
    helper(h, "promote");
    helper(h, "verify");
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else acc.push(p);
      }
      return acc;
    };
    const files = walk(h.fh);
    const dbpassFiles = files.filter((p) => {
      try { return fs.readFileSync(p, "utf8").includes(DBPASS); } catch { return false; }
    });
    expect(dbpassFiles).toEqual([path.join(h.lcm, "api", ".env")]);
    const rowFiles = files.filter((p) => {
      try { return fs.readFileSync(p, "utf8").includes("SENTINEL_PGDUMP_ROW_8866"); } catch { return false; }
    });
    // only the protected dump itself may contain dump content
    for (const p of rowFiles) expect(p).toMatch(/\.dump$/);
    const procOut = readCalls(h.fh);
    expect(procOut).not.toContain(DBPASS);
    expect(procOut).not.toContain("SENTINEL_PGDUMP_ROW");
  });
});

describe("runner orchestrator (deploy.mjs via fake ssh)", () => {
  const node = (fh: string, args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync("node", [path.join(API, "deploy.mjs"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env, PATH: `${FAKES}:${process.env.PATH}`, FAKE_HOST: fh,
        LCM_ROOT: path.join(fh, "opt/livingcost"),
        LCM_HELPER_ALLOW_NONROOT_TEST: "1",
        LCM_SSH_BIN: path.join(FAKES, "ssh"),
        LCM_CURL_BIN: path.join(FAKES, "curl"),
        OPS_KV_BIN: path.join(FAKES, "opskv"),
        ...extraEnv,
      },
      stdin: "ignore",
    });

  it("install-helper pins the executed bytes and refuses a hash mismatch", () => {
    const h = makeHost();
    const bad = node(h.fh, ["install-helper", "--sha", TEST_SHA, "--run", RUN, "--attempt", ATTEMPT]);
    // hashes_bad flag not set → install ok
    expect(bad.status, bad.stdout + bad.stderr).toBe(0);
    const installed = fs.readFileSync(path.join(h.rd, "deploy-host.sh"), "utf8");
    expect(installed).toBe(fs.readFileSync(path.join(API, "deploy-host.sh"), "utf8"));
    expect(fs.statSync(path.join(h.rd, "deploy-host.sh")).mode & 0o777).toBe(0o500);

    const h2 = makeHost({ touchFlags: ["hashes_bad"] });
    const r2 = node(h2.fh, ["install-helper", "--sha", TEST_SHA, "--run", "99", "--attempt", ATTEMPT]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("hash mismatch");
    const calls = readCalls(h2.fh);
    expect(calls).not.toContain("install-check"); // never executed unpinned bytes
  });

  it("runs the gated sequence end-to-end then registers opskv with CAS", () => {
    const h = makeHost();
    const base = ["--sha", TEST_SHA, "--run", "4000", "--attempt", ATTEMPT];
    expect(node(h.fh, ["install-helper", ...base]).status).toBe(0);
    expect(node(h.fh, ["preflight", ...base]).status).toBe(0);
    expect(node(h.fh, ["ensure-rollback", ...base]).status).toBe(0);
    // build a real archive+metadata the way image.mjs would
    const arc = path.join(h.base, "image.tar.gz");
    fs.writeFileSync(arc, "archived-image-bytes");
    const asha = createHash("sha256").update(fs.readFileSync(arc)).digest("hex");
    const meta = path.join(h.base, "metadata.json");
    fs.writeFileSync(meta, JSON.stringify({
      sha: TEST_SHA, imageId: CAND_ID, archiveSha256: asha,
      archiveBytes: fs.statSync(arc).size,
      migrationSqlSha256: MIGRATION.sqlSha256,
      runId: "4000", runAttempt: ATTEMPT,
    }));
    // stage into the receipts dir first (send-archive streams then loads)
    expect(node(h.fh, ["send-archive", ...base, "--metadata", meta, "--archive", arc]).status).toBe(0);
    expect(node(h.fh, ["backup", ...base]).status).toBe(0);
    expect(node(h.fh, ["rehearse", ...base]).status).toBe(0);
    expect(node(h.fh, ["migrate", ...base]).status).toBe(0);
    expect(node(h.fh, ["promote", ...base]).status).toBe(0);
    expect(node(h.fh, ["verify", ...base]).status).toBe(0);
    // offhost copy: 0600, sha-verified, never an artifact
    const copyDir = path.join(h.base, "offhost");
    const fc = node(h.fh, ["fetch-backup-copy", ...base, "--out-dir", copyDir]);
    expect(fc.status, fc.stdout + fc.stderr).toBe(0);
    const dumps = fs.readdirSync(copyDir);
    expect((fs.statSync(path.join(copyDir, dumps[0])).mode & 0o777)).toBe(0o600);
    // public health identity
    expect(node(h.fh, ["verify-public", ...base]).status).toBe(0);
    // opskv CAS
    expect(node(h.fh, ["register-opskv", ...base, "--tmp-dir", path.join(h.base, "vk")]).status).toBe(0);
    expect(fs.readFileSync(path.join(h.st, "opskv_stored.txt"), "utf8").trim()).toBe(NEW_TAG);
    const calls = readCalls(h.fh);
    expect(calls).not.toContain(DBPASS);
    // a version-conflicting set fails closed (state already advanced to v3)
    const conflict = node(h.fh, ["register-opskv", ...base, "--tmp-dir", path.join(h.base, "vk2")]);
    expect(conflict.status).toBe(1);
  });

  it("a remote halt propagates as a failed step with no downstream mutation", () => {
    const h = makeHost({ touchFlags: ["migrate_fail"] });
    const base = ["--sha", TEST_SHA, "--run", "4001", "--attempt", ATTEMPT];
    node(h.fh, ["install-helper", ...base]);
    node(h.fh, ["preflight", ...base]);
    const arc = path.join(h.base, "image.tar.gz");
    fs.writeFileSync(arc, "z");
    const asha = createHash("sha256").update("z").digest("hex");
    const meta = path.join(h.base, "metadata.json");
    fs.writeFileSync(meta, JSON.stringify({ sha: TEST_SHA, imageId: CAND_ID, archiveSha256: asha, archiveBytes: 1, migrationSqlSha256: MIGRATION.sqlSha256 }));
    node(h.fh, ["send-archive", ...base, "--metadata", meta, "--archive", arc]);
    node(h.fh, ["backup", ...base]);
    node(h.fh, ["rehearse", ...base]);
    const composeBefore = fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8");
    const rm = node(h.fh, ["migrate", ...base]);
    expect(rm.status).toBe(1);
    expect(rm.stderr).toContain("halted");
    expect(fs.readFileSync(path.join(h.lcm, "docker-compose.yml"), "utf8")).toBe(composeBefore);
  });

  it("fetch-backup-copy refuses drifted bytes and verify-public refuses identity mismatch", () => {
    const h = makeHost();
    const base = ["--sha", TEST_SHA, "--run", "4002", "--attempt", ATTEMPT];
    const rd2 = path.join(h.lcm, "backups", `actions-4002-${ATTEMPT}-${SHA12}`);
    node(h.fh, ["install-helper", ...base]);
    node(h.fh, ["preflight", ...base]);
    node(h.fh, ["backup", ...base]);
    const man = fs.readFileSync(path.join(rd2, "backup.manifest"), "utf8");
    const dump = man.match(/^dump=(.+)$/m)![1];
    fs.appendFileSync(path.join(rd2, dump), "X"); // drift
    const fc = node(h.fh, ["fetch-backup-copy", ...base, "--out-dir", path.join(h.base, "off")]);
    expect(fc.status).toBe(1);
    fs.writeFileSync(path.join(h.st, "health_public.txt"), JSON.stringify({ ok: true, commitSha: "deadbeef" }));
    const vp = node(h.fh, ["verify-public", ...base]);
    expect(vp.status).toBe(1);
    expect(vp.stderr).toContain("identity mismatch");
    expect(vp.stderr).not.toContain("deadbeef"); // fixed summary only, no raw body
  });
});

describe("needs-API detection", () => {
  const cmp = (files: string[], extra = {}) => ({
    base_commit: { sha: "a".repeat(40) },
    compare_from_sha: "a".repeat(40),
    compare_to_sha: "b".repeat(40),
    total_count: files.length,
    files: files.map((filename) => ({ filename })),
    ...extra,
  });
  it("detects api/prisma/shared/docker-input paths", () => {
    for (const f of ["apps/api/src/app.ts", "prisma/schema.prisma", "packages/shared/src/x.ts", "pnpm-lock.yaml"]) {
      expect(classifyCompare(cmp([f]), { base: "a".repeat(40), head: "b".repeat(40) }).needsApi).toBe(true);
    }
  });
  it("skips pure web/marketing pushes", () => {
    expect(classifyCompare(cmp(["apps/web/src/App.tsx", "docs/x.md"]),
      { base: "a".repeat(40), head: "b".repeat(40) }).needsApi).toBe(false);
  });
  it("fail-closes on missing base (first/force push)", () => {
    expect(classifyCompare(cmp([]), { base: "0".repeat(40), head: "b".repeat(40) }).reason).toBe("no-base");
  });
  it("fail-closes on truncated or mismatched compare evidence", () => {
    expect(classifyCompare(cmp(["apps/web/a.tsx"], { total_count: 999 }),
      { base: "a".repeat(40), head: "b".repeat(40) }).needsApi).toBe(true);
    expect(classifyCompare(cmp(["apps/web/a.tsx"], { compare_to_sha: "z".repeat(40) }),
      { base: "a".repeat(40), head: "b".repeat(40) }).needsApi).toBe(true);
    expect(classifyCompare({} as never, { base: "a".repeat(40), head: "b".repeat(40) }).needsApi).toBe(true);
  });
});

describe("image.mjs guards (Mac Mini side)", () => {
  const node = (args: string[], fh: string) =>
    spawnSync("node", [path.join(API, "image.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FAKES}:${process.env.PATH}`, FAKE_HOST: fh,
        LCM_CI_API_STATE_DIR: path.join(fh, "imgstate") },
      stdin: "ignore",
    });
  it("capacity enforces floor+peak*1.2+reserve from measured free space", () => {
    const h = makeHost({ extraState: { df_avail_k: "1048576" } }); // 1 GiB
    const r = node(["capacity", "--sha", TEST_SHA], h.fh);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("capacity budget not met");
    const h2 = makeHost({ extraState: { df_avail_k: "26000000" } }); // ~24.8 GiB
    expect(node(["capacity", "--sha", TEST_SHA], h2.fh).status).toBe(0);
  });
  it("verify-archive refuses tampered archives and unbound metadata", () => {
    const h = makeHost();
    const arc = path.join(h.base, "a.gz");
    fs.writeFileSync(arc, "one");
    const meta = path.join(h.base, "m.json");
    fs.writeFileSync(meta, JSON.stringify({
      sha: TEST_SHA, imageId: `sha256:${"c".repeat(64)}`,
      archiveSha256: createHash("sha256").update("one").digest("hex"),
      archiveBytes: 3, migrationSqlSha256: MIGRATION.sqlSha256,
    }));
    expect(node(["verify-archive", "--sha", TEST_SHA, "--metadata", meta, "--archive", arc], h.fh).status).toBe(0);
    fs.writeFileSync(arc, "two");
    expect(node(["verify-archive", "--sha", TEST_SHA, "--metadata", meta, "--archive", arc], h.fh).status).toBe(1);
    fs.writeFileSync(arc, "one");
    fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), migrationSqlSha256: "0".repeat(64) }));
    expect(node(["verify-archive", "--sha", TEST_SHA, "--metadata", meta, "--archive", arc], h.fh).status).toBe(1);
  });
});

describe("workflow structure (spec-as-content)", () => {
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
  it("serializes production deploys (no cancel mid-migration)", () => {
    expect(yml).toMatch(/cancel-in-progress:\s*false/);
  });
  it("has no untrusted trigger paths", () => {
    expect(yml).not.toMatch(/(^|\n)[ \t]*workflow_dispatch:/);
    expect(yml).not.toMatch(/(^|\n)[ \t]*pull_request:/);
  });
  it("FE deploy is gated on API stage success when required", () => {
    expect(yml).toContain("needs.needs-api-detect.outputs.needs_api != 'true'");
    expect(yml).toContain("needs.api-deploy.result == 'success'");
  });
  it("API promotion runs under the reviewed production environment", () => {
    expect(yml).toMatch(/api-deploy:[\s\S]*?environment:\s*\n\s*name: production/);
  });
  it("no new permission grants and no provider secrets in the API stages", () => {
    expect(yml).not.toContain("packages: write");
    expect(yml).not.toMatch(/StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
    expect(yml).not.toContain("LCM_HELPER_ALLOW_NONROOT_TEST");
    expect(yml).not.toContain("LCM_ROOT");
  });
  it("image artifact retention is 1 day", () => {
    expect(yml).toMatch(/retention-days: 1\b/);
  });
});
