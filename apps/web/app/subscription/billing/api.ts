import { getServerApiBaseUrl } from "../../lib/serverApi";
import type { BillingApi } from "./types";

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
    readiness: signal => request("/readiness", undefined, signal),
    subscription: signal => request("/subscription", undefined, signal),
    quote: (planId, signal) => request("/quotes", { planId }, signal),
    prepare: (quoteId, signal) => request("/instruments/prepare", { quoteId }, signal),
    confirm: async (id, billingKey, signal) => { await request(`/instruments/${encodeURIComponent(id)}/confirm`, { billingKey }, signal); },
    charge: (input, signal) => request("/charges", input, signal),
    attempt: (id, signal) => request(`/attempts/${encodeURIComponent(id)}`, undefined, signal),
    cancel: signal => request("/subscription/cancel", { atPeriodEnd: true }, signal),
    refund: (id, input, signal) => request(`/attempts/${encodeURIComponent(id)}/refund-requests`, input, signal)
  };
}
