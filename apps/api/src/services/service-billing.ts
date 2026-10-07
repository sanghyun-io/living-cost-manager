import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ServiceBillingQuote } from "@prisma/client";
import {
  serviceBillingCatalog, serviceBillingCatalogVersion, serviceBillingConsentVersions,
  type ServiceBillingReadinessDto, type ServiceBillingSubscriptionDto, type ServiceBillingQuoteDto,
  type ServiceBillingAttemptDto, type ServiceBillingMode,
  type serviceBillingChargeRequestSchema
} from "@living-cost-manager/shared";
import type { z } from "zod";
import type { Env } from "../env.js";
import { decryptBillingKey, encryptBillingKey, instrumentAAD, MockServiceBillingProvider, type ServiceBillingProvider } from "./service-billing-provider.js";

export class ServiceBillingError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}
function fail(code: string, status = 409): never { throw new ServiceBillingError(code, status); }
type Tx = Prisma.TransactionClient;
type ChargeInput = z.infer<typeof serviceBillingChargeRequestSchema>;
const leaseMs = 30_000;
const lookupLimit = 8;

/** Original KST day/month remain frozen; short months clamp independently.
 * First period begins at verified paidAt, ending on the next anchored date's
 * KST midnight. This is a calendar billing period, not a fixed 30-day duration. */
