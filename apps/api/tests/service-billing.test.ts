import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { BillingAccountDeleteBlocked, deleteAccount } from "../src/services/account.js";
import { ServiceBillingService, serviceBillingPeriodBoundary } from "../src/services/service-billing.js";
import { assertLocalMockBillingWorker } from "../src/services/service-billing-worker.js";
import { MockServiceBillingProvider, encryptBillingKey, decryptBillingKey, instrumentAAD, type PaymentObservation } from "../src/services/service-billing-provider.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";
import { serviceBillingChargeRequestSchema } from "@living-cost-manager/shared";

const databaseUrl = resolveApiTestDatabaseUrl(); // loopback + DB/schema test markers mandatory
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const password = "synthetic-only-test-password";
let now: Date;
let service: ServiceBillingService;
let provider: MockServiceBillingProvider;
let userId: string;
let otherId: string;
const clock = () => new Date(now);
const env = () => loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: randomBytes(40).toString("base64"),
  SERVICE_BILLING_MODE: "mock", SERVICE_BILLING_MOCK_ENABLED: "true",
  SERVICE_BILLING_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SERVICE_BILLING_KEY_VERSION: "test-v1" });
beforeEach(async () => {
  // Explicit synthetic dedicated test database only. Never reads runtime .env.
  await prisma.serviceBillingEventReceipt.deleteMany();
  await prisma.serviceRefundRecord.deleteMany();
  await prisma.servicePaidPeriod.deleteMany();
  await prisma.servicePaymentAttempt.deleteMany();
  await prisma.serviceBillingInstrument.deleteMany();
  await prisma.serviceBillingQuote.deleteMany();
  await prisma.serviceSubscriptionContract.deleteMany();
  await prisma.user.deleteMany({ where: { email: { startsWith: "billing-test-" } } });
  now = new Date("2026-11-30T03:12:34.000Z");
  provider = new MockServiceBillingProvider(clock);
  service = new ServiceBillingService(prisma, env(), clock, provider);
  const hash = await argon2.hash(password);
  userId = (await prisma.user.create({ data: { email: `billing-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: hash, emailVerifiedAt: now } })).id;
  otherId = (await prisma.user.create({ data: { email: `billing-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: hash, emailVerifiedAt: now } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
async function prepared(planId: "monthly" | "annual" = "monthly", owner = userId, svc = service) {
  const quote = await svc.createQuote(owner, planId);
  const instrument = await svc.prepare(owner, quote.quoteId);
  const token = `mock_${instrument.sdkRequest.issueId}`;
  await svc.confirm(owner, instrument.instrumentId, token);
  const input = { quoteId: quote.quoteId, instrumentId: instrument.instrumentId, idempotencyKey: randomUUID(),
    consent: { billingVersion: quote.consentVersions.billing, autoRenewVersion: quote.consentVersions.autoRenew, accepted: true as const } };
  return { quote, instrument, token, input };
}

describe("durable isolated service billing", () => {
  it("performs a server-priced purchase without granting paid/free gating", async () => {
    const { input, token } = await prepared();
    const result = await service.charge(userId, input);
    expect(result.status).toBe("paid");
    expect(result.paidPeriod).toEqual({ startsAt: now.toISOString(), endsAt: "2026-12-29T15:00:00.000Z" });
    const sub = await service.subscription(userId);
    expect(sub).toMatchObject({ paidAccess: false, existingFreeAccess: true, premiumScope: "provisional", planId: "monthly" });
    const db = await prisma.serviceBillingInstrument.findUniqueOrThrow({ where: { id: input.instrumentId } });
    expect(Buffer.from(db.ciphertext!).toString("utf8")).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(provider.dispatchCount).toBe(1);
  });
  it("supports annual price and original month-end clamping", async () => {
    now = new Date("2027-01-31T08:00:00Z");
    const { input } = await prepared("annual");
    const a = await service.charge(userId, input);
    expect(a.paidPeriod!.endsAt).toBe("2028-01-30T15:00:00.000Z");
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).totalAmount).toBe(9900);
    expect(serviceBillingPeriodBoundary(now, 1).toISOString()).toBe("2027-02-27T15:00:00.000Z");
    expect(serviceBillingPeriodBoundary(now, 2).toISOString()).toBe("2027-03-30T15:00:00.000Z");
  });
  it("concurrent idempotent requests dispatch exactly once and reserve one period", async () => {
    const { input } = await prepared();
    const results = await Promise.all(Array.from({ length: 6 }, () => service.charge(userId, input)));
    expect(new Set(results.map(x => x.attemptId)).size).toBe(1);
    expect(provider.dispatchCount).toBe(1);
    expect(await prisma.servicePaidPeriod.count()).toBe(1);
  });
  it("rejects same key with another quote and cannot create another initial cycle", async () => {
    const first = await prepared();
    await service.charge(userId, first.input);
    const second = await prepared();
    await expect(service.charge(userId, { ...second.input, idempotencyKey: first.input.idempotencyKey })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.charge(userId, second.input)).rejects.toMatchObject({ code: "SUBSCRIPTION_ALREADY_PURCHASED" });
    expect(provider.dispatchCount).toBe(1);
  });
  it("guards expiry/consent/instrument ownership and atomically leaves quote unconsumed", async () => {
    const { input } = await prepared();
    await expect(service.charge(otherId, input)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.charge(userId, { ...input, consent: { ...input.consent, autoRenewVersion: "stale" } })).rejects.toMatchObject({ code: "CONSENT_VERSION_MISMATCH" });
    expect((await prisma.serviceBillingQuote.findUniqueOrThrow({ where: { id: input.quoteId } })).consumedAt).toBeNull();
    now = new Date(now.getTime() + 16 * 60_000);
    await expect(service.charge(userId, input)).rejects.toMatchObject({ code: "QUOTE_EXPIRED_OR_CONSUMED" });
    expect(provider.dispatchCount).toBe(0);
  });
  it("rejects stolen billing keys by issuance/account binding", async () => {
    const one = await prepared();
    const q = await service.createQuote(otherId, "monthly");
    const i = await service.prepare(otherId, q.quoteId);
    await expect(service.confirm(otherId, i.instrumentId, one.token)).rejects.toMatchObject({ code: "INSTRUMENT_BINDING_MISMATCH" });
    await expect(service.confirm(otherId, one.instrument.instrumentId, one.token)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("parallel preparation creates one issuance and one instrument", async () => {
    const q = await service.createQuote(userId, "monthly");
    const result = await Promise.all(Array.from({ length: 5 }, () => service.prepare(userId, q.quoteId)));
    expect(new Set(result.map(x => x.instrumentId)).size).toBe(1);
    expect(await prisma.serviceBillingInstrument.count()).toBe(1);
  });
  it("lost charge response is resolved by same-ID lookup without retry", async () => {
    const original = provider.charge.bind(provider);
    provider.charge = async input => { await original(input); throw new Error("Synthetic lost response"); };
    const { input } = await prepared();
    const a = await service.charge(userId, input);
    expect(a.status).toBe("paid");
    await service.poll(userId, a.attemptId);
    await service.charge(userId, input);
    expect(provider.dispatchCount).toBe(1);
  });
  it("unknown dispatch and GETs never generate another charge; retries end in manual review", async () => {
    provider.charge = async () => { throw new Error("Synthetic network unavailable"); };
    const { input } = await prepared();
    const a = await service.charge(userId, input);
    expect(a.status).toBe("dispatch_unknown");
    await expect(service.poll(otherId, a.attemptId)).rejects.toMatchObject({ statusCode: 404 });
    for (let n = 0; n < 10; n++) { now = new Date(now.getTime() + 3600_000); await service.reconcileOnce(); }
    const row = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    expect(row.status).toBe("manual_review");
    expect(row.lookupCount).toBe(8);
    expect(await prisma.servicePaymentAttempt.count()).toBe(1);
    expect(await prisma.servicePaidPeriod.count()).toBe(0);
  });
  it.each(["amount", "currency", "store", "environment", "account", "payment", "channel"])("authoritative %s mismatch cannot settle", async mismatch => {
    const original = provider.getPayment.bind(provider);
    provider.getPayment = async id => {
      const value = await original(id);
      if (!value) return null;
      const edits: Record<string, Partial<PaymentObservation>> = { amount: { totalAmount: 1 }, currency: { currency: "USD" },
        store: { storeId: "wrong" }, environment: { environment: "live" }, account: { subjectId: "other" }, payment: { paymentId: "wrong" }, channel: { channelId: "wrong" } };
      return { ...value, ...edits[mismatch] };
    };
    const { input } = await prepared();
    const a = await service.charge(userId, input);
    expect(a.status).toBe("manual_review");
    expect(await prisma.servicePaidPeriod.count()).toBe(0);
  });
  it("paid is stable but duplicate event receipts remain pending without a fresh successful observation", async () => {
    const { input } = await prepared();
    const a = await service.charge(userId, input);
    provider.getPayment = async () => { throw new Error("Must not downgrade a settled period"); };
    const row = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    const event = { ...provider.scope, eventId: "synthetic_paid_event", paymentId: row.paymentId };
    const ids = await Promise.all(Array.from({ length: 8 }, () => service.recordVerifiedEvent(event)));
    await Promise.all(ids.map(id => service.processEvent(id)));
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.servicePaidPeriod.count()).toBe(1);
    expect((await service.poll(userId, a.attemptId)).status).toBe("paid");
    const receipt = await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(receipt.status).toBe("pending");
    expect(receipt.processedAt).toBeNull();
    expect(receipt.nextRetryAt).not.toBeNull();
    await expect(service.recordVerifiedEvent({ ...event, storeId: "wrong" })).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    await expect(service.recordVerifiedEvent({ ...event, paymentId: "other" })).rejects.toMatchObject({ code: "EVENT_IDEMPOTENCY_CONFLICT" });
  });
  it("unknown events have bounded durable retries without granting a period", async () => {
    const id = await service.recordVerifiedEvent({ ...provider.scope, eventId: "unknown_event", paymentId: "unknown_payment" });
    for (let n = 0; n < 10; n++) { await service.processEvent(id); now = new Date(now.getTime() + 3600_000); }
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id } })).status).toBe("manual_review");
    expect(await prisma.servicePaidPeriod.count()).toBe(0);
  });
  it("expired lookup leases are fenced against an older worker result", async () => {
    provider.charge = async () => { throw new Error("No charge result"); };
    const { input } = await prepared();
    const a = await service.charge(userId, input);
    now = new Date(now.getTime() + 10_000);
    let release!: () => void;
    let called!: () => void;
    const entered = new Promise<void>(resolve => { called = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const row = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    const c = await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { id: row.contractId } });
    provider.getPayment = async () => { called(); await hold; return { ...provider.scope, paymentId: row.paymentId, subjectId: c.subjectId,
      status: "PAID", totalAmount: row.totalAmount, currency: row.currency, paidAt: now }; };
    const older = service.reconcile(a.attemptId);
    await entered;
    now = new Date(now.getTime() + 31_000);
    provider.getPayment = async () => null;
    await service.reconcile(a.attemptId);
    release(); await older;
    expect(await prisma.servicePaidPeriod.count()).toBe(0);
    expect((await service.attemptDto(a.attemptId, userId)).status).toBe("dispatch_unknown");
  });
  it("mock renews only a due frozen-price consented cycle, then cancellation excludes renewals", async () => {
    const { input } = await prepared();
    const first = await service.charge(userId, input);
    await expect(service.renewMock(userId)).rejects.toMatchObject({ code: "RENEWAL_NOT_DUE" });
    now = new Date(first.paidPeriod!.endsAt);
    const results = await Promise.all([service.renewMock(userId), service.renewMock(userId)]);
    expect(results[0].attemptId).toBe(results[1].attemptId);
    expect(provider.dispatchCount).toBe(2);
    expect(await prisma.servicePaidPeriod.count()).toBe(2);
    const canceled = await service.cancel(userId);
    expect(canceled).toMatchObject({ renewalStopped: true, providerCancellationStatus: "verified", existingFreeAccess: true });
    now = new Date(now.getTime() + 40 * 86400_000);
    await expect(service.renewMock(userId)).rejects.toMatchObject({ code: "RENEWAL_STOPPED" });
  });
  it("uncertain remote cancellation remains pending and blocks account deletion", async () => {
    const { input } = await prepared(); await service.charge(userId, input);
    provider.cancelSchedule = async () => { throw new Error("Synthetic remote uncertainty"); };
    const result = await service.cancel(userId);
    expect(result.providerCancellationStatus).toBe("pending");
    await expect(deleteAccount(prisma, userId, password)).rejects.toBeInstanceOf(BillingAccountDeleteBlocked);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
  it("refund requests are server-bounded, reserved, idempotent and mock execution authoritative", async () => {
    const { input } = await prepared(); const a = await service.charge(userId, input);
    const key = randomUUID();
    await expect(service.requestRefund(otherId, a.attemptId, key, "other")).rejects.toMatchObject({ statusCode: 404 });
    const r = await service.requestRefund(userId, a.attemptId, key, "other");
    expect(r).toMatchObject({ status: "requested", requestAmount: 990 });
    expect(await service.requestRefund(userId, a.attemptId, key, "other")).toEqual(r);
    await expect(service.requestRefund(userId, a.attemptId, randomUUID(), "other")).rejects.toMatchObject({ code: "REFUND_ALREADY_RESERVED" });
    await expect(service.requestRefund(userId, a.attemptId, key, "changed_mind")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(deleteAccount(prisma, userId, password)).rejects.toBeInstanceOf(BillingAccountDeleteBlocked);
    await service.executeMockRefund(userId, r.requestId);
    expect((await service.attemptDto(a.attemptId, userId)).status).toBe("refunded");
    expect((await service.subscription(userId)).existingFreeAccess).toBe(true);
  });
  it("account deletion retains detached minimal audit after verified cancellation; old free accounts work", async () => {
    await deleteAccount(prisma, otherId, password);
    const { input } = await prepared(); await service.charge(userId, input);
    await expect(deleteAccount(prisma, userId, password)).rejects.toBeInstanceOf(BillingAccountDeleteBlocked);
    await service.cancel(userId); await deleteAccount(prisma, userId, password);
    const c = await prisma.serviceSubscriptionContract.findFirstOrThrow();
    expect(c.userId).toBeNull();
    expect(JSON.stringify(c)).not.toContain("@example.invalid");
    expect(await prisma.servicePaymentAttempt.count()).toBe(1);
    expect(await prisma.servicePaidPeriod.count()).toBe(1);
    expect((await prisma.serviceBillingInstrument.findFirstOrThrow()).ciphertext).toBeNull();
  });
  it("database rejects immutable amounts, broken scopes and financial parent deletion", async () => {
    const { input } = await prepared(); const a = await service.charge(userId, input);
    await expect(prisma.servicePaymentAttempt.update({ where: { id: a.attemptId }, data: { totalAmount: 1 } })).rejects.toThrow();
    await expect(prisma.serviceBillingQuote.update({ where: { id: input.quoteId }, data: { currency: "USD" } })).rejects.toThrow();
    await expect(prisma.servicePaidPeriod.updateMany({ data: { environment: "live" } })).rejects.toThrow();
    await expect(prisma.serviceSubscriptionContract.deleteMany()).rejects.toThrow();
    expect(await prisma.servicePaidPeriod.count()).toBe(1);
  });
  it("SQL blocks overlap, foreign event/period scopes and oversized refund reservations", async () => {
    const { input } = await prepared(); const result = await service.charge(userId, input);
    const a = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    const q = await service.createQuote(userId, "monthly");
    const next = await prisma.servicePaymentAttempt.create({ data: { ...a, id: randomUUID(), cycle: 1, quoteId: q.quoteId,
      idempotencyKey: randomUUID(), paymentId: `lcm${randomUUID().replaceAll("-", "")}` } });
    const period = await prisma.servicePaidPeriod.findFirstOrThrow();
    await expect(prisma.servicePaidPeriod.create({ data: { attemptId: next.id, contractId: a.contractId, cycle: 1,
      environment: "mock", startsAt: new Date(period.startsAt.getTime() + 1000), endsAt: period.endsAt,
      accessEndsAt: period.endsAt, verifiedAt: now } })).rejects.toThrow();
    await expect(prisma.servicePaidPeriod.create({ data: { attemptId: next.id, contractId: a.contractId, cycle: 1,
      environment: "live", startsAt: period.endsAt, endsAt: new Date(period.endsAt.getTime() + 86400_000),
      accessEndsAt: new Date(period.endsAt.getTime() + 86400_000), verifiedAt: now } })).rejects.toThrow();
    await expect(prisma.serviceBillingEventReceipt.create({ data: { provider: "mock", storeId: "wrong", environment: "mock",
      eventId: "scope_event", paymentId: a.paymentId, attemptId: a.id } })).rejects.toThrow();
    await expect(prisma.serviceRefundRecord.create({ data: { attemptId: a.id, provider: a.provider, storeId: a.storeId,
      environment: a.environment, requestAmount: 991, idempotencyKey: randomUUID(), reasonCode: "other" } })).rejects.toThrow();
    await expect(prisma.servicePaymentAttempt.update({ where: { id: a.id }, data: { status: "failed" } })).rejects.toThrow();
  });
  it("account deletion vs new contract cannot resurrect a user FK", async () => {
    const results = await Promise.allSettled([service.createQuote(userId, "monthly"), deleteAccount(prisma, userId, password)]);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const contracts = await prisma.serviceSubscriptionContract.findMany();
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    if (!user) expect(contracts.every(c => c.userId !== userId)).toBe(true);
    else expect(contracts.every(c => c.userId === userId)).toBe(true);
    expect(provider.dispatchCount).toBe(0);
  });
  it("AEAD rejects substituted scope, wrong key and tamper with no static fallback", async () => {
    const key = randomBytes(32);
    const identity = { id: "i", contractId: "c", provider: "mock", storeId: "s", environment: "mock" };
    const aad = instrumentAAD(identity);
    const envelope = encryptBillingKey("synthetic_key", key, "test", aad);
    expect(decryptBillingKey(envelope, key, aad)).toBe("synthetic_key");
    expect(() => decryptBillingKey(envelope, randomBytes(32), aad)).toThrow();
    expect(() => decryptBillingKey(envelope, key, instrumentAAD({ ...identity, contractId: "other" }))).toThrow();
    envelope.authTag[0] ^= 1;
    expect(() => decryptBillingKey(envelope, key, aad)).toThrow();
    const absent = new ServiceBillingService(prisma, { ...env(), SERVICE_BILLING_ENCRYPTION_KEY: undefined }, clock);
    expect(absent.readiness().checkoutEnabled).toBe(false);
    await expect(absent.createQuote(userId, "monthly")).rejects.toMatchObject({ statusCode: 503 });
  });
  it("live, sandbox and production mock all fail closed without provider I/O", async () => {
    for (const mode of ["live", "sandbox", "mock"] as const) {
      const instance = new ServiceBillingService(prisma, { ...env(), SERVICE_BILLING_MODE: mode, NODE_ENV: "production" }, clock);
      expect(instance.readiness()).toMatchObject({ checkoutEnabled: false, sdkConfig: null, capabilities: { charge: false, issueInstrument: false } });
      await expect(instance.createQuote(userId, "monthly")).rejects.toMatchObject({ statusCode: 503 });
      expect((await instance.subscription(userId)).paidAccess).toBe(false);
    }
  });
  it("strict DTOs reject client price fields, empty consents and overlong billing keys", () => {
    expect(serviceBillingChargeRequestSchema.safeParse({ quoteId: "q", instrumentId: "i", idempotencyKey: randomUUID(),
      amount: 1, consent: { billingVersion: "v", autoRenewVersion: "v", accepted: true } }).success).toBe(false);
    expect(serviceBillingChargeRequestSchema.safeParse({ quoteId: "q", instrumentId: "i", idempotencyKey: randomUUID(),
      consent: { billingVersion: "v", autoRenewVersion: "v", accepted: false } }).success).toBe(false);
  });
  it("local worker refuses production, real DB names, remote targets and sandbox", () => {
    expect(() => assertLocalMockBillingWorker(env())).not.toThrow();
    for (const changed of [{ NODE_ENV: "production" as const }, { SERVICE_BILLING_MODE: "sandbox" as const },
      { DATABASE_URL: "postgresql://127.0.0.1/production?schema=billing_test" },
      { DATABASE_URL: "postgresql://remote.invalid/lcm_billing_test?schema=billing_test" },
      { DATABASE_URL: "postgresql://127.0.0.1/lcm_billing_test?schema=public" }, { DATABASE_URL: "invalid" }]) {
      expect(() => assertLocalMockBillingWorker({ ...env(), ...changed })).toThrow();
    }
  });
  it("API uses actual base prefix, verified current tokens, safe bodies and never accepts unsigned PortOne", async () => {
    const settings = { ...env(), API_BASE_PATH: "/living-cost-manager/v1" };
    const app = await buildApp({ env: settings, prisma, logger: false });
    const base = "/living-cost-manager/v1/service-billing";
    try {
      expect((await app.inject({ method: "GET", url: `${base}/readiness` })).json()).toMatchObject({ mode: "mock", checkoutEnabled: true });
      expect((await app.inject({ method: "GET", url: "/service-billing/readiness" })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${base}/quotes`, payload: { planId: "monthly" } })).statusCode).toBe(401);
      const token = app.signTokens({ id: userId, tokenVersion: 0 }).accessToken;
      const headers = { authorization: `Bearer ${token}` };
      expect((await app.inject({ method: "POST", url: `${base}/quotes`, headers, payload: { planId: "monthly", amount: 1 } })).statusCode).toBe(400);
      const quote = (await app.inject({ method: "POST", url: `${base}/quotes`, headers, payload: { planId: "monthly" } })).json();
      expect(quote.totalAmount).toBe(990);
      const i = (await app.inject({ method: "POST", url: `${base}/instruments/prepare`, headers, payload: { quoteId: quote.quoteId } })).json();
      const bad = await app.inject({ method: "POST", url: `${base}/instruments/${i.instrumentId}/confirm`, headers, payload: { billingKey: "private-synthetic-key" } });
      expect(bad.statusCode).toBe(422); expect(bad.body).not.toContain("private-synthetic-key");
      expect((await app.inject({ method: "POST", url: `${base}/instruments/${i.instrumentId}/confirm`, headers, payload: { billingKey: "x".repeat(1025) } })).statusCode).toBe(400);
      const oversized = await app.inject({ method: "POST", url: `${base}/instruments/${i.instrumentId}/confirm`, headers,
        payload: { billingKey: "private-synthetic-oversized".repeat(500) } });
      expect(oversized.statusCode).toBe(413); expect(oversized.body).not.toContain("private-synthetic-oversized");
      const confirmed = await app.inject({ method: "POST", url: `${base}/instruments/${i.instrumentId}/confirm`, headers,
        payload: { billingKey: `mock_${i.sdkRequest.issueId}` } });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toEqual({ instrumentId: i.instrumentId, status: "verified" });
      const purchased = await app.inject({ method: "POST", url: `${base}/charges`, headers, payload: {
        quoteId: quote.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
        consent: { billingVersion: quote.consentVersions.billing, autoRenewVersion: quote.consentVersions.autoRenew, accepted: true }
      } });
      expect(purchased.statusCode).toBe(200);
      expect(purchased.json().status).toBe("paid");
      expect((await app.inject({ method: "POST", url: `${base}/mock/renew`, headers, payload: {} })).statusCode).toBe(409);
      const refunded = (await app.inject({ method: "POST", url: `${base}/attempts/${purchased.json().attemptId}/refund-requests`, headers,
        payload: { idempotencyKey: randomUUID(), reasonCode: "other" } })).json();
      expect(refunded.status).toBe("requested");
      const executed = await app.inject({ method: "POST", url: `${base}/mock/refund-requests/${refunded.requestId}/execute`, headers, payload: {} });
      expect(executed.statusCode).toBe(200); expect(executed.json().status).toBe("verified");
      expect((await app.inject({ method: "GET", url: `${base}/subscription`, headers })).json()).toMatchObject({ paidAccess: false, existingFreeAccess: true, renewalStopped: true });
      expect((await app.inject({ method: "POST", url: `${base}/webhooks/portone`, payload: { type: "Transaction.Paid", data: {} } })).statusCode).toBe(404);
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });
      expect((await app.inject({ method: "POST", url: `${base}/quotes`, headers, payload: { planId: "monthly" } })).statusCode).toBe(403);
      await prisma.user.update({ where: { id: userId }, data: { tokenVersion: 1 } });
      expect((await app.inject({ method: "GET", url: `${base}/subscription`, headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("non-test user quota is account-independent and invalid JWTs do not consume it", async () => {
    const app = await buildApp({ env: { ...env(), NODE_ENV: "development" }, prisma, logger: false });
    try {
      const headers = { authorization: `Bearer ${app.signTokens({ id: userId, tokenVersion: 0 }).accessToken}` };
      for (let n = 0; n < 75; n++) {
        expect((await app.inject({ method: "GET", url: "/service-billing/subscription", headers: { authorization: "Bearer invalid" } })).statusCode).toBe(401);
      }
      for (let n = 0; n < 60; n++) expect((await app.inject({ method: "GET", url: "/service-billing/subscription", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/service-billing/subscription", headers })).statusCode).toBe(429);
      const other = { authorization: `Bearer ${app.signTokens({ id: otherId, tokenVersion: 0 }).accessToken}` };
      expect((await app.inject({ method: "GET", url: "/service-billing/subscription", headers: other })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
