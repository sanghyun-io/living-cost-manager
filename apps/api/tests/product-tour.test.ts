import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { putProductTourState } from "../src/services/product-tour.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const prefix = "auth-test-product-tour-";
const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl,
  JWT_SECRET: "synthetic-tour-secret-at-least-32-characters", EMAIL_PROVIDER: "console",
  API_BASE_PATH: "/living-cost-manager/v1" });
const app = await buildApp({ env, prisma });
const url = "/living-cost-manager/v1/onboarding/product-tour";

async function user(suffix = "one", verified = false) {
  const record = await prisma.user.create({ data: {
    email: `${prefix}${suffix}@example.invalid`, name: "Synthetic tour fixture", passwordHash: "unused",
    emailVerifiedAt: verified ? new Date() : null
  } });
  const tokens = app.signTokens(record);
  return { ...record, ...tokens, headers: { authorization: `Bearer ${tokens.accessToken}` } };
}
beforeAll(() => prisma.$connect());
afterEach(() => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe("personal product tour", () => {
  test("GET is read-only, exact unseen contract and no-store; free/unverified account allowed", async () => {
    const fixture = await user();
    const before = await prisma.userProductTourState.count();
    const response = await app.inject({ method: "GET", url, headers: fixture.headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ version: 1, status: "unseen", updatedAt: null });
    expect(await prisma.userProductTourState.count()).toBe(before);
  });

  test("writes only own state and another session/device reads same ISO timestamp", async () => {
    const first = await user("first"); const other = await user("other", true);
    const response = await app.inject({ method: "PUT", url, headers: first.headers, payload: { version: 1, status: "skipped" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1, status: "skipped", updatedAt: expect.any(String) });
    expect(new Date(response.json().updatedAt).toISOString()).toBe(response.json().updatedAt);
    const session = app.signTokens(first);
    const same = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(same.json()).toEqual(response.json());
    const isolated = await app.inject({ method: "GET", url, headers: other.headers });
    expect(isolated.json()).toEqual({ version: 1, status: "unseen", updatedAt: null });
    const query = await app.inject({ method: "GET", url: `${url}?userId=${first.id}`, headers: other.headers });
    expect(query.json()).toEqual(isolated.json());
    expect((await app.inject({ method: "GET", url: `${url}/${first.id}`, headers: other.headers })).statusCode).toBe(404);
  });

  test.each(["owner", "editor", "viewer"] as const)("%s may store personal preference without changing workspace", async role => {
    const fixture = await user(role);
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic", members: { create: { userId: fixture.id, role } } } });
    const before = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    expect((await app.inject({ method: "PUT", url, headers: fixture.headers, payload: { version: 1, status: "completed" } })).statusCode).toBe(200);
    expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toEqual(before);
  });

  test.each([
    {}, { version: 1, status: "unseen" }, { version: 2, status: "completed" },
    { version: "1", status: "completed" }, { version: 0, status: "skipped" },
    { version: 1, status: "completed", userId: "another" },
    { version: 1, status: "skipped", unknown: true }, null, [],
    { version: 1, status: "COMPLETED" }
  ])("strictly rejects invalid body %j without writing", async payload => {
    const fixture = await user();
    const response = await app.inject({ method: "PUT", url, headers: { ...fixture.headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(await prisma.userProductTourState.count({ where: { userId: fixture.id } })).toBe(0);
  });

  test.each(["GET", "PUT"] as const)("%s requires valid current access JWT", async method => {
    const fixture = await user();
    const payload = method === "PUT" ? { version: 1, status: "completed" } : undefined;
    for (const headers of [undefined, { authorization: "Bearer invalid" }, { authorization: `Bearer ${fixture.refreshToken}` }]) {
      expect((await app.inject({ method, url, headers, payload })).statusCode).toBe(401);
    }
    await prisma.user.update({ where: { id: fixture.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await app.inject({ method, url, headers: fixture.headers, payload })).statusCode).toBe(401);
    await prisma.user.delete({ where: { id: fixture.id } });
    expect((await app.inject({ method, url, headers: fixture.headers, payload })).statusCode).toBe(401);
  });

  test("completed dominates late skip; replays preserve updatedAt; future version untouched", async () => {
    const fixture = await user();
    await prisma.userProductTourState.create({ data: { userId: fixture.id, version: 2, status: "skipped" } });
    const skipped = await putProductTourState(prisma, fixture.id, "skipped");
    expect(await putProductTourState(prisma, fixture.id, "skipped")).toEqual(skipped);
    const completed = await putProductTourState(prisma, fixture.id, "completed");
    expect(await putProductTourState(prisma, fixture.id, "skipped")).toEqual(completed);
    expect(await putProductTourState(prisma, fixture.id, "completed")).toEqual(completed);
    expect((await prisma.userProductTourState.findUnique({ where: { userId_version: { userId: fixture.id, version: 2 } } }))?.status).toBe("skipped");
  });

  test("50 simultaneous mixed requests converge to completion with exactly one row", async () => {
    const fixture = await user();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => app.inject({
      method: "PUT", url, headers: fixture.headers, payload: { version: 1, status: i % 2 ? "completed" : "skipped" }
    })));
    expect(results.every(response => response.statusCode === 200)).toBe(true);
    expect((await app.inject({ method: "GET", url, headers: fixture.headers })).json().status).toBe("completed");
    expect(await prisma.userProductTourState.count({ where: { userId: fixture.id } })).toBe(1);
  });

  test("DB enforces status/version/FK/composite PK and deletion cascades only preference", async () => {
    const fixture = await user(); const other = await user("other");
    await expect(prisma.userProductTourState.create({ data: { userId: fixture.id, version: 0, status: "skipped" } })).rejects.toThrow();
    await expect(prisma.userProductTourState.create({ data: { userId: fixture.id, version: 1, status: "unseen" } })).rejects.toThrow();
    await expect(prisma.userProductTourState.create({ data: { userId: "nonexistent-synthetic", version: 1, status: "skipped" } })).rejects.toThrow();
    await putProductTourState(prisma, fixture.id, "completed"); await putProductTourState(prisma, other.id, "skipped");
    await expect(prisma.userProductTourState.create({ data: { userId: fixture.id, version: 1, status: "skipped" } })).rejects.toThrow();
    await prisma.user.delete({ where: { id: fixture.id } });
    expect(await prisma.userProductTourState.count({ where: { userId: fixture.id } })).toBe(0);
    expect(await prisma.userProductTourState.count({ where: { userId: other.id } })).toBe(1);
  });

  test("DB unavailable/missing table fails safely, never returns unseen or leaks SQL", async () => {
    const fixture = await user();
    const read = vi.spyOn(prisma.userProductTourState, "findUnique").mockRejectedValue(new Error("synthetic private SQL"));
    const write = vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("synthetic private SQL"));
    try {
      for (const method of ["GET", "PUT"] as const) {
        const response = await app.inject({ method, url, headers: fixture.headers,
          payload: method === "PUT" ? { version: 1, status: "completed" } : undefined });
        expect(response.statusCode).toBe(500);
        expect(response.json().message).toBe("Product tour state unavailable");
        expect(response.body).not.toContain("synthetic private SQL");
        expect(response.body).not.toContain("unseen");
      }
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  test("real non-test limiter enforces 30 PUT/minute and 120 GET/minute separately", async () => {
    const fixture = await user();
    const limited = await buildApp({ env: { ...env, NODE_ENV: "development" }, prisma, logger: false });
    try {
      for (let i = 0; i < 30; i++) expect((await limited.inject({ method: "PUT", url, headers: fixture.headers,
        payload: { version: 1, status: "completed" } })).statusCode).toBe(200);
      expect((await limited.inject({ method: "PUT", url, headers: fixture.headers, payload: { version: 1, status: "skipped" } })).statusCode).toBe(429);
      for (let i = 0; i < 120; i++) expect((await limited.inject({ method: "GET", url, headers: fixture.headers })).statusCode).toBe(200);
      expect((await limited.inject({ method: "GET", url, headers: fixture.headers })).statusCode).toBe(429);
    } finally { await limited.close(); }
  });

  test("existing account deletion billing guard preserves preference; allowed deletion cascades and retains contract", async () => {
    const fixture = await user();
    const password = "synthetic-delete-password";
    await prisma.user.update({ where: { id: fixture.id }, data: { passwordHash: await argon2.hash(password) } });
    await putProductTourState(prisma, fixture.id, "completed");
    const contract = await prisma.serviceSubscriptionContract.create({ data: {
      userId: fixture.id, subjectId: "synthetic-tour-delete", provider: "synthetic", storeId: "synthetic",
      environment: "mock", status: "active"
    } });
    try {
      const blocked = await app.inject({ method: "DELETE", url: "/living-cost-manager/v1/account", headers: fixture.headers, payload: { password } });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().code).toBe("BillingAccountDeleteBlocked");
      expect(await prisma.userProductTourState.count({ where: { userId: fixture.id } })).toBe(1);
      await prisma.serviceSubscriptionContract.update({ where: { id: contract.id }, data: { status: "idle" } });
      const deleted = await app.inject({ method: "DELETE", url: "/living-cost-manager/v1/account", headers: fixture.headers, payload: { password } });
      expect(deleted.statusCode).toBe(204);
      expect(await prisma.userProductTourState.count({ where: { userId: fixture.id } })).toBe(0);
      expect((await prisma.serviceSubscriptionContract.findUnique({ where: { id: contract.id } }))?.userId).toBeNull();
      expect((await app.inject({ method: "GET", url, headers: fixture.headers })).statusCode).toBe(401);
    } finally { await prisma.serviceSubscriptionContract.delete({ where: { id: contract.id } }); }
  });

  test("default request serializers never log preference body, email or bearer tokens", async () => {
    const fixture = await user();
    const lines: string[] = [];
    const loggerHost = Fastify({ logger: { stream: { write: (line: string) => { lines.push(line); } } } });
    const logged = await buildApp({ env: { ...env, NODE_ENV: "development" }, prisma, logger: loggerHost.log });
    try {
      expect((await logged.inject({ method: "PUT", url, headers: fixture.headers, payload: { version: 1, status: "completed" } })).statusCode).toBe(200);
      expect((await logged.inject({ method: "GET", url, headers: fixture.headers })).statusCode).toBe(200);
      const text = lines.join("");
      expect(text).toContain("incoming request");
      for (const secret of [fixture.accessToken, fixture.email, fixture.id, '"completed"', '"authorization"']) expect(text).not.toContain(secret);
    } finally { await logged.close(); await loggerHost.close(); }
  });
});
