import { describe, expect, test, vi } from "vitest";
import { BillingController, checkoutReady, renewalConfirmed, validQuote } from "../app/subscription/billing/controller";
import { BillingError, createBillingApi } from "../app/subscription/billing/api";
import type { Attempt, BillingApi, BillingSdk, Quote, Readiness, Subscription } from "../app/subscription/billing/types";

// Entirely synthetic. No accounts, provider calls, remote transport, or real keys.
const now = Date.parse("2026-10-07T00:00:00Z");
const readiness = (): Readiness => ({ mode: "mock", checkoutEnabled: true, blockingCodes: [], catalogVersion: "fixture-v1", currency: "KRW", taxTreatment: "inclusive",
  catalog: { monthly: { totalAmount: 990, periodMonths: 1 }, annual: { totalAmount: 9900, periodMonths: 12 } },
  consentVersions: { billing: "billing-fixture", autoRenew: "renew-fixture" },
  capabilities: { issueInstrument: true, charge: true, renew: true, cancel: true, refund: true },
  sdkConfig: null, approvals: { merchant: true, commerce: true, legal: true, featureScope: true } });
const quote = (): Quote => ({ quoteId: "quote-fixture", planId: "monthly", catalogVersion: "fixture-v1", totalAmount: 990, currency: "KRW", periodMonths: 1,
  expiresAt: "2026-10-07T01:00:00Z", mode: "mock", featureScopeVersion: "scope-fixture", policyVersion: "policy-fixture",
  featureScope: { version: "scope-fixture", text: "Synthetic approved scope" }, billingConsent: { version: "billing-fixture", text: "Synthetic billing consent" },
  autoRenewConsent: { version: "renew-fixture", text: "Synthetic renewal consent" }, sellerDisclosure: { version: "seller-fixture", text: "Synthetic seller" },
  policyDisclosure: { version: "policy-fixture", text: "Synthetic policy" }, nextChargeAt: "2026-11-07T00:00:00Z", nextChargeAmount: 990 });
const subscription = (): Subscription => ({ contractId: null, planId: null, status: "free", paidAccess: false, paidThrough: null, nextChargeAt: null,
  cancelAtPeriodEnd: false, renewalStopped: false, providerCancellationStatus: "unconfirmed", existingFreeAccess: true });
