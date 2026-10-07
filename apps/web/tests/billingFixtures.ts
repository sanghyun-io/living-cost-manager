import { vi } from "vitest";
import { BillingController } from "../app/features/service-subscription/billing/controller";
import { BillingError } from "../app/features/service-subscription/billing/api";
import type { Attempt, BillingApi, BillingSdk, Quote, Readiness, Subscription, SdkRequest, Mode } from "../app/features/service-subscription/billing/types";
export const now = Date.parse("2026-10-07T00:00:00Z");
export const readiness = (): Readiness => ({ mode: "mock", checkoutEnabled: true,
  blockingCodes: ["MOCK_ONLY", "PAID_PRODUCT_APPROVAL_PENDING", "LEGAL_TAX_APPROVAL_PENDING"], catalogVersion: "lcm-990-9900-v1", currency: "KRW", taxTreatment: "pending",
  catalog: { monthly: { totalAmount: 990, periodMonths: 1 }, annual: { totalAmount: 9900, periodMonths: 12 } },
  consentVersions: { billing: "billing-draft-v1", autoRenew: "auto-renew-draft-v1" },
  approvedVersions: { featureScope: "feature-draft-v1", policy: "policy-draft-v1", seller: "seller-draft-v1", billing: "billing-draft-v1", autoRenew: "auto-renew-draft-v1" },
  approvedMaterial: null, approvalStatus: "mock_draft", capabilities: { issueInstrument: true, charge: true, renew: true, cancel: true, refund: true }, sdkConfig: null });
export const approved = (): Readiness => ({ ...readiness(), mode: "live", blockingCodes: [], approvalStatus: "approved", taxTreatment: "inclusive",
  sdkConfig: { storeId: "store-fixture", channelId: "channel-fixture", channelKey: "channel-key-fixture" },
  approvedMaterial: { billing: "Synthetic billing", autoRenew: "Synthetic renewal", features: "Synthetic scope", policy: "Synthetic policy", seller: "Synthetic seller" } });
export const quote = (r = readiness()): Quote => ({ quoteId: "quote-fixture", planId: "monthly", catalogVersion: r.catalogVersion, totalAmount: 990, currency: "KRW", periodMonths: 1,
  expiresAt: "2026-10-07T01:00:00Z", consentVersions: { ...r.consentVersions }, approvedVersions: { ...r.approvedVersions }, approvedMaterial: r.approvedMaterial ? { ...r.approvedMaterial } : null });
export const subscription = (): Subscription => ({ contractId: null, planId: null, status: "free", paidAccess: false, paidThrough: null, nextChargeAt: null,
  cancelAtPeriodEnd: false, renewalStopped: false, providerCancellationStatus: "none", premiumScope: "provisional", existingFreeAccess: true });
export const attempt = (): Attempt => ({ attemptId: "attempt-fixture", status: "paid", mode: "mock", paidAt: "2026-10-07T00:00:00Z", reviewRequired: false,
  paidPeriod: { startsAt: "2026-10-07T00:00:00Z", endsAt: "2026-11-07T00:00:00Z" } });
export function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const api = {
    readiness: vi.fn(async () => readiness()), subscription: vi.fn(async () => subscription()), quote: vi.fn(async () => quote()),
    prepare: vi.fn(async () => ({ instrumentId: "instrument-fixture", sdkRequest: { storeId: "store-fixture", channelId: "channel-fixture", channelKey: "channel-key-fixture", billingKeyMethod: "CARD" as const,
      issueId: "issue-fixture", customer: { id: "opaque-fixture" } } })), confirm: vi.fn(async () => {}),
    charge: vi.fn(async (_input: Parameters<BillingApi["charge"]>[0]) => attempt()), attempt: vi.fn(async () => attempt()),
    byIdempotency: vi.fn(async (_key: string): Promise<Attempt> => { throw new BillingError(404); }),
    instrument: vi.fn(async () => ({ instrumentId: "instrument-fixture", status: "prepared" as const, requiresManualReview: false })),
    revoke: vi.fn(async () => ({ instrumentId: "instrument-fixture", status: "revoked" as const, requiresManualReview: false })),
    cancel: vi.fn(async () => subscription()), refund: vi.fn(async () => ({ requestId: "refund-fixture", status: "requested" as const, requestAmount: 990, currency: "KRW" as const }))
  } satisfies BillingApi;
  const sdk = { supportsMock: true, issue: vi.fn(async (_request: SdkRequest, _mode: Mode) => ({ billingKey: "synthetic-secret-never-persist" })) } satisfies BillingSdk;
  const controller = new BillingController(api, sdk, "account-fixture", storage, () => now, () => "same-uuid-fixture-long");
  return { controller, api, sdk, values, storage };
}
export async function ready(f: ReturnType<typeof fixture>) {
  await f.controller.load(true); await f.controller.quote("monthly"); f.controller.consent("billing", true); f.controller.consent("renewal", true);
}
