import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspaceRequestSchema } from "@living-cost-manager/shared";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { createUserWorkspace, aggregateUserWorkspaces } from "../src/services/workspaces.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prefix = `multiledger-test-${crypto.randomUUID()}-`;
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = await buildApp({ prisma, env: loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "multiledger-test-secret-at-least-32-characters" }) });
const budget = { monthlyIncome: 3000000, categories: [{ id: "housing", label: "Housing" }], cards: [], fixedCosts: [{
  id: "rent", name: "Rent", categoryId: "housing", paymentMethodId: "cash", paymentOptionId: "",
  amount: 900000, periodMonths: 3, billingDay: 31, isEndOfMonth: false, billingAnchorDate: "2026-01-31",
}] };
async function user(verified = true) {
  const row = await prisma.user.create({ data: { email: `${prefix}${crypto.randomUUID()}@example.com`, name: "Account", passwordHash: "unused", emailVerifiedAt: verified ? new Date() : null } });
  return { row, headers: { authorization: `Bearer ${app.signTokens(row).accessToken}` } };
}
async function create(headers: { authorization: string }, name = "Personal") {
  return app.inject({ method: "POST", url: "/workspaces", headers, payload: { name, initialBudget: budget } });
}
afterEach(async () => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe("multi-ledger workspace API", () => {
  test("verified account creates multiple independent ledgers atomically with initial version and backup", async () => {
    const owner = await user();
    const first = await create(owner.headers);
    const second = await create(owner.headers, "Family");
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
    const body = first.json(); const other = second.json();
    expect(body.workspace).toMatchObject({ name: "Personal", role: "owner" });
    expect(body.snapshot).toMatchObject({ workspaceId: body.workspace.id, syncVersion: 0, monthlyIncome: 3000000 });
    expect(body.snapshot.fixedCosts[0].workspaceId).toBe(body.workspace.id);
    expect(other.workspace.id).not.toBe(body.workspace.id);
    expect(await prisma.backupSnapshot.count({ where: { workspaceId: body.workspace.id } })).toBe(1);
    expect((await app.inject({ method: "GET", url: "/workspaces", headers: owner.headers })).json()).toHaveLength(2);
    const aggregate = await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: owner.headers, payload: { workspaceIds: [other.workspace.id, body.workspace.id, body.workspace.id] } });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json().workspaces.map((w: { id: string }) => w.id)).toEqual([other.workspace.id, body.workspace.id]);
    expect(aggregate.json().totals.monthlyNormalizedExpense).toBe(600000);
    expect(aggregate.json().workspaces.map((w: { monthlyIncome: number }) => w.monthlyIncome)).toEqual([3000000, 3000000]);
    expect(aggregate.json().totals).not.toHaveProperty("monthlyIncome");
    expect(JSON.stringify(aggregate.json())).not.toMatch(/email|passwordHash|categoryId|Rent/);
  });
  test("authentication, verification and strict payload validation prevent identity overrides", async () => {
    expect((await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Test" } })).statusCode).toBe(401);
    const unverified = await user(false);
    expect((await create(unverified.headers)).json().code).toBe("EMAIL_NOT_VERIFIED");
    const owner = await user();
    for (const payload of [{ name: "Test", userId: unverified.row.id }, { name: " " }, { name: "Test", initialBudget: { ...budget, fixedCosts: [{ ...budget.fixedCosts[0], workspaceId: "victim" }] } }, { name: "Test", initialBudget: { ...budget, categories: [] } }]) {
      expect((await app.inject({ method: "POST", url: "/workspaces", headers: owner.headers, payload })).statusCode).toBe(400);
    }
    expect(await prisma.workspaceMember.count({ where: { userId: owner.row.id } })).toBe(0);
  });
  test("owner-only rename; editor/viewer aggregation; unauthorized/missing/revoked selection fails whole", async () => {
    const owner = await user(); const editor = await user(); const viewer = await user(); const stranger = await user();
    const body = (await create(owner.headers)).json(); const id = body.workspace.id;
    for (const [member, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
      await prisma.workspaceMember.create({ data: { workspaceId: id, userId: member.row.id, role } });
      expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: member.headers, payload: { workspaceIds: [id] } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PATCH", url: `/workspaces/${id}`, headers: member.headers, payload: { name: "Hijack" } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "PATCH", url: `/workspaces/${id}`, headers: owner.headers, payload: { name: " New name " } })).json().name).toBe("New name");
    const own = (await create(viewer.headers, "Viewer personal")).json().workspace.id;
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: id, userId: viewer.row.id } } });
    for (const [headers, ids] of [[viewer.headers, [own, id]], [owner.headers, [id, "missing"]], [stranger.headers, [id]]] as const) {
      const response = await app.inject({ method: "POST", url: "/workspaces/aggregate", headers, payload: { workspaceIds: ids } });
      expect(response.statusCode).toBe(403); expect(response.json()).not.toHaveProperty("workspaces");
      expect(response.body).not.toContain("New name");
    }
  });
  test("late initialization failure rolls back workspace, membership, financial rows and backup", async () => {
    const owner = await user();
    const failing = prisma.$extends({ query: { backupSnapshot: { create: async () => { throw new Error("synthetic backup failure"); } } } });
    const before = await prisma.workspace.count();
    await expect(createUserWorkspace(failing as unknown as PrismaClient, owner.row.id, createWorkspaceRequestSchema.parse({ name: "Rollback", initialBudget: budget }))).rejects.toThrow("synthetic backup failure");
    expect(await prisma.workspace.count()).toBe(before);
    expect(await prisma.workspaceMember.count({ where: { userId: owner.row.id } })).toBe(0);
    expect(await prisma.workspace.count({ where: { name: "Rollback" } })).toBe(0);
  });
  test("empty ledgers produce zero; all unknown schedules produce null; selection is bounded", async () => {
    const owner = await user();
    const empty = (await app.inject({ method: "POST", url: "/workspaces", headers: owner.headers, payload: { name: "Empty" } })).json().workspace.id;
    expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: owner.headers, payload: { workspaceIds: [empty] } })).json().totals).toMatchObject({ thirtyDayDue: 0, fixedCostCount: 0 });
    const unknown = (await app.inject({ method: "POST", url: "/workspaces", headers: owner.headers, payload: { name: "Unknown", initialBudget: { ...budget, fixedCosts: [{ ...budget.fixedCosts[0], billingAnchorDate: null, periodMonths: 0.5 }] } } })).json().workspace.id;
    const response = await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: owner.headers, payload: { workspaceIds: [unknown] } });
    expect(response.json().totals).toMatchObject({ thirtyDayDue: null, unknownScheduleCount: 1, monthlyNormalizedExpense: 1800000 });
    for (const workspaceIds of [[], Array(21).fill(unknown)]) expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: owner.headers, payload: { workspaceIds } })).statusCode).toBe(400);
  });
  test("all memberships are checked before financial reads with a repeatable-read transaction", async () => {
    const findMany = vi.fn();
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      workspaceMember: { findMany: async () => [{ workspaceId: "allowed", role: "owner" }] },
      workspace: { findMany },
    }));
    await expect(aggregateUserWorkspaces({ $transaction: transaction } as unknown as PrismaClient, "account", { workspaceIds: ["allowed", "revoked"] })).rejects.toThrow("Forbidden");
    expect(findMany).not.toHaveBeenCalled();
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: "RepeatableRead" });
  });
  test("membership and finances stay on one snapshot during concurrent committed changes", async () => {
    const owner = await user(); const viewer = await user();
    const id = (await create(owner.headers)).json().workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId: id, userId: viewer.row.id, role: "viewer" } });
    let mutated = false;
    const racing = prisma.$extends({ query: { workspaceMember: { findMany: async ({ args, query }) => {
      const rows = await query(args);
      if (!mutated) {
        mutated = true;
        await prisma.$transaction([
          prisma.workspace.update({ where: { id }, data: { monthlyIncome: 1, syncVersion: { increment: 1 } } }),
          prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: id, userId: viewer.row.id } } }),
        ]);
      }
      return rows;
    } } } });
    const snapshot = await aggregateUserWorkspaces(racing as unknown as PrismaClient, viewer.row.id, { workspaceIds: [id] }, new Date("2026-10-07T00:00:00Z"));
    expect(mutated).toBe(true);
    expect(snapshot.workspaces[0]).toMatchObject({ role: "viewer", syncVersion: 0, monthlyIncome: 3000000 });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id } })).syncVersion).toBe(1);
    await expect(aggregateUserWorkspaces(prisma, viewer.row.id, { workspaceIds: [id] })).rejects.toThrow("Forbidden");
  });
  test("rename maps an injected Prisma serialization conflict to 409 without changing name", async () => {
    const owner = await user();
    const id = (await create(owner.headers)).json().workspace.id;
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Synthetic serialization conflict", { code: "P2034", clientVersion: Prisma.prismaVersion.client }));
    try {
      const response = await app.inject({ method: "PATCH", url: `/workspaces/${id}`, headers: owner.headers, payload: { name: "Should not persist" } });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe("Concurrent membership change, please retry");
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id } })).name).toBe("Personal");
    } finally { transaction.mockRestore(); }
  });
});
