import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { deleteAccount } from "../src/services/account.js";
import { ServiceBillingService, serviceBillingPeriodBoundary } from "../src/services/service-billing.js";
import { MockServiceBillingProvider } from "../src/services/service-billing-provider.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

// Independent frozen-422 regression gates. No expected-failure conversion: the
// Imported from 167b833 (historical frozen-422 evidence remains untouched).
// One ownership assertion is checked before deletion: after deletion an owned
// API correctly returns 404 and cannot authorize the former account.
const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let now: Date;
let service: ServiceBillingService;
let provider: MockServiceBillingProvider;
let userId: string;
const password = "independent-synthetic-only";
let settings: ReturnType<typeof loadEnv>;
const clock = () => new Date(now);
beforeEach(async () => {
  // Runner supplies a new owned cluster, DB and schema; no shared runtime data.
  now = new Date("2027-01-31T03:00:00.000Z"); // Jan 31 noon KST
  settings = loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl,
    JWT_SECRET: randomBytes(40).toString("base64"), SERVICE_BILLING_MODE: "mock",
    SERVICE_PAID_FEATURES_PUBLISHED: "true", SERVICE_BILLING_MOCK_ENABLED: "true", SERVICE_BILLING_KEY_VERSION: "independent-test-v1",
    SERVICE_BILLING_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
  provider = new MockServiceBillingProvider(clock);
  service = new ServiceBillingService(prisma, settings, clock, provider);
  userId = (await prisma.user.create({ data: { email: `billing-independent-test-${randomUUID()}@example.invalid`,
    name: "Synthetic", passwordHash: await argon2.hash(password), emailVerifiedAt: now } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
async function purchase() {
  const quote = await service.createQuote(userId, "monthly");
  const instrument = await service.prepare(userId, quote.quoteId);
  await service.confirm(userId, instrument.instrumentId, `mock_${instrument.sdkRequest.issueId}`);
  const input = { quoteId: quote.quoteId, instrumentId: instrument.instrumentId, idempotencyKey: randomUUID(),
    consent: { billingVersion: quote.consentVersions.billing, autoRenewVersion: quote.consentVersions.autoRenew, accepted: true as const } };
  return { input, result: await service.charge(userId, input) };
}
describe("independent phase-one financial release gates", () => {
  it("REQUIRED FIX: Jan31 first renewal on Apr15 must reject expired Feb28-Mar31 cycle before dispatch", async () => {
    const { result } = await purchase();
    expect(result.paidPeriod!.endsAt).toBe("2027-02-27T15:00:00.000Z");
    now = new Date("2027-04-14T15:00:00.000Z"); // Apr15 midnight KST
    const outcome = await service.renewMock(userId).then(value => ({ value }), error => ({ error }));
    const contract = await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } });
    const attempts = await prisma.servicePaymentAttempt.findMany({ where: { contractId: contract.id }, include: { period: true } });
    // Report factual reproduction without provider IDs, keys, JWTs or customers.
    console.log(JSON.stringify({ synthetic: true, regression: "expired-renewal", dispatches: provider.dispatchCount,
      cycles: attempts.map(a => ({ cycle: a.cycle, amount: a.totalAmount, start: a.period?.startsAt, end: a.period?.endsAt })), now }));
    expect(provider.dispatchCount, "must not charge historical expired coverage").toBe(1);
    expect("error" in outcome).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(contract.originalAnchor?.toISOString()).toBe("2027-01-31T03:00:00.000Z");
  });
  it("REQUIRED FIX: verified cancellation replay must not call provider or demote verified and block deletion", async () => {
    await purchase();
    expect((await service.cancel(userId)).providerCancellationStatus).toBe("verified");
    let calls = 0;
    provider.cancelSchedule = async () => { calls++; throw new Error("Synthetic replay outage"); };
    const replay = await service.cancel(userId);
    const deleted = await deleteAccount(prisma, userId, password).then(() => true, () => false);
    console.log(JSON.stringify({ synthetic: true, regression: "cancel-replay", calls, status: replay.providerCancellationStatus, deleted }));
    expect(replay.providerCancellationStatus).toBe("verified");
    expect(calls).toBe(0);
    expect(deleted).toBe(true);
  });
  it("REQUIRED FIX: verified refund replay must not re-cancel or demote verified cancellation", async () => {
    const { result } = await purchase();
    const r = await service.requestRefund(userId, result.attemptId, randomUUID(), "other");
    await service.executeMockRefund(userId, r.requestId);
    expect((await service.subscription(userId)).providerCancellationStatus).toBe("verified");
    let calls = 0;
    provider.cancelSchedule = async () => { calls++; throw new Error("Synthetic replay outage"); };
    await service.executeMockRefund(userId, r.requestId);
    const replay = await service.subscription(userId);
    expect((await service.refundDto(userId, r.requestId)).status).toBe("verified");
    const deleted = await deleteAccount(prisma, userId, password).then(() => true, () => false);
    console.log(JSON.stringify({ synthetic: true, regression: "refund-replay", calls, status: replay.providerCancellationStatus, deleted }));
    expect(replay.providerCancellationStatus).toBe("verified");
    expect(calls).toBe(0);
    expect(deleted).toBe(true);
  });
  it("fresh mock process losing a paid observation cannot redispatch an unknown attempt", async () => {
    const original = provider.charge.bind(provider);
    provider.charge = async input => { await original(input); throw new Error("Synthetic lost response"); };
    provider.getPayment = async () => null;
    const { input, result } = await purchase();
    expect(result.status).toBe("dispatch_unknown");
    expect(provider.dispatchCount).toBe(1);
    const restartedProvider = new MockServiceBillingProvider(clock);
    const restarted = new ServiceBillingService(prisma, settings, clock, restartedProvider);
    await restarted.charge(userId, input);
    for (let n = 0; n < 10; n++) { now = new Date(now.getTime() + 3600000); await restarted.reconcileOnce(); }
    expect((await restarted.attemptDto(result.attemptId, userId)).status).toBe("manual_review");
    expect(restartedProvider.dispatchCount).toBe(0);
    expect(await prisma.servicePaidPeriod.count({ where: { attemptId: result.attemptId } })).toBe(0);
  });
  it("transaction error rolls back cancellation intent and quote consumption", async () => {
    const { input } = await purchase();
    const before = await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } });
    await expect(prisma.$transaction(async tx => {
      await tx.serviceSubscriptionContract.update({ where: { id: before.id }, data: { renewalStopped: true } });
      await tx.serviceBillingQuote.update({ where: { id: input.quoteId }, data: { totalAmount: 1 } });
    })).rejects.toThrow();
    expect((await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } })).renewalStopped).toBe(false);
    expect((await prisma.serviceBillingQuote.findUniqueOrThrow({ where: { id: input.quoteId } })).totalAmount).toBe(990);
  });
  it("same body replay stays stable while consent/instrument changes under same key conflict", async () => {
    const { input, result } = await purchase();
    expect(await service.charge(userId, input)).toEqual(result);
    for (const changed of [{ ...input, instrumentId: randomUUID() },
      { ...input, consent: { ...input.consent, billingVersion: "changed-draft" } }]) {
      await expect(service.charge(userId, changed)).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
    }
    expect(provider.dispatchCount).toBe(1);
  });
  it("SQL independently rejects duplicate cycle, idempotency key and immutable quote bindings", async () => {
    const { input, result } = await purchase();
    const a = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    const contract = await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } });
    const q = await service.createQuote(userId, "monthly");
    const newRow = { ...a, id: randomUUID(), paymentId: `lcm${randomUUID().replaceAll("-", "")}`, quoteId: q.quoteId, idempotencyKey: randomUUID() };
    await expect(prisma.servicePaymentAttempt.create({ data: newRow })).rejects.toThrow();
    await expect(prisma.servicePaymentAttempt.create({ data: { ...newRow, cycle: 1, idempotencyKey: a.idempotencyKey } })).rejects.toThrow();
    await expect(prisma.serviceBillingQuote.update({ where: { id: input.quoteId }, data: { channelId: "wrong-channel" } })).rejects.toThrow();
    expect(await prisma.servicePaymentAttempt.count({ where: { contractId: contract.id } })).toBe(1);
  });
  it("verified unused instrument blocks delete until explicitly revoked; free account delete works", async () => {
    const q = await service.createQuote(userId, "monthly");
    const i = await service.prepare(userId, q.quoteId);
    await service.confirm(userId, i.instrumentId, `mock_${i.sdkRequest.issueId}`);
    await expect(deleteAccount(prisma, userId, password)).rejects.toMatchObject({ code: "BillingAccountDeleteBlocked" });
    await service.cancel(userId);
    await deleteAccount(prisma, userId, password);
    expect((await prisma.serviceSubscriptionContract.findFirstOrThrow({ where: { quotes: { some: { id: q.quoteId } } } })).userId).toBeNull();
    const free = await prisma.user.create({ data: { email: `billing-independent-free-test-${randomUUID()}@example.invalid`,
      name: "Synthetic", passwordHash: await argon2.hash(password) } });
    await deleteAccount(prisma, free.id, password);
    expect(await prisma.user.findUnique({ where: { id: free.id } })).toBeNull();
  });
  it("closed cancellation still blocks deletion for unresolved linked event audit", async () => {
    const { result } = await purchase();
    await service.cancel(userId);
    const a = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    const eventId = await service.recordVerifiedEvent({ ...provider.scope, eventId: `synthetic-${randomUUID()}`, paymentId: a.paymentId });
    await expect(deleteAccount(prisma, userId, password)).rejects.toMatchObject({ code: "BillingAccountDeleteBlocked" });
    await service.processEvent(eventId);
    await deleteAccount(prisma, userId, password);
    expect((await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { id: a.contractId } })).userId).toBeNull();
  });
  it("independent original leap-day and month-end boundaries do not drift", () => {
    const leap = new Date("2024-02-29T03:00:00.000Z");
    expect(serviceBillingPeriodBoundary(leap, 12).toISOString()).toBe("2025-02-27T15:00:00.000Z");
    expect(serviceBillingPeriodBoundary(leap, 48).toISOString()).toBe("2028-02-28T15:00:00.000Z");
    expect(serviceBillingPeriodBoundary(now, 1).toISOString()).toBe("2027-02-27T15:00:00.000Z");
    expect(serviceBillingPeriodBoundary(now, 2).toISOString()).toBe("2027-03-30T15:00:00.000Z");
  });
});
