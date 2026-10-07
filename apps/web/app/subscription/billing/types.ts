import type { ServiceBillingReadinessDto, ServiceBillingQuoteDto, ServiceBillingSubscriptionDto,
  ServiceBillingAttemptDto, ServiceBillingPrepareDto, ServiceBillingMode, ServiceBillingRefundDto } from "@living-cost-manager/shared";
import type { serviceBillingInstrumentResponseSchema } from "@living-cost-manager/shared";
export type Readiness = ServiceBillingReadinessDto;
export type Quote = ServiceBillingQuoteDto;
export type Subscription = ServiceBillingSubscriptionDto;
export type Attempt = ServiceBillingAttemptDto;
export type Instrument = ServiceBillingPrepareDto;
export type InstrumentSnapshot = ReturnType<typeof serviceBillingInstrumentResponseSchema.parse>;
export type Mode = ServiceBillingMode;
export type Plan = Quote["planId"];
export type Refund = ServiceBillingRefundDto;
// Official browser shape differs from the server preparation's customer.id.
export interface SdkRequest { storeId: string; channelKey?: string; issueId: string; customer: { customerId: string }; billingKeyMethod: "CARD" }
export interface ChargeInput { quoteId: string; instrumentId: string; idempotencyKey: string;
  consent: { billingVersion: string; autoRenewVersion: string; accepted: true } }
export interface Intent {
  quoteId: string; idempotencyKey: string; phase: "issuing" | "confirming" | "charging" | "attempt";
  createdAt?: string; instrumentId?: string; attemptId?: string; refundIdempotencyKey?: string; chargeInput?: ChargeInput;
}
export interface BillingApi {
  readiness(signal?: AbortSignal): Promise<Readiness>;
  subscription(signal?: AbortSignal): Promise<Subscription>;
  quote(planId: Plan, signal?: AbortSignal): Promise<Quote>;
  prepare(quoteId: string, signal?: AbortSignal): Promise<Instrument>;
  confirm(instrumentId: string, billingKey: string, signal?: AbortSignal): Promise<void>;
  charge(input: ChargeInput, signal?: AbortSignal): Promise<Attempt>;
  attempt(id: string, signal?: AbortSignal): Promise<Attempt>;
  byIdempotency(key: string, signal?: AbortSignal): Promise<Attempt>;
  instrument(id: string, signal?: AbortSignal): Promise<InstrumentSnapshot>;
  revoke(id: string, signal?: AbortSignal): Promise<InstrumentSnapshot>;
  cancel(signal?: AbortSignal): Promise<Subscription>;
  refund(id: string, input: { idempotencyKey: string; reasonCode: "changed_mind" | "service_issue" | "other" }, signal?: AbortSignal): Promise<Refund>;
}
export interface BillingSdk {
  readonly supportsMock?: boolean;
  issue(request: SdkRequest, mode: Mode): Promise<{ billingKey?: string; code?: string } | undefined>;
}
