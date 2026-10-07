import { expect, test } from "vitest";
import { isoTimestamp, validSubscription } from "../app/subscription/billing/subscriptionValidation";
import type { Subscription } from "../app/subscription/billing/types";
const now = Date.parse("2026-10-07T00:00:00Z");
const active = (): Subscription => ({ contractId: "synthetic", planId: "monthly", status: "active", paidAccess: true,
  paidThrough: "2026-11-07T00:00:00Z", nextChargeAt: "2026-11-07T00:00:00Z", cancelAtPeriodEnd: false,
  renewalStopped: false, providerCancellationStatus: "unconfirmed", existingFreeAccess: true });
test.each(["active", "ending"] as const)("known %s current period allows server access", status => {
  expect(validSubscription({ ...active(), status }, "live", now)).toBe(true);
});
test.each([{ status: "UNKNOWN_FUTURE_STATUS" }, { status: "ACTIVE" }, { status: "expired" }, { status: "pending" },
  { paidThrough: "bad" }, { paidThrough: "2026-02-30T00:00:00Z" }, { paidThrough: "2025-11-07T00:00:00Z" },
  { nextChargeAt: "bad" }, { nextChargeAt: "2026-10-08T00:00:00Z" }, { nextChargeAt: undefined },
  { cancelAtPeriodEnd: "false" }, { renewalStopped: undefined }, { providerCancellationStatus: "UNKNOWN" },
  { providerCancellationStatus: "CONFIRMED" }, { existingFreeAccess: false }, { planId: "pro" },
  { mode: "sandbox" }, { mode: "unknown" }, { currency: "USD" }, { cancellationProof: { allChargePathsStopped: true } },
  { premiumScope: "arbitrary" }, { premiumScope: { version: "v", features: [false] } }])("rejects incomplete/unknown subscription %j", patch => {
  expect(validSubscription({ ...active(), ...patch }, "live", now)).toBe(false);
});
test("free/null and historical closed states remain valid without paid entitlement", () => {
  const free = { ...active(), contractId: null, planId: null, paidAccess: false, paidThrough: null, nextChargeAt: null };
  expect(validSubscription({ ...free, status: "free" }, "live", now)).toBe(true);
  expect(validSubscription({ ...free, status: null }, "live", now)).toBe(true);
  expect(validSubscription({ ...active(), status: "closed", paidAccess: false, paidThrough: "2025-11-07T00:00:00Z", nextChargeAt: null }, "live", now)).toBe(true);
  expect(validSubscription({ ...active(), paidAccess: false }, "live", now)).toBe(true);
});
test("every required subscription field is required, no missing fields masquerade as verified access", () => {
  for (const field of Object.keys(active())) {
    const s = { ...active() } as Record<string, unknown>; delete s[field];
    expect(validSubscription(s, "live", now), field).toBe(false);
  }
});
test("ISO timestamp validation rejects rollover, non-ISO and non-finite dates", () => {
  for (const value of ["2026-02-30T00:00:00Z", "2026-10-07", "2026-13-01T00:00:00Z", "Infinity", null, 1]) expect(isoTimestamp(value)).toBe(false);
  expect(isoTimestamp("2026-10-07T00:00:00.000Z")).toBe(true);
});
