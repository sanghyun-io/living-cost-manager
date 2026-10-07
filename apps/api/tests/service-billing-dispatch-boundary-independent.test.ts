import { randomUUID } from "node:crypto";
import { PrismaClient, type ServicePaymentAttempt } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceBillingService } from "../src/services/service-billing.js";
import { FakePortOneHttp, syntheticApprovedConfiguration } from "./service-billing-portone-fixtures.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

// Real PostgreSQL and runtime service, not a model of the dispatch guard. The
// adapter hook runs AFTER the reservation COMMIT and BEFORE dispatch can start.
// It never patches a service method or changes a transaction's returned value.
const databaseUrl = resolveApiTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let now: Date;
const clock = () => new Date(now);
let http: FakePortOneHttp;
let service: ServiceBillingService;
let userId: string;
let setup: ReturnType<typeof syntheticApprovedConfiguration>;
let afterReservation: ((attempt: ServicePaymentAttempt) => Promise<void>) | undefined;
let boundaryHits: number;
let proof: { reservedAt: string; claimClock: string; committedStatus: string; dispatchAt: Date | null };

const hookedPrisma = new Proxy(prisma, {
  get(target, property) {
    if (property === "$transaction") return async (...args: unknown[]) => {
      const result = await (target.$transaction as Function).apply(target, args);
      if (afterReservation && result?.cycle === 1 && result?.status === "created" && !result?.dispatchAt) {
        const hook = afterReservation; afterReservation = undefined; boundaryHits++;
        const committed = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { id: result.id } });
        proof = { reservedAt: now.toISOString(), claimClock: "", committedStatus: committed.status, dispatchAt: committed.dispatchAt };
        await hook(committed);
        proof.claimClock = now.toISOString();
      }
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  }
});
beforeEach(async () => {
  now = new Date("2027-01-31T03:00:00.000Z"); afterReservation = undefined; boundaryHits = 0;
  setup = syntheticApprovedConfiguration(databaseUrl);
  http = new FakePortOneHttp(setup.manifest, clock);
  service = new ServiceBillingService(hookedPrisma, setup.env, clock, http.provider([setup.secret]));
  userId = (await prisma.user.create({ data: { email: `dispatch-boundary-test-${randomUUID()}@example.invalid`,
    name: "Synthetic boundary", passwordHash: "synthetic-not-a-login", emailVerifiedAt: now } })).id;
  const q = await service.createQuote(userId, "monthly");
  const i = await service.prepare(userId, q.quoteId);
  await service.confirm(userId, i.instrumentId, http.issue(i.sdkRequest.issueId, i.sdkRequest.customer.id));
  const paid = await service.charge(userId, { quoteId: q.quoteId, instrumentId: i.instrumentId, idempotencyKey: randomUUID(),
    consent: { billingVersion: q.consentVersions.billing, autoRenewVersion: q.consentVersions.autoRenew, accepted: true } });
  expect(paid.status).toBe("paid"); expect(http.chargeCount).toBe(1);
  now = new Date(paid.paidPeriod!.endsAt); // Feb28 00:00 KST, exactly eligible
  expect(now.toISOString()).toBe("2027-02-27T15:00:00.000Z");
});
afterAll(async () => prisma.$disconnect());

