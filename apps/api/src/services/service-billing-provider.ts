import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { ServiceBillingMode } from "@living-cost-manager/shared";

export type BillingScope = { provider: string; storeId: string; environment: ServiceBillingMode; channelId: string };
export type PaymentObservation = BillingScope & {
  paymentId: string; subjectId: string; status: "PAID" | "FAILED" | "PENDING";
  totalAmount: number; currency: string; paidAt: Date | null;
};
export interface ServiceBillingProvider {
  readonly scope: BillingScope;
  prepare(input: { issuanceId: string; subjectId: string }): Promise<void>;
  getInstrument(key: string): Promise<{ issuanceId: string; subjectId: string } & BillingScope>;
  charge(input: { paymentId: string; subjectId: string; billingKey: string; totalAmount: number; currency: string }): Promise<void>;
  getPayment(paymentId: string): Promise<PaymentObservation | null>;
  cancelSchedule(subjectId: string): Promise<void>;
  getSchedule(subjectId: string): Promise<{ stopped: boolean }>;
  refund(input: { paymentId: string; amount: number; requestId: string }): Promise<void>;
  getCancellation(requestId: string): Promise<{ paymentId: string; amount: number; cancelId: string } | null>;
  // Real signed PortOne verification remains unsupported; no fake verifier.
  verifyWebhook(raw: Buffer, headers: Record<string, string>): Promise<{ eventId: string; paymentId: string }>;
}

/** Synthetic provider only. Keys and observations never leave this process.
 * Restart loses its observations; unknown persisted attempts require manual
 * review rather than redispatch. It is NOT a sandbox or approval proof. */
export class MockServiceBillingProvider implements ServiceBillingProvider {
  readonly scope: BillingScope = { provider: "mock", storeId: "lcm-local-mock", environment: "mock", channelId: "mock-card" };
  private instruments = new Map<string, { issuanceId: string; subjectId: string }>();
  private payments = new Map<string, PaymentObservation>();
  private stopped = new Set<string>();
  private cancellations = new Map<string, { paymentId: string; amount: number; cancelId: string }>();
  dispatchCount = 0;
  constructor(private clock: () => Date = () => new Date()) {}
  async prepare(input: { issuanceId: string; subjectId: string }) {
    this.instruments.set(`mock_${input.issuanceId}`, input);
  }
  async getInstrument(key: string) {
    const instrument = this.instruments.get(key);
    if (!instrument) throw new Error("Instrument verification failed");
    return { ...instrument, ...this.scope };
  }
  async charge(input: { paymentId: string; subjectId: string; billingKey: string; totalAmount: number; currency: string }) {
    const instrument = await this.getInstrument(input.billingKey);
    if (instrument.subjectId !== input.subjectId || this.payments.has(input.paymentId)) throw new Error("Dispatch rejected");
    this.dispatchCount++;
    this.payments.set(input.paymentId, { ...this.scope, paymentId: input.paymentId, subjectId: input.subjectId,
      totalAmount: input.totalAmount, currency: input.currency, status: "PAID", paidAt: this.clock() });
  }
  async getPayment(paymentId: string) { return this.payments.get(paymentId) ?? null; }
  async cancelSchedule(subjectId: string) { this.stopped.add(subjectId); }
  async getSchedule(subjectId: string) { return { stopped: this.stopped.has(subjectId) }; }
  async refund(input: { paymentId: string; amount: number; requestId: string }) {
    const payment = this.payments.get(input.paymentId);
    if (!payment || input.amount !== payment.totalAmount) throw new Error("Refund rejected");
    if (!this.cancellations.has(input.requestId)) this.cancellations.set(input.requestId, {
      paymentId: input.paymentId, amount: input.amount, cancelId: `mock_${randomUUID()}`
    });
  }
  async getCancellation(requestId: string) { return this.cancellations.get(requestId) ?? null; }
  async verifyWebhook(_raw: Buffer, _headers: Record<string, string>): Promise<{ eventId: string; paymentId: string }> {
    throw new Error("PortOne webhook verification unsupported in mock mode");
  }
}

export type Envelope = { ciphertext: Uint8Array; nonce: Uint8Array; authTag: Uint8Array; keyVersion: string };
export function instrumentAAD(input: { id: string; contractId: string; provider: string; storeId: string; environment: string }) {
  return Buffer.from(JSON.stringify(["LCM-billing-instrument-v1", input.id, input.contractId, input.provider, input.storeId, input.environment]));
}
export function encryptBillingKey(value: string, key: Buffer, keyVersion: string, aad: Buffer): Envelope {
  if (key.length !== 32) throw new Error("Encryption unavailable");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion };
}
export function decryptBillingKey(envelope: Envelope, key: Buffer, aad: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.authTag));
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
}
