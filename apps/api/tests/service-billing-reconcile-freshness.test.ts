import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { resolveApiTestDatabaseUrl } from "./test-database.js";
import { syntheticApprovedConfiguration, FakePortOneHttp, signedPortOneFixture } from "./service-billing-portone-fixtures.js";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { PortOneHttpTransport, PortOneServiceBillingProvider } from "../src/services/service-billing-portone.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let now: Date; const clock = () => new Date(now);
let setup: ReturnType<typeof syntheticApprovedConfiguration>; let http: FakePortOneHttp;
let service: ServiceBillingService; let attemptId: string; let paymentId: string;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(async () => {
  await prisma.serviceBillingEventReceipt.deleteMany(); await prisma.serviceRefundRecord.deleteMany(); await prisma.servicePaidPeriod.deleteMany();
  await prisma.servicePaymentAttempt.deleteMany(); await prisma.serviceBillingInstrument.deleteMany(); await prisma.serviceBillingQuote.deleteMany(); await prisma.serviceSubscriptionContract.deleteMany();
  await prisma.user.deleteMany({ where: { email: { startsWith: "billing-freshness-test-" } } });
  now = new Date("2027-01-31T03:00:00.000Z"); setup = syntheticApprovedConfiguration(databaseUrl);
  http = new FakePortOneHttp(setup.manifest, clock);
  service = new ServiceBillingService(prisma, setup.env, clock, http.provider([setup.secret]));
  const user = await prisma.user.create({ data: { email: `billing-freshness-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: "not-login-capable", emailVerifiedAt: now } });
  const q = await service.createQuote(user.id, "monthly"); const i = await service.prepare(user.id, q.quoteId);
  await service.confirm(user.id, i.instrumentId, http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id));
  const a = await service.charge(user.id, { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
    consent: { billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true } });
  attemptId = a.attemptId; paymentId = (await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).paymentId;
});
afterAll(async () => prisma.$disconnect());
function cancel(amount = 990) {
  const p = http.payments.get(paymentId)!;
  p.amount.cancelled = amount; p.status = amount === 990 ? "CANCELLED" : "PARTIAL_CANCELLED";
  p.cancellations = [{ status: "SUCCEEDED", id: "synthetic_external_cancellation", totalAmount: amount, reason: "Synthetic external cancellation" }];
}
async function receipt(type = "Transaction.Cancelled") {
  const id = `synthetic_event_${randomUUID()}`;
  const signed = signedPortOneFixture(setup.secret, setup.manifest.storeId, paymentId, id, type);
  expect(await service.acceptPortOneWebhook(signed.raw, signed.headers)).toMatchObject({ accepted: true, ignored: false });
  return prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { provider_storeId_environment_eventId: {
    provider: "portone", storeId: setup.manifest.storeId, environment: "sandbox", eventId: id } } });
}
function holdOneGet() {
  const started = deferred(); const release = deferred(); let holding = true;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await http.fetch(input, init); // capture PAID before the event
    if (init?.method === "GET" && new URL(String(input)).pathname.startsWith("/payments/") && holding) {
      holding = false; started.resolve(); await release.promise;
    }
    return response;
  };
  const provider = new PortOneServiceBillingProvider(setup.manifest, new PortOneHttpTransport("synthetic-only", fetcher, 8000), [setup.secret]);
  return { started, release, heldService: new ServiceBillingService(prisma, setup.env, clock, provider) };
}

describe("fresh authoritative event reconciliation, fake HTTP and isolated PG only", () => {
  it("busy paid lease cannot consume cancellation; pre-event GET completion cannot replace a fresh lookup", async () => {
    const hold = holdOneGet(); const oldGet = hold.heldService.reconcile(attemptId, true); await hold.started.promise;
    const e = await receipt(); cancel(); const calls = http.calls.length;
    await service.processEvent(e.id);
    expect(http.calls.length).toBe(calls); // lease skipped, ZERO new requests
    expect(await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "pending_cancelled", processedAt: null, retryCount: 1 });
    hold.release.resolve(); expect((await oldGet).outcome).toBe("fresh_authoritative_committed");
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("paid");
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).processedAt).toBeNull();
    now = new Date(now.getTime() + 5000); await service.reconcileOnce();
    expect(http.calls.length).toBeGreaterThan(calls);
    expect(await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "processed_cancelled", nextRetryAt: null });
    const a = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(a).toMatchObject({ status: "refunded", reviewRequired: true });
    expect((await prisma.servicePaidPeriod.findUniqueOrThrow({ where: { attemptId } })).accessEndsAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(await prisma.serviceRefundRecord.count()).toBe(0); expect(http.chargeCount).toBe(1);
  });
  it("fresh but eventually-consistent PAID cannot acknowledge a signed cancellation; bounded retries retain intent", async () => {
    const e = await receipt(); await service.processEvent(e.id);
    expect(await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "pending_cancelled", processedAt: null });
    for (let n = 0; n < 8; n++) { now = new Date(now.getTime() + 300_000); await service.processEvent(e.id); }
    expect(await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "manual_review_cancelled", retryCount: 8, processedAt: null, nextRetryAt: null });
    expect(http.chargeCount).toBe(1);
  });
  it("partial cancellation requires effective cancellation, then durable audit and coverage truncate", async () => {
    const e = await receipt("Transaction.PartialCancelled"); await service.processEvent(e.id);
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("pending_partial_cancelled");
    cancel(100); now = new Date(now.getTime() + 5000); await service.processEvent(e.id);
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("processed_partial_cancelled");
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).reviewRequired).toBe(true);
  });
  it("duplicate and concurrent receipts cannot steal a busy attempt or consume stale evidence", async () => {
    const e = await receipt();
    expect(await service.recordVerifiedEvent({ ...http.provider([setup.secret]).scope, eventId: e.eventId, paymentId, expectation: "cancelled" })).toBe(e.id);
    const e2 = await receipt(); const hold = holdOneGet();
    const first = hold.heldService.processEvent(e.id); await hold.started.promise;
    await Promise.all([service.processEvent(e.id), service.processEvent(e2.id)]);
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e2.id } })).processedAt).toBeNull();
    cancel(); hold.release.resolve(); await first;
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).processedAt).toBeNull();
    now = new Date(now.getTime() + 5000); await service.processEvent(e.id);
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("processed_cancelled");
    // Unknown external cancellation creates operator review; another receipt
    // must not borrow the first receipt's observation to erase its own audit.
    await service.processEvent(e2.id);
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e2.id } })).processedAt).toBeNull();
    expect(http.chargeCount).toBe(1);
  });
  it("expired attempt and receipt fences reject late old PAID commit after newer cancellation GET", async () => {
    const e = await receipt(); const hold = holdOneGet();
    const old = hold.heldService.processEvent(e.id); await hold.started.promise;
    cancel(); now = new Date(now.getTime() + 120_000); await service.processEvent(e.id);
    const newer = await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } });
    expect(newer.status).toBe("processed_cancelled");
    hold.release.resolve(); await old;
    expect(await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).toEqual(newer);
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("refunded");
    expect(http.chargeCount).toBe(1);
  });
  it("lookup failure after signature ACK retains durable pending receipt without raw body", async () => {
    const e = await receipt(); http.unavailableLookups = true; await service.processEvent(e.id);
    const stored = await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } });
    expect(stored).toMatchObject({ status: "pending_cancelled", processedAt: null, retryCount: 1 }); expect(stored.nextRetryAt).not.toBeNull();
    expect(Object.keys(stored)).not.toContain("body"); expect(Object.keys(stored)).not.toContain("signature");
    http.unavailableLookups = false; cancel(); now = new Date(now.getTime() + 120_000); await service.processEvent(e.id);
    expect((await prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("processed_cancelled");
  });
  it.each(["PENDING", "CANCEL_PENDING", "FUTURE_PAYMENT"])("unsupported authoritative payment status %s fails closed", async status => {
    http.payments.get(paymentId)!.status = status;
    await expect(http.provider([setup.secret]).getPayment(paymentId)).rejects.toMatchObject({ code: "PORTONE_INVALID_EVIDENCE" });
    expect((await service.reconcile(attemptId, true)).outcome).toBe("manual_review");
  });
  it.each(["PENDING", "FUTURE_CANCEL"])("unsupported cancellation status %s cannot be filtered away", async status => {
    http.payments.get(paymentId)!.cancellations = [{ status, id: "synthetic-unknown-cancel", totalAmount: 100, reason: "Synthetic" }];
    await expect(http.provider([setup.secret]).getPayment(paymentId)).rejects.toMatchObject({ code: "PORTONE_INVALID_EVIDENCE" });
  });
  it.each(["REQUESTED", "FAILED", "SUCCEEDED"])("official cancellation status %s remains supported", async status => {
    const p = http.payments.get(paymentId)!;
    p.cancellations = [{ status, id: "synthetic-supported-cancel", totalAmount: 100, reason: "Synthetic" }];
    if (status === "SUCCEEDED") { p.amount.cancelled = 100; p.status = "PARTIAL_CANCELLED"; }
    expect((await http.provider([setup.secret]).getPayment(paymentId))?.cancelledAmount).toBe(status === "SUCCEEDED" ? 100 : 0);
  });
});
