import { expect, test, vi } from "vitest";
import { BillingController, checkoutReady, renewalConfirmed, validQuote } from "../app/subscription/billing/controller";
import { BillingError, createBillingApi } from "../app/subscription/billing/api";
import { browserBillingSdk } from "../app/subscription/billing/sdk";
import type { BillingApi, Subscription } from "../app/subscription/billing/types";
import { approved, attempt, fixture, now, quote, readiness, ready, subscription } from "./billingFixtures";
test("OFF / mock without local adapter never prepares or loads SDK", async () => {
  const f = fixture(); f.api.readiness.mockResolvedValue({ ...readiness(), checkoutEnabled: false }); await ready(f); await f.controller.pay();
  expect(f.api.prepare).not.toHaveBeenCalled(); expect(f.sdk.issue).not.toHaveBeenCalled();
  expect(checkoutReady(readiness(), { issue: f.sdk.issue })).toBe(false);
  expect(checkoutReady(readiness(), browserBillingSdk("living-cost-manager.gamja.top"))).toBe(false);
});
test("local mock has explicit draft material and no provider calls", async () => {
  const sdk = browserBillingSdk("localhost"); expect(checkoutReady(readiness(), sdk)).toBe(true);
  expect(await sdk.issue({ storeId: "fixture", issueId: "own-issued-id", customer: { customerId: "opaque" }, billingKeyMethod: "CARD" }, "mock")).toEqual({ billingKey: "mock_own-issued-id" });
});
test.each(["issueInstrument", "charge", "renew"] as const)("distinct %s gate fails closed", capability => {
  const r = readiness(); r.capabilities[capability] = false; expect(checkoutReady(r, fixture().sdk)).toBe(false);
});
test.each([{ approvalStatus: "blocked" }, { taxTreatment: "pending" }, { approvedMaterial: null }, { blockingCodes: ["NOT_READY"] },
  { sdkConfig: { storeId: "s", channelId: "c" } }])("real approvals require complete evidence %j", patch => {
  expect(checkoutReady({ ...approved(), ...patch } as ReturnType<typeof approved>, fixture().sdk)).toBe(false);
});
test("consents start separate/unchecked and reset on explicit new quote", async () => {
  const f = fixture(); await f.controller.load(true); await f.controller.quote("monthly"); expect(f.controller.canPay()).toBe(false);
  f.controller.consent("billing", true); expect(f.controller.canPay()).toBe(false); f.controller.consent("renewal", true); expect(f.controller.canPay()).toBe(true);
  await f.controller.quote("monthly"); expect(f.controller.state.billingConsent).toBe(false); expect(f.controller.state.renewalConsent).toBe(false);
});
test.each(["featureScope", "policy", "seller", "billing", "autoRenew"] as const)("immutable %s version mismatch requires reconfirmation", field => {
  const r = approved(), q = quote(r); q.approvedVersions[field] = "changed"; expect(validQuote(q, r, "monthly", now)).toBe(false);
});
test.each(["features", "policy", "seller", "billing", "autoRenew"] as const)("immutable %s plaintext mismatch is rejected", field => {
  const r = approved(), q = quote(r); q.approvedMaterial![field] = "changed"; expect(validQuote(q, r, "monthly", now)).toBe(false);
});
test.each([{ totalAmount: 1 }, { currency: "USD" }, { periodMonths: 2 }, { catalogVersion: "changed" }, { expiresAt: "2020-01-01" }, { mode: "live" }])("strict quote rejects %j", patch => {
  expect(validQuote({ ...quote(), ...patch } as ReturnType<typeof quote>, readiness(), "monthly", now)).toBe(false);
});
test("refreshed readiness changes clear quote/consent before issuance", async () => {
  const f = fixture(); await ready(f); f.api.readiness.mockResolvedValue({ ...readiness(), catalogVersion: "new" }); await f.controller.pay();
  expect(f.api.prepare).not.toHaveBeenCalled(); expect(f.controller.state.quote).toBeNull(); expect(f.controller.state.billingConsent).toBe(false);
});
test("expired quote never silently fetches a replacement", async () => {
  const f = fixture(); let time = now; const c = new BillingController(f.api, f.sdk, "expiry", f.storage, () => time);
  await c.load(true); await c.quote("monthly"); c.consent("billing", true); c.consent("renewal", true); time += 7200000; await c.pay();
  expect(f.api.prepare).not.toHaveBeenCalled(); expect(f.api.quote).toHaveBeenCalledTimes(1);
});
test("duplicate click dispatches once; official SDK receives channelKey and customerId, never channelId", async () => {
  const f = fixture(); await ready(f); await Promise.all([f.controller.pay(), f.controller.pay()]); expect(f.api.charge).toHaveBeenCalledTimes(1);
  expect(f.sdk.issue.mock.calls[0]?.[0]).toEqual({ storeId: "store-fixture", channelKey: "channel-key-fixture", issueId: "issue-fixture", customer: { customerId: "opaque-fixture" }, billingKeyMethod: "CARD" });
  expect(f.api.charge.mock.calls[0]?.[0]).toEqual({ quoteId: "quote-fixture", instrumentId: "instrument-fixture", idempotencyKey: "same-uuid-fixture-long",
    consent: { billingVersion: "billing-draft-v1", autoRenewVersion: "auto-renew-draft-v1", accepted: true } });
  expect(f.controller.state.subscription?.paidAccess).toBe(false); expect(JSON.stringify([...f.values])).not.toContain("synthetic-secret");
});
test("lost charge response recovers same owned UUID using GET only; no new dispatch", async () => {
  const f = fixture(); await ready(f); f.api.charge.mockRejectedValue(new Error("uncertain secret")); await f.controller.pay();
  f.api.byIdempotency.mockImplementation(async () => attempt() as never);
  const restored = new BillingController(f.api, f.sdk, "account-fixture", f.storage, () => now); await restored.load(true); await restored.pay();
  expect(restored.state.attempt?.attemptId).toBe("attempt-fixture"); expect(f.api.charge).toHaveBeenCalledTimes(1);
  expect(f.api.byIdempotency).toHaveBeenCalledWith("same-uuid-fixture-long", expect.any(AbortSignal));
  expect(restored.state.intent?.chargeInput?.idempotencyKey).toBe("same-uuid-fixture-long");
});
test("404 recovery is NOT non-dispatch proof; original intent/payload stays blocked", async () => {
  const f = fixture(); await ready(f); f.api.charge.mockRejectedValue(new Error("uncertain")); await f.controller.pay(); await f.controller.check();
  expect(f.controller.state.message).toContain("404"); expect(f.controller.state.intent?.phase).toBe("charging");
  expect(f.controller.canQuote()).toBe(false); expect(f.api.charge).toHaveBeenCalledTimes(1);
});
test("SDK cancellation and confirmation failure never blindly reissue or charge", async () => {
  const f = fixture(); await ready(f); f.sdk.issue.mockResolvedValue({ billingKey: "" }); await f.controller.pay(); await f.controller.pay();
  expect(f.api.charge).not.toHaveBeenCalled(); expect(f.api.prepare).toHaveBeenCalledTimes(1);
  const g = fixture(); await ready(g); g.api.confirm.mockRejectedValue(new Error("secret")); await g.controller.pay();
  expect(g.api.charge).not.toHaveBeenCalled(); expect(JSON.stringify([...g.values])).not.toContain("synthetic-secret");
});
test("storage denial and corrupt intent fail closed", async () => {
  const f = fixture(); await ready(f); f.storage.setItem = () => { throw new Error("quota"); }; await f.controller.pay(); expect(f.api.prepare).not.toHaveBeenCalled();
  const g = fixture(); g.storage.setItem("living-cost-manager:billing-intent:v1:account-fixture", "{}");
  const c = new BillingController(g.api, g.sdk, "account-fixture", g.storage, () => now); await c.load(true); expect(c.canQuote()).toBe(false);
});
test("late response after account disposal never starts SDK or leaks another account intent", async () => {
  const f = fixture(); await ready(f); let finish!: (value: ReturnType<typeof readiness>) => void;
  f.api.readiness.mockImplementation(() => new Promise(resolve => { finish = resolve; })); const task = f.controller.pay(); f.controller.dispose(); finish(readiness()); await task;
  expect(f.api.prepare).not.toHaveBeenCalled(); expect(new BillingController(f.api, f.sdk, "other", f.storage, () => now).state.intent).toBeNull();
});
test("403 clears private view without echoing server error", async () => {
  const f = fixture(); await ready(f); await f.controller.pay(); f.api.attempt.mockRejectedValue(new BillingError(403)); await f.controller.check();
  expect(f.controller.state.attempt).toBeNull(); expect(f.controller.state.subscription).toBeNull(); expect(f.controller.state.message).toContain("권한");
});
test.each(["created", "dispatch_unknown", "manual_review"] as const)("%s is not payment success; checks bounded", async status => {
  const f = fixture(); await ready(f); f.api.attempt.mockResolvedValue({ ...attempt(), status, paidAt: null, paidPeriod: null, reviewRequired: status === "manual_review" });
  await f.controller.pay(); for (let i = 0; i < 6; i++) await f.controller.check(); expect(f.api.attempt).toHaveBeenCalledTimes(4);
  expect(f.controller.state.subscription?.paidAccess).toBe(false); expect(f.controller.canQuote()).toBe(false);
});
test("live access comes from owned approved subscription, not SDK or POST callback", async () => {
  const f = fixture(); const r = approved(); f.api.readiness.mockResolvedValue(r); f.api.quote.mockResolvedValue(quote(r));
  f.api.attempt.mockResolvedValue({ ...attempt(), mode: "live", status: "dispatch_unknown", paidAt: null, paidPeriod: null }); await ready(f); await f.controller.pay();
  expect(f.controller.state.subscription?.paidAccess).toBe(false);
  f.api.attempt.mockResolvedValue({ ...attempt(), mode: "live" }); f.api.subscription.mockResolvedValue({ ...subscription(), status: "active", planId: "monthly", contractId: "fixture", paidAccess: true, premiumScope: "account-subscription-v1", paidThrough: "2026-11-07T00:00:00Z" });
  await f.controller.check(); expect(f.controller.state.subscription?.paidAccess).toBe(true);
});
test("unknown subscription state or reviewRequired clears/ungrants access", async () => {
  const f = fixture(); f.api.subscription.mockResolvedValue({ ...subscription(), status: "UNKNOWN_FUTURE_STATUS", paidAccess: true } as unknown as Subscription);
  await f.controller.load(true); expect(f.controller.state.subscription).toBeNull();
  const g = fixture(); await ready(g); g.api.attempt.mockResolvedValue({ ...attempt(), reviewRequired: true }); await g.controller.pay(); await g.controller.refund();
  expect(g.api.refund).not.toHaveBeenCalled(); expect(g.controller.canQuote()).toBe(false);
});
test("mock cannot grant approved live coverage even with server paidAccess true", async () => {
  const f = fixture(); f.api.subscription.mockResolvedValue({ ...subscription(), status: "active", planId: "monthly", contractId: "fixture", paidAccess: true, premiumScope: "account-subscription-v1", paidThrough: "2026-11-07T00:00:00Z" });
  await f.controller.load(true); expect(f.controller.state.subscription?.paidAccess).toBe(false);
});
test("idle contract can request quote without fabricating plan/status mapping", async () => {
  const f = fixture(); f.api.subscription.mockResolvedValue({ ...subscription(), status: "idle", contractId: "fixture", planId: "monthly" });
  await f.controller.load(true); expect(f.controller.canQuote()).toBe(true);
});
test("pending cancellation is not verified; verified stop preserves remaining live coverage", async () => {
  const f = fixture(); f.api.readiness.mockResolvedValue(approved()); const s: Subscription = { ...subscription(), status: "active", contractId: "fixture", planId: "monthly", paidAccess: true, premiumScope: "account-subscription-v1", paidThrough: "2026-11-07T00:00:00Z" };
  f.api.subscription.mockResolvedValue(s); await f.controller.load(true); f.api.cancel.mockResolvedValue({ ...s, status: "cancel_at_period_end", cancelAtPeriodEnd: true, renewalStopped: true, providerCancellationStatus: "pending" });
  await f.controller.cancel(); expect(renewalConfirmed(f.controller.state.subscription)).toBe(false); expect(f.controller.state.message).toContain("아직 확인되지");
  expect(renewalConfirmed({ ...s, renewalStopped: true, providerCancellationStatus: "verified" })).toBe(true); expect(f.controller.state.subscription?.paidAccess).toBe(true);
});
test("revoke is verified separately and never clears uncertain charge intent", async () => {
  const f = fixture(); await ready(f); f.api.charge.mockRejectedValue(new Error("uncertain")); await f.controller.pay(); await f.controller.check(); await f.controller.revoke();
  expect(f.controller.state.instrument?.status).toBe("revoked"); expect(f.controller.state.intent?.idempotencyKey).toBe("same-uuid-fixture-long"); expect(f.controller.canQuote()).toBe(false);
});
test("refund is a server-amount request, retries preserve same UUID and reason enum", async () => {
  const f = fixture(); await ready(f); await f.controller.pay(); await f.controller.refund(); await f.controller.refund();
  expect(f.controller.state.message).toContain("완료나 승인 안내가 아닙니다"); expect(f.controller.state.refund?.requestAmount).toBe(990);
  expect(f.api.refund.mock.calls[0]).toEqual(f.api.refund.mock.calls[1]);
});
test("distinct cancel/refund capabilities prevent requests", async () => {
  const f = fixture(); const r = readiness(); r.capabilities.cancel = false; r.capabilities.refund = false; f.api.readiness.mockResolvedValue(r);
  await ready(f); await f.controller.pay(); await f.controller.refund(); await f.controller.cancel(); expect(f.api.refund).not.toHaveBeenCalled(); expect(f.api.cancel).not.toHaveBeenCalled();
});
test("HTTP strict shared schemas reject unknown JSON; owned lookup is GET with bearer, never charge", async () => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL; process.env.NEXT_PUBLIC_API_BASE_URL = "https://synthetic.invalid/v1/";
  try {
    const transport = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ...attempt(), status: "UNKNOWN" }), { status: 200 }));
    const api = createBillingApi("synthetic-token", transport as typeof fetch)!; await expect(api.byIdempotency("same-uuid-fixture-long")).rejects.toThrow();
    expect(transport.mock.calls[0]?.[0]).toBe("https://synthetic.invalid/v1/service-billing/attempts/by-idempotency/same-uuid-fixture-long"); expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(transport.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer synthetic-token" });
  } finally { if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL; else process.env.NEXT_PUBLIC_API_BASE_URL = previous; }
});
test("SDK exception retains intent and never blindly retries registration or charge", async () => {
  const f = fixture(); await ready(f); f.sdk.issue.mockRejectedValue(new Error("sensitive-provider-message"));
  await f.controller.pay(); await f.controller.pay(); expect(f.api.prepare).toHaveBeenCalledTimes(1);
  expect(f.api.charge).not.toHaveBeenCalled(); expect(f.controller.state.message).not.toContain("sensitive");
});
test("approved material renders as escaped text, never HTML", async () => {
  const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
  const { BillingPanel } = await import("../app/subscription/subscription-page");
  const f = fixture(), r = approved(); r.approvedMaterial!.features = '<img src="x" onerror="alert(1)">';
  f.api.readiness.mockResolvedValue(r); f.api.quote.mockResolvedValue(quote(r)); await ready(f);
  const html = renderToStaticMarkup(createElement(BillingPanel, { controller: f.controller }));
  expect(html).toContain("&lt;img"); expect(html).not.toContain('<img src="x"');
});
