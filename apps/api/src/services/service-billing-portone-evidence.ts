import { Webhook, type Payment } from "@portone/server-sdk";
import { ServiceBillingError } from "./service-billing.js";

/** Phase-two evidence helpers, NOT a registered live adapter. No API secret,
 * merchant calls, invented environment response field, or checkout switch.
 * SelectedChannel.id, issueId and customer.id are optional in official types:
 * missing binding is unsupported, never equivalent to token possession. */
export type VerifiedPortOneScope = {
  merchantId: string; storeId: string; channelId: string;
  environment: "sandbox" | "live"; configurationVerified: true;
};
function invalid(): never { throw new ServiceBillingError("PORTONE_BINDING_UNVERIFIED", 422); }
export function validatePortOneInstrument(
  info: Payment.BillingKey.IssuedBillingKeyInfo,
  expected: VerifiedPortOneScope & { issuanceId: string; subjectId: string }
) {
  if (expected.configurationVerified !== true || info.status !== "ISSUED" ||
    info.merchantId !== expected.merchantId || info.storeId !== expected.storeId ||
    info.issueId !== expected.issuanceId || info.customer.id !== expected.subjectId ||
    info.channels.length !== 1 || info.channels[0]?.id !== expected.channelId ||
    info.channels[0]?.type !== (expected.environment === "sandbox" ? "TEST" : "LIVE")) invalid();
  // Environment is supplied by verified channel configuration, not by GET.
  return { issuanceId: expected.issuanceId, subjectId: expected.subjectId,
    provider: "portone", storeId: expected.storeId, environment: expected.environment, channelId: expected.channelId };
}
export function validatePortOnePaidPayment(
  info: Payment.PaidPayment,
  expected: VerifiedPortOneScope & { paymentId: string; subjectId: string; totalAmount: number; currency: "KRW" }
) {
  if (expected.configurationVerified !== true || info.status !== "PAID" || info.id !== expected.paymentId ||
    info.merchantId !== expected.merchantId || info.storeId !== expected.storeId || info.channel.id !== expected.channelId ||
    info.channel.type !== (expected.environment === "sandbox" ? "TEST" : "LIVE") ||
    info.customer.id !== expected.subjectId || info.amount.total !== expected.totalAmount || info.currency !== expected.currency ||
    info.amount.cancelled !== 0) invalid();
  const paidAt = new Date(info.paidAt);
  if (!Number.isFinite(paidAt.getTime())) invalid();
  return { provider: "portone", storeId: expected.storeId, environment: expected.environment,
    channelId: expected.channelId, paymentId: info.id, subjectId: expected.subjectId,
    totalAmount: info.amount.total, currency: info.currency, status: "PAID" as const, paidAt };
}
export async function verifyPortOneRawWebhook(
  raw: Buffer, headers: Record<string, string | string[] | undefined>, secret: Uint8Array,
  scope: VerifiedPortOneScope
) {
  if (!scope.configurationVerified || secret.length < 32) throw new ServiceBillingError("WEBHOOK_NOT_CONFIGURED", 404);
  if (raw.length > 16_384 || !headers["webhook-id"] || !headers["webhook-timestamp"] || !headers["webhook-signature"]) {
    throw new ServiceBillingError("WEBHOOK_NOT_CONFIGURED", 404);
  }
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    if (typeof headers[name] !== "string" || headers[name]!.length > 2048) throw new ServiceBillingError("INVALID_WEBHOOK_SIGNATURE", 400);
  }
  let webhook;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    // Exact raw UTF-8 bytes, not JSON.stringify(parsedBody).
    webhook = await Webhook.verify(secret, text, headers);
  } catch { throw new ServiceBillingError("INVALID_WEBHOOK_SIGNATURE", 400); }
  if (!webhook || typeof webhook !== "object" || !("data" in webhook)) return null; // SDK unknown future event type
  if (typeof webhook.type !== "string" || ![
    "Transaction.Ready", "Transaction.Paid", "Transaction.VirtualAccountIssued", "Transaction.PartialCancelled",
    "Transaction.Cancelled", "Transaction.Failed", "Transaction.PayPending", "Transaction.CancelPending",
    "Transaction.DisputeCreated", "Transaction.DisputeResolved"
  ].includes(webhook.type)) return null;
  const data = webhook.data;
  if (!data || data.storeId !== scope.storeId) throw new ServiceBillingError("WEBHOOK_SCOPE_MISMATCH", 400);
  if (!("paymentId" in data)) return null; // Never persist a BillingKey event/token.
  const eventId = headers["webhook-id"];
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) ||
    typeof data.paymentId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(data.paymentId)) {
    throw new ServiceBillingError("INVALID_WEBHOOK_EVENT", 400);
  }
  // Caller must claim receipt then use authoritative getPayment; no entitlement.
  return { provider: "portone", storeId: scope.storeId, environment: scope.environment, eventId, paymentId: data.paymentId };
}
