// Ephemeral test-only PostgreSQL cluster for LCM API integration tests on the
// Mac Mini self-hosted runner.
//
// Security (P1 PG trust fix):
//   - NO TCP listener (listen_addresses='') — prevents other OS UIDs from
//     connecting as DB superuser via TCP with trust auth
//   - Unix socket only, in a 0700 directory owned by the CI user
//   - peer auth for local (Unix socket) connections — DB superuser role must
//     match the actual OS username (os.userInfo().username)
//   - reject auth for host (TCP) connections — explicit defense in depth
//   - DB name = role = schema = "lcm_ci_test" (satisfies *_test_* guard)
//
// Connection URL format:
//   postgresql://<os-user>@localhost/lcm_ci_test?host=<socket-dir>&schema=lcm_ci_test
// The hostname "localhost" satisfies the test-database.ts guard, but the actual
// connection goes through the Unix socket via the ?host= query parameter.
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
import os from "node:os";

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
const socketDir = join(stateDir, "socket"); // Unix socket directory (0700, CI-owned)
const stateFile = join(stateDir, "state.json");
const lockDir = join(stateDir, "host.lock");

for (const bin of ["initdb", "pg_ctl", "psql"]) {
  if (!existsSync(join(pgBinDir, bin))) {
    throw new Error(`PostgreSQL ${bin} not found under ${pgBinDir}; set LCM_CI_PG_BIN_DIR`);
  }
}
const uid = process.getuid();
if (uid === 0) throw new Error("refusing to run the test cluster as root");

// DB superuser role must match the actual OS username for peer auth
const osUsername = os.userInfo().username;

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
  // Also clean socket dir
  if (existsSync(socketDir)) {
    rmSync(socketDir, { recursive: true, force: true });
  }
}

async function pickFreePortAsync() {
  // We still pick a port for metadata, but TCP is disabled.
  // This is for logging/tracing only — no actual TCP listener.
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

    // Create socket directory (0700, CI-owned)
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { mode: 0o700 });
    }
    chmodSync(socketDir, 0o700);

    const port = await pickFreePortAsync();
    if (!port) throw new Error("no free 127.0.0.1 port in range 54500-54559");

    // initdb with peer auth for local, reject for host (TCP)
    // DB superuser role = OS username (for peer auth matching)
    const initdb = spawnSync(
      join(pgBinDir, "initdb"),
      [
        "-D", dataDir,
        "-U", osUsername, // DB superuser = OS username (peer auth requirement)
        "--auth-local=peer", // Unix socket: peer auth
        "--auth-host=reject", // TCP: reject all
        "-E", "UTF8"
      ],
      { stdio: "inherit" }
    );
    if (initdb.status !== 0) throw new Error("initdb failed");
    chmodSync(dataDir, 0o700);

    // Create the test database and role
    // We need to start the cluster temporarily to create the DB/role
    const socketOpts = `-c unix_socket_directories='${socketDir}'`;
    const ctl = spawnSync(join(pgBinDir, "pg_ctl"), [
      "-D", dataDir, "-l", join(stateDir, "pg.log"), "-w", "-t", "60", "start",
      "-o", `-c listen_addresses='' ${socketOpts} -c fsync=off -c max_connections=64`
    ], { stdio: "inherit" });
    if (ctl.status !== 0) throw new Error("pg_ctl start failed");
    try {
      chmodSync(join(stateDir, "pg.log"), 0o600);
    } catch {}

    // Create test database and role via Unix socket (peer auth)
    // The role name must match the OS username for peer auth, but we also
    // create a separate role for the test DB if needed.
    // Actually, the DB superuser is the OS username, so we can create the test DB directly.
    const createDb = spawnSync(
      join(pgBinDir, "createdb"),
      ["-h", socketDir, "-U", osUsername, PG_DB_NAME],
      { stdio: "inherit" }
    );
    if (createDb.status !== 0) throw new Error("createdb failed");

    // Create schema in the test database
    const createSchema = spawnSync(
      join(pgBinDir, "psql"),
      ["-h", socketDir, "-U", osUsername, "-d", PG_DB_NAME, "-c", `CREATE SCHEMA IF NOT EXISTS ${PG_DB_NAME};`],
      { stdio: "inherit" }
    );
    if (createSchema.status !== 0) throw new Error("create schema failed");

    const state = {
      version: 2, // v2: Unix socket + peer auth
      uid,
      pid: postmasterPid(),
      port, // metadata only, no TCP listener
      dataDir,
      socketDir,
      pgBinDir,
      osUsername,
      startedAt: new Date().toISOString()
    };
    writeFileSync(stateFile, JSON.stringify(state) + "\n", { mode: 0o600 });
    // Lock owner becomes the postmaster so a concurrent start can detect a live cluster.
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ uid, pid: state.pid, at: state.startedAt }) + "\n", { mode: 0o600 });

    // Connection URL: Unix socket via ?host= query parameter
    // The hostname "localhost" satisfies the test-database.ts guard,
    // but the actual connection goes through the Unix socket.
    // The port is included so the client finds the right socket file (.s.PGSQL.<port>).
    const encodedSocketDir = encodeURIComponent(socketDir);
    const url = `postgresql://${osUsername}@localhost:${port}/${PG_DB_NAME}?host=${encodedSocketDir}&schema=${PG_DB_NAME}`;
    
    if (githubEnvFile) {
      writeFileSync(githubEnvFile, `API_TEST_DATABASE_URL=${url}\n`, { flag: "a" });
    }
    console.log(url);
    console.log(`Unix socket: ${socketDir}`);
    console.log(`TCP listener: disabled (listen_addresses='')`);
    console.log(`Auth: peer (local), reject (host)`);
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
