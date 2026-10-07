import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const prefix = `workspace-limit-test-${crypto.randomUUID()}-`;
// The existing NODE_ENV=test allowList disables limiters. Dedicated development
// apps enable real plugin limits without touching production config or trust.
async function gated() {
  return buildApp({ prisma, logger: false, env: loadEnv({ NODE_ENV: "development", TRUST_PROXY: "off", DATABASE_URL: databaseUrl, JWT_SECRET: "workspace-limit-synthetic-test-secret-32" }) });
}
async function user(verified = true) {
  return prisma.user.create({ data: { email: `${prefix}${crypto.randomUUID()}@example.com`, name: "Synthetic account", passwordHash: "unused", emailVerifiedAt: verified ? new Date() : null } });
}
async function ledger(userId: string) {
  return prisma.workspace.create({ data: { name: "Limit fixture", members: { create: { userId, role: "owner" } } } });
}
afterEach(async () => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => prisma.$disconnect());

describe("non-test workspace quotas with TRUST_PROXY=off and a shared peer", () => {
  test("creation quota belongs to a verified account, not the peer or spoofable headers", async () => {
    const app = await gated();
    try {
      const a = await user(); const b = await user();
      const token = app.signTokens(a).accessToken;
      for (let i = 0; i < 20; i++) {
        expect((await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: `Ledger ${i}` } })).statusCode).toBe(i === 0 ? 201 : 403);
      }
      const denied = await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${app.signTokens(a).accessToken}`, "x-forwarded-for": "203.0.113.21", "x-user-id": b.id }, payload: { name: "Over quota" } });
      expect(denied.statusCode).toBe(429);
      expect(denied.body).not.toContain(a.id);
      expect(denied.body).not.toContain("workspaces:account:");
      expect((await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${app.signTokens(b).accessToken}` }, payload: { name: "Independent" } })).statusCode).toBe(201);
      expect(await prisma.workspaceMember.count({ where: { userId: a.id } })).toBe(1);
    } finally { await app.close(); }
  });
  test("aggregate quota is account-local across tokens, despite a shared peer", async () => {
    const app = await gated();
    try {
      const a = await user(); const b = await user();
      const first = await ledger(a.id); const second = await ledger(b.id);
      for (let i = 0; i < 60; i++) expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: { authorization: `Bearer ${app.signTokens(a).accessToken}` }, payload: { workspaceIds: [first.id] } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: { authorization: `Bearer ${app.signTokens(a).accessToken}`, "x-forwarded-for": "203.0.113.22" }, payload: { workspaceIds: [first.id] } })).statusCode).toBe(429);
      expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: { authorization: `Bearer ${app.signTokens(b).accessToken}` }, payload: { workspaceIds: [second.id] } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  test("unverified email and invalid signatures do not poison the verified creation quota", async () => {
    const app = await gated();
    try {
      const a = await user(false); const token = app.signTokens(a).accessToken;
      for (let i = 0; i < 30; i++) {
        expect((await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "Unverified" } })).statusCode).toBe(403);
        expect((await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${token.slice(0, -5)}WRONG` }, payload: { name: "Bad JWT" } })).statusCode).toBe(401);
      }
      await prisma.user.update({ where: { id: a.id }, data: { emailVerifiedAt: new Date() } });
      for (let i = 0; i < 20; i++) expect((await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "Verified" } })).statusCode).toBe(i === 0 ? 201 : 403);
      expect((await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "Limited" } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  test("revoked and garbage tokens cannot consume an authenticated aggregation quota", async () => {
    const app = await gated();
    try {
      const a = await user(); const row = await ledger(a.id); const old = app.signTokens(a).accessToken;
      await prisma.user.update({ where: { id: a.id }, data: { tokenVersion: 1 } });
      for (let i = 0; i < 80; i++) expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: { authorization: `Bearer ${i % 2 ? old : "garbage.token.here"}` }, payload: { workspaceIds: [row.id] } })).statusCode).toBe(401);
      const current = app.signTokens({ id: a.id, tokenVersion: 1 }).accessToken;
      for (let i = 0; i < 60; i++) expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: { authorization: `Bearer ${current}` }, payload: { workspaceIds: [row.id] } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: { authorization: `Bearer ${current}` }, payload: { workspaceIds: [row.id] } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  test("coarse pre-auth backstop bounds DB work across routes, spoofed claims and headers", async () => {
    const app = await gated(); const a = await user(); const revoked = app.signTokens(a).accessToken;
    await prisma.user.update({ where: { id: a.id }, data: { tokenVersion: 1 } });
    const lookup = vi.spyOn(prisma.user, "findUnique");
    try {
      for (let i = 0; i < 1200; i++) {
        const headers = { "x-forwarded-for": `203.0.113.${i % 255}`, "x-user-id": `fake-${i}`,
          ...(i % 3 === 0 ? { authorization: `Bearer ${revoked}` } : i % 3 === 1 ? { authorization: `Bearer garbage-${i}.token.here` } : {}) };
        const response = await app.inject({ method: "POST", url: i % 2 ? "/workspaces" : "/workspaces/aggregate", headers, payload: {} });
        expect(response.statusCode).toBe(401);
      }
      expect(lookup).toHaveBeenCalledTimes(400);
      for (const url of ["/workspaces", "/workspaces/aggregate"]) {
        const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${app.signTokens({ id: a.id, tokenVersion: 1 }).accessToken}`, "x-forwarded-for": "198.51.100.99" }, payload: {} });
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBeDefined();
        expect(response.body).not.toContain(a.id);
      }
      expect(lookup).toHaveBeenCalledTimes(400);
    } finally { lookup.mockRestore(); await app.close(); }
  }, 30_000);
});
