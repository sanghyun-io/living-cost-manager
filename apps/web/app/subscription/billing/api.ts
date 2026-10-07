import { getServerApiBaseUrl } from "../../lib/serverApi";
import type { BillingApi, Instrument } from "./types";
import { serviceBillingReadinessResponseSchema, serviceBillingQuoteResponseSchema, serviceBillingAttemptResponseSchema,
  serviceBillingSubscriptionResponseSchema, serviceBillingInstrumentResponseSchema, serviceBillingRefundResponseSchema,
  serviceBillingInstrumentStatusSchema } from "@living-cost-manager/shared";

function prepared(value: unknown): Instrument {
  const p = value as Instrument;
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
  const keys = (v: unknown, allowed: string[]) => !!v && typeof v === "object" && Object.keys(v).every(k => allowed.includes(k));
  if (!keys(p, ["instrumentId", "sdkRequest"]) || !id(p.instrumentId) ||
    !keys(p.sdkRequest, ["storeId", "channelId", "channelKey", "issueId", "customer", "billingKeyMethod"]) ||
    !id(p.sdkRequest.storeId) || !id(p.sdkRequest.channelId) || !id(p.sdkRequest.issueId) ||
    (p.sdkRequest.channelKey !== undefined && !id(p.sdkRequest.channelKey)) ||
    !keys(p.sdkRequest.customer, ["id"]) || !id(p.sdkRequest.customer.id) || p.sdkRequest.billingKeyMethod !== "CARD") throw new Error("Invalid preparation");
  return p;
}

export class BillingError extends Error {
  constructor(readonly status: number) { super("결제 정보를 확인하지 못했습니다."); }
}
export function createBillingApi(token: string | null, fetchImpl: typeof fetch = fetch): BillingApi | null {
  const base = getServerApiBaseUrl();
  if (!base) return null;
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) abort.abort();
    const timeout = setTimeout(stop, 15000);
    try {
      const response = await fetchImpl(`${base}/service-billing${path}`, {
      method: body === undefined ? "GET" : "POST", signal: abort.signal, cache: "no-store",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    // Never surface provider messages, response bodies, keys, or tokens.
    if (!response.ok) throw new BillingError(response.status);
      return await response.json() as T;
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", stop); }
  }
  return {
    readiness: signal => request("/readiness", undefined, signal).then(v => serviceBillingReadinessResponseSchema.parse(v)),
    subscription: signal => request("/subscription", undefined, signal).then(v => serviceBillingSubscriptionResponseSchema.parse(v)),
    quote: (planId, signal) => request("/quotes", { planId }, signal).then(v => serviceBillingQuoteResponseSchema.parse(v)),
    prepare: (quoteId, signal) => request("/instruments/prepare", { quoteId }, signal).then(prepared),
    confirm: async (id, billingKey, signal) => {
      const v = await request<{ instrumentId: string; status: string }>(`/instruments/${encodeURIComponent(id)}/confirm`, { billingKey }, signal);
      if (!v || Object.keys(v).some(k => !["instrumentId", "status"].includes(k)) || v.instrumentId !== id ||
        serviceBillingInstrumentStatusSchema.parse(v.status) !== "verified") throw new Error("Confirmation unavailable");
    },
    charge: (input, signal) => request("/charges", input, signal).then(v => serviceBillingAttemptResponseSchema.parse(v)),
    attempt: (id, signal) => request(`/attempts/${encodeURIComponent(id)}`, undefined, signal).then(v => serviceBillingAttemptResponseSchema.parse(v)),
    byIdempotency: (key, signal) => request(`/attempts/by-idempotency/${encodeURIComponent(key)}`, undefined, signal).then(v => serviceBillingAttemptResponseSchema.parse(v)),
    instrument: (id, signal) => request(`/instruments/${encodeURIComponent(id)}`, undefined, signal).then(v => serviceBillingInstrumentResponseSchema.parse(v)),
    revoke: (id, signal) => request(`/instruments/${encodeURIComponent(id)}/revoke`, {}, signal).then(v => serviceBillingInstrumentResponseSchema.parse(v)),
    cancel: signal => request("/subscription/cancel", { atPeriodEnd: true }, signal).then(v => serviceBillingSubscriptionResponseSchema.parse(v)),
    refund: (id, input, signal) => request(`/attempts/${encodeURIComponent(id)}/refund-requests`, input, signal).then(v => serviceBillingRefundResponseSchema.parse(v))
  };
}
