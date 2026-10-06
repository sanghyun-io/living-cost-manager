// Purpose-created local cluster only. Never uses DATABASE_URL from the caller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { assertVerificationTarget } from "./verification-target.mjs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = process.env.LCM_TEST_TEMP_ROOT || tmpdir();
const pg = (name) => process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name;
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "USER", "LANG", "SHELL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: "1", NEXT_TELEMETRY_DISABLED: "1", EMAIL_PROVIDER: "console" });
let cluster, clusterStarted = false, api, web;
let active;
let interrupted = false;
let cleaning = false;
const children = new Set();
function launch(command, args, extra = {}) {
  if (interrupted && !cleaning) throw new Error("Verification interrupted");
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, stdio: "inherit", detached: process.platform !== "win32" });
  children.add(child); child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}
async function run(command, args, extra) {
  active = launch(command, args, extra);
  const [code, signal] = await once(active, "exit"); active = null;
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`);
}
async function port() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  const timer = setTimeout(() => signalChild(child, "SIGKILL"), 5000);
  await once(child, "exit"); clearTimeout(timer);
}
async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (interrupted || child?.signalCode || (child?.exitCode !== null && child?.exitCode !== undefined)) throw new Error("Server exited before ready");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server readiness timeout: ${url}`);
}
function signalChild(child, signal) {
  if (!child.pid) return;
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
const signalHandler = () => {
  interrupted = true; process.exitCode = 1;
  for (const child of children) signalChild(child, "SIGTERM");
};
process.on("SIGINT", signalHandler); process.on("SIGTERM", signalHandler);
try {
  await mkdir(tempRoot, { recursive: true });
  cluster = await mkdtemp(path.join(tempRoot, "lcm-usability-test-"));
  let dbPort = await port();
  while ([5432, 5433].includes(dbPort)) dbPort = await port();
  const apiPort = await port();
  const webPort = await port();
  const databaseUrl = `postgresql://lcm_test@127.0.0.1:${dbPort}/lcm_test?schema=lcm_test`;
  const target = new URL(databaseUrl);
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/lcm_test"); assert.equal(target.searchParams.get("schema"), "lcm_test");
  Object.assign(env, { DATABASE_URL: databaseUrl, API_TEST_DATABASE_URL: databaseUrl,
    JWT_SECRET: "isolated-test-only-secret-at-least-32-chars", HOST: "127.0.0.1", PORT: String(apiPort),
    CORS_ORIGIN: `http://127.0.0.1:${webPort}`, APP_BASE_URL: `http://127.0.0.1:${webPort}`,
    NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${apiPort}`, LCM_E2E_ORIGIN: `http://127.0.0.1:${webPort}`,
    LCM_E2E_API: `http://127.0.0.1:${apiPort}`,
    LCM_VERIFY_CLUSTER_MARKER: path.join(cluster, "ownership.json"),
    PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE || "playwright",
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  await run(pg("initdb"), ["-D", path.join(cluster, "data"), "-U", "lcm_test", "-A", "trust", "--no-locale", "-E", "UTF8"]);
  await writeFile(env.LCM_VERIFY_CLUSTER_MARKER, JSON.stringify({ databaseUrl, apiOrigin: env.LCM_E2E_API, webOrigin: env.LCM_E2E_ORIGIN }), { mode: 0o600 });
  await assertVerificationTarget(env);
  // Startup may have launched postgres even when pg_ctl is interrupted.
  // Treat the cluster as potentially running until an explicit stop succeeds.
  clusterStarted = true;
  await run(pg("pg_ctl"), ["-D", path.join(cluster, "data"), "-l", path.join(cluster, "postgres.log"), "-o", `-h 127.0.0.1 -p ${dbPort} -k ''`, "-w", "start"]);
  await run(pg("createdb"), ["-h", "127.0.0.1", "-p", String(dbPort), "-U", "lcm_test", "lcm_test"]);
  if (process.env.LCM_VERIFY_INJECT_FAILURE === "after-db") throw new Error("Injected verification failure after DB startup");
  await run("pnpm", ["prisma", "generate"]);
  await run("pnpm", ["--filter", "@living-cost-manager/shared", "build"]);
  await run("node", ["--test", "scripts/verification-target.test.mjs"]);
  await run("pnpm", ["test:marketing"]);
  await assertVerificationTarget(env);
  await run("pnpm", ["test"]);
  await run("pnpm", ["build"]);
  await run("node", ["scripts/test-service-worker.mjs"]);
  api = launch("node", ["apps/api/dist/server.js"], { NODE_ENV: "test" });
  await ready(`${env.LCM_E2E_API}/health`, api);
  const webRoot = path.join(root, "apps/web/out");
  web = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, env.LCM_E2E_ORIGIN).pathname);
      let file = path.resolve(webRoot, "." + pathname);
      if (!file.startsWith(webRoot + path.sep) && file !== webRoot) throw new Error("outside export");
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
      response.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end("Not found"); }
  });
  web.listen(webPort, "127.0.0.1"); await once(web, "listening");
  await run("node", ["scripts/usability-browser.mjs"]);
  await run("node", ["scripts/ui-refresh-browser.mjs"], process.env.LCM_UI_EVIDENCE ? { LCM_UI_EVIDENCE: process.env.LCM_UI_EVIDENCE } : {});
  await run("node", ["scripts/pm-local-e2e.mjs"]);
  await run("node", ["scripts/pm-sync-e2e.mjs"]);
  await run("node", ["scripts/verify-marketing.mjs"]);
  await run("node", ["scripts/verify-pricing.mjs"]);
  console.log("PASS: shared/web/API tests, builds, service worker, desktop/mobile and sync browser regressions");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  cleaning = true;
  for (const child of [...children]) await stop(child);
  if (web) await new Promise(resolve => { web.close(resolve); web.closeAllConnections(); });
  let stopped = !clusterStarted;
  if (clusterStarted) {
    try { await run(pg("pg_ctl"), ["-D", path.join(cluster, "data"), "-m", "fast", "-w", "stop"]); stopped = true; }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
  if (cluster && stopped) { await rm(cluster, { recursive: true, force: true }); console.log("CLEANUP: temporary cluster removed; all verification servers stopped"); }
  process.off("SIGINT", signalHandler); process.off("SIGTERM", signalHandler);
}
