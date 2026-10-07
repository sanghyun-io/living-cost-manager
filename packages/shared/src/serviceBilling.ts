import { z } from "zod";

export const serviceBillingCatalog = Object.freeze({
  monthly: Object.freeze({ totalAmount: 990, periodMonths: 1 } as const),
  annual: Object.freeze({ totalAmount: 9900, periodMonths: 12 } as const)
});
export const serviceBillingCatalogVersion = "lcm-990-9900-v1";
export const serviceBillingConsentVersions = Object.freeze({ billing: "billing-draft-v1", autoRenew: "auto-renew-draft-v1" } as const);
const id = z.string().min(1).max(128);
const key = z.string().regex(/^[A-Za-z0-9_-]{16,100}$/);
export const serviceBillingQuoteRequestSchema = z.strictObject({ planId: z.enum(["monthly", "annual"]) });
export const serviceBillingPrepareRequestSchema = z.strictObject({ quoteId: id });
export const serviceBillingConfirmRequestSchema = z.strictObject({ billingKey: z.string().min(1).max(1024) });
export const serviceBillingChargeRequestSchema = z.strictObject({
  quoteId: id, instrumentId: id, idempotencyKey: key,
  consent: z.strictObject({ billingVersion: id, autoRenewVersion: id, accepted: z.literal(true) })
});
export const serviceBillingCancelRequestSchema = z.strictObject({ atPeriodEnd: z.literal(true) });
export const serviceBillingMockExecutionRequestSchema = z.strictObject({});
export const serviceBillingRefundRequestSchema = z.strictObject({ idempotencyKey: key, reasonCode: z.enum(["changed_mind", "service_issue", "other"]) });
export const serviceBillingIdempotencyKeySchema = key;
export const serviceBillingApprovedVersionsSchema = z.strictObject({ featureScope: id, policy: id, seller: id, billing: id, autoRenew: id });
export const serviceBillingSubscriptionStatusSchema = z.enum(["free", "idle", "active", "cancel_at_period_end"]);
export const serviceBillingAttemptStatusSchema = z.enum(["created", "dispatch_unknown", "paid", "failed", "manual_review", "canceled_before_dispatch", "refunded"]);
export const serviceBillingInstrumentStatusSchema = z.enum(["prepared", "verified", "revocation_pending", "revoked", "manual_review"]);
export const serviceBillingCancellationStatusSchema = z.enum(["none", "pending", "verified"]);
export const serviceBillingRefundStatusSchema = z.enum(["requested", "dispatch_unknown", "verified", "rejected", "manual_review"]);
export type ServiceBillingMode = "mock" | "sandbox" | "live";
export type ServiceBillingQuoteDto = {
  quoteId: string; planId: "monthly" | "annual"; catalogVersion: string;
  totalAmount: number; currency: "KRW"; periodMonths: number; expiresAt: string;
  consentVersions: { billing: string; autoRenew: string };
  approvedVersions: z.infer<typeof serviceBillingApprovedVersionsSchema>;
  approvedMaterial: null | { billing: string; autoRenew: string; features: string; policy: string; seller: string };
};
export type ServiceBillingReadinessDto = {
  mode: ServiceBillingMode; checkoutEnabled: boolean; blockingCodes: string[];
  catalogVersion: string; catalog: typeof serviceBillingCatalog; currency: "KRW";
  taxTreatment: "pending" | "inclusive";
  consentVersions: { billing: string; autoRenew: string };
  capabilities: { issueInstrument: boolean; charge: boolean; renew: boolean; cancel: boolean; refund: boolean };
  sdkConfig: null | { storeId: string; channelId: string; channelKey?: string };
  approvedVersions: z.infer<typeof serviceBillingApprovedVersionsSchema>;
  approvedMaterial: null | { billing: string; autoRenew: string; features: string; policy: string; seller: string };
  approvalStatus: "mock_draft" | "blocked" | "approved";
};
export type ServiceBillingSubscriptionDto = {
  contractId: string | null; planId: "monthly" | "annual" | null; status: z.infer<typeof serviceBillingSubscriptionStatusSchema>;
  paidAccess: boolean; paidThrough: string | null; nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean; renewalStopped: boolean; providerCancellationStatus: z.infer<typeof serviceBillingCancellationStatusSchema>;
  premiumScope: "provisional" | "account-subscription-v1"; existingFreeAccess: true;
};
export type ServiceBillingAttemptDto = {
  attemptId: string; status: z.infer<typeof serviceBillingAttemptStatusSchema>; mode: ServiceBillingMode; paidAt: string | null;
  reviewRequired: boolean;
  paidPeriod: null | { startsAt: string; endsAt: string };
};
export type ServiceBillingPrepareDto = {
  instrumentId: string;
  sdkRequest: { storeId: string; channelId: string; channelKey?: string; issueId: string; customer: { id: string }; billingKeyMethod: "CARD" };
};
export type ServiceBillingInstrumentDto = { instrumentId: string; status: z.infer<typeof serviceBillingInstrumentStatusSchema> };
export type ServiceBillingRefundDto = { requestId: string; status: z.infer<typeof serviceBillingRefundStatusSchema>; requestAmount: number; currency: "KRW" };
export const serviceBillingAttemptResponseSchema = z.strictObject({ attemptId: id, status: serviceBillingAttemptStatusSchema,
  mode: z.enum(["mock", "sandbox", "live"]), paidAt: z.iso.datetime().nullable(), reviewRequired: z.boolean(),
  paidPeriod: z.strictObject({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }).nullable() });
