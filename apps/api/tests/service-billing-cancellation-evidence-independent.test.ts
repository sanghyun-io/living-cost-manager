import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Payment } from "@portone/server-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { PortOneHttpTransport, PortOneServiceBillingProvider } from "../src/services/service-billing-portone.js";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { FakePortOneHttp, syntheticApprovedConfiguration } from "./service-billing-portone-fixtures.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

// Trust boundary: malformed authoritative provider HTTP evidence, NOT an
// unauthenticated client exploit. No SDK/provider network or real approvals.
// SDK 0.19.0 PaymentAmount.cancelled is aggregate; a SUCCEEDED cancellation's
// official amount field is totalAmount (not an invented cancelledAmount).
const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const now = new Date("2027-01-31T03:00:00.000Z");
const setup = syntheticApprovedConfiguration(databaseUrl);
const scope = setup.manifest;
const cancellation = (amount: number, id = "synthetic-cancellation"): Payment.SucceededPaymentCancellation => ({
  status: "SUCCEEDED", id, totalAmount: amount, taxFreeAmount: 0, vatAmount: 0,
  reason: "Synthetic upstream cancellation", requestedAt: now.toISOString(), cancelledAt: now.toISOString()
});
function fixture(status: "PAID" | "CANCELLED" | "PARTIAL_CANCELLED", cancelled = 0,
  cancellations: Payment.PaymentCancellation[] = []): Payment.PaidPayment | Payment.CancelledPayment | Payment.PartialCancelledPayment {
  const base = { id: "synthetic-payment", transactionId: "synthetic-transaction", merchantId: scope.merchantId, storeId: scope.storeId,
    channel: { id: scope.channelId, type: "TEST" as const, pgProvider: "NICE" as const, pgMerchantId: "synthetic-pg" }, version: "V2" as const,
    orderName: "Synthetic subscription", requestedAt: now.toISOString(), updatedAt: now.toISOString(), statusChangedAt: now.toISOString(),
    customer: { id: "synthetic-subject" }, currency: "KRW" as const, paidAt: now.toISOString(), cancelledAt: now.toISOString(),
    amount: { total: 990, paid: 990, taxFree: 0, discount: 0, cancelled, cancelledTaxFree: 0 }, cancellations };
  if (status === "PAID") return { ...base, status, disputes: [] };
  if (status === "CANCELLED") return { ...base, status };
  return { ...base, status };
}
function providerFor(raw: unknown) {
  const fetcher: typeof fetch = async (_url, init) => {
    expect(init?.method).toBe("GET"); return Response.json(raw);
  };
  return new PortOneServiceBillingProvider(scope, new PortOneHttpTransport("synthetic-only", fetcher), [setup.secret]);
}
afterAll(async () => prisma.$disconnect());

