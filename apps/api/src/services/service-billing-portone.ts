import { z } from "zod";
import type { Payment, PaymentClient, BillingKeyClient } from "@portone/server-sdk";
import type { BillingApprovalManifest } from "./service-billing-config.js";
import type { BillingScope, PaymentObservation, ServiceBillingProvider } from "./service-billing-provider.js";
import { verifyPortOneRawWebhook } from "./service-billing-portone-evidence.js";

/** HTTP parity with pinned @portone/server-sdk 0.19.0 generated clients. No
 * retries, redirects or arbitrary origins. SDK result types + runtime binding
 * validation; transport errors never retain body/URL/token/headers as a cause. */
export class PortOneTransportError extends Error {
  constructor(readonly code: "PORTONE_UNAVAILABLE" | "PORTONE_NOT_FOUND" | "PORTONE_INVALID_EVIDENCE") { super(code); }
}
type PayInput = Parameters<PaymentClient["payWithBillingKey"]>[0];
type CancelInput = Parameters<PaymentClient["cancelPayment"]>[0];
export class PortOneHttpTransport {
  constructor(private secret: string, private fetcher: typeof fetch = fetch, private timeoutMs = 8000) {}
  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(new URL(path, "https://api.portone.io"), { method, redirect: "error", signal: abort.signal,
        headers: { Authorization: `PortOne ${this.secret}`, "Content-Type": "application/json", "User-Agent": "lcm-service-billing-portone-sdk-0.19.0" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 404) throw new PortOneTransportError("PORTONE_NOT_FOUND");
      if (!response.ok) throw new PortOneTransportError("PORTONE_UNAVAILABLE");
      const reader = response.body?.getReader();
      if (!reader) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length; if (bytes > 256 * 1024) { await reader.cancel(); throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE"); }
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch (error) { if (error instanceof PortOneTransportError) throw error; throw new PortOneTransportError("PORTONE_UNAVAILABLE"); }
    finally { clearTimeout(timer); }
  }
  getPayment(options: Parameters<PaymentClient["getPayment"]>[0]) {
    return this.request<Payment.Payment>("GET", `/payments/${encodeURIComponent(options.paymentId)}?storeId=${encodeURIComponent(options.storeId ?? "")}`);
  }
  payWithBillingKey(options: PayInput) {
    const { paymentId, ...body } = options;
    return this.request<Awaited<ReturnType<PaymentClient["payWithBillingKey"]>>>("POST", `/payments/${encodeURIComponent(paymentId)}/billing-key`, body);
  }
  cancelPayment(options: CancelInput) {
    const { paymentId, ...body } = options;
    return this.request<Awaited<ReturnType<PaymentClient["cancelPayment"]>>>("POST", `/payments/${encodeURIComponent(paymentId)}/cancel`, body);
  }
  getBillingKeyInfo(options: Parameters<BillingKeyClient["getBillingKeyInfo"]>[0]) {
    return this.request<Payment.BillingKey.BillingKeyInfo>("GET", `/billing-keys/${encodeURIComponent(options.billingKey)}?storeId=${encodeURIComponent(options.storeId ?? "")}`);
  }
  deleteBillingKey(options: Parameters<BillingKeyClient["deleteBillingKey"]>[0]) {
    return this.request<Awaited<ReturnType<BillingKeyClient["deleteBillingKey"]>>>("DELETE", `/billing-keys/${encodeURIComponent(options.billingKey)}?storeId=${encodeURIComponent(options.storeId ?? "")}&reason=LCM%20subscription%20canceled&requester=CUSTOMER`);
  }
  getBillingKeyInfos(storeId: string, customerId: string) {
    const request = { page: { number: 0, size: 100 }, filter: { storeId, customerId } };
    return this.request<Awaited<ReturnType<BillingKeyClient["getBillingKeyInfos"]>>>("GET", `/billing-keys?requestBody=${encodeURIComponent(JSON.stringify(request))}`);
  }
}
const channelSchema = z.object({ id: z.string().min(1), type: z.enum(["TEST", "LIVE"]) });
const instrumentSchema = z.object({ status: z.enum(["ISSUED", "DELETED"]), storeId: z.string(), merchantId: z.string(),
  issueId: z.string(), customer: z.object({ id: z.string() }), channels: z.array(channelSchema).length(1) });
// Exact recognized discriminants from SDK 0.19.0 Payment/PaymentCancellation.
// SDK's Unrecognized union is intentionally unsupported authoritative evidence.
const paymentSchema = z.object({ status: z.enum(["PAID", "CANCELLED", "PARTIAL_CANCELLED", "FAILED", "PAY_PENDING", "READY", "VIRTUAL_ACCOUNT_ISSUED"]), id: z.string(), storeId: z.string(), merchantId: z.string(),
  channel: channelSchema, customer: z.object({ id: z.string() }), currency: z.literal("KRW"),
  amount: z.object({ total: z.number().int().positive(), cancelled: z.number().int().nonnegative() }),
  paidAt: z.string().optional(), cancellations: z.array(z.object({ status: z.enum(["SUCCEEDED", "FAILED", "REQUESTED"]), id: z.string(),
    totalAmount: z.number().int().positive(), reason: z.string().max(3000) })).optional() });

export class PortOneServiceBillingProvider implements ServiceBillingProvider {
  readonly scope: BillingScope;
  private stopped = new Set<string>(); // advisory only; service additionally verifies DB stop + every key deletion
  constructor(readonly manifest: BillingApprovalManifest, private transport: PortOneHttpTransport,
    private webhookSecrets: Buffer[]) {
    this.scope = { provider: "portone", storeId: manifest.storeId, channelId: manifest.channelId, environment: manifest.mode };
  }
  private instrument(info: unknown) {
    const parsed = instrumentSchema.safeParse(info);
    if (!parsed.success) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    const i = parsed.data;
    if (i.storeId !== this.manifest.storeId || i.merchantId !== this.manifest.merchantId ||
      i.channels[0]!.id !== this.manifest.channelId || i.channels[0]!.type !== (this.manifest.mode === "live" ? "LIVE" : "TEST")) {
      throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    }
    return i;
  }
  async prepare(_input: { issuanceId: string; subjectId: string }) { /* Browser V2 requestIssueBillingKey, no server issuance I/O. */ }
  async getInstrument(billingKey: string) {
    const i = this.instrument(await this.transport.getBillingKeyInfo({ billingKey, storeId: this.manifest.storeId }));
    if (i.status !== "ISSUED") throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    return { ...this.scope, issuanceId: i.issueId, subjectId: i.customer.id };
  }
  async charge(input: { paymentId: string; subjectId: string; billingKey: string; totalAmount: number; currency: string }) {
    if (input.currency !== "KRW" || !Number.isInteger(input.totalAmount) || input.totalAmount <= 0) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    await this.transport.payWithBillingKey({ paymentId: input.paymentId, storeId: this.manifest.storeId, channelKey: this.manifest.channelKey,
      billingKey: input.billingKey, orderName: "Living Cost Manager subscription", customer: { id: input.subjectId },
      amount: { total: input.totalAmount }, currency: "KRW" }); // response alone NEVER settles
  }
  async getPayment(paymentId: string): Promise<PaymentObservation | null> {
    let raw;
    try { raw = await this.transport.getPayment({ paymentId, storeId: this.manifest.storeId }); }
    catch (error) { if (error instanceof PortOneTransportError && error.code === "PORTONE_NOT_FOUND") return null; throw error; }
    const result = paymentSchema.safeParse(raw);
    if (!result.success) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    const p = result.data;
    if (p.id !== paymentId || p.merchantId !== this.manifest.merchantId || p.storeId !== this.manifest.storeId ||
      p.channel.id !== this.manifest.channelId || p.channel.type !== (this.manifest.mode === "live" ? "LIVE" : "TEST") || p.amount.cancelled > p.amount.total) {
      throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    }
    const paid = ["PAID", "PARTIAL_CANCELLED", "CANCELLED"].includes(p.status);
    const paidAt = paid && p.paidAt ? new Date(p.paidAt) : null;
    if (paid && (!paidAt || !Number.isFinite(paidAt.getTime()))) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    const cancellations = (p.cancellations ?? []).filter(c => c.status === "SUCCEEDED").map(c => ({ cancelId: c.id, amount: c.totalAmount, reason: c.reason }));
    if (new Set(cancellations.map(c => c.cancelId)).size !== cancellations.length ||
      cancellations.reduce((n, c) => n + c.amount, 0) !== p.amount.cancelled) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    return { ...this.scope, paymentId: p.id, subjectId: p.customer.id, totalAmount: p.amount.total, currency: p.currency,
      status: paid ? "PAID" : p.status === "FAILED" ? "FAILED" : "PENDING", paidAt, cancelledAmount: p.amount.cancelled, cancellations };
  }
  // Internal due-cycle worker is the ONLY scheduler. We never create external
  // PortOne payment schedules; this flag cannot by itself verify cancellation.
  async cancelSchedule(subjectId: string) { this.stopped.add(subjectId); }
  async getSchedule(subjectId: string) { return { stopped: this.stopped.has(subjectId) }; }
  async revokeInstrument(input: { billingKey: string; issuanceId: string; subjectId: string }) {
    let info = this.instrument(await this.transport.getBillingKeyInfo({ billingKey: input.billingKey, storeId: this.manifest.storeId }));
    if (info.issueId !== input.issuanceId || info.customer.id !== input.subjectId) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    if (info.status !== "DELETED") {
      try { await this.transport.deleteBillingKey({ billingKey: input.billingKey, storeId: this.manifest.storeId }); } catch { /* authoritative GET only */ }
      info = this.instrument(await this.transport.getBillingKeyInfo({ billingKey: input.billingKey, storeId: this.manifest.storeId }));
    }
    return info.status === "DELETED" && info.issueId === input.issuanceId && info.customer.id === input.subjectId;
  }
  async recoverInstrument(input: { issuanceId: string; subjectId: string }) {
    // Scoped own-customer recovery; absence/partial pagination is NOT revocation.
    const response = await this.transport.getBillingKeyInfos(this.manifest.storeId, input.subjectId);
    const list = z.object({ items: z.array(z.object({ billingKey: z.string().min(1).max(1024) }).passthrough()) }).safeParse(response);
    if (!list.success) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    const matching = list.data.items.filter(item => {
      try { const i = this.instrument(item); return i.issueId === input.issuanceId && i.customer.id === input.subjectId; } catch { return false; }
    });
    if (matching.length !== 1) return null;
    return matching[0]!.billingKey;
  }
  async refund(input: { paymentId: string; amount: number; requestId: string }) {
    await this.transport.cancelPayment({ paymentId: input.paymentId, storeId: this.manifest.storeId, amount: input.amount,
      currentCancellableAmount: input.amount, reason: `LCM refund ${input.requestId}`, requester: "ADMIN" });
  }
  async lookupCancellation(input: { paymentId: string; requestId: string; amount: number; subjectId: string; totalAmount: number; currency: string }) {
    const observation = await this.getPayment(input.paymentId);
    if (!observation || observation.subjectId !== input.subjectId || observation.totalAmount !== input.totalAmount || observation.currency !== input.currency) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    const matches = observation?.cancellations?.filter(c => c.reason === `LCM refund ${input.requestId}` && c.amount === input.amount) ?? [];
    if (matches.length !== 1) return null;
    return { paymentId: input.paymentId, amount: matches[0]!.amount, cancelId: matches[0]!.cancelId };
  }
  async getCancellation(_requestId: string): Promise<null> { return null; } // legacy mock API; real uses scoped payment lookup
  async verifyWebhook(raw: Buffer, headers: Record<string, string>) {
    let result = null;
    for (const secret of this.webhookSecrets) {
      try { result = await verifyPortOneRawWebhook(raw, headers, secret, { ...this.manifest, environment: this.manifest.mode, configurationVerified: true }); break; }
      catch { /* up to two trusted active secrets; no logging/signature persistence */ }
    }
    if (!result) throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
    return { eventId: result.eventId, paymentId: result.paymentId };
  }
  async verifyWebhookOrIgnore(raw: Buffer, headers: Record<string, string>) {
    for (const secret of this.webhookSecrets) {
      try { return await verifyPortOneRawWebhook(raw, headers, secret, { ...this.manifest, environment: this.manifest.mode, configurationVerified: true }); }
      catch { /* try next approved active secret */ }
    }
    throw new PortOneTransportError("PORTONE_INVALID_EVIDENCE");
  }
}