export const serviceBillingSubscriptionResponseSchema = z.strictObject({ contractId: id.nullable(), planId: z.enum(["monthly", "annual"]).nullable(),
  status: serviceBillingSubscriptionStatusSchema, paidAccess: z.boolean(), paidThrough: z.iso.datetime().nullable(), nextChargeAt: z.iso.datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(), renewalStopped: z.boolean(), providerCancellationStatus: serviceBillingCancellationStatusSchema,
  premiumScope: z.enum(["provisional", "account-subscription-v1"]), existingFreeAccess: z.literal(true) });
export const serviceBillingMaterialSchema = z.strictObject({ billing: z.string().max(2000), autoRenew: z.string().max(2000),
  features: z.string().max(2000), policy: z.string().max(2000), seller: z.string().max(2000) });
export const serviceBillingQuoteResponseSchema = z.strictObject({ quoteId: id, planId: z.enum(["monthly", "annual"]), catalogVersion: id,
  totalAmount: z.number().int().positive(), currency: z.literal("KRW"), periodMonths: z.union([z.literal(1), z.literal(12)]), expiresAt: z.iso.datetime(),
  consentVersions: z.strictObject({ billing: id, autoRenew: id }), approvedVersions: serviceBillingApprovedVersionsSchema,
  approvedMaterial: serviceBillingMaterialSchema.nullable() });
export const serviceBillingReadinessResponseSchema = z.strictObject({ mode: z.enum(["mock", "sandbox", "live"]), checkoutEnabled: z.boolean(),
  blockingCodes: z.array(id).max(20), catalogVersion: id, catalog: z.strictObject({ monthly: z.strictObject({ totalAmount: z.literal(990), periodMonths: z.literal(1) }),
    annual: z.strictObject({ totalAmount: z.literal(9900), periodMonths: z.literal(12) }) }), currency: z.literal("KRW"), taxTreatment: z.enum(["pending", "inclusive"]),
  consentVersions: z.strictObject({ billing: id, autoRenew: id }), capabilities: z.strictObject({ issueInstrument: z.boolean(), charge: z.boolean(), renew: z.boolean(), cancel: z.boolean(), refund: z.boolean() }),
  sdkConfig: z.strictObject({ storeId: id, channelId: id, channelKey: id.optional() }).nullable(), approvedVersions: serviceBillingApprovedVersionsSchema,
  approvedMaterial: serviceBillingMaterialSchema.nullable(), approvalStatus: z.enum(["mock_draft", "blocked", "approved"]) });
export const serviceBillingInstrumentResponseSchema = z.strictObject({ instrumentId: id, status: serviceBillingInstrumentStatusSchema, requiresManualReview: z.boolean() });
export const serviceBillingRefundResponseSchema = z.strictObject({ requestId: id, status: serviceBillingRefundStatusSchema, requestAmount: z.number().int().positive(), currency: z.literal("KRW") });
