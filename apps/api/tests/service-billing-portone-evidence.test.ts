import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Payment } from "@portone/server-sdk";
import { validatePortOneInstrument, validatePortOnePaidPayment, verifyPortOneRawWebhook } from "../src/services/service-billing-portone-evidence.js";

const scope = { merchantId: "synthetic-merchant", storeId: "synthetic-store", channelId: "synthetic-channel",
  environment: "sandbox" as const, configurationVerified: true as const };
function fixture(type = "Transaction.Paid", storeId = scope.storeId) {
  const secret = randomBytes(32);
  const raw = Buffer.from(`{ "type": "${type}", "timestamp": "${new Date().toISOString()}", "data": { "storeId": "${storeId}", "paymentId": "synthetic_payment" } }`);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = "synthetic_signed_event";
  const signature = createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(raw).digest("base64");
  return { secret, raw, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` } };
}
describe("official PortOne evidence helpers (not live merchant integration)", () => {
  it("official SDK verifies the exact raw bytes and returns no entitlement", async () => {
    const f = fixture();
    expect(await verifyPortOneRawWebhook(f.raw, f.headers, f.secret, scope)).toEqual({
      provider: "portone", storeId: scope.storeId, environment: "sandbox", eventId: "synthetic_signed_event", paymentId: "synthetic_payment"
    });
    const changed = Buffer.from(JSON.stringify(JSON.parse(f.raw.toString())));
    await expect(verifyPortOneRawWebhook(changed, f.headers, f.secret, scope)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("missing headers 404, wrong signature/scope 400, unknown signed events ignored", async () => {
    const f = fixture();
    await expect(verifyPortOneRawWebhook(f.raw, {}, f.secret, scope)).rejects.toMatchObject({ statusCode: 404 });
    await expect(verifyPortOneRawWebhook(f.raw, f.headers, randomBytes(32), scope)).rejects.toMatchObject({ statusCode: 400 });
    const wrong = fixture("Transaction.Paid", "other-store");
    await expect(verifyPortOneRawWebhook(wrong.raw, wrong.headers, wrong.secret, scope)).rejects.toMatchObject({ code: "WEBHOOK_SCOPE_MISMATCH" });
    const unknown = fixture("Future.Event");
    expect(await verifyPortOneRawWebhook(unknown.raw, unknown.headers, unknown.secret, scope)).toBeNull();
    const billingKey = fixture("BillingKey.Issued");
    expect(await verifyPortOneRawWebhook(billingKey.raw, billingKey.headers, billingKey.secret, scope)).toBeNull();
  });
  it("requires official optional issuance, customer and channel bindings rather than key possession", () => {
    const issued: Payment.BillingKey.IssuedBillingKeyInfo = { status: "ISSUED", billingKey: "synthetic-key", merchantId: scope.merchantId,
      storeId: scope.storeId, customer: { id: "subject" }, issueId: "issuance", issuedAt: new Date().toISOString(),
      channels: [{ type: "TEST", id: scope.channelId, pgProvider: "NICE", pgMerchantId: "synthetic-pg" }] };
    const expected = { ...scope, issuanceId: "issuance", subjectId: "subject" };
    expect(validatePortOneInstrument(issued, expected)).toMatchObject({ environment: "sandbox", issuanceId: "issuance" });
    for (const changed of [{ ...issued, issueId: undefined }, { ...issued, customer: {} }, { ...issued, channels: [] }, { ...issued, merchantId: "other" }]) {
      expect(() => validatePortOneInstrument(changed, expected)).toThrow("PORTONE_BINDING_UNVERIFIED");
    }
  });
  it("uses exact amount/currency/customer and verified config environment, rejecting cancellation", () => {
    // Only fields read by pure normalizer are synthetic; no API call/record used.
    const paid = { status: "PAID", id: "payment", merchantId: scope.merchantId, storeId: scope.storeId,
      channel: { id: scope.channelId, type: "TEST" }, customer: { id: "subject" }, amount: { total: 990, cancelled: 0 }, currency: "KRW",
      paidAt: new Date().toISOString() } as Payment.PaidPayment;
    const expected = { ...scope, paymentId: "payment", subjectId: "subject", totalAmount: 990, currency: "KRW" as const };
    expect(validatePortOnePaidPayment(paid, expected).environment).toBe("sandbox");
    expect(() => validatePortOnePaidPayment({ ...paid, amount: { ...paid.amount, cancelled: 1 } }, expected)).toThrow();
    expect(() => validatePortOnePaidPayment({ ...paid, customer: {} }, expected)).toThrow();
    expect(() => validatePortOnePaidPayment({ ...paid, paidAt: "not-a-date" }, expected)).toThrow();
  });
});