const inconsistent = [
  { name: "CANCELLED with zero cancellation and empty entries", raw: fixture("CANCELLED") },
  { name: "CANCELLED with only partial amount despite matching sum", raw: fixture("CANCELLED", 330, [cancellation(330)]) },
  { name: "PARTIAL_CANCELLED with zero cancellation and empty entries", raw: fixture("PARTIAL_CANCELLED") },
  { name: "PARTIAL_CANCELLED with full cancellation despite matching sum", raw: fixture("PARTIAL_CANCELLED", 990, [cancellation(990)]) },
  { name: "PAID with partial cancellation despite matching sum", raw: fixture("PAID", 330, [cancellation(330)]) },
  { name: "PAID with full cancellation despite matching sum", raw: fixture("PAID", 990, [cancellation(990)]) }
];
describe("independent official status/amount cancellation consistency", () => {
  it.each(inconsistent)("REQUIRED FIX: $name is invalid evidence, never normalize to PAID", async ({ raw }) => {
    await expect(providerFor(raw).getPayment(raw.id)).rejects.toMatchObject({ code: "PORTONE_INVALID_EVIDENCE" });
  });
  it.each([
    { name: "cancelled exceeds total", raw: fixture("CANCELLED", 991, [cancellation(991)]) },
    { name: "negative aggregate", raw: fixture("PARTIAL_CANCELLED", -1) },
    { name: "noninteger aggregate", raw: fixture("PARTIAL_CANCELLED", 0.5, [cancellation(0.5)]) },
    { name: "successful sum mismatches aggregate", raw: fixture("PARTIAL_CANCELLED", 330, [cancellation(329)]) },
    { name: "missing successful entries for full cancellation", raw: fixture("CANCELLED", 990) },
    { name: "duplicate successful cancellation IDs", raw: fixture("PARTIAL_CANCELLED", 330, [cancellation(165), cancellation(165)]) },
    { name: "negative cancellation entry", raw: fixture("PARTIAL_CANCELLED", 330, [cancellation(-330)]) },
    { name: "noninteger cancellation entry", raw: fixture("PARTIAL_CANCELLED", 330, [cancellation(330.5)]) },
    { name: "zero cancellation entry", raw: fixture("PARTIAL_CANCELLED", 330, [cancellation(0)]) },
    { name: "requested entry cannot prove succeeded amount", raw: fixture("PARTIAL_CANCELLED", 330,
      [{ ...cancellation(330), status: "REQUESTED" } as Payment.RequestedPaymentCancellation]) }
  ])("control: $name rejects malformed amounts/evidence", async ({ raw }) => {
    await expect(providerFor(raw).getPayment(raw.id)).rejects.toMatchObject({ code: "PORTONE_INVALID_EVIDENCE" });
  });
  it.each([
    fixture("PAID"), fixture("CANCELLED", 990, [cancellation(990)]),
    fixture("PARTIAL_CANCELLED", 330, [cancellation(100, "first"), cancellation(230, "second")])
  ])("control: consistent official $status evidence can retain legacy PAID normalization", async raw => {
    // Observation normalization is deliberately distinct from granting coverage;
    // this test makes no partial-refund or prorating business-policy decision.
    expect(await providerFor(raw).getPayment(raw.id)).toMatchObject({ status: "PAID", cancelledAmount: raw.amount.cancelled,
      cancellations: raw.cancellations?.filter((c): c is Payment.SucceededPaymentCancellation => c.status === "SUCCEEDED")
        .map(c => ({ cancelId: c.id, amount: c.totalAmount, reason: c.reason })) ?? [] });
  });
  it.each(["CANCELLED", "PARTIAL_CANCELLED"] as const)(
    "REQUIRED FIX: initial settlement of contradictory %s/zero evidence grants no period and persists review", async status => {
      const http = new FakePortOneHttp(scope, () => new Date(now));
      const fetcher: typeof fetch = async (url, init) => {
        const response = await http.fetch(url, init);
        if (init?.method === "GET" && new URL(String(url)).pathname.startsWith("/payments/") && response.ok) {
          const raw = await response.json();
          return Response.json({ ...raw, status, amount: { ...raw.amount, cancelled: 0 }, cancellations: [] });
        }
        return response;
      };
      const provider = new PortOneServiceBillingProvider(scope, new PortOneHttpTransport("synthetic-only", fetcher), [setup.secret]);
      const service = new ServiceBillingService(prisma, setup.env, () => new Date(now), provider);
      const userId = (await prisma.user.create({ data: { email: `cancel-evidence-test-${randomUUID()}@example.invalid`,
        name: "Synthetic upstream", passwordHash: "synthetic-not-a-login", emailVerifiedAt: now } })).id;
      const q = await service.createQuote(userId, "monthly"); const i = await service.prepare(userId, q.quoteId);
      await service.confirm(userId, i.instrumentId, http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id));
      const result = await service.charge(userId, { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
        consent: { billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true } });
      const c = await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } });
      console.log(JSON.stringify({ synthetic: true, upstreamStatus: status, upstreamCancelled: 0, attemptStatus: result.status,
        periodGranted: !!result.paidPeriod, nextCycle: c.nextCycle }));
      expect.soft(result.status).toBe("manual_review"); expect.soft(result.paidPeriod).toBeNull();
      expect.soft(await prisma.servicePaidPeriod.count({ where: { attemptId: result.attemptId } })).toBe(0);
      expect.soft(c.originalAnchor).toBeNull(); expect.soft(c.nextCycle).toBe(0);
      expect(http.chargeCount).toBe(1); // no hidden charge retry after bad evidence
      await service.poll(userId, result.attemptId); expect(http.chargeCount).toBe(1);
    });
});
