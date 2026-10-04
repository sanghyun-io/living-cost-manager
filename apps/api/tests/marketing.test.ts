import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import {
  MarketingMetricsStore, nodeMarketingMetricsFileSystem as disk,
  parseMarketingMetricsFile, utcDateKey
} from "../src/services/marketing-metrics.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.useRealTimers(); });
async function temp() {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".marketing-test-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "aggregate.json");
}
const event = "personal_cost_saved" as const;
const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://unused", JWT_SECRET: "test-secret-with-at-least-32-characters" };
async function appFor(file?: string, extra = {}, logger?: FastifyBaseLogger) {
  const app = await buildApp({ env: loadEnv({ ...base, ...(file ? { MARKETING_METRICS_ENABLED: "true", MARKETING_METRICS_FILE: file } : {}), ...extra }), prisma: {} as PrismaClient, logger });
  await app.ready(); cleanup.push(() => app.close()); return app;
}
async function storeFor(filePath: string, extra = {}) {
  const store = new MarketingMetricsStore({ filePath, idleCleanupIntervalMs: 0, ...extra });
  await store.initialize(); cleanup.push(() => store.close()); return store;
}
const aggregate = (date: string, counts = { [event]: 1 }) => ({ version: 1, days: [{ date, counts }] });

test("unsafe existing directory or aggregate fails503 without chmod, overwrite or orphan cleanup", async () => {
  for (const unsafeDirectory of [true, false]) {
    const file = await temp(); const dir = path.dirname(file);
    const text = JSON.stringify(aggregate(utcDateKey(Date.now())));
    await fs.writeFile(file, text, { mode: 0o600 });
    await fs.writeFile(`${file}.tmp`, "orphan evidence", { mode: 0o600 });
    await fs.chmod(unsafeDirectory ? dir : file, unsafeDirectory ? 0o755 : 0o644);
    const app = await appFor(file);
    expect((await app.inject({ method: "POST", url: "/marketing/events", payload: { event } })).statusCode).toBe(503);
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect(await fs.readFile(file, "utf8")).toBe(text);
    expect(await fs.readFile(`${file}.tmp`, "utf8")).toBe("orphan evidence");
    expect((await fs.stat(unsafeDirectory ? dir : file)).mode & 0o777).toBe(unsafeDirectory ? 0o755 : 0o644);
  }
});

test("runtime permission changes and aggregate symlink/hardlink replacements latch without mutation", async () => {
  for (const mutation of ["directory", "file", "symlink", "hardlink"]) {
    const file = await temp(); const store = await storeFor(file); await store.record(event);
    const original = await fs.readFile(file, "utf8");
    const target = path.join(path.dirname(file), "evidence");
    if (mutation === "directory") await fs.chmod(path.dirname(file), 0o755);
    else if (mutation === "file") await fs.chmod(file, 0o644);
    else if (mutation === "hardlink") await fs.link(file, target);
    else { await fs.rename(file, target); await fs.symlink(target, file); }
    await expect(store.record(event)).rejects.toThrow();
    expect(store.status.available).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    if (mutation === "symlink") expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    if (mutation === "hardlink") expect((await fs.lstat(file)).nlink).toBe(2);
  }
});

test("direct directory symlink and aggregate symlink rejected at startup; owner mismatch rejected", async () => {
  const file = await temp(); const real = path.join(path.dirname(file), "real");
  await fs.mkdir(real, { mode: 0o700 });
  const alias = path.join(path.dirname(file), "alias"); await fs.symlink(real, alias);
  const linkedDirectory = await storeFor(path.join(alias, "aggregate.json"));
  expect(linkedDirectory.status.available).toBe(false);
  expect(await fs.readdir(real)).toEqual([]);
  const target = path.join(real, "target"); await fs.writeFile(target, "evidence", { mode: 0o600 });
  await fs.symlink(target, file);
  const linkedFile = await storeFor(file); expect(linkedFile.status.available).toBe(false);
  expect(await fs.readFile(target, "utf8")).toBe("evidence");
  const safe = await temp(); const store = await storeFor(safe);
  // Non-root tests cannot chown arbitrarily. Inject the same lstat uid discrepancy
  // the OS reports for another owner's directory/file, without changing production IO.
  const originalLstat = fs.lstat.bind(fs);
  const spy = vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await originalLstat(...args);
    if (String(args[0]) === safe) Object.defineProperty(stat, "uid", { value: process.getuid!()+1 });
    return stat;
  }) as typeof fs.lstat);
  try {
    await expect(store.record(event)).rejects.toThrow(); expect(store.status.available).toBe(false);
  } finally { spy.mockRestore(); }
});

