import { describe, expect, test } from "vitest";
import { createSandboxAttempt, describeSandboxLifecycle, periodBoundary, reconcileAttempt,
  resolveServiceEntitlement, type VerifiedObservation } from "../src/services/service-subscription.js";

const attempt = (planId = "monthly") => createSandboxAttempt({ accountId: "account-a", paymentId: "payment-a",
  merchantId: "lcm-test-only", plan: { planId }, anchor: "2024-01-31", cycle: 0 });
const observation = (overrides: Partial<VerifiedObservation> = {}): VerifiedObservation => ({
  paymentId: "payment-a", merchantId: "lcm-test-only", environment: "sandbox", currency: "KRW", amount: 990,
  status: "paid", fetchedAt: 100, ...overrides });

describe("LCM server billing preparation (never real payment)", () => {
  test.each([
    ["2024-01-31", "monthly", 1, "2024-02-28T15:00:00.000Z"],
    ["2024-01-31", "monthly", 2, "2024-03-30T15:00:00.000Z"],
    ["2023-01-31", "monthly", 1, "2023-02-27T15:00:00.000Z"],
    ["2024-02-29", "annual", 1, "2025-02-27T15:00:00.000Z"],
    ["2024-02-29", "annual", 4, "2028-02-28T15:00:00.000Z"],
    ["2024-12-31", "monthly", 1, "2025-01-30T15:00:00.000Z"],
    ["2024-04-30", "monthly", 1, "2024-05-29T15:00:00.000Z"]
  ])("original anchor %s / %s cycle %s uses Korean midnight", (anchor, plan, cycle, expected) => {
    expect(periodBoundary(anchor as string, plan as "monthly" | "annual", cycle as number).toISOString()).toBe(expected);
  });
  test.each(["2023-02-29", "2024-02-30", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-1", "1999-12-31", "not-a-date"])("rejects invalid anchor %s", anchor => {
    expect(() => periodBoundary(anchor, "monthly", 0)).toThrow();
  });
  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid cycle %s", cycle => {
    expect(() => createSandboxAttempt({ accountId: "a", paymentId: "p", merchantId: "m", plan: { planId: "monthly" }, anchor: "2024-01-31", cycle })).toThrow();
  });
  test("catalog reuse is immutable, annual quote is total not monthly equivalent", () => {
    const a = attempt("annual");
    expect(a.quote).toMatchObject({ totalAmount: 9900, currency: "KRW", checkoutEnabled: false });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.quote)).toBe(true);
    expect(() => createSandboxAttempt({ accountId: "a", paymentId: "p", merchantId: "m", plan: { planId: "monthly", amount: 1 }, anchor: "2024-01-31", cycle: 0 })).toThrow();
  });
  test.each([
    { amount: 825 }, { amount: 990.1 }, { amount: NaN }, { currency: "USD" }, { paymentId: "other" },
    { merchantId: "harudo" }, { environment: "live" }, { fetchedAt: -1 }, { fetchedAt: Infinity }, { fetchedAt: 0.1 }
  ] as Partial<VerifiedObservation>[])("mismatched provider facts cannot settle: %j", fields => {
    expect(() => reconcileAttempt(attempt(), observation(fields))).toThrow();
  });
  test("duplicate events with new fetch times produce only one paid period", () => {
    const first = reconcileAttempt(attempt(), observation());
    expect(first.outcome).toBe("settled");
    const duplicate = reconcileAttempt(first.attempt, observation({ fetchedAt: 101 }));
    expect(duplicate.period).toBeNull();
    expect(reconcileAttempt(first.attempt, observation()).outcome).toBe("stale");
  });
  test("stale and delayed failure cannot revoke or extend paid period", () => {
    const paid = reconcileAttempt(attempt(), observation());
    expect(reconcileAttempt(paid.attempt, observation({ status: "failed", fetchedAt: 99 })).outcome).toBe("stale");
    const late = reconcileAttempt(paid.attempt, observation({ status: "failed", fetchedAt: 101 }));
    expect(late.attempt.status).toBe("paid");
    expect(late.period).toBeNull();
  });
  test("provider lookup error changes nothing; retry same ID after failure can settle once", () => {
    const original = attempt();
    const failed = reconcileAttempt(original, observation({ status: "failed" }));
    expect(failed.period).toBeNull();
    expect(original.status).toBe("pending");
    const retry = reconcileAttempt(failed.attempt, observation({ fetchedAt: 101 }));
    expect(retry.attempt.paymentId).toBe(original.paymentId);
    expect(retry.outcome).toBe("settled");
  });
  test("refund before or after paid requires review and delayed paid cannot grant again", () => {
    for (const initial of [attempt(), reconcileAttempt(attempt(), observation()).attempt]) {
      const refund = reconcileAttempt(initial, observation({ status: "refunded", fetchedAt: 101 }));
      expect(refund.attempt.status).toBe("refund_review");
      expect(refund.period).toBeNull();
      expect(reconcileAttempt(refund.attempt, observation({ fetchedAt: 102 })).period).toBeNull();
    }
  });
  test("cancel intent survives settlement; term is half-open with no renewal execution", () => {
    const paid = reconcileAttempt(attempt(), observation());
    const period = paid.period!;
    expect(describeSandboxLifecycle(paid.attempt, period, true, new Date(period.startsAt))).toMatchObject({ state: "ending", nextChargeAllowed: false, cancellationExecuted: false });
    expect(describeSandboxLifecycle(paid.attempt, period, false, new Date(period.endsAt))).toMatchObject({ state: "expired", nextChargeAllowed: false });
    expect(describeSandboxLifecycle(paid.attempt, period, false, new Date(Date.parse(period.startsAt) - 1)).state).toBe("scheduled");
    expect(() => describeSandboxLifecycle(paid.attempt, { ...period, accountId: "other" }, true, new Date())).toThrow();
  });
  test("entitlement is server-only and hard disabled; sandbox paid and local UI cannot unlock", () => {
    const paid = reconcileAttempt(attempt(), observation());
    const now = new Date(paid.period!.startsAt);
    expect(resolveServiceEntitlement("account-a", [paid.period!], now)).toMatchObject({ paidAccess: false, tier: "free", sandboxPeriodCovered: true });
    expect(resolveServiceEntitlement("other", [paid.period!], now).sandboxPeriodCovered).toBe(false);
    expect(resolveServiceEntitlement("account-a", [paid.period!], new Date(paid.period!.endsAt)).sandboxPeriodCovered).toBe(false);
    expect(() => resolveServiceEntitlement("account-a", [], new Date(NaN))).toThrow();
  });
});
