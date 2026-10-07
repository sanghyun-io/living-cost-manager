import { createHmac, randomBytes } from "node:crypto";
import { loadEnv } from "../src/env.js";
import { PortOneHttpTransport, PortOneServiceBillingProvider } from "../src/services/service-billing-portone.js";
import type { BillingApprovalManifest } from "../src/services/service-billing-config.js";

export function syntheticApprovedConfiguration(databaseUrl: string, mode: "sandbox" | "live" = "sandbox") {
  const secret = randomBytes(32);
  const manifest: BillingApprovalManifest = {
    mode, status: "verified", approvalReference: "synthetic-approval-v1", configurationReference: "synthetic-config-v1", launchReference: "synthetic-launch-v1", workerRegistrationReference: "synthetic-worker-v1",
    merchantId: "synthetic-lcm-merchant", storeId: "synthetic-lcm-store", channelId: "synthetic-lcm-channel", channelKey: "synthetic-lcm-public-channel-key",
    domain: "living-cost-manager.gamja.top", catalogVersion: "lcm-990-9900-v1", featureScope: "account-subscription-v1", featureScopeVersion: "features-v1",
    policyVersion: "policy-v1", sellerVersion: "seller-v1", billingVersion: "billing-v1", autoRenewVersion: "renew-v1", taxTreatment: "inclusive",
    materials: { billing: "Synthetic billing consent material only.", autoRenew: "Synthetic recurring renewal consent only.",
      features: "Synthetic paid scope, not approved real benefits.", policy: "Synthetic test policy, not public legal advice.", seller: "Synthetic seller disclosure, not a real seller." },
    capabilities: { issueInstrument: true, charge: true, renew: true, cancel: true, refund: true }, refundPolicy: "full_remaining_manual_v1",
    workers: { reconcile: true, renew: true, refunds: true }
  };
  const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl, JWT_SECRET: randomBytes(40).toString("base64"), SERVICE_BILLING_MODE: mode,
    SERVICE_BILLING_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SERVICE_BILLING_KEY_VERSION: "test-v2",
    SERVICE_BILLING_APPROVAL_MANIFEST: JSON.stringify(manifest), PORTONE_LCM_API_SECRET: randomBytes(32).toString("base64"),
    PORTONE_LCM_WEBHOOK_SECRETS: JSON.stringify([secret.toString("base64")]) });
  return { manifest, env, secret };
}

/** Only an injected in-process fetch. No socket/network/provider account. Fake
 * JSON uses official response fields, including TEST/LIVE channel type; no
 * fabricated provider environment field. Tests may corrupt observations. */
export class FakePortOneHttp {
  readonly calls: { method: string; pathname: string }[] = []; // NO headers/body/key-containing URLs
  instruments = new Map<string, Record<string, any>>();
  payments = new Map<string, Record<string, any>>();
  chargeCount = 0;
  cancelCount = 0;
  deleteCount = 0;
  loseChargeResponse = false;
  unavailableLookups = false;
  unavailableDeletion = false;
  constructor(readonly manifest: BillingApprovalManifest, private clock: () => Date) {}
  issue(issuanceId: string, subjectId: string) {
    const token = `synthetic_${issuanceId}`;
    this.instruments.set(token, { status: "ISSUED", billingKey: token, merchantId: this.manifest.merchantId, storeId: this.manifest.storeId,
      issueId: issuanceId, customer: { id: subjectId }, channels: [{ id: this.manifest.channelId, type: this.manifest.mode === "sandbox" ? "TEST" : "LIVE" }], issuedAt: this.clock().toISOString() });
    return token;
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.portone.io" || !init?.signal || init.redirect !== "error") throw new Error("Unexpected fake transport request");
    const method = init?.method ?? "GET";
    this.calls.push({ method, pathname: url.pathname.startsWith("/billing-keys/") ? "/billing-keys/[redacted]" : url.pathname });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const scopeStore = body.storeId ?? url.searchParams.get("storeId") ?? JSON.parse(url.searchParams.get("requestBody") ?? "{}").filter?.storeId;
    if (scopeStore !== this.manifest.storeId) return Response.json({}, { status: 403 });
    if (url.pathname === "/billing-keys") {
      const filter = JSON.parse(url.searchParams.get("requestBody")!).filter;
      return Response.json({ items: [...this.instruments.values()].filter(i => i.customer.id === filter.customerId), page: { number: 0, size: 100, totalCount: 1 } });
    }
    if (url.pathname.startsWith("/billing-keys/")) {
      const token = decodeURIComponent(url.pathname.slice("/billing-keys/".length));
      const i = this.instruments.get(token);
      if (!i) return Response.json({}, { status: 404 });
      if (method === "DELETE") {
        if (this.unavailableDeletion) throw new Error("Synthetic DELETE unavailable");
        this.deleteCount++; i.status = "DELETED"; i.deletedAt = this.clock().toISOString();
        return Response.json({ deletedAt: i.deletedAt });
      }
      return Response.json(i);
    }
    const match = /^\/payments\/([^/]+)(\/billing-key|\/cancel)?$/.exec(url.pathname);
    if (!match) throw new Error("Unexpected fake API endpoint");
    const paymentId = decodeURIComponent(match[1]!);
    if (method === "POST" && match[2] === "/billing-key") {
      if (this.payments.has(paymentId)) return Response.json({}, { status: 409 });
      this.chargeCount++;
      if (body.channelKey !== this.manifest.channelKey || this.instruments.get(body.billingKey)?.status !== "ISSUED") return Response.json({}, { status: 422 });
      this.payments.set(paymentId, { status: "PAID", id: paymentId, storeId: this.manifest.storeId, merchantId: this.manifest.merchantId,
        channel: { id: this.manifest.channelId, type: this.manifest.mode === "sandbox" ? "TEST" : "LIVE" }, customer: body.customer,
        amount: { total: body.amount.total, cancelled: 0 }, currency: body.currency, paidAt: this.clock().toISOString(), cancellations: [] });
      if (this.loseChargeResponse) throw new Error("Synthetic POST response lost");
      return Response.json({ payment: { paidAt: this.clock().toISOString() } });
    }
    const p = this.payments.get(paymentId);
    if (!p) return Response.json({}, { status: 404 });
    if (match[2] === "/cancel") {
      if (body.currentCancellableAmount !== p.amount.total - p.amount.cancelled || body.amount > body.currentCancellableAmount) return Response.json({}, { status: 409 });
      this.cancelCount++; p.amount.cancelled += body.amount; p.status = p.amount.cancelled === p.amount.total ? "CANCELLED" : "PARTIAL_CANCELLED";
      p.cancellations.push({ status: "SUCCEEDED", id: `synthetic_cancellation_${this.cancelCount}`, totalAmount: body.amount, reason: body.reason });
      return Response.json({ cancellation: p.cancellations.at(-1) });
    }
    if (this.unavailableLookups) throw new Error("Synthetic GET unavailable");
    return Response.json(p);
  };
  provider(secrets: Buffer[]) { return new PortOneServiceBillingProvider(this.manifest, new PortOneHttpTransport("synthetic_transport_credential", this.fetch, 100), secrets); }
}
export function signedPortOneFixture(secret: Buffer, storeId: string, paymentId: string, eventId: string, type = "Transaction.Paid") {
  const raw = Buffer.from(`{ "type": "${type}", "timestamp": "${new Date().toISOString()}", "data": { "storeId": "${storeId}", "paymentId": "${paymentId}" } }`);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${eventId}.${timestamp}.`).update(raw).digest("base64");
  return { raw, headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` } };
}
