// Provisional web-only contract. Replace with frozen shared DTOs at integration.
export type Mode = "mock" | "sandbox" | "live";
export type Plan = "monthly" | "annual";
export type Capability = "issueInstrument" | "charge" | "renew" | "cancel" | "refund";
export interface Readiness {
  mode: Mode; checkoutEnabled: boolean; blockingCodes: string[]; catalogVersion: string;
  currency: "KRW"; taxTreatment: "pending" | "inclusive";
  catalog: Record<Plan, { totalAmount: number; periodMonths: number }>;
  consentVersions: { billing: string; autoRenew: string };
  capabilities: Record<Capability, boolean>;
  sdkConfig: null | { storeId: string; channelId: string };
  // Explicit readiness evidence required; missing fields fail closed.
  approvals: { merchant: boolean; commerce: boolean; legal: boolean; featureScope: boolean };
}
export interface ApprovedMaterial {
  version: string; text: string;
}
export interface Quote {
  quoteId: string; planId: Plan; catalogVersion: string; totalAmount: number;
  currency: "KRW"; periodMonths: number; expiresAt: string; mode: Mode;
  featureScopeVersion: string; policyVersion: string;
  featureScope: ApprovedMaterial; billingConsent: ApprovedMaterial; autoRenewConsent: ApprovedMaterial;
  // Server-approved display data, not a browser-authored policy.
  sellerDisclosure: ApprovedMaterial; policyDisclosure: ApprovedMaterial;
  nextChargeAt: string; nextChargeAmount: number;
}
export interface Subscription {
  contractId: string | null; planId: Plan | null; status: string; paidAccess: boolean;
  paidThrough: string | null; nextChargeAt: string | null; cancelAtPeriodEnd: boolean;
  renewalStopped: boolean; providerCancellationStatus: string; existingFreeAccess: true;
  cancellationProof?: { allChargePathsStopped: boolean; inFlightResolved: boolean };
}
export interface Attempt {
  attemptId: string; status: "pending" | "paid" | "failed"; mode: Mode;
  paidAt: string | null; totalAmount: number; currency: "KRW";
}
export interface SdkRequest {
  storeId: string; channelKey: string; billingKeyMethod: "CARD";
  issueId: string; customer: { customerId: string };
}
export interface Instrument { instrumentId: string; sdkRequest: SdkRequest }
export interface Intent {
  quoteId: string; idempotencyKey: string; phase: "issuing" | "confirming" | "charging" | "attempt";
  instrumentId?: string; attemptId?: string; refundIdempotencyKey?: string;
}
export interface BillingApi {
  readiness(signal?: AbortSignal): Promise<Readiness>;
  subscription(signal?: AbortSignal): Promise<Subscription>;
  quote(planId: Plan, signal?: AbortSignal): Promise<Quote>;
  prepare(quoteId: string, signal?: AbortSignal): Promise<Instrument>;
  confirm(instrumentId: string, billingKey: string, signal?: AbortSignal): Promise<void>;
  charge(input: { quoteId: string; instrumentId: string; idempotencyKey: string;
    consent: { billingVersion: string; autoRenewVersion: string; accepted: true } }, signal?: AbortSignal): Promise<Attempt>;
  attempt(id: string, signal?: AbortSignal): Promise<Attempt>;
  cancel(signal?: AbortSignal): Promise<Subscription>;
  refund(id: string, input: { idempotencyKey: string; reasonCode: "CUSTOMER_REQUEST" }, signal?: AbortSignal): Promise<{ requestId: string; status: string }>;
}
export interface BillingSdk {
  readonly synthetic?: boolean;
  issue(request: SdkRequest): Promise<{ billingKey?: string; code?: string } | undefined>;
}
