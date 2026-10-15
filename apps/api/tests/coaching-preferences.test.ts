import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const prefix = "auth-test-coaching-";
const app = await buildApp({ prisma, env: loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "synthetic-coaching-secret-at-least-32-characters" }) });
beforeAll(() => prisma.$connect());
afterEach(() => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => { await app.close(); await prisma.$disconnect(); });
async function fixture(role: "owner" | "editor" | "viewer" = "owner") {
  const user = await prisma.user.create({ data: { email: `${prefix}${crypto.randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: "unused", emailVerifiedAt: new Date() } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic", monthlyIncome: 1000000, members: { create: { userId: user.id, role } }, categories: { create: { id: "subscription", label: "구독" } } } });
  await prisma.fixedCost.create({ data: { id: "a", workspaceId: workspace.id, name: "Synthetic", categoryId: "subscription", paymentMethodId: "bank-transfer", amount: 10000, billingDay: 15 } });
  return { user, workspace, headers: { authorization: `Bearer ${app.signTokens(user).accessToken}` }, url: `/workspaces/${workspace.id}/coaching-preferences` };
}
const payload = (expectedRevision = 0, protectedItems = [{ fixedCostId: "a" }]) => ({ schemaVersion: 1, expectedRevision, protectedItems });

test("default GET does not write; valid JWT required and private no-store", async () => {
  const f = await fixture();
  expect((await app.inject({ method: "GET", url: f.url })).statusCode).toBe(401);
  const response = await app.inject({ method: "GET", url: f.url, headers: f.headers });
  expect(response.json()).toEqual({ schemaVersion: 1, revision: 0, protectedItems: [] });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(await prisma.userWorkspaceCoachingPreference.count()).toBe(0);
});
test("workspace isolation and revoked JWT never expose private preferences", async () => {
  const a = await fixture(); const b = await fixture();
  await prisma.workspaceMember.create({ data: { workspaceId: b.workspace.id, userId: a.user.id, role: "editor" } });
  await app.inject({ method: "PUT", url: a.url, headers: a.headers, payload: payload() });
  expect((await app.inject({ method: "GET", url: b.url, headers: a.headers })).json().revision).toBe(0);
  await prisma.user.update({ where: { id: a.user.id }, data: { tokenVersion: { increment: 1 } } });
  for (const method of ["GET", "PUT"] as const) expect((await app.inject({ method, url: a.url, headers: a.headers, payload: method === "PUT" ? payload(1) : undefined })).statusCode).toBe(401);
});
test.each(["P2002", "P2034"])("%s transaction failures become manual 409, never automatic overwrites", async code => {
  const f = await fixture();
  const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Prisma.PrismaClientKnownRequestError("synthetic conflict", { code, clientVersion: "test" }));
  try {
    const response = await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("manually");
  } finally { spy.mockRestore(); }
  expect(await prisma.userWorkspaceCoachingPreference.count()).toBe(0);
});
test.each(["owner", "editor", "viewer"] as const)("%s writes own private preferences without workspace or history mutations", async role => {
  const f = await fixture(role);
  const before = await prisma.workspace.findUnique({ where: { id: f.workspace.id } });
  const response = await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ schemaVersion: 1, revision: 1, protectedItems: [{ fixedCostId: "a" }] });
  expect(await prisma.workspace.findUnique({ where: { id: f.workspace.id } })).toEqual(before);
  expect(await prisma.backupSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  if (role === "viewer") expect((await app.inject({ method: "PUT", url: `/workspaces/${f.workspace.id}/snapshot`, headers: f.headers, payload: {} })).statusCode).toBe(403);
});
test("same-workspace owner cannot target viewer preferences; outsiders and revoked members denied", async () => {
  const a = await fixture(); const b = await fixture("viewer");
  expect((await app.inject({ method: "GET", url: a.url, headers: b.headers })).statusCode).toBe(403);
  await prisma.workspaceMember.create({ data: { workspaceId: a.workspace.id, userId: b.user.id, role: "viewer" } });
  expect((await app.inject({ method: "PUT", url: a.url, headers: b.headers, payload: payload() })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: a.url, headers: a.headers })).json().revision).toBe(0);
  expect((await app.inject({ method: "GET", url: `${a.url}?userId=${b.user.id}`, headers: a.headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "PUT", url: a.url, headers: a.headers, payload: { ...payload(), userId: b.user.id } })).statusCode).toBe(400);
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: a.workspace.id, userId: b.user.id } } });
  expect((await app.inject({ method: "GET", url: a.url, headers: b.headers })).statusCode).toBe(403);
  expect((await app.inject({ method: "PUT", url: a.url, headers: b.headers, payload: payload(1) })).statusCode).toBe(403);
});
test("strict bodies, unknown/outside items rejected without writing", async () => {
  const f = await fixture(); const other = await fixture();
  await prisma.fixedCost.update({ where: { workspaceId_id: { workspaceId: other.workspace.id, id: "a" } }, data: { id: "outside" } });
  for (const body of [payload(0, [{ fixedCostId: "unknown" }]), payload(0, [{ fixedCostId: "outside" }]), payload(0, [{ fixedCostId: "a" }, { fixedCostId: "a" }]), { ...payload(), unknown: true }, { ...payload(), expectedRevision: -1 }, { ...payload(), protectedItems: [{ fixedCostId: "a", reason: "sensitive free text" }] }]) {
    expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: body })).statusCode).toBe(400);
  }
  expect(await prisma.userWorkspaceCoachingPreference.count()).toBe(0);
});
test("CAS stale writes and simultaneous initial/update saves have exactly one winner", async () => {
  const f = await fixture();
  for (const revision of [0, 1]) {
    const responses = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(revision) })));
    expect(responses.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter(r => r.statusCode === 409)).toHaveLength(4);
  }
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(1, []) })).statusCode).toBe(409);
  expect((await app.inject({ method: "GET", url: f.url, headers: f.headers })).json().revision).toBe(2);
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(2, []) })).json().protectedItems).toEqual([]);
});
test("snapshot upload delete/recreate retains private intent; orphan reads stable and public snapshot excludes intent", async () => {
  const f = await fixture();
  await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  const url = `/workspaces/${f.workspace.id}/snapshot`;
  const snapshot = (await app.inject({ method: "GET", url, headers: f.headers })).json();
  expect(JSON.stringify(snapshot)).not.toMatch(/protectedItems|coachingPreferences|essential/);
  const uploaded = await app.inject({ method: "PUT", url, headers: f.headers, payload: snapshot });
  expect(uploaded.statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: f.url, headers: f.headers })).json()).toEqual({ schemaVersion: 1, revision: 1, protectedItems: [{ fixedCostId: "a" }] });
  await prisma.fixedCost.deleteMany({ where: { workspaceId: f.workspace.id } });
  expect((await app.inject({ method: "GET", url: f.url, headers: f.headers })).json().revision).toBe(1);
  expect((await app.inject({ method: "GET", url: f.url, headers: f.headers })).json().protectedItems).toEqual([{ fixedCostId: "a" }]);
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(1) })).statusCode).toBe(400);
  const history = await prisma.backupSnapshot.findMany({ where: { workspaceId: f.workspace.id } });
  expect(JSON.stringify(history)).not.toMatch(/protectedItems|coachingPreferences/);
});
test("database errors do not return empty defaults or leak details; saved state retained", async () => {
  const f = await fixture();
  await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("private SQL synthetic failure"));
  try {
    for (const method of ["GET", "PUT"] as const) {
      const r = await app.inject({ method, url: f.url, headers: f.headers, payload: method === "PUT" ? payload(1, []) : undefined });
      expect(r.statusCode).toBe(503); expect(r.body).not.toContain("private SQL");
    }
  } finally { spy.mockRestore(); }
  expect((await app.inject({ method: "GET", url: f.url, headers: f.headers })).json().protectedItems).toEqual([{ fixedCostId: "a" }]);
});
test("user and workspace deletion cascade only their private containers", async () => {
  const a = await fixture(); const b = await fixture();
  for (const f of [a, b]) await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  await prisma.user.delete({ where: { id: a.user.id } });
  expect(await prisma.userWorkspaceCoachingPreference.count({ where: { userId: a.user.id } })).toBe(0);
  await prisma.workspace.delete({ where: { id: a.workspace.id } });
  expect(await prisma.userWorkspaceCoachingPreference.count({ where: { userId: b.user.id } })).toBe(1);
  await prisma.workspace.delete({ where: { id: b.workspace.id } });
  expect(await prisma.userWorkspaceCoachingPreference.count()).toBe(0);
});