export function serviceBillingPeriodBoundary(anchor: Date, months: number): Date {
  const kst = new Date(anchor.getTime() + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth() + months;
  const day = Math.min(kst.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  return new Date(Date.UTC(y, m, day) - 9 * 3600_000);
}

export class ServiceBillingService {
  readonly mode: ServiceBillingMode;
  readonly provider: ServiceBillingProvider | null;
  private readonly key: Buffer | null;
  private readonly keyVersion: string;
  private readonly enabled: boolean;
  constructor(readonly prisma: PrismaClient, readonly env: Env,
    private clock: () => Date = () => new Date(), provider?: ServiceBillingProvider) {
    this.mode = env.SERVICE_BILLING_MODE ?? "sandbox";
    this.key = env.SERVICE_BILLING_ENCRYPTION_KEY ? Buffer.from(env.SERVICE_BILLING_ENCRYPTION_KEY, "base64") : null;
    this.keyVersion = env.SERVICE_BILLING_KEY_VERSION ?? "";
    this.enabled = this.mode === "mock" && env.NODE_ENV !== "production" &&
      env.SERVICE_BILLING_MOCK_ENABLED === "true" && this.key?.length === 32 && !!this.keyVersion;
    // Explicitly no live/sandbox provider construction or capability promotion.
    this.provider = this.enabled ? (provider ?? new MockServiceBillingProvider(clock)) : null;
    if (this.provider && (this.provider.scope.environment !== "mock" || this.provider.scope.provider !== "mock")) {
      throw new Error("Only isolated mock provider supported");
    }
  }
  readiness(): ServiceBillingReadinessDto {
    return {
      mode: this.mode, checkoutEnabled: this.enabled,
      blockingCodes: this.enabled ? ["MOCK_ONLY", "PAID_PRODUCT_APPROVAL_PENDING", "LEGAL_TAX_APPROVAL_PENDING"] :
        ["PROVIDER_ADAPTER_NOT_VERIFIED", "MERCHANT_APPROVAL_UNVERIFIED", "PAID_PRODUCT_APPROVAL_PENDING", "LEGAL_TAX_APPROVAL_PENDING",
          ...(this.mode === "mock" ? [this.env.NODE_ENV === "production" ? "MOCK_FORBIDDEN_IN_PRODUCTION" : "MOCK_CONFIGURATION_REQUIRED"] : [])],
      catalogVersion: serviceBillingCatalogVersion, catalog: serviceBillingCatalog, currency: "KRW", taxTreatment: "pending",
      consentVersions: serviceBillingConsentVersions,
      capabilities: { issueInstrument: this.enabled, charge: this.enabled, renew: this.enabled, cancel: this.enabled, refund: this.enabled },
      sdkConfig: null // No external SDK is invoked for a simulated checkout.
    };
  }
  private requireMock() { if (!this.enabled || !this.provider || !this.key) fail("SERVICE_BILLING_NOT_READY", 503); }
  private async lockUser(tx: Tx, userId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!rows.length) fail("ACCOUNT_NOT_FOUND", 401);
  }
  private async lockContract(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "ServiceSubscriptionContract" WHERE "id" = ${id} FOR UPDATE`;
    const contract = await tx.serviceSubscriptionContract.findUnique({ where: { id } });
    if (!contract) fail("BILLING_NOT_FOUND", 404);
    return contract!;
  }
  private async ownedContract(tx: Tx, userId: string, create = false) {
    await this.lockUser(tx, userId);
    let contract = await tx.serviceSubscriptionContract.findUnique({ where: { userId } });
    if (!contract && create) {
      this.requireMock();
      const scope = this.provider!.scope;
      contract = await tx.serviceSubscriptionContract.create({ data: {
        userId, subjectId: `lcm_${randomUUID().replaceAll("-", "")}`, provider: scope.provider,
        storeId: scope.storeId, environment: scope.environment
      } });
    }
    if (!contract) fail("BILLING_NOT_FOUND", 404);
    const locked = await this.lockContract(tx, contract!.id);
    if (locked.userId !== userId) fail("BILLING_NOT_FOUND", 404);
    if (this.provider && (locked.provider !== this.provider.scope.provider || locked.storeId !== this.provider.scope.storeId ||
      locked.environment !== this.provider.scope.environment)) fail("BILLING_SCOPE_MISMATCH");
    return locked;
  }
  private quoteDto(q: ServiceBillingQuote): ServiceBillingQuoteDto {
    return { quoteId: q.id, planId: q.planId as "monthly" | "annual", catalogVersion: q.catalogVersion,
      totalAmount: q.totalAmount, currency: "KRW", periodMonths: q.periodMonths, expiresAt: q.expiresAt.toISOString(),
      consentVersions: { billing: q.billingVersion, autoRenew: q.autoRenewVersion } };
  }
  private quoteData(contract: { id: string; provider: string; storeId: string; environment: string }, planId: "monthly" | "annual") {
    return { contractId: contract.id, provider: contract.provider, storeId: contract.storeId, environment: contract.environment,
      channelId: this.provider!.scope.channelId, planId, ...serviceBillingCatalog[planId], catalogVersion: serviceBillingCatalogVersion,
      currency: "KRW", billingVersion: serviceBillingConsentVersions.billing, autoRenewVersion: serviceBillingConsentVersions.autoRenew,
      expiresAt: new Date(this.clock().getTime() + 15 * 60_000) };
  }
  async createQuote(userId: string, planId: "monthly" | "annual") {
    this.requireMock();
    return this.prisma.$transaction(async tx => {
      const contract = await this.ownedContract(tx, userId, true);
      if (contract.cancelRequested) fail("RENEWAL_STOPPED");
      return this.quoteDto(await tx.serviceBillingQuote.create({ data: this.quoteData(contract, planId) }));
    });
  }
  private async validQuote(tx: Tx, contractId: string, quoteId: string) {
    const q = await tx.serviceBillingQuote.findFirst({ where: { id: quoteId, contractId } });
    if (!q) fail("BILLING_NOT_FOUND", 404);
    if (q!.consumedAt || q!.expiresAt <= this.clock()) fail("QUOTE_EXPIRED_OR_CONSUMED");
    return q!;
  }
  async prepare(userId: string, quoteId: string) {
    this.requireMock();
    const prepared = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      if (c.cancelRequested) fail("RENEWAL_STOPPED");
      await this.validQuote(tx, c.id, quoteId);
      const existing = await tx.serviceBillingInstrument.findUnique({ where: { quoteId } });
      const instrument = existing ?? await tx.serviceBillingInstrument.create({ data: {
        contractId: c.id, quoteId, provider: c.provider, storeId: c.storeId, environment: c.environment,
        issuanceId: `lcm_issue_${randomUUID().replaceAll("-", "")}`
      } });
      return { instrument, subjectId: c.subjectId };
    });
    try { await this.provider!.prepare({ issuanceId: prepared.instrument.issuanceId, subjectId: prepared.subjectId }); }
    catch { fail("INSTRUMENT_PREPARATION_UNAVAILABLE", 503); }
    return { instrumentId: prepared.instrument.id, sdkRequest: {
      storeId: this.provider!.scope.storeId, channelId: this.provider!.scope.channelId,
      issueId: prepared.instrument.issuanceId, customer: { id: prepared.subjectId }, billingKeyMethod: "CARD" as const
    } };
  }
  async confirm(userId: string, instrumentId: string, billingKey: string) {
    this.requireMock();
    // Own the instrument BEFORE provider lookup; possession of a key is not proof.
    const instrument = await this.prisma.serviceBillingInstrument.findFirst({ where: { id: instrumentId, contract: { userId } } });
    if (!instrument) fail("BILLING_NOT_FOUND", 404);
    let observed;
    try { observed = await this.provider!.getInstrument(billingKey); }
    catch { fail("INSTRUMENT_VERIFICATION_FAILED", 422); }
    return this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      const i = await tx.serviceBillingInstrument.findFirst({ where: { id: instrumentId, contractId: c.id } });
      if (!i || i.status === "revoked" || c.cancelRequested) fail("INSTRUMENT_UNAVAILABLE");
      await this.validQuote(tx, c.id, i!.quoteId);
      if (observed!.issuanceId !== i!.issuanceId || observed!.subjectId !== c.subjectId || observed!.provider !== c.provider ||
        observed!.storeId !== c.storeId || observed!.environment !== c.environment || observed!.channelId !== this.provider!.scope.channelId) {
        fail("INSTRUMENT_BINDING_MISMATCH", 422);
      }
      if (i!.status !== "verified") {
        const envelope = encryptBillingKey(billingKey, this.key!, this.keyVersion, instrumentAAD(i!));
        await tx.serviceBillingInstrument.update({ where: { id: i!.id }, data: { ...envelope,
          ciphertext: Buffer.from(envelope.ciphertext), nonce: Buffer.from(envelope.nonce), authTag: Buffer.from(envelope.authTag),
          status: "verified", verifiedAt: this.clock() } });
      }
      return { instrumentId, status: "verified" };
    });
  }
  private binding(input: ChargeInput) {
    return createHash("sha256").update(JSON.stringify([input.quoteId, input.instrumentId, input.consent.billingVersion,
      input.consent.autoRenewVersion, input.consent.accepted])).digest("hex");
  }
  async charge(userId: string, input: ChargeInput) {
    this.requireMock();
    const binding = this.binding(input);
    const attempt = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      const old = await tx.servicePaymentAttempt.findUnique({ where: { contractId_idempotencyKey: { contractId: c.id, idempotencyKey: input.idempotencyKey } } });
      if (old) { if (old.requestBinding !== binding) fail("IDEMPOTENCY_CONFLICT"); return old; }
      if (c.cancelRequested || c.renewalStopped) fail("RENEWAL_STOPPED");
      // Initial checkout only. Renewal has its own due-cycle worker.
      if (c.nextCycle !== 0) fail("SUBSCRIPTION_ALREADY_PURCHASED");
      const q = await this.validQuote(tx, c.id, input.quoteId);
      const i = await tx.serviceBillingInstrument.findFirst({ where: { id: input.instrumentId, contractId: c.id, quoteId: q.id, status: "verified" } });
      if (!i || i.revokedAt) fail("INSTRUMENT_UNAVAILABLE");
      if (input.consent.billingVersion !== q.billingVersion || input.consent.autoRenewVersion !== q.autoRenewVersion || !input.consent.accepted) fail("CONSENT_VERSION_MISMATCH");
      const cycleExists = await tx.servicePaymentAttempt.findUnique({ where: { contractId_cycle: { contractId: c.id, cycle: c.nextCycle } } });
      if (cycleExists) fail("CYCLE_ALREADY_RESERVED");
      await tx.serviceBillingQuote.update({ where: { id: q.id }, data: { consumedAt: this.clock() } });
      return tx.servicePaymentAttempt.create({ data: this.attemptData(c, q, i.id, input.idempotencyKey, binding, this.clock()) });
    });
    await this.dispatch(attempt.id);
    return this.attemptDto(attempt.id, userId);
  }
  private attemptData(c: { id: string; provider: string; storeId: string; environment: string; nextCycle: number }, q: ServiceBillingQuote,
    instrumentId: string, idempotencyKey: string, requestBinding: string, acceptedAt: Date) {
    return { contractId: c.id, provider: c.provider, storeId: c.storeId, environment: c.environment,
      quoteId: q.id, instrumentId, cycle: c.nextCycle, paymentId: `lcm${randomUUID().replaceAll("-", "")}`,
      idempotencyKey, requestBinding, totalAmount: q.totalAmount, currency: q.currency,
      billingVersion: q.billingVersion, autoRenewVersion: q.autoRenewVersion, acceptedAt };
  }
  private async dispatch(attemptId: string) {
    this.requireMock();
    const seed = await this.prisma.servicePaymentAttempt.findUnique({ where: { id: attemptId } });
    if (!seed) return;
    if (seed.provider !== this.provider!.scope.provider || seed.storeId !== this.provider!.scope.storeId || seed.environment !== this.mode) fail("BILLING_SCOPE_MISMATCH");
    const claim = await this.prisma.$transaction(async tx => {
      const c = await this.lockContract(tx, seed.contractId);
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.dispatchAt || a.status !== "created") return null;
      if (c.cancelRequested) {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { status: "canceled_before_dispatch" } });
        return null;
      }
      const i = await tx.serviceBillingInstrument.findUniqueOrThrow({ where: { id: a.instrumentId } });
      if (i.status !== "verified" || !i.ciphertext || !i.nonce || !i.authTag || i.keyVersion !== this.keyVersion) fail("INSTRUMENT_UNAVAILABLE");
      let billingKey;
      try { billingKey = decryptBillingKey({ ciphertext: i.ciphertext!, nonce: i.nonce!, authTag: i.authTag!, keyVersion: i.keyVersion! }, this.key!, instrumentAAD(i)); }
      catch { fail("INSTRUMENT_DECRYPTION_FAILED"); }
      await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: {
        dispatchAt: this.clock(), status: "dispatch_unknown", nextLookupAt: new Date(this.clock().getTime() + leaseMs),
        leaseOwner: "dispatch", leaseUntil: new Date(this.clock().getTime() + leaseMs), fence: { increment: 1 }
      } });
      return { a, billingKey: billingKey!, subjectId: c.subjectId };
    });
    if (!claim) return;
    // Persisted dispatch marker precedes I/O. Even a process crash before send
    // must never create another payment ID or retry the charge.
    try { await this.provider!.charge({ paymentId: claim.a.paymentId, subjectId: claim.subjectId,
      billingKey: claim.billingKey, totalAmount: claim.a.totalAmount, currency: claim.a.currency }); }
    catch { /* unknown: only authoritative lookup, never redispatch */ }
    await this.prisma.servicePaymentAttempt.updateMany({ where: { id: attemptId, leaseOwner: "dispatch" }, data: {
      leaseOwner: null, leaseUntil: null, nextLookupAt: this.clock()
    } });
    await this.reconcile(attemptId);
  }
  async reconcile(attemptId: string) {
    this.requireMock();
    const seed = await this.prisma.servicePaymentAttempt.findUnique({ where: { id: attemptId } });
    if (!seed) return;
    if (seed.provider !== this.provider!.scope.provider || seed.storeId !== this.provider!.scope.storeId || seed.environment !== this.mode) fail("BILLING_SCOPE_MISMATCH");
    const owner = randomUUID();
    const claim = await this.prisma.$transaction(async tx => {
      const c = await this.lockContract(tx, seed.contractId);
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      const now = this.clock();
      if (!a.dispatchAt || ["paid", "failed", "manual_review", "refunded", "canceled_before_dispatch"].includes(a.status) ||
        (a.leaseUntil && a.leaseUntil > now) || (a.nextLookupAt && a.nextLookupAt > now)) return null;
      const next = await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: {
        leaseOwner: owner, leaseUntil: new Date(now.getTime() + leaseMs), fence: { increment: 1 }, lookupCount: { increment: 1 }
      } });
      return { a: next, c };
    });
    if (!claim) return;
    let observed = null;
    try { observed = await this.provider!.getPayment(claim.a.paymentId); } catch { /* bounded retry */ }
    await this.prisma.$transaction(async tx => {
      const c = await this.lockContract(tx, seed.contractId);
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.leaseOwner !== owner || a.fence !== claim.a.fence) return;
      const release = { leaseOwner: null, leaseUntil: null };
      const q = await tx.serviceBillingQuote.findUniqueOrThrow({ where: { id: a.quoteId } });
      const valid = observed && observed.paymentId === a.paymentId && observed.subjectId === c.subjectId &&
        observed.provider === a.provider && observed.storeId === a.storeId && observed.environment === a.environment &&
        observed.channelId === q.channelId && observed.totalAmount === a.totalAmount && observed.currency === a.currency;
      if (observed && !valid) {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release, status: "manual_review", nextLookupAt: null } });
        return;
      }
      if (valid && observed!.status === "PAID" && observed!.paidAt && Number.isFinite(observed!.paidAt.getTime()) && observed!.paidAt <= this.clock()) {
        const previous = await tx.servicePaidPeriod.findFirst({ where: { contractId: c.id }, orderBy: { cycle: "desc" } });
        const anchor = c.originalAnchor ?? observed!.paidAt;
        const startsAt = previous ? previous.endsAt : observed!.paidAt;
        const months = q.periodMonths * (a.cycle + 1);
        const endsAt = serviceBillingPeriodBoundary(anchor, months);
        if (endsAt <= startsAt || (previous && previous.cycle + 1 !== a.cycle)) fail("PERIOD_INCONSISTENCY");
        await tx.servicePaidPeriod.create({ data: { attemptId: a.id, contractId: c.id, cycle: a.cycle,
          environment: a.environment, startsAt, endsAt, accessEndsAt: endsAt, verifiedAt: this.clock() } });
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release, status: "paid", paidAt: observed!.paidAt, nextLookupAt: null } });
        await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: {
          status: c.cancelRequested ? "cancel_at_period_end" : "active", planId: q.planId,
          originalAnchor: anchor, nextCycle: a.cycle + 1, version: { increment: 1 }
        } });
      } else if (valid && observed!.status === "FAILED") {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release, status: "failed", nextLookupAt: null } });
      } else {
        const exhausted = a.lookupCount >= lookupLimit;
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release,
          status: exhausted ? "manual_review" : "dispatch_unknown",
          nextLookupAt: exhausted ? null : new Date(this.clock().getTime() + Math.min(3600_000, 1000 * 2 ** a.lookupCount)) } });
      }
    });
  }
  async attemptDto(id: string, userId: string): Promise<ServiceBillingAttemptDto> {
    const a = await this.prisma.servicePaymentAttempt.findFirst({ where: { id, contract: { userId } }, include: { period: true } });
    if (!a) fail("BILLING_NOT_FOUND", 404);
    return { attemptId: a!.id, status: a!.status, mode: a!.environment as ServiceBillingMode,
      paidAt: a!.paidAt?.toISOString() ?? null, paidPeriod: a!.period ? {
        startsAt: a!.period.startsAt.toISOString(), endsAt: a!.period.endsAt.toISOString()
      } : null };
  }
  async poll(userId: string, attemptId: string) {
    await this.attemptDto(attemptId, userId); // own before any lookup
    if (this.enabled) await this.reconcile(attemptId);
    return this.attemptDto(attemptId, userId);
  }
  async subscription(userId: string): Promise<ServiceBillingSubscriptionDto> {
    const c = await this.prisma.serviceSubscriptionContract.findUnique({ where: { userId } });
    const period = c ? await this.prisma.servicePaidPeriod.findFirst({ where: { contractId: c.id }, orderBy: { cycle: "desc" } }) : null;
    return { contractId: c?.id ?? null, planId: c?.planId ?? null, status: c?.status ?? "free",
      paidAccess: false, // No commercial approval in phase one. Mock/sandbox NEVER grant live access.
      paidThrough: period?.accessEndsAt.toISOString() ?? null,
      nextChargeAt: c && !c.cancelRequested && !c.renewalStopped ? period?.endsAt.toISOString() ?? null : null,
      cancelAtPeriodEnd: c?.cancelRequested ?? false, renewalStopped: c?.renewalStopped ?? false,
      providerCancellationStatus: c?.providerCancellationStatus ?? "none", premiumScope: "provisional", existingFreeAccess: true };
  }
  async cancel(userId: string) {
    this.requireMock();
    const c = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      await tx.servicePaymentAttempt.updateMany({ where: { contractId: c.id, status: "created", dispatchAt: null },
        data: { status: "canceled_before_dispatch" } });
      return tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: {
        cancelRequested: true, renewalStopped: true, providerCancellationStatus: "pending", status: "cancel_at_period_end", version: { increment: 1 }
      } });
    });
    // Local renewal stop is durable even when remote cancellation is uncertain.
    let stopped = false;
    try { await this.provider!.cancelSchedule(c.subjectId); stopped = (await this.provider!.getSchedule(c.subjectId)).stopped; } catch { /* retain pending */ }
    if (stopped) await this.prisma.$transaction(async tx => {
      await this.lockContract(tx, c.id);
      await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: { providerCancellationStatus: "verified" } });
      await tx.serviceBillingInstrument.updateMany({ where: { contractId: c.id }, data: { status: "revoked", revokedAt: this.clock(),
        ciphertext: null, nonce: null, authTag: null, keyVersion: null } });
    });
    return this.subscription(userId);
  }
  /** Manual local mock renewal only. No timer registration or production loop. */
  async renewMock(userId: string) {
    this.requireMock();
    const attempt = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      if (c.cancelRequested || c.renewalStopped || !c.originalAnchor || !c.planId) fail("RENEWAL_STOPPED");
      const previous = await tx.servicePaymentAttempt.findFirst({ where: { contractId: c.id, status: "paid" }, orderBy: { cycle: "desc" }, include: { period: true, quote: true, instrument: true } });
      if (!previous?.period || previous.period.endsAt > this.clock()) fail("RENEWAL_NOT_DUE");
      const existing = await tx.servicePaymentAttempt.findUnique({ where: { contractId_cycle: { contractId: c.id, cycle: c.nextCycle } } });
      if (existing) return existing;
      const planId = c.planId as "monthly" | "annual";
      if (!(planId in serviceBillingCatalog) || previous.totalAmount !== serviceBillingCatalog[planId].totalAmount ||
        previous.billingVersion !== serviceBillingConsentVersions.billing || previous.autoRenewVersion !== serviceBillingConsentVersions.autoRenew ||
        previous.instrument.status !== "verified") fail("RENEWAL_RECONSENT_REQUIRED");
      const q = await tx.serviceBillingQuote.create({ data: { ...this.quoteData(c, planId), consumedAt: this.clock() } });
      return tx.servicePaymentAttempt.create({ data: this.attemptData(c, q, previous.instrumentId,
        `renewal_${c.nextCycle}_${c.id}`, `renewal:${previous.id}`, previous.acceptedAt) });
    });
    await this.dispatch(attempt.id);
    return this.attemptDto(attempt.id, userId);
  }
  async requestRefund(userId: string, attemptId: string, idempotencyKey: string, reasonCode: string) {
    // Request capture is distinct from dispatch. In phase one only mock may execute.
    const refund = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      const a = await tx.servicePaymentAttempt.findFirst({ where: { id: attemptId, contractId: c.id } });
      if (!a) fail("BILLING_NOT_FOUND", 404);
      const old = await tx.serviceRefundRecord.findUnique({ where: { attemptId_idempotencyKey: { attemptId, idempotencyKey } } });
      if (old) { if (old.reasonCode !== reasonCode) fail("IDEMPOTENCY_CONFLICT"); return old; }
      if (a!.status !== "paid") fail("PAYMENT_NOT_REFUNDABLE");
      const prior = await tx.serviceRefundRecord.aggregate({ where: { attemptId, status: { not: "rejected" } }, _sum: { requestAmount: true } });
      const amount = a!.totalAmount - (prior._sum.requestAmount ?? 0);
      if (amount <= 0) fail("REFUND_ALREADY_RESERVED");
      return tx.serviceRefundRecord.create({ data: { attemptId, idempotencyKey, reasonCode, requestAmount: amount,
        provider: a!.provider, storeId: a!.storeId, environment: a!.environment } });
    });
    return { requestId: refund.id, status: refund.status, requestAmount: refund.requestAmount, currency: "KRW" as const };
  }
  /** Local simulation of full refunds; policy is NOT approved for live dispatch. */
  async executeMockRefund(userId: string, requestId: string) {
    this.requireMock();
    const r = await this.prisma.serviceRefundRecord.findFirst({ where: { id: requestId, attempt: { contract: { userId } } }, include: { attempt: true } });
    if (!r) fail("BILLING_NOT_FOUND", 404);
    if (r.provider !== this.provider!.scope.provider || r.storeId !== this.provider!.scope.storeId || r.environment !== this.mode) fail("BILLING_SCOPE_MISMATCH");
    const claimed = await this.prisma.serviceRefundRecord.updateMany({ where: { id: r!.id, status: "requested" }, data: { status: "dispatch_unknown" } });
    if (claimed.count) { try { await this.provider!.refund({ paymentId: r!.attempt.paymentId, requestId, amount: r!.requestAmount }); } catch { /* lookup only */ } }
    let observed;
    try { observed = await this.provider!.getCancellation(requestId); } catch { return; }
    if (!observed) return;
    if (observed.paymentId !== r!.attempt.paymentId || observed.amount !== r!.requestAmount) fail("REFUND_OBSERVATION_MISMATCH");
    await this.prisma.$transaction(async tx => {
      await this.lockContract(tx, r!.attempt.contractId);
      const current = await tx.serviceRefundRecord.findUniqueOrThrow({ where: { id: requestId } });
      if (current.status === "verified") return;
      await tx.serviceRefundRecord.update({ where: { id: requestId }, data: { status: "verified", providerCancelId: observed!.cancelId,
        verifiedAmount: observed!.amount, verifiedAt: this.clock() } });
      await tx.servicePaymentAttempt.update({ where: { id: r!.attemptId }, data: { status: "refunded" } });
      const p = await tx.servicePaidPeriod.findUnique({ where: { attemptId: r!.attemptId } });
      if (p) await tx.servicePaidPeriod.update({ where: { id: p.id }, data: { accessEndsAt: new Date(Math.max(p.startsAt.getTime(), Math.min(this.clock().getTime(), p.endsAt.getTime()))) } });
      await tx.serviceSubscriptionContract.update({ where: { id: r!.attempt.contractId }, data: {
        renewalStopped: true, cancelRequested: true, providerCancellationStatus: "pending", version: { increment: 1 }
      } });
    });
    // Synthetic full refund stops renewal too; real policy remains blocked.
    await this.cancel(userId);
  }
  async refundDto(userId: string, requestId: string) {
    const refund = await this.prisma.serviceRefundRecord.findFirst({ where: { id: requestId, attempt: { contract: { userId } } } });
    if (!refund) fail("BILLING_NOT_FOUND", 404);
    return { requestId: refund.id, status: refund.status, requestAmount: refund.requestAmount, currency: "KRW" as const };
  }
  /** Bounded durable reconciliation; never charges or creates cycles. */
  async reconcileOnce(limit = 25) {
    this.requireMock();
    const due = await this.prisma.servicePaymentAttempt.findMany({ where: {
      environment: "mock", provider: this.provider!.scope.provider, storeId: this.provider!.scope.storeId,
      status: "dispatch_unknown", nextLookupAt: { lte: this.clock() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: this.clock() } }]
    }, take: Math.min(100, Math.max(1, limit)), orderBy: { nextLookupAt: "asc" } });
    for (const a of due) await this.reconcile(a.id);
    const events = await this.prisma.serviceBillingEventReceipt.findMany({ where: {
      provider: this.provider!.scope.provider, storeId: this.provider!.scope.storeId, environment: this.mode,
      status: "pending", OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: this.clock() } }],
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: this.clock() } }] }]
    }, take: Math.min(100, Math.max(1, limit)), orderBy: { receivedAt: "asc" } });
    for (const event of events) await this.processEvent(event.id);
    return due.length;
  }

  /** Called ONLY with verified adapter output; not exposed as a client endpoint.
   * Tests use synthetic IDs, not a fabricated PortOne signature fixture. */
  async recordVerifiedEvent(input: { provider: string; storeId: string; environment: string; eventId: string; paymentId: string }) {
    this.requireMock();
    if (input.provider !== this.provider!.scope.provider || input.storeId !== this.provider!.scope.storeId ||
      input.environment !== this.mode || !/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId) || !/^[A-Za-z0-9_-]{1,40}$/.test(input.paymentId)) fail("EVENT_SCOPE_MISMATCH", 400);
    const attempt = await this.prisma.servicePaymentAttempt.findUnique({ where: {
      provider_storeId_environment_paymentId: { provider: input.provider, storeId: input.storeId, environment: input.environment, paymentId: input.paymentId }
    } });
    await this.prisma.serviceBillingEventReceipt.createMany({ data: [{
      provider: input.provider, storeId: input.storeId, environment: input.environment,
      eventId: input.eventId, paymentId: input.paymentId, attemptId: attempt?.id
    }], skipDuplicates: true });
    const event = await this.prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: {
      provider_storeId_environment_eventId: { provider: input.provider, storeId: input.storeId, environment: input.environment, eventId: input.eventId }
    } });
    if (event.paymentId !== input.paymentId) fail("EVENT_IDEMPOTENCY_CONFLICT");
    return event.id;
  }
  async processEvent(eventId: string) {
    this.requireMock();
    const owner = randomUUID();
    const claim = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ServiceBillingEventReceipt" WHERE "id" = ${eventId} FOR UPDATE`;
      const e = await tx.serviceBillingEventReceipt.findUnique({ where: { id: eventId } });
      if (!e || e.provider !== this.provider!.scope.provider || e.storeId !== this.provider!.scope.storeId || e.environment !== this.mode ||
        e.status !== "pending" || (e.leaseUntil && e.leaseUntil > this.clock()) || (e.nextRetryAt && e.nextRetryAt > this.clock())) return null;
      return tx.serviceBillingEventReceipt.update({ where: { id: e.id }, data: { leaseOwner: owner,
        leaseUntil: new Date(this.clock().getTime() + leaseMs), fence: { increment: 1 }, retryCount: { increment: 1 } } });
    });
    if (!claim) return;
    let attemptId = claim.attemptId;
    if (!attemptId) {
      attemptId = (await this.prisma.servicePaymentAttempt.findUnique({ where: { provider_storeId_environment_paymentId: {
        provider: claim.provider, storeId: claim.storeId, environment: claim.environment, paymentId: claim.paymentId
      } } }))?.id ?? null;
    }
    let processed = false;
    if (attemptId) {
      try {
        await this.reconcile(attemptId);
        const a = await this.prisma.servicePaymentAttempt.findUnique({ where: { id: attemptId } });
        processed = !!a && ["paid", "failed", "refunded", "canceled_before_dispatch"].includes(a.status);
      } catch { /* bounded retry; no event payload errors leak */ }
    }
    const exhausted = claim.retryCount >= lookupLimit;
    await this.prisma.serviceBillingEventReceipt.updateMany({ where: { id: claim.id, leaseOwner: owner, fence: claim.fence }, data: {
      attemptId, leaseOwner: null, leaseUntil: null, processedAt: processed ? this.clock() : null,
      status: processed ? "processed" : exhausted ? "manual_review" : "pending",
      nextRetryAt: processed || exhausted ? null : new Date(this.clock().getTime() + 1000 * 2 ** claim.retryCount)
    } });
  }
}
