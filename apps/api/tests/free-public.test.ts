import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { TEMPLATE_SCENARIOS, createWorkspaceRequestSchema } from "@living-cost-manager/shared";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { PaidFeaturePolicy } from "../src/services/paid-feature-policy.js";
import { createUserWorkspace, aggregateUserWorkspaces } from "../src/services/workspaces.js";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { parseBillingConfiguration } from "../src/services/service-billing-config.js";
import { runBillingWorker } from "../src/services/service-billing-worker.js";
import { syntheticApprovedConfiguration, FakePortOneHttp } from "./service-billing-portone-fixtures.js";
import { cleanupAuthTestRecords, resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const prefix = `free-public-test-${randomUUID()}-`;
const base = { NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: "free-public-synthetic-secret-at-least-32" };
const app = await buildApp({ prisma, env: loadEnv(base), logger: false });
async function user() {
  const row = await prisma.user.create({ data: { email: `${prefix}${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: "unused", emailVerifiedAt: new Date() } });
  return { row, headers: { authorization: `Bearer ${app.signTokens(row).accessToken}` } };
}
async function create(headers: { authorization: string }, name = "Synthetic free ledger", initialBudget?: unknown) {
  return app.inject({ method: "POST", url: "/workspaces", headers, payload: { name, ...(initialBudget ? { initialBudget } : {}) } });
}
afterEach(async () => cleanupAuthTestRecords(prisma, prefix));
afterAll(async () => { await app.close(); await prisma.$disconnect(); });

describe("FREE_PUBLIC is the real server default", () => {
  test("publication flag accepts only exact strings, defaults dark, not yes/1/boolean", () => {
    expect(loadEnv(base).SERVICE_PAID_FEATURES_PUBLISHED).toBe("false");
    for (const value of ["yes", "1", "TRUE", " true ", true, 1]) expect(() => loadEnv({ ...base, SERVICE_PAID_FEATURES_PUBLISHED: value })).toThrow();
  });
  test.each(["false", "true"])("production flag %s with no approved commercial configuration registers no billing routes", async flag => {
    const server = await buildApp({ prisma: {} as PrismaClient, logger: false,
      env: loadEnv({ ...base, NODE_ENV: "production", API_BASE_PATH: "/living-cost-manager/v1", SERVICE_PAID_FEATURES_PUBLISHED: flag }) });
    try {
      for (const path of ["readiness", "subscription", "quotes", "instruments/prepare", "instruments/unknown/confirm", "charges", "attempts/unknown", "subscription/cancel", "mock/renew", "webhooks/portone", "callback", "unknown"]) {
        for (const method of ["GET", "POST"] as const) expect((await server.inject({ method, url: `/living-cost-manager/v1/service-billing/${path}` })).statusCode).toBe(404);
      }
      expect(server.hasDecorator("serviceBilling")).toBe(false);
      const health = (await server.inject({ method: "GET", url: "/living-cost-manager/v1/health" })).json();
      expect(Object.keys(health).sort()).toEqual(["commitSha", "ok", "releaseId"]);
    } finally { await server.close(); }
  });
  test("dark mock startup without encryption key boots without constructing billing provider", async () => {
    const server = await buildApp({ prisma, logger: false, env: loadEnv({ ...base, SERVICE_BILLING_MODE: "mock", SERVICE_BILLING_MOCK_ENABLED: "true" }) });
    try { expect((await server.inject({ url: "/health" })).statusCode).toBe(200); expect(server.hasDecorator("serviceBilling")).toBe(false); }
    finally { await server.close(); }
  });
  test("production publication flag alone still enforces free account quota and aggregate denial", async () => {
    const owner = await user();
    const server = await buildApp({ prisma, logger: false, env: loadEnv({ ...base, NODE_ENV: "production", SERVICE_PAID_FEATURES_PUBLISHED: "true" }) });
    const headers = { authorization: `Bearer ${server.signTokens(owner.row).accessToken}` };
    try {
      const first = await server.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "First free" } });
      expect(first.statusCode).toBe(201);
      expect((await server.inject({ method: "POST", url: "/workspaces", headers, payload: { name: "Unpaid second" } })).json().code).toBe("FREE_WORKSPACE_LIMIT");
      expect((await server.inject({ method: "POST", url: "/workspaces/aggregate", headers, payload: { workspaceIds: [first.json().workspace.id] } })).json().code).toBe("FEATURE_NOT_AVAILABLE");
    } finally { await server.close(); }
  });
  test("concurrent creates serialize under User lock: one 201, one stable free 403, one snapshot", async () => {
    const owner = await user();
    const transaction = vi.spyOn(prisma, "$transaction");
    let responses;
    try {
      responses = await Promise.all([create(owner.headers), create(owner.headers)]);
      expect(transaction).toHaveBeenCalledTimes(2);
      for (const call of transaction.mock.calls) expect(call[1]).toEqual({ isolationLevel: "ReadCommitted" });
    } finally { transaction.mockRestore(); }
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 403]);
    expect(responses.find(r => r.statusCode === 403)!.json()).toMatchObject({ statusCode: 403, code: "FREE_WORKSPACE_LIMIT", message: "FREE_WORKSPACE_LIMIT" });
    const members = await prisma.workspaceMember.findMany({ where: { userId: owner.row.id, role: "owner" } });
    expect(members).toHaveLength(1);
    expect(await prisma.backupSnapshot.count({ where: { workspaceId: members[0].workspaceId } })).toBe(1);
  });
  test.each(["viewer", "editor"] as const)("a shared %s membership does not consume the first owned ledger", async role => {
    const owner = await user(); const invited = await user();
    const id = (await create(owner.headers)).json().workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId: id, userId: invited.row.id, role } });
    expect((await create(invited.headers)).statusCode).toBe(201);
    expect((await create(invited.headers)).json().code).toBe("FREE_WORKSPACE_LIMIT");
    expect((await app.inject({ url: "/workspaces", headers: invited.headers })).json()).toHaveLength(2);
    expect((await app.inject({ url: `/workspaces/${id}/snapshot`, headers: invited.headers })).statusCode).toBe(200);
  });
  test("existing multiple owned ledgers remain list/read/rename/write/exportable; only new creation and aggregate are denied", async () => {
    const owner = await user(); const stranger = await user();
    const ids: string[] = [];
    for (const name of ["Existing A", "Existing B"]) ids.push((await prisma.workspace.create({ data: { name, monthlyIncome: 1234, members: { create: { userId: owner.row.id, role: "owner" } } } })).id);
    expect((await app.inject({ url: "/workspaces", headers: owner.headers })).json()).toHaveLength(2);
    for (const id of ids) {
      const snapshot = await app.inject({ url: `/workspaces/${id}/snapshot`, headers: owner.headers });
      expect(snapshot.statusCode).toBe(200); expect(snapshot.json().monthlyIncome).toBe(1234);
      expect((await app.inject({ method: "PATCH", url: `/workspaces/${id}`, headers: owner.headers, payload: { name: "Preserved" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: `/workspaces/${id}/snapshot`, headers: owner.headers, payload: { ...snapshot.json(), monthlyIncome: 5678 } })).statusCode).toBe(200);
      expect((await app.inject({ url: `/workspaces/${id}/snapshot/history`, headers: owner.headers })).statusCode).toBe(200);
      expect((await app.inject({ url: `/workspaces/${id}/snapshot`, headers: stranger.headers })).statusCode).toBe(403);
    }
    expect((await create(owner.headers)).json().code).toBe("FREE_WORKSPACE_LIMIT");
    for (const workspaceIds of [[ids[0]], ids]) expect((await app.inject({ method: "POST", url: "/workspaces/aggregate", headers: owner.headers, payload: { workspaceIds } })).json().code).toBe("FEATURE_NOT_AVAILABLE");
    expect(await prisma.workspaceMember.count({ where: { userId: owner.row.id, role: "owner" } })).toBe(2);
  });
  test("template-initialized workspace uses the same atomic gate, does not overwrite an existing ledger or template", async () => {
    const owner = await user();
    const template = await app.inject({ method: "POST", url: "/templates", headers: owner.headers, payload: { blueprint: TEMPLATE_SCENARIOS[0] } });
    expect(template.statusCode).toBe(201);
    const saved = await prisma.budgetTemplate.findUniqueOrThrow({ where: { id: template.json().id } });
    const budget = { monthlyIncome: 321, categories: [{ id: "synthetic-category", label: "Synthetic" }], cards: [], fixedCosts: [] };
    const outcomes = await Promise.all([create(owner.headers, "Normal creation"), create(owner.headers, "Template initialized", budget)]);
    expect(outcomes.map(r => r.statusCode).sort()).toEqual([201, 403]);
    expect(await prisma.budgetTemplate.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(saved);
    const before = (await app.inject({ url: `/workspaces/${outcomes.find(r => r.statusCode === 201)!.json().workspace.id}/snapshot`, headers: owner.headers })).body;
    expect((await create(owner.headers, "Denied template", budget)).json().code).toBe("FREE_WORKSPACE_LIMIT");
    expect((await app.inject({ url: `/workspaces/${outcomes.find(r => r.statusCode === 201)!.json().workspace.id}/snapshot`, headers: owner.headers })).body).toBe(before);
  });
  test("direct service calls are gated without app/UI and missing user is 401 without a workspace write", async () => {
    const owner = await user();
    await createUserWorkspace(prisma, owner.row.id, createWorkspaceRequestSchema.parse({ name: "Direct first" }));
    await expect(createUserWorkspace(prisma, owner.row.id, createWorkspaceRequestSchema.parse({ name: "Direct second" }))).rejects.toMatchObject({ code: "FREE_WORKSPACE_LIMIT" });
    await expect(aggregateUserWorkspaces(prisma, owner.row.id, { workspaceIds: ["anything"] })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    await expect(createUserWorkspace(prisma, "missing-synthetic-user", createWorkspaceRequestSchema.parse({ name: "Missing" }))).rejects.toMatchObject({ statusCode: 401 });
  });
  test("the explicit legacy fixture cannot be enabled in production/development", async () => {
    for (const NODE_ENV of ["production", "development"]) {
      await expect(buildApp({ prisma, logger: false, env: loadEnv({ ...base, NODE_ENV }), testPaidFeatureAccess: true })).rejects.toThrow("restricted to tests");
      expect(() => new PaidFeaturePolicy(loadEnv({ ...base, NODE_ENV }), true)).toThrow("restricted to tests");
    }
  });
  test("publication alone and sandbox never grant additional ledgers; authoritative coverage query is scoped LIVE", async () => {
    const { env } = syntheticApprovedConfiguration(databaseUrl, "live");
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = { servicePaidPeriod: { findFirst } } as unknown as Parameters<PaidFeaturePolicy["hasPaidAccess"]>[0];
    expect(await new PaidFeaturePolicy(loadEnv({ ...base, SERVICE_PAID_FEATURES_PUBLISHED: "true" })).hasPaidAccess(tx, "synthetic-user")).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
    expect(await new PaidFeaturePolicy({ ...env, SERVICE_BILLING_MODE: "sandbox" }).hasPaidAccess(tx, "synthetic-user")).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
    const policy = new PaidFeaturePolicy(env);
    expect(await policy.hasPaidAccess(tx, "synthetic-user")).toBe(false);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ environment: "live", contract: { userId: "synthetic-user", storeId: "synthetic-lcm-store" }, attempt: { status: "paid", reviewRequired: false, quote: { premiumScope: "account-subscription-v1", channelId: "synthetic-lcm-channel" } } });
    findFirst.mockResolvedValue({ id: "synthetic-current-coverage" });
    expect(await policy.hasPaidAccess(tx, "synthetic-user")).toBe(true);
  });
  test("dark billing refuses issue/charge/renew/refund dispatch and CLI before DB/provider requests", async () => {
    const { env, manifest, secret } = syntheticApprovedConfiguration(databaseUrl, "live");
    const dark = { ...env, SERVICE_PAID_FEATURES_PUBLISHED: "false" as const };
    const fake = new FakePortOneHttp(manifest, () => new Date());
    const provider = fake.provider([secret]);
    const service = new ServiceBillingService({} as PrismaClient, dark, () => new Date(), provider);
    expect(Object.values(parseBillingConfiguration(dark).capabilities)).toEqual([false, false, false, false, false]);
    expect(service.readiness().checkoutEnabled).toBe(false);
    for (const operation of [() => service.createQuote("synthetic-user", "monthly"), () => service.prepare("synthetic-user", "synthetic-quote"),
      () => service.charge("synthetic-user", {} as never), () => service.renew("synthetic-user"),
      () => service.cancel("synthetic-user"),
      () => service.renewOnce(), () => service.revokeInstrument("synthetic-user", "synthetic-instrument")]) {
      await expect(operation()).rejects.toMatchObject({ code: "SERVICE_BILLING_NOT_READY" });
    }
    await expect(service.approveAndExecuteRefund("synthetic-refund", "synthetic-operation", "policy-v1")).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", statusCode: 403 });
    for (const job of ["renew", "refund"] as const) await expect(runBillingWorker(dark, job)).rejects.toThrow("approval/capability required");
    expect(fake.calls).toHaveLength(0);
  });
});