const attempt = (): Attempt => ({ attemptId: "attempt-fixture", status: "paid", mode: "mock", paidAt: "2026-10-07T00:00:00Z", totalAmount: 990, currency: "KRW" });
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const api = {
    readiness: vi.fn(async () => readiness()), subscription: vi.fn(async () => subscription()), quote: vi.fn(async () => quote()),
    prepare: vi.fn(async () => ({ instrumentId: "instrument-fixture", sdkRequest: { storeId: "store-fixture", channelKey: "channel-fixture", billingKeyMethod: "CARD" as const,
      issueId: "issue-fixture", customer: { customerId: "opaque-fixture" } } })),
    confirm: vi.fn(async () => {}), charge: vi.fn(async (_input: Parameters<BillingApi["charge"]>[0]) => attempt()), attempt: vi.fn(async () => attempt()),
    cancel: vi.fn(async () => subscription()), refund: vi.fn(async () => ({ requestId: "refund-fixture", status: "requested" }))
  } satisfies BillingApi;
  const sdk = { synthetic: true, issue: vi.fn(async () => ({ billingKey: "synthetic-secret-never-persist" })) } satisfies BillingSdk;
  const controller = new BillingController(api, sdk, "account-fixture", storage, () => now, () => "same-uuid-fixture");
  return { controller, api, sdk, values, storage };
}
async function ready(f: ReturnType<typeof fixture>) {
  await f.controller.load(true); await f.controller.quote("monthly");
  f.controller.consent("billing", true); f.controller.consent("renewal", true);
}
describe("readiness and immutable consent", () => {
  test("production OFF and mock without injected SDK never issue instruments", async () => {
    const f = fixture(); f.api.readiness.mockResolvedValue({ ...readiness(), checkoutEnabled: false });
    await ready(f); await f.controller.pay();
    expect(f.api.prepare).not.toHaveBeenCalled(); expect(f.sdk.issue).not.toHaveBeenCalled();
    expect(checkoutReady(readiness(), { issue: f.sdk.issue })).toBe(false);
  });
  test.each(["merchant", "commerce", "legal", "featureScope"] as const)("missing %s approval blocks checkout", field => {
    const r = readiness(); r.approvals[field] = false;
    expect(checkoutReady(r, fixture().sdk)).toBe(false);
  });
  test("pending tax or blocking code fails closed", () => {
    expect(checkoutReady({ ...readiness(), taxTreatment: "pending" }, fixture().sdk)).toBe(false);
    expect(checkoutReady({ ...readiness(), blockingCodes: ["NOT_READY"] }, fixture().sdk)).toBe(false);
  });
  test("consents start unchecked and reset for a new quote", async () => {
    const f = fixture(); await f.controller.load(true); await f.controller.quote("monthly");
    expect(f.controller.canPay()).toBe(false); f.controller.consent("billing", true);
    expect(f.controller.canPay()).toBe(false); f.controller.consent("renewal", true);
    expect(f.controller.canPay()).toBe(true); await f.controller.quote("monthly");
    expect(f.controller.state.billingConsent).toBe(false); expect(f.controller.state.renewalConsent).toBe(false);
  });
  test.each([{ totalAmount: 1 }, { currency: "USD" }, { periodMonths: 2 }, { catalogVersion: "changed" },
    { featureScopeVersion: "missing" }, { policyVersion: "missing" }, { expiresAt: "2020-01-01" }, { nextChargeAt: "invalid" }])("rejects untrusted quote %j", patch => {
    expect(validQuote({ ...quote(), ...patch } as Quote, readiness(), "monthly", now)).toBe(false);
  });
  test("approval/price changes before pay require fresh quote and consent; no SDK", async () => {
    const f = fixture(); await ready(f); f.api.readiness.mockResolvedValue({ ...readiness(), catalogVersion: "new" });
    await f.controller.pay(); expect(f.api.prepare).not.toHaveBeenCalled(); expect(f.controller.state.quote).toBeNull();
    expect(f.controller.state.billingConsent).toBe(false);
  });
  test("expired quote never charges or silently obtains another quote", async () => {
    const f = fixture(); let time = now;
    const c = new BillingController(f.api, f.sdk, "other", f.storage, () => time);
    await c.load(true); await c.quote("monthly"); c.consent("billing", true); c.consent("renewal", true);
    time += 7200000; await c.pay(); expect(f.api.prepare).not.toHaveBeenCalled(); expect(f.api.quote).toHaveBeenCalledTimes(1);
  });
});
describe("owned payment state and recovery", () => {
  test("duplicate clicks issue one charge; SDK result does not grant access", async () => {
    const f = fixture(); await ready(f); await Promise.all([f.controller.pay(), f.controller.pay()]);
    expect(f.api.charge).toHaveBeenCalledTimes(1); expect(f.api.attempt).toHaveBeenCalledTimes(1);
    expect(f.api.charge.mock.calls[0]?.[0]).toEqual({ quoteId: "quote-fixture", instrumentId: "instrument-fixture", idempotencyKey: "same-uuid-fixture",
      consent: { billingVersion: "billing-fixture", autoRenewVersion: "renew-fixture", accepted: true } });
    expect(f.controller.state.subscription?.paidAccess).toBe(false);
    expect(JSON.stringify([...f.values])).not.toContain("synthetic-secret");
  });
  test("lost charge response retains SAME idempotency and blocks new charges after reload", async () => {
    const f = fixture(); await ready(f); f.api.charge.mockRejectedValue(new Error("uncertain synthetic-secret"));
    await f.controller.pay(); await f.controller.pay();
    const restored = new BillingController(f.api, f.sdk, "account-fixture", f.storage, () => now);
    await restored.load(true); await restored.quote("monthly"); await restored.pay();
    expect(f.api.charge).toHaveBeenCalledTimes(1); expect(restored.state.intent?.idempotencyKey).toBe("same-uuid-fixture");
    expect(restored.state.message).not.toContain("synthetic-secret");
  });
  test("SDK cancellation does not charge or blindly reissue", async () => {
    const f = fixture(); await ready(f); f.sdk.issue.mockResolvedValue({ billingKey: "", code: "USER_CANCEL" } as never);
    await f.controller.pay(); await f.controller.pay();
    expect(f.api.charge).not.toHaveBeenCalled(); expect(f.api.prepare).toHaveBeenCalledTimes(1);
  });
  test("confirm network failure never charges and key is not persisted", async () => {
    const f = fixture(); await ready(f); f.api.confirm.mockRejectedValue(new Error("secret")); await f.controller.pay();
    expect(f.api.charge).not.toHaveBeenCalled(); expect(f.controller.state.intent?.phase).toBe("confirming");
    expect(JSON.stringify([...f.values])).not.toContain("synthetic-secret");
  });
  test("storage failure blocks instrument creation", async () => {
    const f = fixture(); await ready(f); f.storage.setItem = () => { throw new Error("quota"); };
    await f.controller.pay(); expect(f.api.prepare).not.toHaveBeenCalled();
  });
  test("corrupt saved intent fails closed", async () => {
    const f = fixture(); f.storage.setItem("living-cost-manager:billing-intent:v1:account-fixture", "{}");
    const c = new BillingController(f.api, f.sdk, "account-fixture", f.storage, () => now);
    await c.load(true); await c.quote("monthly"); expect(c.canQuote()).toBe(false);
  });
  test("account disposal ignores late response and never starts SDK", async () => {
    const f = fixture(); await ready(f); let finish!: (value: ReturnType<typeof readiness>) => void;
    f.api.readiness.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const task = f.controller.pay(); f.controller.dispose(); finish(readiness()); await task;
    expect(f.api.prepare).not.toHaveBeenCalled();
    const other = new BillingController(f.api, f.sdk, "another-account", f.storage, () => now);
    expect(other.state.intent).toBeNull();
  });
  test("403 attempt response clears private view and sanitizes message", async () => {
    const f = fixture(); await ready(f); await f.controller.pay();
    f.api.attempt.mockRejectedValue(new BillingError(403)); await f.controller.check();
    expect(f.controller.state.attempt).toBeNull(); expect(f.controller.state.subscription).toBeNull();
    expect(f.controller.state.message).toContain("권한");
  });
  test("bounded manual polling only; pending is never success", async () => {
    const f = fixture(); await ready(f); f.api.attempt.mockResolvedValue({ ...attempt(), status: "pending", paidAt: null });
    await f.controller.pay(); for (let n = 0; n < 6; n++) await f.controller.check();
    expect(f.api.attempt).toHaveBeenCalledTimes(4); expect(f.controller.state.checks).toBe(3);
    expect(f.controller.state.message).toContain("확인 중");
  });
  test("sandbox/mock inconsistent entitlement cannot show live paid access", async () => {
    const f = fixture(); f.api.subscription.mockResolvedValue({ ...subscription(), paidAccess: true, contractId: "fixture", paidThrough: "2026-11-07T00:00:00Z" });
    await f.controller.load(true); expect(f.controller.state.subscription?.paidAccess).toBe(false);
  });
  test("live entitlement comes only from owned server subscription after attempt GET, never SDK or charge callback", async () => {
    const f = fixture(); const r = { ...readiness(), mode: "live" as const, sdkConfig: { storeId: "store-fixture", channelId: "channel-fixture" } };
    f.api.readiness.mockResolvedValue(r); f.api.quote.mockResolvedValue({ ...quote(), mode: "live" });
    f.api.charge.mockResolvedValue({ ...attempt(), mode: "live", status: "paid" });
    f.api.attempt.mockResolvedValue({ ...attempt(), mode: "live", status: "pending", paidAt: null });
    const c = new BillingController(f.api, { issue: f.sdk.issue }, "live-synthetic", f.storage, () => now, () => "live-fixture");
    await c.load(true); await c.quote("monthly"); c.consent("billing", true); c.consent("renewal", true); await c.pay();
    expect(c.state.attempt?.status).toBe("pending"); expect(c.state.subscription?.paidAccess).toBe(false);
    f.api.attempt.mockResolvedValue({ ...attempt(), mode: "live" });
    f.api.subscription.mockResolvedValue({ ...subscription(), paidAccess: true, contractId: "fixture", paidThrough: "2026-11-07T00:00:00Z" });
    await c.check(); expect(c.state.subscription?.paidAccess).toBe(true);
  });
  test("attempt price mismatch is not a successful payment display", async () => {
    const f = fixture(); await ready(f); f.api.attempt.mockResolvedValue({ ...attempt(), totalAmount: 1 }); await f.controller.pay();
    expect(f.controller.state.attempt).toBeNull(); expect(f.controller.state.subscription?.paidAccess).toBe(false);
  });
  test("cancel pending is not cancellation proof", async () => {
    const f = fixture(); f.api.subscription.mockResolvedValue({ ...subscription(), contractId: "fixture" });
    await f.controller.load(true); f.api.cancel.mockResolvedValue({ ...subscription(), contractId: "fixture", cancelAtPeriodEnd: true, renewalStopped: true });
    await f.controller.cancel(); expect(f.controller.state.message).toContain("아직 확인되지");
    expect(renewalConfirmed(f.controller.state.subscription)).toBe(false);
    expect(renewalConfirmed({ ...subscription(), renewalStopped: true, providerCancellationStatus: "not_applicable" })).toBe(false);
    expect(renewalConfirmed({ ...subscription(), renewalStopped: true, providerCancellationStatus: "confirmed" })).toBe(false);
    expect(renewalConfirmed({ ...subscription(), renewalStopped: true, providerCancellationStatus: "confirmed", cancellationProof: { allChargePathsStopped: true, inFlightResolved: true } })).toBe(true);
  });
  test("refund request isn't completion; repeated request uses same key", async () => {
    const f = fixture(); await ready(f); await f.controller.pay(); await f.controller.refund(); await f.controller.refund();
    expect(f.controller.state.message).toContain("완료나 승인 안내가 아닙니다");
    expect(f.api.refund.mock.calls[0]).toEqual(f.api.refund.mock.calls[1]);
  });
  test("distinct cancel/refund capability gates prevent requests", async () => {
    const f = fixture(); const r = readiness(); r.capabilities.cancel = false; r.capabilities.refund = false; f.api.readiness.mockResolvedValue(r);
    await ready(f); await f.controller.pay(); await f.controller.refund(); await f.controller.cancel();
    expect(f.api.refund).not.toHaveBeenCalled(); expect(f.api.cancel).not.toHaveBeenCalled();
  });
});
test("HTTP adapter sends relative owned path, bearer and only allowed charge fields; errors never echo body", async () => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL; process.env.NEXT_PUBLIC_API_BASE_URL = "https://synthetic.invalid/living-cost-manager/v1/";
  try {
    const transport = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("private-provider-message", { status: 403 }));
    const api = createBillingApi("synthetic-token", transport as typeof fetch)!;
    await expect(api.attempt("owned/id")).rejects.toThrow("결제 정보를 확인하지 못했습니다.");
    expect(transport.mock.calls[0]?.[0]).toBe("https://synthetic.invalid/living-cost-manager/v1/service-billing/attempts/owned%2Fid");
    expect((transport.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ Authorization: "Bearer synthetic-token" });
  } finally { if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL; else process.env.NEXT_PUBLIC_API_BASE_URL = previous; }
});