async function renewal() {
  const outcome = await service.renew(userId).then(value => ({ value }), error => ({ error }));
  const c = await prisma.serviceSubscriptionContract.findUniqueOrThrow({ where: { userId } });
  const a = await prisma.servicePaymentAttempt.findUniqueOrThrow({ where: { contractId_cycle: { contractId: c.id, cycle: 1 } } });
  expect(boundaryHits).toBe(1);
  expect(proof.committedStatus).toBe("created"); expect(proof.dispatchAt).toBeNull();
  const period = await prisma.servicePaidPeriod.findUnique({ where: { attemptId: a.id } });
  console.log(JSON.stringify({ synthetic: true, boundary: proof, renewalDispatches: http.chargeCount - 1,
    finalStatus: a.status, dispatchIntentWritten: !!a.dispatchAt, dispatchAt: a.dispatchAt,
    period: period ? { startsAt: period.startsAt, endsAt: period.endsAt } : null,
    renewalStopped: c.renewalStopped, renewalReviewRequired: c.renewalReviewRequired }));
  return { outcome, c, a };
}
async function expectBlocked(a: ServicePaymentAttempt) {
  expect.soft(http.chargeCount - 1, "ZERO renewal provider charges after the committed boundary").toBe(0);
  expect.soft(a.dispatchAt, "no durable intent permitting provider I/O").toBeNull();
  expect.soft(a.status).toBe("canceled_before_dispatch");
  expect.soft(await prisma.servicePaidPeriod.count({ where: { attemptId: a.id } })).toBe(0);
}
describe("independent reservation-to-dispatch financial boundary", () => {
  it.each(["2027-04-01T00:00:00.000Z", "2027-03-30T15:00:00.000Z", "2027-03-30T15:00:00.001Z", "2027-02-27T15:00:00.001Z"])(
    "REQUIRED FIX: committed eligible reservation cannot dispatch at late clock %s", async late => {
      afterReservation = async () => { now = new Date(late); };
      const { c, a } = await renewal();
      await expectBlocked(a);
      expect.soft(c.renewalStopped, "late/skipped cycle must stop durably, not invent arrears").toBe(true);
      expect.soft(c.renewalReviewRequired).toBe(true);
      expect.soft(c.nextCycle).toBe(1);
    });
  it.each(["renewalStopped", "renewalReviewRequired", "both"])(
    "REQUIRED FIX: %s committed between reservation and claim blocks at unchanged due clock", async flag => {
      afterReservation = async a => {
        await prisma.serviceSubscriptionContract.update({ where: { id: a.contractId }, data: {
          ...(flag !== "renewalReviewRequired" ? { renewalStopped: true } : {}),
          ...(flag !== "renewalStopped" ? { renewalReviewRequired: true } : {}) } });
      };
      const { c, a } = await renewal();
      expect(proof.claimClock).toBe(proof.reservedAt);
      await expectBlocked(a);
      expect.soft(c.renewalStopped || c.renewalReviewRequired).toBe(true);
      expect.soft(c.nextCycle).toBe(1);
    });
  it("control: cancelRequested at the same boundary already prevents dispatch", async () => {
    afterReservation = async a => { await prisma.serviceSubscriptionContract.update({ where: { id: a.contractId }, data: { cancelRequested: true } }); };
    const { a } = await renewal(); await expectBlocked(a);
  });
  it("control: unchanged eligible due clock dispatches exactly once", async () => {
    afterReservation = async () => {};
    const { a } = await renewal();
    expect(http.chargeCount).toBe(2); expect(a.status).toBe("paid");
    const period = await prisma.servicePaidPeriod.findUniqueOrThrow({ where: { attemptId: a.id } });
    expect(period.startsAt.toISOString()).toBe("2027-02-27T15:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2027-03-30T15:00:00.000Z");
  });
  it("error control: committed dispatch_unknown must only GET the same ID even after expiry and restart", async () => {
    afterReservation = async () => {};
    http.loseChargeResponse = true; http.unavailableLookups = true;
    const { a } = await renewal(); expect(a.status).toBe("dispatch_unknown");
    const lookups: string[] = [];
    const provider = http.provider([setup.secret]);
    const get = provider.getPayment.bind(provider);
    provider.getPayment = async id => { lookups.push(id); return get(id); };
    const restarted = new ServiceBillingService(prisma, setup.env, clock, provider);
    now = new Date("2027-04-01T00:00:00.000Z");
    await restarted.renew(userId);
    for (let n = 0; n < 3; n++) { now = new Date(now.getTime() + 3600000); await restarted.reconcile(a.id); }
    expect(lookups.length).toBeGreaterThan(0); expect(new Set(lookups)).toEqual(new Set([a.paymentId]));
    expect(http.chargeCount).toBe(2);
    expect(await prisma.servicePaymentAttempt.count({ where: { contractId: a.contractId, cycle: 1 } })).toBe(1);
    expect(await prisma.servicePaidPeriod.count({ where: { attemptId: a.id } })).toBe(0);
  });
});
