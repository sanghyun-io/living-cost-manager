import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createDefaultWorkspacePlanningData } from "@living-cost-manager/shared";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const prefix = "auth-test-planning-";
const app = await buildApp({ prisma, env: loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "synthetic-planning-secret-at-least-32-characters" }) });
beforeAll(() => prisma.$connect());
afterEach(() => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => { await app.close(); await prisma.$disconnect(); });
async function fixture(role: "owner" | "editor" | "viewer" = "owner") {
  const user = await prisma.user.create({ data: { email: `${prefix}${crypto.randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: "unused", emailVerifiedAt: new Date() } });
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic", monthlyIncome: 1000000, members: { create: { userId: user.id, role } } } });
  return { user, workspace, headers: { authorization: `Bearer ${app.signTokens(user).accessToken}` }, url: `/workspaces/${workspace.id}/planning` };
}
const data = () => ({ ...createDefaultWorkspacePlanningData(), weekStartDay: 7, weeks: [{ weekStart: "2026-10-18", budgetAmount: 0, spentAmount: 0, recordedAt: "2026-10-18T12:00:00.000Z" }], reserves: [{ id: "reserve-1", costId: "orphan", savedAmount: 0, targetAmount: 10000, targetDueDate: null, recordedAt: "2026-10-18T12:00:00.000Z", costLabel: "Synthetic reserve" }] });
const payload = (expectedRevision = 0, expectedSnapshotVersion = 0) => ({ expectedRevision, expectedSnapshotVersion, data: data() });
test("GET requires auth, never creates defaults; no-store and explicit version", async () => {
  const f = await fixture();
  expect((await app.inject({ method: "GET", url: f.url })).statusCode).toBe(401);
  const r = await app.inject({ method: "GET", url: f.url, headers: f.headers });
  expect(r.json()).toEqual({ workspaceId: f.workspace.id, revision: 0, currentSnapshotVersion: 0, data: createDefaultWorkspacePlanningData() });
  expect(r.json().data.weekStartDay).toBe(1);
  expect(r.headers["cache-control"]).toBe("private, no-store");
  expect(await prisma.workspacePlanningState.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});
test.each(["owner", "editor"] as const)("verified %s saves shared state and full archive without snapshot version mutation", async role => {
  const f = await fixture(role);
  const before = await prisma.workspace.findUnique({ where: { id: f.workspace.id } });
  const r = await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ workspaceId: f.workspace.id, revision: 1, currentSnapshotVersion: 0, data: data() });
  expect(r.headers["cache-control"]).toBe("private, no-store");
  expect(await prisma.workspace.findUnique({ where: { id: f.workspace.id } })).toEqual(before);
  const backups = await prisma.backupSnapshot.findMany({ where: { workspaceId: f.workspace.id } });
  expect(backups).toHaveLength(1);
  expect(backups[0]?.payload).toMatchObject({ monthlyIncome: 1000000, syncVersion: 0, categories: [], cards: [], fixedCosts: [], planning: { revision: 1, data: data() } });
});
test("viewer reads same financial state but cannot write; unverified write rejected", async () => {
  const f = await fixture(); const viewer = await fixture("viewer");
  await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: viewer.user.id, role: "viewer" } });
  await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  expect((await app.inject({ method: "GET", url: f.url, headers: viewer.headers })).json().data).toEqual(data());
  expect((await app.inject({ method: "PUT", url: f.url, headers: viewer.headers, payload: payload(1) })).statusCode).toBe(403);
  await prisma.user.update({ where: { id: f.user.id }, data: { emailVerifiedAt: null } });
  const r = await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(1) });
  expect(r.statusCode).toBe(403); expect(r.json().code).toBe("EMAIL_NOT_VERIFIED");
});
test("outsiders, missing workspace, revoked membership and invalidated token fail closed", async () => {
  const a = await fixture(); const b = await fixture();
  for (const url of [a.url, "/workspaces/missing/planning"]) for (const method of ["GET", "PUT"] as const) {
    expect((await app.inject({ method, url, headers: b.headers, payload: method === "PUT" ? payload() : undefined })).statusCode).toBe(403);
  }
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: a.workspace.id, userId: a.user.id } } });
  expect((await app.inject({ method: "PUT", url: a.url, headers: a.headers, payload: payload() })).statusCode).toBe(403);
  await prisma.user.update({ where: { id: b.user.id }, data: { tokenVersion: { increment: 1 } } });
  expect((await app.inject({ method: "GET", url: b.url, headers: b.headers })).statusCode).toBe(401);
});
test("cross-workspace cost IDs are opaque orphans, never query/expose other workspace financials", async () => {
  const a = await fixture(); const b = await fixture();
  const input = payload(); input.data.reserves[0]!.costId = b.workspace.id;
  expect((await app.inject({ method: "PUT", url: a.url, headers: a.headers, payload: input })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: b.url, headers: b.headers })).json().revision).toBe(0);
  expect((await app.inject({ method: "GET", url: a.url, headers: a.headers })).json().data.reserves[0].costId).toBe(b.workspace.id);
});
test("concurrent initial and subsequent CAS writes have one winner and exactly one archive", async () => {
  const f = await fixture();
  for (const revision of [0, 1]) {
    const responses = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(revision) })));
    expect(responses.map(r => [r.statusCode, r.json().message]).filter(([code]) => code !== 200 && code !== 409)).toEqual([]);
    expect(responses.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter(r => r.statusCode === 409)).toHaveLength(4);
  }
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(1) })).statusCode).toBe(409);
  expect(await prisma.backupSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
});
test("old snapshot PUT preserves planning row/revision/orphan, archives both and conflicts stale budget planning", async () => {
  const f = await fixture();
  await prisma.category.create({ data: { workspaceId: f.workspace.id, id: "other", label: "Other" } });
  await prisma.fixedCost.create({ data: { workspaceId: f.workspace.id, id: "orphan", categoryId: "other", name: "Synthetic", paymentMethodId: "bank-transfer", amount: 10000, billingDay: 10 } });
  await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
  const before = await prisma.workspacePlanningState.findUnique({ where: { workspaceId: f.workspace.id } });
  const url = `/workspaces/${f.workspace.id}/snapshot`;
  const snapshot = (await app.inject({ method: "GET", url, headers: f.headers })).json();
  expect(snapshot.planning).toBeUndefined();
  expect((await app.inject({ method: "PUT", url, headers: f.headers, payload: snapshot })).statusCode).toBe(200);
  expect(await prisma.workspacePlanningState.findUnique({ where: { workspaceId: f.workspace.id } })).toEqual(before);
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(1, 0) })).statusCode).toBe(409);
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload(1, 1) })).statusCode).toBe(200);
  const backups = await prisma.backupSnapshot.findMany({ where: { workspaceId: f.workspace.id } });
  expect(backups).toHaveLength(3);
  expect(backups.map(b => b.payload)).toContainEqual({ ...snapshot, syncVersion: 1, planning: { revision: 1, data: data() } });
  expect(JSON.stringify(backups)).not.toMatch(/protectedItems|coachingPreferences|passwordHash/);
  const latestBudget = (await app.inject({ method: "GET", url, headers: f.headers })).json();
  expect((await app.inject({ method: "PUT", url, headers: f.headers, payload: { ...latestBudget, fixedCosts: [] } })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: f.url, headers: f.headers })).json()).toMatchObject({ revision: 2, data: data() });
});
test("concurrent budget and planning writes serialize or return manual conflict; archives remain coherent", async () => {
  const f = await fixture();
  const url = `/workspaces/${f.workspace.id}/snapshot`;
  const snapshot = (await app.inject({ method: "GET", url, headers: f.headers })).json();
  const [budget, plan] = await Promise.all([
    app.inject({ method: "PUT", url, headers: f.headers, payload: { ...snapshot, monthlyIncome: 12345 } }),
    app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() })
  ]);
  expect(budget.statusCode).toBe(200); expect([200, 409]).toContain(plan.statusCode);
  const current = (await app.inject({ method: "GET", url: f.url, headers: f.headers })).json();
  expect(current.currentSnapshotVersion).toBe(1);
  for (const backup of await prisma.backupSnapshot.findMany({ where: { workspaceId: f.workspace.id } })) {
    const p = backup.payload as Record<string, unknown>;
    expect(p.monthlyIncome).toBe(p.syncVersion === 0 ? 1000000 : 12345);
  }
});
test("strict invalid envelopes, query fields and body limit rejected without state", async () => {
  const f = await fixture();
  for (const value of [{ ...payload(), schemaVersion: 1 }, { ...payload(), expectedRevision: -1 }, { ...payload(), data: { ...data(), schemaVersion: 2 } }, { ...payload(), data: { ...data(), weeks: [{ ...data().weeks[0], weekStart: "2026-02-30" }] } }]) {
    expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: value })).statusCode).toBe(400);
  }
  expect((await app.inject({ method: "GET", url: `${f.url}?userId=someone`, headers: f.headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: { ...payload(), oversized: "x".repeat(513 * 1024) } })).statusCode).toBe(413);
  expect(await prisma.workspacePlanningState.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});
test("corrupt/future stored planning fails closed without overwriting or leaking values", async () => {
  const f = await fixture();
  await prisma.workspacePlanningState.create({ data: { workspaceId: f.workspace.id, payloadJson: { schemaVersion: 999, sensitive: "synthetic-private-sentinel" } } });
  for (const method of ["GET", "PUT"] as const) {
    const response = await app.inject({ method, url: f.url, headers: f.headers, payload: method === "PUT" ? payload(1) : undefined });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("sentinel");
  }
  expect(await prisma.backupSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});
test("planning PUT rejects an overflowing week even when it matches the Monday setting", async () => {
  const f = await fixture();
  const input = payload();
  input.data.weekStartDay = 1;
  input.data.weeks[0]!.weekStart = "9999-12-27";
  const response = await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: input });
  expect(response.statusCode).toBe(400);
  expect(response.json().message).toBe("Invalid planning request");
  expect(await prisma.workspacePlanningState.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  expect(await prisma.backupSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});
test.each([{}, { schemaVersion: 999, sensitive: "synthetic-private-sentinel" }])("snapshot PUT maps only corrupt planning storage to safe 503 and rolls back every financial row: %j", async corrupt => {
  const f = await fixture();
  await prisma.category.create({ data: { workspaceId: f.workspace.id, id: "other", label: "Synthetic" } });
  await prisma.fixedCost.create({ data: { workspaceId: f.workspace.id, id: "cost", categoryId: "other", name: "Synthetic cost", paymentMethodId: "bank-transfer", amount: 10000, billingDay: 10 } });
  expect((await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() })).statusCode).toBe(200);
  await prisma.workspacePlanningState.update({ where: { workspaceId: f.workspace.id }, data: { payloadJson: corrupt } });
  const include = { categories: true, cards: true, fixedCosts: true, planningState: true, backups: true } as const;
  const before = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspace.id }, include });
  const url = `/workspaces/${f.workspace.id}/snapshot`;
  const snapshot = (await app.inject({ method: "GET", url, headers: f.headers })).json();
  const response = await app.inject({ method: "PUT", url, headers: f.headers, payload: { ...snapshot, monthlyIncome: 123, categories: [], cards: [], fixedCosts: [] } });
  expect(response.statusCode).toBe(503);
  expect(response.json().message).toBe("Planning unavailable; keep local financial data");
  expect(response.body).not.toMatch(/sentinel|schemaVersion|payloadJson|Prisma|SQL|WorkspacePlanningState/);
  expect(await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspace.id }, include })).toEqual(before);
});
test("archive failure rolls back state, maps safe errors; unrelated unique error is not mislabeled conflict", async () => {
  const f = await fixture();
  // Real SQL failure in backup creation (transaction client interceptor).
  const extended = prisma.$extends({ query: { backupSnapshot: { create() { throw new Error("synthetic SQL private sentinel"); } } } });
  const { putWorkspacePlanning } = await import("../src/services/planning.js");
  await expect(putWorkspacePlanning(extended as unknown as PrismaClient, f.user.id, f.workspace.id, payload())).rejects.toThrow("sentinel");
  expect(await prisma.workspacePlanningState.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Prisma.PrismaClientKnownRequestError("private SQL sentinel", { code: "P2002", clientVersion: "test" }));
  try {
    const r = await app.inject({ method: "PUT", url: f.url, headers: f.headers, payload: payload() });
    expect(r.statusCode).toBe(503); expect(r.body).not.toContain("sentinel");
  } finally { spy.mockRestore(); }
});