test("only literal true enables; missing/relative path/default remain off", async () => {
  for (const flag of [undefined, "false", "1", "yes", "on", "TRUE"]) {
    expect(loadEnv({ ...base, MARKETING_METRICS_ENABLED: flag }).MARKETING_METRICS_ENABLED).toBe(false);
  }
  for (const extra of [{}, { MARKETING_METRICS_ENABLED: "true" }, { MARKETING_METRICS_ENABLED: "true", MARKETING_METRICS_FILE: "relative" }]) {
    const app = await appFor(undefined, extra);
    expect((await app.inject({ method: "POST", url: "/marketing/events", payload: { event } })).statusCode).toBe(404);
    expect((await app.inject("/health")).statusCode).toBe(200);
  }
});

test("strict public schema, no read endpoints even JWT, prefix and opt-out", async () => {
  const file = await temp(); const app = await appFor(file, { API_BASE_PATH: "/v1" });
  const url = "/v1/marketing/events";
  expect((await app.inject({ method: "POST", url, payload: "x".repeat(257), headers: { "content-type": "application/json" } })).statusCode).toBe(413);
  expect((await app.inject({ method: "POST", url, payload: "xml", headers: { "content-type": "application/xml" } })).statusCode).toBe(415);
  for (const payload of [{ event, timestamp: 1 }, { event, id: "user" }, { event, amount: 10 }, { event: "other" }, {}, [], { event: 1 }]) {
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(400);
  }
  for (const header of ["dnt", "sec-gpc"]) {
    expect((await app.inject({ method: "POST", url, payload: { event, id: "private" }, headers: { [header]: "1" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { event }, headers: { [header]: "1" } })).statusCode).toBe(202);
  }
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 1, days: [] });
  const token = app.signTokens({ id: "unused", tokenVersion: 0 }).accessToken;
  for (const target of [url, "/v1/marketing/stats", "/v1/marketing/events/stats"]) {
    expect((await app.inject({ method: "GET", url: target, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
  }
  expect((await app.inject({ method: "POST", url, payload: { event }, headers: { authorization: "invalid" } })).statusCode).toBe(202);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(aggregate(utcDateKey(Date.now())));
});

test("actual Fastify logger sees no marketing request/error/body/query/IP/UA, including disabled and malformed requests", async () => {
  const logs: string[] = [];
  const loggerHost = Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  cleanup.push(() => loggerHost.close());
  const logger = loggerHost.log;
  for (const enabled of [true, false]) {
    const file = await temp(); const app = await appFor(enabled ? file : undefined, {}, logger); logs.length = 0;
    for (const options of [
      { method: "POST" as const, payload: { event } },
      { method: "POST" as const, payload: '{"event":"SECRET', headers: { "content-type": "application/json" } },
      { method: "POST" as const, payload: "SECRET".repeat(100), headers: { "content-type": "application/json" } },
      { method: "POST" as const, payload: { event, email: "SECRET" } },
      { method: "GET" as const },
    ]) {
      const result = await app.inject({ ...options, url: "/marketing/events", headers: { ...options.headers, "user-agent": "SECRET_UA" }, remoteAddress: "192.0.2.55" });
      if (result.statusCode === 400) expect(result.body).not.toContain("SECRET");
    }
    await app.inject({ method: "POST", url: "/marketing/events?SECRET=1", payload: { event } });
    expect(logs).toEqual([]);
    if (enabled) {
      await fs.writeFile(file, "SECRET_CORRUPTION");
      expect((await app.inject({ method: "POST", url: "/marketing/events?SECRET=1", payload: { event } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/marketing/events", payload: { event }, headers: { "user-agent": "SECRET_UA" } })).statusCode).toBe(503);
      expect(logs).toHaveLength(1); // generic collector health alarm only
      expect(logs.join()).not.toMatch(/SECRET|remoteAddress|reqId|aggregate.json/);
      logs.length = 0;
    }
    await app.inject("/health"); expect(logs.length).toBeGreaterThan(0);
  }
});

test("120/min global shared rate budget counts rejected requests from different IPs", async () => {
  const app = await appFor(await temp());
  for (let i = 0; i < 120; i++) expect((await app.inject({ method: "POST", url: "/marketing/events", payload: {}, remoteAddress: `192.0.2.${i + 1}` })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/marketing/events", payload: { event }, remoteAddress: "198.51.100.1" })).statusCode).toBe(429);
});

test("real atomic disk concurrent writes persist every accepted event with mode600 and no temp artifacts", async () => {
  const file = await temp(); const store = await storeFor(file);
  await Promise.all(Array.from({ length: 32 }, () => store.record(event)));
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(aggregate(utcDateKey(Date.now()), { [event]: 32 }));
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(path.dirname(file))).toEqual(["aggregate.json"]);
});

test("startup retention keeps today plus89days, idle timer prunes without new events", async () => {
  const file = await temp(); let now = Date.parse("2026-10-05T00:00:00Z");
  await fs.writeFile(file, JSON.stringify({ version: 1, days: [89,90].map(age => ({ date: utcDateKey(now-age*86400000), counts: { [event]: 1 } })) }), { mode: 0o600 });
  await storeFor(file, { now: () => now, idleCleanupIntervalMs: 10, idleThresholdMs: 0 });
  expect(JSON.parse(await fs.readFile(file, "utf8")).days).toHaveLength(1);
  now += 86400000;
  await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, "utf8")).days).toEqual([]));
});

test("corrupt/oversize/non-regular file isolates health,503,no overwrite; failure latches until restart", async () => {
  for (const contents of ['{"SECRET":1}', "x".repeat(65537)]) {
    const file = await temp(); await fs.writeFile(file, contents, { mode: 0o600 }); const app = await appFor(file);
    expect((await app.inject({ method: "POST", url: "/marketing/events", payload: { event } })).statusCode).toBe(503);
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect(await fs.readFile(file, "utf8")).toBe(contents);
  }
  const file = await temp(); await fs.writeFile(file, "bad", { mode: 0o600 }); const store = await storeFor(file);
  await fs.rm(file); await expect(store.record(event)).rejects.toMatchObject({ reason: "corrupt_file" });
  await expect(store.retainNow()).rejects.toMatchObject({ reason: "corrupt_file" });
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  const directory = await temp(); await fs.mkdir(directory); const invalid = await storeFor(directory);
  expect(invalid.status.available).toBe(false);
});

test("strict aggregate caps: 90entries, calendar, integer, unknown keys; per-event and total cap leave file intact", async () => {
  for (const value of [
    { version: 1, days: Array.from({ length: 91 }, () => ({ date: "2026-10-05", counts: {} })) },
    aggregate("2026-02-30"), aggregate("2026-10-05", { [event]: 1.5 }),
    aggregate("2026-10-05", { [event]: 5001 }), { ...aggregate("2026-10-05"), user: "x" }
  ]) expect(() => parseMarketingMetricsFile(JSON.stringify(value))).toThrow();
  for (const counts of [{ [event]: 5000 }, { personal_billing_date_saved: 5000, personal_renewal_decision_saved: 5000 }]) {
    const file = await temp(); const text = JSON.stringify(aggregate(utcDateKey(Date.now()), counts)); await fs.writeFile(file, text, { mode: 0o600 });
    const store = await storeFor(file); await expect(store.record(event)).rejects.toMatchObject({ name: "MarketingMetricsCapacityError" });
    expect(await fs.readFile(file, "utf8")).toBe(text);
  }
});

test("queue32 bound, write errors and idle cleanup write errors latch unavailable", async () => {
  const file = await temp(); let fail = false; let writes = 0;
  const store = await storeFor(file, { fileSystem: { ...disk, atomicWrite: async (p: string, c: string) => { writes++; if (fail) throw Object.assign(new Error("SECRET/path"), { code: "EIO" }); await disk.atomicWrite(p,c); } } });
  const results = await Promise.allSettled(Array.from({ length: 33 }, () => store.record(event)));
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  fail = true; await expect(store.record(event)).rejects.toMatchObject({ reason: "write_failed" }); const before = writes;
  await expect(store.record(event)).rejects.toThrow(); expect(writes).toBe(before);
  const other = await temp(); let now = Date.now();
  const idle = await storeFor(other, { now: () => now, fileSystem: { ...disk, atomicWrite: async(p: string,c: string) => { if (now > Date.now()+86400000) throw new Error("disk failed"); await disk.atomicWrite(p,c); } } });
  await idle.record(event); now += 91*86400000;
  await expect(idle.retainNow()).rejects.toMatchObject({ reason: "write_failed" }); expect(idle.status.available).toBe(false);
});

test("rename published but directory fsync failure is ambiguous, latched without retries", async () => {
  const file = await temp(); let fail = false; let writes = 0;
  const store = await storeFor(file, { fileSystem: { ...disk, atomicWrite: async (p: string, c: string) => {
    writes++; await disk.atomicWrite(p,c); if (fail) throw new Error("directory fsync failed after rename");
  } } });
  fail = true;
  await expect(store.record(event)).rejects.toMatchObject({ reason: "write_failed" });
  expect(JSON.parse(await fs.readFile(file, "utf8")).days[0].counts[event]).toBe(1);
  const before = writes;
  await expect(store.record(event)).rejects.toThrow(); expect(writes).toBe(before);
});

test("directory startup failure, bounded serialization, and runtime deletion fail closed", async () => {
  const file = await temp();
  const broken = await storeFor(file, { fileSystem: { ...disk, ensureDirectory: async () => { throw Object.assign(new Error("private"), { code: "EACCES" }); } } });
  expect(broken.status).toMatchObject({ available: false, reason: "directory_unavailable" });
  const small = await storeFor(file, { maxFileBytes: 30 });
  await expect(small.record(event)).rejects.toMatchObject({ reason: "serialized_oversized" });
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 1, days: [] });
  await fs.rm(file);
  await expect(small.record(event)).rejects.toMatchObject({ reason: "read_failed" });
});

test("fixed temp slot recovers private crash orphan and rejects symlink without touching target", async () => {
  const file = await temp();
  await fs.writeFile(`${file}.tmp`, "partial", { mode: 0o600 });
  await storeFor(file);
  expect(await fs.readdir(path.dirname(file))).toEqual(["aggregate.json"]);
  const second = await temp(); const target = path.join(path.dirname(second), "target");
  await fs.writeFile(target, "do not touch"); await fs.symlink(target, `${second}.tmp`);
  const store = await storeFor(second);
  expect(store.status.available).toBe(false);
  expect(await fs.readFile(target, "utf8")).toBe("do not touch");
  expect((await fs.lstat(`${second}.tmp`)).isSymbolicLink()).toBe(true);
});

test("startup removes aged private orphan even with an existing empty aggregate and no new writes", async () => {
  const file = await temp();
  const empty = JSON.stringify({ version: 1, days: [] });
  await fs.writeFile(file, empty, { mode: 0o600 });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(aggregate("2020-01-01")), { mode: 0o600 });
  await fs.utimes(`${file}.tmp`, new Date("2020-01-01"), new Date("2020-01-01"));
  const store = await storeFor(file);
  expect(store.status.available).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe(empty);
  expect(await fs.readdir(path.dirname(file))).toEqual(["aggregate.json"]);
  await expect(store.retainNow()).resolves.toEqual({ droppedDays: 0, rewritten: false });
});
