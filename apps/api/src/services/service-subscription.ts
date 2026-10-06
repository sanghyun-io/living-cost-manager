import { previewServicePrice, SERVICE_PRICING } from "@living-cost-manager/shared";

// Preparatory server domain only. No route, SDK, credential, worker or DB write.
// Never accept these records from a browser. The future repository must lock the
// account + attempt and persist reconciliation/period/event receipt atomically.
export type PlanId = "monthly" | "annual";
export type Quote = ReturnType<typeof previewServicePrice>;
export const BILLING_TIME_ZONE = "Asia/Seoul";

/** Original calendar anchor, never the previously clamped renewal date. */
export function periodBoundary(anchor: string, planId: PlanId, cycle: number): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor);
  if (!match || !Number.isSafeInteger(cycle) || cycle < 0) throw new TypeError("Invalid cycle anchor");
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 2000 || year > 9999 || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new TypeError("Invalid calendar date");
  const quote = previewServicePrice({ planId });
  const targetMonth = year * 12 + month - 1 + cycle * quote.periodMonths;
  if (!Number.isSafeInteger(targetMonth) || targetMonth > 9999 * 12 + 11) throw new TypeError("Cycle outside supported calendar");
  const targetYear = Math.floor(targetMonth / 12), monthIndex = targetMonth % 12;
  const clampedDay = Math.min(day, new Date(Date.UTC(targetYear, monthIndex + 1, 0)).getUTCDate());
  // Korea has no DST in this supported range; billing boundary is local midnight.
  return new Date(Date.UTC(targetYear, monthIndex, clampedDay, -9));
}

export type Attempt = Readonly<{
  accountId: string;
  paymentId: string;
  merchantId: string;
  environment: "sandbox";
  quote: Quote;
  anchor: string;
  cycle: number;
  status: "pending" | "failed" | "paid" | "refund_review";
  reconciledAt: number;
}>;
/** A server-to-provider lookup result, NOT a webhook or browser payload. */
export type VerifiedObservation = Readonly<{
  paymentId: string;
  merchantId: string;
  environment: "sandbox" | "live";
  currency: string;
  amount: number;
  status: "pending" | "failed" | "paid" | "refunded";
  fetchedAt: number;
}>;

export function createSandboxAttempt(input: {
  accountId: string; paymentId: string; merchantId: string; plan: unknown; anchor: string; cycle: number;
}): Attempt {
  for (const value of [input.accountId, input.paymentId, input.merchantId]) {
    if (!value || value.length > 200) throw new TypeError("Invalid server reference");
  }
  const quote = previewServicePrice(input.plan);
  periodBoundary(input.anchor, quote.planId, input.cycle);
  periodBoundary(input.anchor, quote.planId, input.cycle + 1);
  return Object.freeze({ accountId: input.accountId, paymentId: input.paymentId, merchantId: input.merchantId,
    environment: "sandbox", quote, anchor: input.anchor, cycle: input.cycle, status: "pending", reconciledAt: -1 });
}

/** Retry a failed lookup with the SAME payment ID; this function never charges.
 * Return one immutable period only on the first verified paid transition.
 * Persistence must enforce UNIQUE(paymentId), UNIQUE(accountId, cycle/contract).
 */
export function reconcileAttempt(attempt: Attempt, observation: VerifiedObservation) {
  if (observation.paymentId !== attempt.paymentId || observation.merchantId !== attempt.merchantId ||
      observation.environment !== attempt.environment || observation.currency !== attempt.quote.currency ||
      !Number.isSafeInteger(observation.amount) || observation.amount !== attempt.quote.totalAmount ||
      !Number.isSafeInteger(observation.fetchedAt) || observation.fetchedAt < 0) {
    throw new TypeError("Provider observation does not match server attempt");
  }
  if (!["pending", "failed", "paid", "refunded"].includes(observation.status)) throw new TypeError("Unknown provider status");
  if (observation.fetchedAt <= attempt.reconciledAt) return { attempt, outcome: "stale" as const, period: null };
  // Refunds need a separate verified refund ledger + approved access policy.
  // An older failure notification can never revoke an already paid period.
  const status = observation.status === "refunded" ? "refund_review" :
    attempt.status === "refund_review" ? "refund_review" :
    attempt.status === "paid" ? "paid" : observation.status;
  const next: Attempt = Object.freeze({ ...attempt, status, reconciledAt: observation.fetchedAt });
  const period = status === "paid" && attempt.status !== "paid" ? Object.freeze({
    accountId: attempt.accountId, paymentId: attempt.paymentId,
    startsAt: periodBoundary(attempt.anchor, attempt.quote.planId, attempt.cycle).toISOString(),
    endsAt: periodBoundary(attempt.anchor, attempt.quote.planId, attempt.cycle + 1).toISOString()
  }) : null;
  return { attempt: next, outcome: period ? "settled" as const : "observed" as const, period };
}

export type PaidPeriod = NonNullable<ReturnType<typeof reconcileAttempt>["period"]>;

/** Lifecycle proposal in sandbox; does NOT cancel a provider schedule/account.
 * Cancellation is an independent intent so a delayed paid callback cannot erase it.
 * Grace/retry and refund access are deliberately not decided by this model.
 */
export function describeSandboxLifecycle(attempt: Attempt, period: PaidPeriod | null,
  cancelFutureCharges: boolean, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid lifecycle clock");
  if (period && (period.accountId !== attempt.accountId || period.paymentId !== attempt.paymentId ||
      period.startsAt !== periodBoundary(attempt.anchor, attempt.quote.planId, attempt.cycle).toISOString() ||
      period.endsAt !== periodBoundary(attempt.anchor, attempt.quote.planId, attempt.cycle + 1).toISOString())) {
    throw new TypeError("Period does not match server attempt");
  }
  const state = attempt.status === "refund_review" ? "refund_review" :
    attempt.status === "failed" ? "payment_failed" :
    attempt.status !== "paid" || !period ? "pending" :
    now.getTime() < Date.parse(period.startsAt) ? "scheduled" :
    now.getTime() >= Date.parse(period.endsAt) ? "expired" :
    cancelFutureCharges ? "ending" : "paid_period";
  return Object.freeze({ state, cancelFutureCharges, nextChargeAllowed: false as const,
    cancellationExecuted: false as const, paidThrough: period?.endsAt ?? null });
}

/** Existing free access stays intact. No local paid flag or sandbox unlock. */
export function resolveServiceEntitlement(accountId: string, periods: readonly PaidPeriod[], now: Date) {
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid entitlement clock");
  const covered = periods.some(p => p.accountId === accountId &&
    Date.parse(p.startsAt) <= now.getTime() && now.getTime() < Date.parse(p.endsAt));
  return Object.freeze({ tier: "free" as const, paidAccess: false,
    reason: SERVICE_PRICING.checkoutEnabled ? "activation_requires_review" : "billing_not_enabled",
    // Do not expose candidate periods or payment references to client telemetry.
    sandboxPeriodCovered: covered });
}
