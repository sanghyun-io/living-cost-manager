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
export type ServiceBillingMode = "mock" | "sandbox" | "live";
export type ServiceBillingQuoteDto = {
  quoteId: string; planId: "monthly" | "annual"; catalogVersion: string;
  totalAmount: number; currency: "KRW"; periodMonths: number; expiresAt: string;
  consentVersions: { billing: string; autoRenew: string };
};
export type ServiceBillingReadinessDto = {
  mode: ServiceBillingMode; checkoutEnabled: boolean; blockingCodes: string[];
  catalogVersion: string; catalog: typeof serviceBillingCatalog; currency: "KRW";
  taxTreatment: "pending" | "inclusive";
  consentVersions: { billing: string; autoRenew: string };
  capabilities: { issueInstrument: boolean; charge: boolean; renew: boolean; cancel: boolean; refund: boolean };
  sdkConfig: null | { storeId: string; channelId: string };
};
export type ServiceBillingSubscriptionDto = {
  contractId: string | null; planId: string | null; status: string;
  paidAccess: boolean; paidThrough: string | null; nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean; renewalStopped: boolean; providerCancellationStatus: string;
  premiumScope: "provisional"; existingFreeAccess: true;
};
export type ServiceBillingAttemptDto = {
  attemptId: string; status: string; mode: ServiceBillingMode; paidAt: string | null;
  paidPeriod: null | { startsAt: string; endsAt: string };
};
export type ServiceBillingPrepareDto = {
  instrumentId: string;
  sdkRequest: { storeId: string; channelId: string; issueId: string; customer: { id: string }; billingKeyMethod: "CARD" };
};
export type ServiceBillingInstrumentDto = { instrumentId: string; status: string };
export type ServiceBillingRefundDto = { requestId: string; status: string; requestAmount: number; currency: "KRW" };
