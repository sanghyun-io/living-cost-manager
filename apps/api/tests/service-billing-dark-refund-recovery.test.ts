import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { PortOneHttpTransport, PortOneServiceBillingProvider } from "../src/services/service-billing-portone.js";
import { runBillingWorker } from "../src/services/service-billing-worker.js";
import { syntheticApprovedConfiguration, FakePortOneHttp } from "./service-billing-portone-fixtures.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
let now: Date;
const clock = () => new Date(now);
let setup: ReturnType<typeof syntheticApprovedConfiguration>;
let http: FakePortOneHttp;
let service: ServiceBillingService;
let dark: ServiceBillingService;
let userId: string;
let attemptId: string;
let paymentId: string;
let requestId: string;
let operationId: string;
const darkEnv = () => ({ ...setup.env, SERVICE_PAID_FEATURES_PUBLISHED: "false" as const });
beforeEach(async () => {
  // Owned loopback test DB/schema only; no runtime .env or provider sockets.
  await prisma.serviceBillingEventReceipt.deleteMany(); await prisma.serviceRefundRecord.deleteMany(); await prisma.servicePaidPeriod.deleteMany();
  await prisma.servicePaymentAttempt.deleteMany(); await prisma.serviceBillingInstrument.deleteMany(); await prisma.serviceBillingQuote.deleteMany(); await prisma.serviceSubscriptionContract.deleteMany();
  await prisma.user.deleteMany({ where: { email: { startsWith: "billing-dark-recovery-test-" } } });
  now = new Date("2027-01-31T03:00:00.000Z");
  setup = syntheticApprovedConfiguration(databaseUrl, "live");
  http = new FakePortOneHttp(setup.manifest, clock);
  service = new ServiceBillingService(prisma, setup.env, clock, http.provider([setup.secret]));
  userId = (await prisma.user.create({ data: { email: `billing-dark-recovery-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: "not-login-capable", emailVerifiedAt: now } })).id;
  const q = await service.createQuote(userId, "monthly"); const i = await service.prepare(userId, q.quoteId);
  await service.confirm(userId, i.instrumentId, http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id));
  const a = await service.charge(userId, { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
    consent: { billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true } });
  attemptId = a.attemptId; paymentId = (await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).paymentId;
  const r = await service.requestRefund(userId, attemptId, randomUUID(), "other"); requestId = r.requestId; operationId = randomUUID();
  dark = new ServiceBillingService(prisma, darkEnv(), clock, http.provider([setup.secret]));
});
afterAll(async () => prisma.$disconnect());
async function dispatchedUnknown() {
  // Real service dispatch/reservation path against fake PG, then unavailable
  // GET. Not an inserted dispatch_unknown fixture masquerading as dispatch.
  http.unavailableLookups = true;
  const lostResponse: typeof fetch = async (input, init) => {
    const response = await http.fetch(input, init);
    if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/cancel")) throw new Error("Synthetic cancellation response lost after acceptance");
    return response;
  };
  const dispatching = new ServiceBillingService(prisma, setup.env, clock,
    new PortOneServiceBillingProvider(setup.manifest, new PortOneHttpTransport("synthetic-only", lostResponse, 100), [setup.secret]));
  await dispatching.approveAndExecuteRefund(requestId, operationId, "policy-v1");
  http.unavailableLookups = false;
  expect(await prisma.serviceRefundRecord.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: "dispatch_unknown", lookupCount: 1, fence: 1, approvalOperationId: operationId });
  expect(http.cancelCount).toBe(1);
  expect(await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "paid", nextLookupAt: null });
  expect(await prisma.serviceBillingEventReceipt.count()).toBe(0);
  now = new Date(now.getTime() + 300_000);
  http.calls.length = 0;
}
const row = () => prisma.serviceRefundRecord.findUniqueOrThrow({ where: { id: requestId } });
function assertGetOnly(count: number) {
  expect(http.calls).toHaveLength(count);
  expect(http.calls.every(c => c.method === "GET" && c.pathname === `/payments/${paymentId}`)).toBe(true);
  expect(http.cancelCount).toBe(1); expect(http.chargeCount).toBe(1); expect(http.deleteCount).toBe(0);
}

describe("private dark refund recovery never authorizes a fresh dispatch", () => {
  test("previous approved response-unknown refund recovers with one GET, zero new POST, idempotent replay and public 404", async () => {
    await dispatchedUnknown();
    expect(dark.readiness().capabilities.refund).toBe(false);
    await dark.reconcileOnce();
    assertGetOnly(1);
    expect(await row()).toMatchObject({ status: "verified", verifiedAmount: 990, lookupCount: 2, leaseOwner: null, leaseUntil: null, nextLookupAt: null, approvalOperationId: operationId });
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("refunded");
    expect((await prisma.servicePaidPeriod.findUniqueOrThrow({ where: { attemptId } })).accessEndsAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect((await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } }))).toMatchObject({ renewalStopped: true, cancelRequested: true, providerCancellationStatus: "pending" });
    await dark.reconcileOnce(); assertGetOnly(1);
    for (const op of [operationId, randomUUID()]) await expect(dark.approveAndExecuteRefund(requestId, op, "policy-v1")).rejects.toMatchObject({ statusCode: 403 });
    assertGetOnly(1); expect(await prisma.serviceRefundRecord.count()).toBe(1);
    const app = await buildApp({ env: darkEnv(), prisma, logger: false, serviceBillingProvider: http.provider([setup.secret]), serviceBillingClock: clock });
    try {
      for (const path of ["readiness", "subscription", "quotes", "charges", "webhooks/portone", `mock/refund-requests/${requestId}/execute`])
        expect((await app.inject({ method: "POST", url: `/service-billing/${path}`, payload: {} })).statusCode).toBe(404);
      expect(app.hasDecorator("serviceBilling")).toBe(false);
    } finally { await app.close(); }
    assertGetOnly(1);
  });
  test("requested but never dispatched refund stays unchanged, no new approval/reservation or GET/POST", async () => {
    const before = await row(); http.calls.length = 0;
    await expect(dark.approveAndExecuteRefund(requestId, operationId, "policy-v1")).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", statusCode: 403 });
    await dark.reconcileOnce();
    expect(await row()).toEqual(before); expect(http.calls).toHaveLength(0); expect(http.cancelCount).toBe(0);
    expect(await prisma.serviceRefundRecord.count()).toBe(1);
  });
  test("recovery uses registered read reconciliation, not the now-disabled refund dispatch capability/worker", async () => {
    await dispatchedUnknown();
    const manifest = { ...setup.manifest, capabilities: { ...setup.manifest.capabilities, refund: false }, workers: { ...setup.manifest.workers, refunds: false }, refundPolicy: null };
    // Inject the same persisted fake remote payment, with the same verified
    // scope/policy, into a freshly configured read-only recovery adapter.
    const fake = new FakePortOneHttp(manifest, clock); fake.payments.set(paymentId, http.payments.get(paymentId)!);
    const restarted = new ServiceBillingService(prisma, { ...darkEnv(), SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify(manifest) }, clock, fake.provider([setup.secret]));
    expect(restarted.readiness().capabilities.refund).toBe(false);
    await restarted.reconcileOnce();
    expect(fake.calls).toHaveLength(1); expect(fake.calls[0].method).toBe("GET"); expect(fake.cancelCount).toBe(0);
    expect(await row()).toMatchObject({ status: "verified", approvalOperationId: operationId });
  });
  test.each([
    { fence: 0, lookupCount: 0 },
    { approvalOperationId: null, approvalPolicyVersion: null },
    { approvalOperationId: "!!!!!!!!!!!!!!!!!" },
    { approvalPolicyVersion: "other-policy-v1" },
    { lookupCount: 8 },
  ])("invalid persisted marker/binding %j enters manual review without provider lookup", async delta => {
    const bindingCase = "approvalOperationId" in delta || "approvalPolicyVersion" in delta;
    if (bindingCase) {
      // Existing SQL immutability rejects re-binding a dispatched approval.
      // Instead manufacture an invalid initial claim on our unapproved fixture
      // (no POST), without disabling constraints/triggers or altering schema.
      await prisma.serviceRefundRecord.update({ where: { id: requestId }, data: {
        status: "dispatch_unknown", fence: 1, lookupCount: 1,
        approvalOperationId: operationId, approvalPolicyVersion: "policy-v1", ...delta } });
      http.calls.length = 0;
    } else {
      await dispatchedUnknown();
      await prisma.serviceRefundRecord.update({ where: { id: requestId }, data: delta });
    }
    await dark.reconcileOnce();
    expect(await row()).toMatchObject({ status: "manual_review", leaseOwner: null, leaseUntil: null, nextLookupAt: null });
    expect(http.calls).toHaveLength(0); expect(http.cancelCount).toBe(bindingCase ? 0 : 1);
  });
  test("previous approval is SQL-immutable; supplying a different operator operation never changes the recovery binding", async () => {
    await dispatchedUnknown();
    await expect(prisma.serviceRefundRecord.update({ where: { id: requestId }, data: { approvalOperationId: randomUUID() } })).rejects.toThrow("Immutable refund approval");
    await expect(dark.approveAndExecuteRefund(requestId, randomUUID(), "policy-v1")).rejects.toMatchObject({ statusCode: 403 });
    expect((await row()).approvalOperationId).toBe(operationId);
    await dark.reconcileOnce(); expect(await row()).toMatchObject({ status: "verified", approvalOperationId: operationId }); assertGetOnly(1);
  });
  test.each(["merchant", "channel", "customer", "currency", "amount", "cancellationEntry"])("invalid %s evidence cannot settle an outstanding refund", async field => {
    await dispatchedUnknown();
    const p = http.payments.get(paymentId)!;
    if (field === "merchant") p.merchantId = "different-merchant";
    if (field === "channel") p.channel.id = "different-channel";
    if (field === "customer") p.customer.id = "different-subject";
    if (field === "currency") p.currency = "USD";
    if (field === "amount") p.amount.total = 1234;
    if (field === "cancellationEntry") p.cancellations[0].id = "";
    await dark.reconcileOnce();
    expect(await row()).toMatchObject({ status: "manual_review", verifiedAt: null, verifiedAmount: null });
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("paid");
    assertGetOnly(1);
  });
  test("unmatched request identity is retried at most eight observations, never reposted", async () => {
    await dispatchedUnknown();
    http.payments.get(paymentId)!.cancellations[0].reason = "LCM refund different-request";
    for (let n = 0; n < 12; n++) { now = new Date(now.getTime() + 300_000); await dark.reconcileOnce(); }
    expect(await row()).toMatchObject({ status: "manual_review", lookupCount: 8, verifiedAt: null, nextLookupAt: null });
    assertGetOnly(7); // one pre-dark lookup, seven remaining bounded GETs
  });
  test("missing trusted configuration blocks private recovery before any GET and preserves pending audit", async () => {
    await dispatchedUnknown(); const before = await row();
    const disabled = new ServiceBillingService(prisma, { ...darkEnv(), PORTONE_LCM_API_SECRET: undefined }, clock);
    expect(disabled.provider).toBeNull();
    await expect(disabled.reconcileOnce()).rejects.toMatchObject({ code: "SERVICE_BILLING_NOT_READY" });
    await expect(runBillingWorker({ ...darkEnv(), PORTONE_LCM_API_SECRET: undefined }, "reconcile")).rejects.toThrow("approval/capability required");
    expect(await row()).toEqual(before); assertGetOnly(0);
  });
  test("transport outage retains the same unknown reservation with backoff and a bounded terminal audit state", async () => {
    await dispatchedUnknown(); http.unavailableLookups = true;
    await dark.reconcileOnce();
    const pending = await row();
    expect(pending).toMatchObject({ status: "dispatch_unknown", lookupCount: 2, verifiedAt: null, approvalOperationId: operationId, requestAmount: 990 });
    expect(pending.nextLookupAt!.getTime()).toBeGreaterThan(now.getTime());
    await dark.reconcileOnce(); assertGetOnly(1);
    for (let n = 0; n < 10; n++) { now = new Date(now.getTime() + 300_000); await dark.reconcileOnce(); }
    expect(await row()).toMatchObject({ status: "manual_review", lookupCount: 8, verifiedAt: null, nextLookupAt: null }); assertGetOnly(7);
    expect(await prisma.serviceRefundRecord.count()).toBe(1);
  });
  test("concurrent scans respect the lease and stale GET cannot commit after a fence changes", async () => {
    await dispatchedUnknown();
    let release!: () => void; let started!: () => void;
    const wait = new Promise<void>(r => { release = r; }); const began = new Promise<void>(r => { started = r; });
    const fetcher: typeof fetch = async (input, init) => {
      const response = await http.fetch(input, init); started(); await wait; return response;
    };
    const provider = new PortOneServiceBillingProvider(setup.manifest, new PortOneHttpTransport("synthetic-only", fetcher, 8000), [setup.secret]);
    const held = new ServiceBillingService(prisma, darkEnv(), clock, provider);
    const pending = held.reconcileOnce(); await began;
    await dark.reconcileOnce(); assertGetOnly(1);
    const claimed = await row();
    await prisma.serviceRefundRecord.update({ where: { id: requestId }, data: { fence: { increment: 1 }, status: "manual_review", leaseOwner: null, leaseUntil: null } });
    release(); await pending;
    expect(await row()).toMatchObject({ status: "manual_review", fence: claimed.fence + 1, verifiedAt: null });
    assertGetOnly(1);
  });
  test("existing charge response-unknown lookup remains authorized while publication is dark", async () => {
    const other = await prisma.user.create({ data: { email: `billing-dark-recovery-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: "unused", emailVerifiedAt: now } });
    const q = await service.createQuote(other.id, "monthly"); const i = await service.prepare(other.id, q.quoteId);
    await service.confirm(other.id, i.instrumentId, http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id));
    http.loseChargeResponse = true; http.unavailableLookups = true;
    const unknown = await service.charge(other.id, { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
      consent: { billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true } });
    expect(unknown.status).toBe("dispatch_unknown");
    expect(await prisma.servicePaidPeriod.findUnique({ where: { attemptId: unknown.attemptId } })).toBeNull();
    http.unavailableLookups = false; now = new Date(now.getTime() + 300_000);
    http.calls.length = 0;
    await dark.reconcileOnce();
    expect(http.calls).toHaveLength(1); expect(http.calls[0].method).toBe("GET");
    expect((await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: unknown.attemptId } })).status).toBe("paid");
    expect(http.cancelCount).toBe(0); expect(http.chargeCount).toBe(2);
  });
});
