import { randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveApiTestDatabaseUrl } from "./test-database.js";
import { syntheticApprovedConfiguration, FakePortOneHttp, signedPortOneFixture } from "./service-billing-portone-fixtures.js";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { parseBillingConfiguration } from "../src/services/service-billing-config.js";
import { buildApp } from "../src/app.js";
import { BillingAccountDeleteBlocked, deleteAccount } from "../src/services/account.js";
import { PortOneHttpTransport } from "../src/services/service-billing-portone.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let now: Date; let userId: string; let otherId: string;
const clock = () => new Date(now);
let setup: ReturnType<typeof syntheticApprovedConfiguration>;
let http: FakePortOneHttp; let service: ServiceBillingService;
const password = "synthetic-billing-only-password";
beforeEach(async () => {
  await prisma.serviceBillingEventReceipt.deleteMany(); await prisma.serviceRefundRecord.deleteMany(); await prisma.servicePaidPeriod.deleteMany();
  await prisma.servicePaymentAttempt.deleteMany(); await prisma.serviceBillingInstrument.deleteMany(); await prisma.serviceBillingQuote.deleteMany(); await prisma.serviceSubscriptionContract.deleteMany();
  await prisma.user.deleteMany({ where: { email: { startsWith: "billing-provider-test-" } } });
  now = new Date("2027-01-31T03:00:00.000Z"); setup = syntheticApprovedConfiguration(databaseUrl);
  http = new FakePortOneHttp(setup.manifest, clock); service = new ServiceBillingService(prisma, setup.env, clock, http.provider([setup.secret]));
  const hash = await argon2.hash(password);
  userId = (await prisma.user.create({ data: { email: `billing-provider-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: hash, emailVerifiedAt: now } })).id;
  otherId = (await prisma.user.create({ data: { email: `billing-provider-test-${randomUUID()}@example.invalid`, name: "Synthetic", passwordHash: hash, emailVerifiedAt: now } })).id;
});
afterAll(async () => prisma.$disconnect());
async function prepare(owner = userId, instance = service, fake = http) {
  const q = await instance.createQuote(owner, "monthly"); const i = await instance.prepare(owner, q.quoteId);
  const token = fake.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id);
  await instance.confirm(owner, i.instrumentId, token);
  const input = { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(), consent: {
    billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true as const } };
  return { q, i, token, input };
}

describe("real PortOne adapter with exclusively fake HTTP", () => {
  it("uses official endpoints, verified bindings and authoritative GET; sandbox is not entitlement", async () => {
    const p = await prepare();
    expect(p.i.sdkRequest.channelKey).toBe(setup.manifest.channelKey);
    expect(p.q.approvedMaterial).toEqual(setup.manifest.materials);
    expect(p.q.approvedVersions.featureScope).toBe("features-v1");
    const a = await service.charge(userId, p.input);
    expect(a.status).toBe("paid"); expect(http.chargeCount).toBe(1);
    expect(http.calls.some(c => c.method === "POST" && c.pathname.endsWith("/billing-key"))).toBe(true);
    expect(http.calls.some(c => c.method === "GET" && c.pathname.startsWith("/payments/"))).toBe(true);
    expect((await service.subscription(userId)).paidAccess).toBe(false);
  });
  it("complete synthetic live approvals can expose LIVE paid coverage, never existing-free gating", async () => {
    setup = syntheticApprovedConfiguration(databaseUrl, "live"); http = new FakePortOneHttp(setup.manifest, clock);
    service = new ServiceBillingService(prisma, setup.env, clock, http.provider([setup.secret]));
    const p = await prepare(); const a = await service.charge(userId, p.input);
    expect(service.readiness()).toMatchObject({ checkoutEnabled: true, approvalStatus: "approved", taxTreatment: "inclusive" });
    expect((await service.subscription(userId))).toMatchObject({ paidAccess: true, existingFreeAccess: true, premiumScope: "account-subscription-v1" });
    now = new Date(a.paidPeriod!.endsAt);
    expect((await service.subscription(userId)).paidAccess).toBe(false);
  });
  it("one flag, missing approval material, wrong channel mode or secrets never activate checkout", () => {
    for (const delta of [{ SERVICE_BILLING_APPROVAL_MANIFEST: undefined }, { PORTONE_LCM_API_SECRET: undefined }, { PORTONE_LCM_WEBHOOK_SECRETS: undefined },
      { SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify({ ...setup.manifest, mode: "live" }) },
      { SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify({ ...setup.manifest, policyVersion: "policy-draft-v1" }) },
      { SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify({ ...setup.manifest, materials: {} }) },
      { SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify({ ...setup.manifest, workers: { ...setup.manifest.workers, reconcile: false } }) }]) {
      expect(parseBillingConfiguration({ ...setup.env, ...delta }).enabled).toBe(false);
    }
    expect(() => new ServiceBillingService(prisma, setup.env)).toThrow("Test mode requires");
  });
  it("same idempotency survives lost response and concurrent first POST without rebilling", async () => {
    http.loseChargeResponse = true;
    const p = await prepare();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.charge(userId, p.input)));
    const recovered = await service.byIdempotency(userId, p.input.idempotencyKey);
    expect(new Set(results.map(a => a.attemptId)).size).toBe(1); expect(recovered.status).toBe("paid");
    expect(http.chargeCount).toBe(1);
    await expect(service.byIdempotency(otherId, p.input.idempotencyKey)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.byIdempotency(userId, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    expect(http.chargeCount).toBe(1);
  });
  it("rejects modified material under the same consent version and stale quote versions", async () => {
    const p = await prepare();
    const env = { ...setup.env, SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify({ ...setup.manifest, materials: { ...setup.manifest.materials, billing: "Different content with same version is not accepted." } }) };
    const changed = new ServiceBillingService(prisma, env, clock, http.provider([setup.secret]));
    await expect(changed.charge(userId, p.input)).rejects.toMatchObject({ code: "RECONSENT_REQUIRED" });
    expect(http.chargeCount).toBe(0);
  });
  it.each(["store", "merchant", "channel", "type", "customer", "issuance"])("rejects %s mismatches in issued billing key evidence", async field => {
    const q = await service.createQuote(userId, "monthly"); const i = await service.prepare(userId, q.quoteId);
    const token = http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id); const raw = http.instruments.get(token)!;
    if (field === "store") raw.storeId = "other";
    if (field === "merchant") raw.merchantId = "other";
    if (field === "channel") raw.channels[0].id = "other";
    if (field === "type") raw.channels[0].type = "LIVE";
    if (field === "customer") raw.customer.id = "other";
    if (field === "issuance") delete raw.issueId;
    await expect(service.confirm(userId, i.instrumentId, token)).rejects.toThrow();
    expect(http.chargeCount).toBe(0);
  });
  it("uncertain provider deletion blocks account deletion; verified GET DELETED closes safely", async () => {
    const p = await prepare(); await service.charge(userId, p.input);
    http.unavailableDeletion = true;
    expect((await service.cancel(userId)).providerCancellationStatus).toBe("pending");
    await expect(deleteAccount(prisma, userId, password)).rejects.toBeInstanceOf(BillingAccountDeleteBlocked);
    http.unavailableDeletion = false;
    expect((await service.cancel(userId)).providerCancellationStatus).toBe("verified");
    expect(http.instruments.get(p.token)!.status).toBe("DELETED");
    await deleteAccount(prisma, userId, password);
    expect((await prisma.serviceSubscriptionContract.findFirstOrThrow()).userId).toBeNull();
  });
  it("owned prepared issuance can recover a browser-lost key and revoke; absence isn't false deletion", async () => {
    const q = await service.createQuote(userId, "monthly"); const i = await service.prepare(userId, q.quoteId);
    await expect(service.revokeInstrument(otherId, i.instrumentId)).rejects.toMatchObject({ statusCode: 404 });
    const token = http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id);
    expect((await service.revokeInstrument(userId, i.instrumentId)).status).toBe("revoked");
    expect(http.instruments.get(token)!.status).toBe("DELETED");
    const q2 = await service.createQuote(userId, "monthly"); const i2 = await service.prepare(userId, q2.quoteId);
    expect(await service.revokeInstrument(userId, i2.instrumentId)).toMatchObject({ status: "manual_review", requiresManualReview: true });
    await expect(deleteAccount(prisma, userId, password)).rejects.toBeInstanceOf(BillingAccountDeleteBlocked);
  });
  it("renewal worker reserves exactly one anchored cycle and respects cancellation", async () => {
    const p = await prepare(); const a = await service.charge(userId, p.input); now = new Date(a.paidPeriod!.endsAt);
    await Promise.all([service.renewOnce(), service.renewOnce(), service.renewOnce()]);
    expect(http.chargeCount).toBe(2); expect(await prisma.servicePaidPeriod.count()).toBe(2);
    const periods = await prisma.servicePaidPeriod.findMany({ orderBy: { cycle: "asc" } });
    expect(periods[1]!.startsAt).toEqual(periods[0]!.endsAt);
    expect(periods[1]!.endsAt.toISOString()).toBe("2027-03-30T15:00:00.000Z");
    await service.cancel(userId); now = new Date(now.getTime() + 60 * 86400_000); await service.renewOnce();
    expect(http.chargeCount).toBe(2);
  });
  it("missed expired cycles require reconsent rather than back-billing multiple expired periods", async () => {
    const p = await prepare(); await service.charge(userId, p.input);
    now = new Date("2027-05-01T03:00:00.000Z");
    await expect(service.renew(userId)).rejects.toMatchObject({ code: "RENEWAL_LATE_RECONSENT_REQUIRED" });
    await service.renewOnce(); expect(http.chargeCount).toBe(1); expect(await prisma.servicePaymentAttempt.count()).toBe(1);
  });
  it("refund is request-only until explicit policy/operation approval, then POST once plus authoritative cancellation", async () => {
    const p = await prepare(); const a = await service.charge(userId, p.input);
    const r = await service.requestRefund(userId, a.attemptId, randomUUID(), "other");
    expect(http.cancelCount).toBe(0);
    await expect(service.approveAndExecuteRefund(r.requestId, randomUUID(), "wrong-policy")).rejects.toMatchObject({ code: "REFUND_APPROVAL_REQUIRED" });
    const op = randomUUID();
    await service.approveAndExecuteRefund(r.requestId, op, "policy-v1");
    await service.approveAndExecuteRefund(r.requestId, op, "policy-v1");
    expect(http.cancelCount).toBe(1); expect((await service.refundDto(userId, r.requestId)).status).toBe("verified");
    expect((await service.subscription(userId))).toMatchObject({ paidAccess: false, renewalStopped: true, existingFreeAccess: true });
  });
  it("unrequested authoritative partial cancellation is flagged, never silently treated as an approved refund", async () => {
    const p = await prepare(); const a = await service.charge(userId, p.input); const payment = [...http.payments.values()][0]!;
    payment.amount.cancelled = 100; payment.status = "PARTIAL_CANCELLED"; payment.cancellations = [{ status: "SUCCEEDED", id: "external-cancel", totalAmount: 100, reason: "Unsolicited provider-side cancellation" }];
    await service.reconcile(a.attemptId, true);
    expect((await service.attemptDto(a.attemptId, userId)).reviewRequired).toBe(true);
    expect(await prisma.serviceRefundRecord.count()).toBe(0);
    expect((await service.subscription(userId))).toMatchObject({ paidAccess: false, renewalStopped: true, existingFreeAccess: true });
    await expect(deleteAccount(prisma, userId, password)).rejects.toBeInstanceOf(BillingAccountDeleteBlocked);
  });
  it("changed authoritative paid evidence fails closed instead of retaining premium eligibility", async () => {
    const p = await prepare(); const a = await service.charge(userId, p.input);
    [...http.payments.values()][0]!.channel.type = "LIVE";
    await service.reconcile(a.attemptId, true);
    expect((await service.attemptDto(a.attemptId, userId)).reviewRequired).toBe(true);
    await expect(service.requestRefund(userId, a.attemptId, randomUUID(), "other")).rejects.toMatchObject({ code: "PAYMENT_NOT_REFUNDABLE" });
  });
  it("unknown refund response is fenced, looked up at most eight times and never redispatched", async () => {
    const p = await prepare(); const a = await service.charge(userId, p.input);
    const r = await service.requestRefund(userId, a.attemptId, randomUUID(), "other");
    http.unavailableLookups = true;
    const op = randomUUID();
    await Promise.all([service.approveAndExecuteRefund(r.requestId, op, "policy-v1"), service.approveAndExecuteRefund(r.requestId, op, "policy-v1")]);
    for (let n = 0; n < 10; n++) {
      now = new Date(now.getTime() + 300_000);
      await service.approveAndExecuteRefund(r.requestId, op, "policy-v1");
    }
    const row = await prisma.serviceRefundRecord.findUniqueOrThrow({ where: { id: r.requestId } });
    expect(row).toMatchObject({ status: "manual_review", lookupCount: 8, leaseOwner: null, nextLookupAt: null });
    expect(http.cancelCount).toBe(1);
  });
  it("raw signed webhook queues durable receipts; JSON canonicalization and malformed signatures never reach DB", async () => {
    const p = await prepare(); http.unavailableLookups = true; const a = await service.charge(userId, p.input);
    const row = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    const app = await buildApp({ env: setup.env, prisma, logger: false, serviceBillingProvider: http.provider([setup.secret]), serviceBillingClock: clock });
    const url = "/service-billing/webhooks/portone";
    const signed = signedPortOneFixture(setup.secret, setup.manifest.storeId, row.paymentId, "synthetic_event_1");
    try {
      expect((await app.inject({ method: "POST", url, headers: signed.headers, payload: JSON.stringify(JSON.parse(signed.raw.toString())) })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: signed.raw })).statusCode).toBe(400);
      expect(await prisma.serviceBillingEventReceipt.count()).toBe(0);
      expect((await app.inject({ method: "POST", url, headers: signed.headers, payload: signed.raw })).statusCode).toBe(202);
      expect((await app.inject({ method: "POST", url, headers: signed.headers, payload: signed.raw })).statusCode).toBe(202);
      expect(await prisma.serviceBillingEventReceipt.count()).toBe(1); expect(await prisma.servicePaidPeriod.count()).toBe(0);
      http.unavailableLookups = false; now = new Date(now.getTime() + 60_000); await service.reconcileOnce();
      expect(await prisma.servicePaidPeriod.count()).toBe(1);
      const unknown = signedPortOneFixture(setup.secret, setup.manifest.storeId, "unknown_owned_payment", "synthetic_unknown_event");
      const calls = http.calls.length;
      expect((await app.inject({ method: "POST", url, headers: unknown.headers, payload: unknown.raw })).json()).toMatchObject({ ignored: true });
      expect(http.calls.length).toBe(calls); expect(await prisma.serviceBillingEventReceipt.count()).toBe(1);
    } finally { await app.close(); }
  });
  it("trusted active second webhook secret verifies, unknown signed event ignored and invalid UTF-8 rejected", async () => {
    const second = randomBytes(32); const provider = http.provider([randomBytes(32), second]);
    const signed = signedPortOneFixture(second, setup.manifest.storeId, "payment", "rotated_event");
    expect(await provider.verifyWebhookOrIgnore(signed.raw, signed.headers)).toMatchObject({ eventId: "rotated_event" });
    const unknown = signedPortOneFixture(second, setup.manifest.storeId, "payment", "ignored_event", "Future.Event");
    expect(await provider.verifyWebhookOrIgnore(unknown.raw, unknown.headers)).toBeNull();
    await expect(provider.verifyWebhookOrIgnore(Buffer.from([0xff, 0xfe]), signed.headers)).rejects.toThrow();
  });
  it("HTTP errors/timeout have no raw key/URL/provider body in exceptions and never retry", async () => {
    let calls = 0;
    const transport = new PortOneHttpTransport("synthetic_secret_not_for_logging", async () => { calls++; throw new Error("synthetic-private-provider-body"); });
    try { await transport.getBillingKeyInfo({ billingKey: "synthetic_sensitive_token", storeId: "store" }); throw new Error("Expected error"); }
    catch (error) { expect(String(error)).toBe("Error: PORTONE_UNAVAILABLE"); expect(String(error)).not.toContain("sensitive"); }
    expect(calls).toBe(1);
    const timeout = new PortOneHttpTransport("synthetic", async (_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("Aborted")))), 5);
    await expect(timeout.getPayment({ paymentId: "payment", storeId: "store" })).rejects.toThrow("PORTONE_UNAVAILABLE");
  });
});
