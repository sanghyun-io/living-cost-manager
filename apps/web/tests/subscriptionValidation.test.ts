import { expect, test } from "vitest";
import { validSubscription } from "../app/features/service-subscription/billing/subscriptionValidation";
import { now, subscription } from "./billingFixtures";
const active = () => ({ ...subscription(), contractId: "synthetic", planId: "monthly" as const, status: "active" as const, paidAccess: true,
  premiumScope: "account-subscription-v1" as const, paidThrough: "2026-11-07T00:00:00Z", nextChargeAt: "2026-11-07T00:00:00Z" });
test.each(["active", "cancel_at_period_end"] as const)("exact authoritative %s paid coverage accepted", status => expect(validSubscription({ ...active(), status }, "live", now)).toBe(true));
test.each([{ status: "UNKNOWN_FUTURE_STATUS" }, { status: "ACTIVE" }, { status: "ending" }, { status: "idle" }, { status: null },
  { paidThrough: "bad" }, { paidThrough: "2026-02-30T00:00:00Z" }, { paidThrough: "2025-11-07T00:00:00Z" }, { nextChargeAt: "bad" },
  { nextChargeAt: undefined }, { renewalStopped: undefined }, { cancelAtPeriodEnd: "false" }, { providerCancellationStatus: "confirmed" },
  { existingFreeAccess: false }, { premiumScope: "unknown" }, { planId: "pro" }, { mode: "live" }, { currency: "KRW" }])("shared strict contract rejects %j", patch => expect(validSubscription({ ...active(), ...patch }, "live", now)).toBe(false));
test("inactive/free periods and known fields remain safe without paid access", () => {
  expect(validSubscription(subscription(), "live", now)).toBe(true);
  expect(validSubscription({ ...active(), status: "idle", paidAccess: false, paidThrough: "2025-11-07T00:00:00Z", nextChargeAt: null }, "live", now)).toBe(true);
});
test("every required field is required by frozen shared schema", () => {
  for (const key of Object.keys(active())) { const s: Record<string, unknown> = { ...active() }; delete s[key]; expect(validSubscription(s, "live", now), key).toBe(false); }
});
