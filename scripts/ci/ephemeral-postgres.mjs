// Ephemeral test-only PostgreSQL cluster for LCM API integration tests on the
// Mac Mini self-hosted runner. Owns exactly one state directory (default
// $HOME/lcm-ci-test-pg, mode 0700) and a 127.0.0.1-only cluster with
// trust auth (no password in URLs or logs). Database/role/schema names all
// carry the `test` marker required by apps/api/tests/test-database.ts, and the
// process refuses to touch anything not recorded in its own state file (never
// the 5432 developer cluster, tunnels, or production/OCI databases).
//
// Usage:
//   node scripts/ci/ephemeral-postgres.mjs start [--github-env <file>]
//   node scripts/ci/ephemeral-postgres.mjs stop
// State dir override: env LCM_CI_TEST_STATE_DIR or --state-dir.
// PG binaries: env LCM_CI_PG_BIN_DIR (default Homebrew postgresql@16).
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, existsSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLock, releaseLock } from "./host-lock.mjs";

const PG_DB_NAME = "lcm_ci_test"; // db = role = schema; satisfies the *_test_* guard
const PORT_CANDIDATES = Array.from({ length: 60 }, (_, i) => 54500 + i);

const argv = process.argv.slice(2);
const command = argv[0];
const flagValue = (name) => {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
};

const stateDir = resolve(
  flagValue("state-dir") ?? process.env.LCM_CI_TEST_STATE_DIR ?? join(process.env.HOME ?? "", "lcm-ci-test-pg")
);
if (!process.env.HOME || stateDir === resolve(process.env.HOME)) {
  throw new Error("refusing: state dir must be a dedicated 0700 subdirectory of the CI user home");
}
const pgBinDir = flagValue("pg-bin-dir") ?? process.env.LCM_CI_PG_BIN_DIR ?? "/opt/homebrew/opt/postgresql@16/bin";
const dataDir = join(stateDir, "data");
const stateFile = join(stateDir, "state.json");
const lockDir = join(stateDir, "host.lock");

for (const bin of ["initdb", "pg_ctl", "psql"]) {
  if (!existsSync(join(pgBinDir, bin))) {
    throw new Error(`PostgreSQL ${bin} not found under ${pgBinDir}; set LCM_CI_PG_BIN_DIR`);
  }
}
const uid = process.getuid();
if (uid === 0) throw new Error("refusing to run the test cluster as root");

function ensureStateDir() {
  if (existsSync(stateDir)) {
    const st = statSync(stateDir);
    if (st.uid !== uid) throw new Error(`state dir ${stateDir} is owned by uid ${st.uid}; refusing`);
    chmodSync(stateDir, 0o700);
  } else {
    mkdirSync(stateDir, { mode: 0o700 });
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Stop a cluster we previously recorded (validated ownership), then remove the
// data dir. Idempotent; safe to call from `stop` and from `start` cleanup.
function stopOwnedCluster() {
  const state = readState();
  if (!state) {
    if (existsSync(dataDir)) {
      const entries = readdirSync(dataDir);
      if (entries.length === 0) rmSync(dataDir, { recursive: true, force: true });
      else if (entries.includes("PG_VERSION") && !pidAlive(postmasterPid())) cleanupDataDir();
      else throw new Error(`data dir ${dataDir} has unexpected content without a state file; refusing to delete`);
    }
    return;
  }
  if (state.uid !== uid || state.dataDir !== dataDir) {
    throw new Error(`state file references uid ${state.uid} / path ${state.dataDir}; refusing to touch`);
  }
  const running = spawnSync(join(pgBinDir, "pg_ctl"), ["-D", dataDir, "status"], { encoding: "utf8" });
  if (running.status === 0) {
    const stopped = spawnSync(join(pgBinDir, "pg_ctl"), ["-D", dataDir, "stop", "-m", "fast", "-w", "-t", "60"], {
      stdio: "inherit"
    });
    if (stopped.status !== 0) throw new Error("pg_ctl stop failed; inspect before retrying");
  }
  cleanupDataDir();
  try {
    unlinkSync(stateFile);
  } catch {}
}

function postmasterPid() {
  try {
    return parseInt(readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n")[0], 10);
  } catch {
    return 0;
  }
}

function cleanupDataDir() {
  if (existsSync(dataDir)) {
    const entries = readdirSync(dataDir);
    if (entries.length === 0 || entries.includes("PG_VERSION")) {
      rmSync(dataDir, { recursive: true, force: true });
    } else {
      throw new Error(`refusing to remove unexpected data dir content in ${dataDir}`);
    }
  }
}

async function pickFreePortAsync() {
  for (const port of PORT_CANDIDATES) {
    const free = await new Promise((resolvePromise) => {
      const s = createServer();
      s.once("error", () => resolvePromise(false));
      s.once("listening", () => {
        s.close(() => resolvePromise(true));
      });
      s.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

async function start(githubEnvFile) {
  ensureStateDir();
  const lock = await acquireLock(lockDir);
  try {
    stopOwnedCluster(); // clean any previous job's leftovers

    const port = await pickFreePortAsync();
    if (!port) throw new Error("no free 127.0.0.1 port in range 54500-54559");

    const initdb = spawnSync(join(pgBinDir, "initdb"), ["-D", dataDir, "-U", PG_DB_NAME, "-A", "trust", "-E", "UTF8"], {
      stdio: "inherit"
    });
    if (initdb.status !== 0) throw new Error("initdb failed");
    chmodSync(dataDir, 0o700);

    const socketOpts = `-c unix_socket_directories='${stateDir}'`;
    const ctl = spawnSync(join(pgBinDir, "pg_ctl"), [
      "-D", dataDir, "-l", join(stateDir, "pg.log"), "-w", "-t", "60", "start",
      "-o", `-p ${port} -c listen_addresses=127.0.0.1 ${socketOpts} -c fsync=off -c max_connections=64`
    ], { stdio: "inherit" });
    if (ctl.status !== 0) throw new Error("pg_ctl start failed");
    try {
      chmodSync(join(stateDir, "pg.log"), 0o600);
    } catch {}

    const state = {
      version: 1,
      uid,
      pid: postmasterPid(),
      port,
      dataDir,
      pgBinDir,
      startedAt: new Date().toISOString()
    };
    writeFileSync(stateFile, JSON.stringify(state) + "\n", { mode: 0o600 });
    // Lock owner becomes the postmaster so a concurrent start can detect a live cluster.
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ uid, pid: state.pid, at: state.startedAt }) + "\n", { mode: 0o600 });

    const url = `postgresql://${PG_DB_NAME}@127.0.0.1:${port}/${PG_DB_NAME}?schema=${PG_DB_NAME}`;
    if (githubEnvFile) {
      writeFileSync(githubEnvFile, `API_TEST_DATABASE_URL=${url}\n`, { flag: "a" });
    }
    console.log(url);
  } finally {
    // The lock stays held conceptually for the cluster's lifetime via owner pid;
    // release only when the cluster is not (or no longer) running under this state.
    const state = readState();
    if (!state || !pidAlive(state.pid)) await releaseLock(lockDir);
  }
}

async function stop() {
  if (!existsSync(stateDir)) return console.log("no state dir; nothing to stop");
  stopOwnedCluster();
  await releaseLock(lockDir);
  console.log("ephemeral test cluster stopped and data dir removed");
}

if (command === "start") {
  await start(flagValue("github-env"));
} else if (command === "stop") {
  await stop();
} else {
  console.error("usage: ephemeral-postgres.mjs start|stop [--state-dir DIR] [--github-env FILE]");
  process.exit(2);
}
