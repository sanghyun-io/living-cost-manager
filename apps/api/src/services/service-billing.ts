import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ServiceBillingQuote } from "@prisma/client";
import {
  serviceBillingCatalog, serviceBillingCatalogVersion, serviceBillingConsentVersions,
  type ServiceBillingReadinessDto, type ServiceBillingSubscriptionDto, type ServiceBillingQuoteDto,
  type ServiceBillingAttemptDto, type ServiceBillingMode,
  serviceBillingAttemptResponseSchema, serviceBillingSubscriptionResponseSchema,
  serviceBillingReadinessResponseSchema, serviceBillingQuoteResponseSchema, serviceBillingInstrumentResponseSchema, serviceBillingRefundResponseSchema,
  type serviceBillingChargeRequestSchema
} from "@living-cost-manager/shared";
import type { z } from "zod";
import type { Env } from "../env.js";
import { decryptBillingKey, encryptBillingKey, instrumentAAD, MockServiceBillingProvider, type ServiceBillingProvider } from "./service-billing-provider.js";
import { parseBillingConfiguration } from "./service-billing-config.js";
import { PortOneHttpTransport, PortOneServiceBillingProvider, PortOneTransportError } from "./service-billing-portone.js";

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
  private readonly config: ReturnType<typeof parseBillingConfiguration>;
  constructor(readonly prisma: PrismaClient, readonly env: Env,
    private clock: () => Date = () => new Date(), provider?: ServiceBillingProvider) {
    this.mode = env.SERVICE_BILLING_MODE ?? "sandbox";
    this.key = env.SERVICE_BILLING_ENCRYPTION_KEY ? Buffer.from(env.SERVICE_BILLING_ENCRYPTION_KEY, "base64") : null;
    this.keyVersion = env.SERVICE_BILLING_KEY_VERSION ?? "";
    this.config = parseBillingConfiguration(env);
    this.enabled = this.config.enabled;
    if (this.enabled && this.mode !== "mock" && env.NODE_ENV === "test" && !provider) throw new Error("Test mode requires an injected non-network provider");
    if (provider && this.mode !== "mock" && env.NODE_ENV !== "test") throw new Error("Provider injection restricted to tests");
    this.provider = this.enabled ? (provider ?? (this.mode === "mock" ? new MockServiceBillingProvider(clock) :
      new PortOneServiceBillingProvider(this.config.manifest!, new PortOneHttpTransport(env.PORTONE_LCM_API_SECRET!), this.config.webhookSecrets))) : null;
    if (this.provider && (this.provider.scope.environment !== this.mode || this.provider.scope.provider !== (this.mode === "mock" ? "mock" : "portone") ||
      (this.mode !== "mock" && (this.provider.scope.storeId !== this.config.manifest!.storeId || this.provider.scope.channelId !== this.config.manifest!.channelId)))) {
      throw new Error("Provider scope mismatch");
    }
  }
  readiness(): ServiceBillingReadinessDto {
    return serviceBillingReadinessResponseSchema.parse({
      mode: this.mode, checkoutEnabled: this.config.capabilities.issueInstrument && this.config.capabilities.charge && this.config.capabilities.renew,
      blockingCodes: this.mode === "mock" && this.enabled ? ["MOCK_ONLY", "PAID_PRODUCT_APPROVAL_PENDING", "LEGAL_TAX_APPROVAL_PENDING"] :
        [...this.config.blockers, ...(this.enabled && this.mode !== "mock" ? Object.entries(this.config.capabilities).filter(([, v]) => !v).map(([k]) => `${k.toUpperCase()}_DISABLED`) : [])],
      catalogVersion: serviceBillingCatalogVersion, catalog: serviceBillingCatalog, currency: "KRW",
      taxTreatment: this.mode !== "mock" && this.enabled ? "inclusive" : "pending",
      consentVersions: { billing: this.config.approvedVersions.billing, autoRenew: this.config.approvedVersions.autoRenew },
      capabilities: this.config.capabilities,
      approvedVersions: this.config.approvedVersions,
      approvedMaterial: this.mode !== "mock" && this.enabled ? this.config.manifest!.materials : null,
      approvalStatus: this.mode === "mock" && this.enabled ? "mock_draft" : this.enabled ? "approved" : "blocked",
      sdkConfig: this.mode !== "mock" && this.config.capabilities.issueInstrument ? { storeId: this.config.manifest!.storeId,
        channelId: this.config.manifest!.channelId, channelKey: this.config.manifest!.channelKey } : null
    });
  }
  private requireMock() { if (this.mode !== "mock") fail("MOCK_ONLY", 404); this.requireReady(); }
  private requireReady(capability?: keyof ReturnType<typeof parseBillingConfiguration>["capabilities"]) {
    if (!this.enabled || !this.provider || !this.key || (capability && !this.config.capabilities[capability])) fail("SERVICE_BILLING_NOT_READY", 503);
  }
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
      this.requireReady("issueInstrument");
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
    return serviceBillingQuoteResponseSchema.parse({ quoteId: q.id, planId: q.planId as "monthly" | "annual", catalogVersion: q.catalogVersion,
      totalAmount: q.totalAmount, currency: "KRW", periodMonths: q.periodMonths, expiresAt: q.expiresAt.toISOString(),
      consentVersions: { billing: q.billingVersion, autoRenew: q.autoRenewVersion },
      approvedVersions: { featureScope: q.featureScopeVersion, policy: q.policyVersion, seller: q.sellerVersion, billing: q.billingVersion, autoRenew: q.autoRenewVersion },
      approvedMaterial: q.materialsSnapshot as ServiceBillingQuoteDto["approvedMaterial"] });
  }
  private quoteData(contract: { id: string; provider: string; storeId: string; environment: string }, planId: "monthly" | "annual") {
    return { contractId: contract.id, provider: contract.provider, storeId: contract.storeId, environment: contract.environment,
      channelId: this.provider!.scope.channelId, planId, ...serviceBillingCatalog[planId], catalogVersion: serviceBillingCatalogVersion,
      currency: "KRW", billingVersion: this.config.approvedVersions.billing, autoRenewVersion: this.config.approvedVersions.autoRenew,
      featureScopeVersion: this.config.approvedVersions.featureScope, policyVersion: this.config.approvedVersions.policy,
      sellerVersion: this.config.approvedVersions.seller, premiumScope: this.mode === "mock" ? "provisional" : this.config.manifest!.featureScope,
      materialsSnapshot: this.mode === "mock" ? Prisma.JsonNull : this.config.manifest!.materials,
      expiresAt: new Date(this.clock().getTime() + 15 * 60_000) };
  }
  async createQuote(userId: string, planId: "monthly" | "annual") {
    this.requireReady("issueInstrument");
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
    this.validateCurrentQuote(q);
    return q!;
  }
  private validateCurrentQuote(q: ServiceBillingQuote) {
    const plan = serviceBillingCatalog[q.planId as "monthly" | "annual"];
    if (!plan || q.catalogVersion !== serviceBillingCatalogVersion || q.totalAmount !== plan.totalAmount || q.periodMonths !== plan.periodMonths ||
      q.billingVersion !== this.config.approvedVersions.billing || q.autoRenewVersion !== this.config.approvedVersions.autoRenew ||
      q.featureScopeVersion !== this.config.approvedVersions.featureScope || q.policyVersion !== this.config.approvedVersions.policy || q.sellerVersion !== this.config.approvedVersions.seller ||
      q.channelId !== this.provider!.scope.channelId || q.currency !== "KRW") fail("RECONSENT_REQUIRED");
    if (this.mode !== "mock") {
      const snapshot = q.materialsSnapshot as Record<string, string> | null;
      if (!snapshot || Object.entries(this.config.manifest!.materials).some(([k, v]) => snapshot[k] !== v)) fail("RECONSENT_REQUIRED");
    }
  }
  async prepare(userId: string, quoteId: string) {
    this.requireReady("issueInstrument");
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
      ...(this.mode !== "mock" ? { channelKey: this.config.manifest!.channelKey } : {}),
      issueId: prepared.instrument.issuanceId, customer: { id: prepared.subjectId }, billingKeyMethod: "CARD" as const
    } };
  }
  async confirm(userId: string, instrumentId: string, billingKey: string) {
    this.requireReady("issueInstrument");
    // Own the instrument BEFORE provider lookup; possession of a key is not proof.
    const instrument = await this.prisma.serviceBillingInstrument.findFirst({ where: { id: instrumentId, contract: { userId } } });
    if (!instrument) fail("BILLING_NOT_FOUND", 404);
    let observed;
    try { observed = await this.provider!.getInstrument(billingKey); }
    catch { fail("INSTRUMENT_VERIFICATION_FAILED", 422); }
    return this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      const i = await tx.serviceBillingInstrument.findFirst({ where: { id: instrumentId, contractId: c.id } });
      if (!i || !["prepared", "verified"].includes(i.status) || c.cancelRequested) fail("INSTRUMENT_UNAVAILABLE");
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
    this.requireReady("charge");
    if (this.mode !== "mock" && !this.readiness().checkoutEnabled) fail("SERVICE_BILLING_NOT_READY", 503);
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
    this.requireReady("charge");
    const seed = await this.prisma.servicePaymentAttempt.findUnique({ where: { id: attemptId } });
    if (!seed) return;
    if (seed.provider !== this.provider!.scope.provider || seed.storeId !== this.provider!.scope.storeId || seed.environment !== this.mode) fail("BILLING_SCOPE_MISMATCH");
    const claim = await this.prisma.$transaction(async tx => {
      const c = await this.lockContract(tx, seed.contractId);
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.dispatchAt || a.status !== "created") return null;
      const quote = await tx.serviceBillingQuote.findUniqueOrThrow({ where: { id: a.quoteId } });
      if (c.cancelRequested) {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { status: "canceled_before_dispatch" } });
        return null;
      }
      if (a.cycle > 0 && (c.renewalStopped || c.renewalReviewRequired)) {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { status: "canceled_before_dispatch" } });
        if (!c.renewalStopped) await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: { renewalStopped: true, version: { increment: 1 } } });
        return { blocked: c.renewalReviewRequired ? "OVERDUE_RENEWAL_REVIEW" : "RENEWAL_STOPPED" };
      }
      this.validateCurrentQuote(quote);
      const i = await tx.serviceBillingInstrument.findUniqueOrThrow({ where: { id: a.instrumentId } });
      if (i.status !== "verified" || !i.ciphertext || !i.nonce || !i.authTag || i.keyVersion !== this.keyVersion) fail("INSTRUMENT_UNAVAILABLE");
      let billingKey;
      try { billingKey = decryptBillingKey({ ciphertext: i.ciphertext!, nonce: i.nonce!, authTag: i.authTag!, keyVersion: i.keyVersion! }, this.key!, instrumentAAD(i)); }
      catch { fail("INSTRUMENT_DECRYPTION_FAILED"); }
      // Reservation eligibility is not authority to send later. Re-read the
      // clock under this claim's contract lock immediately before writing intent.
      const now = this.clock();
      if (a.cycle > 0) {
        const startsAt = c.originalAnchor ? serviceBillingPeriodBoundary(c.originalAnchor, quote.periodMonths * a.cycle) : null;
        const endsAt = c.originalAnchor ? serviceBillingPeriodBoundary(c.originalAnchor, quote.periodMonths * (a.cycle + 1)) : null;
        if (!startsAt || !endsAt || endsAt <= now || startsAt < now || startsAt > now || a.cycle !== c.nextCycle) {
          await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { status: "canceled_before_dispatch" } });
          await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: {
            renewalStopped: true, renewalReviewRequired: true, version: { increment: 1 } } });
          return { blocked: "OVERDUE_RENEWAL_REVIEW" };
        }
      }
      await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: {
        dispatchAt: now, status: "dispatch_unknown", nextLookupAt: new Date(now.getTime() + leaseMs),
        leaseOwner: "dispatch", leaseUntil: new Date(now.getTime() + leaseMs), fence: { increment: 1 }
      } });
      return { a, billingKey: billingKey!, subjectId: c.subjectId };
    });
    if (!claim) return;
    if ("blocked" in claim) fail(claim.blocked!);
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
  async reconcile(attemptId: string, force = false): Promise<
    { outcome: "skipped" | "retry" | "manual_review" } |
    { outcome: "fresh_authoritative_committed"; fence: number; initiatedAt: Date; cancelledAmount: number; totalAmount: number }
  > {
    this.requireReady();
    const seed = await this.prisma.servicePaymentAttempt.findUnique({ where: { id: attemptId } });
    if (!seed) return { outcome: "skipped" };
    if (seed.provider !== this.provider!.scope.provider || seed.storeId !== this.provider!.scope.storeId || seed.environment !== this.mode) fail("BILLING_SCOPE_MISMATCH");
    const owner = randomUUID();
    const claim = await this.prisma.$transaction(async tx => {
      const c = await this.lockContract(tx, seed.contractId);
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      const now = this.clock();
      if (!a.dispatchAt || a.reviewRequired || ((!force || !["paid", "refunded"].includes(a.status)) && ["paid", "failed", "manual_review", "refunded", "canceled_before_dispatch"].includes(a.status)) ||
        (a.leaseUntil && a.leaseUntil > now) || (a.nextLookupAt && a.nextLookupAt > now)) return null;
      const next = await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: {
        leaseOwner: owner, leaseUntil: new Date(now.getTime() + leaseMs), fence: { increment: 1 }, lookupCount: { increment: 1 }
      } });
      return { a: next, c };
    });
    if (!claim) return { outcome: "skipped" };
    const initiatedAt = this.clock(); // this invocation ONLY; never borrow another worker's observation
    let observed = null;
    let invalidEvidence = false;
    try { observed = await this.provider!.getPayment(claim.a.paymentId); }
    catch (error) { invalidEvidence = error instanceof PortOneTransportError && error.code === "PORTONE_INVALID_EVIDENCE"; }
    return this.prisma.$transaction(async tx => {
      const c = await this.lockContract(tx, seed.contractId);
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.leaseOwner !== owner || a.fence !== claim.a.fence) return { outcome: "skipped" as const };
      const fresh = () => ({ outcome: "fresh_authoritative_committed" as const, fence: claim.a.fence, initiatedAt,
        cancelledAmount: observed?.cancelledAmount ?? 0, totalAmount: a.totalAmount });
      const release = { leaseOwner: null, leaseUntil: null };
      const q = await tx.serviceBillingQuote.findUniqueOrThrow({ where: { id: a.quoteId } });
      const valid = observed && observed.paymentId === a.paymentId && observed.subjectId === c.subjectId &&
        observed.provider === a.provider && observed.storeId === a.storeId && observed.environment === a.environment &&
        observed.channelId === q.channelId && observed.totalAmount === a.totalAmount && observed.currency === a.currency;
      if (invalidEvidence || (observed && !valid)) {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release,
          ...(["paid", "refunded"].includes(a.status) ? { reviewRequired: true } : { status: "manual_review" }), nextLookupAt: null } });
        return { outcome: "manual_review" as const };
      }
      if (["paid", "refunded"].includes(a.status)) {
        if (valid && observed!.status === "PAID") {
          const canceled = observed!.cancelledAmount ?? 0;
          let unknownCancellation = false;
          for (const cancellation of observed!.cancellations ?? []) {
            const r = await tx.serviceRefundRecord.findFirst({ where: { attemptId: a.id,
              OR: [{ providerCancelId: cancellation.cancelId }, { id: cancellation.reason.replace(/^LCM refund /, "") }] } });
            if (!r || r.requestAmount !== cancellation.amount || (this.mode !== "mock" && !r.approvalOperationId)) { unknownCancellation = true; continue; }
            await tx.serviceRefundRecord.update({ where: { id: r.id }, data: { status: "verified", providerCancelId: cancellation.cancelId,
              verifiedAmount: cancellation.amount, verifiedAt: this.clock() } });
          }
          await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release, nextLookupAt: null, lookupCount: 0,
            ...(canceled === a.totalAmount ? { status: "refunded" } : {}), ...(unknownCancellation ? { reviewRequired: true } : {}) } });
          if (canceled > 0) {
            const p = await tx.servicePaidPeriod.findUnique({ where: { attemptId: a.id } });
            if (p) await tx.servicePaidPeriod.update({ where: { id: p.id }, data: { accessEndsAt: new Date(Math.max(p.startsAt.getTime(), Math.min(this.clock().getTime(), p.accessEndsAt.getTime()))) } });
            await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: { renewalStopped: true, cancelRequested: true,
              providerCancellationStatus: c.providerCancellationStatus === "verified" ? "verified" : "pending", version: { increment: 1 } } });
          }
          // Cancellation coverage changes are committed even for unknown external
          // refunds; the durable review flag separately blocks operator deletion.
          return fresh();
        } else {
          const exhausted = a.lookupCount >= lookupLimit;
          await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release,
            ...(exhausted ? { reviewRequired: true } : {}), nextLookupAt: exhausted ? null : new Date(this.clock().getTime() + leaseMs) } });
          return { outcome: exhausted ? "manual_review" as const : "retry" as const };
        }
      }
      if (valid && (observed!.cancelledAmount ?? 0) > 0) {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release, status: "manual_review", reviewRequired: true, nextLookupAt: null } });
        return { outcome: "manual_review" as const };
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
        return fresh();
      } else if (valid && observed!.status === "FAILED") {
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release, status: "failed", nextLookupAt: null } });
        return fresh();
      } else {
        const exhausted = a.lookupCount >= lookupLimit;
        await tx.servicePaymentAttempt.update({ where: { id: a.id }, data: { ...release,
          status: exhausted ? "manual_review" : "dispatch_unknown",
          nextLookupAt: exhausted ? null : new Date(this.clock().getTime() + Math.min(3600_000, 1000 * 2 ** a.lookupCount)) } });
        return { outcome: exhausted ? "manual_review" as const : "retry" as const };
      }
    });
  }
  async attemptDto(id: string, userId: string): Promise<ServiceBillingAttemptDto> {
    const a = await this.prisma.servicePaymentAttempt.findFirst({ where: { id, contract: { userId } }, include: { period: true } });
    if (!a) fail("BILLING_NOT_FOUND", 404);
    return serviceBillingAttemptResponseSchema.parse({ attemptId: a!.id, status: a!.status, mode: a!.environment as ServiceBillingMode,
      reviewRequired: a!.reviewRequired,
      paidAt: a!.paidAt?.toISOString() ?? null, paidPeriod: a!.period ? {
        startsAt: a!.period.startsAt.toISOString(), endsAt: a!.period.endsAt.toISOString()
      } : null });
  }
  async poll(userId: string, attemptId: string) {
    await this.attemptDto(attemptId, userId); // own before any lookup
    if (this.enabled) await this.reconcile(attemptId, this.mode !== "mock");
    return this.attemptDto(attemptId, userId);
  }
  async byIdempotency(userId: string, idempotencyKey: string) {
    const a = await this.prisma.servicePaymentAttempt.findFirst({ where: { idempotencyKey, contract: { userId } } });
    if (!a) fail("BILLING_NOT_FOUND", 404); // NOT proof that an in-flight original POST will never commit
    return this.poll(userId, a.id);
  }
  async instrumentDto(userId: string, instrumentId: string) {
    const i = await this.prisma.serviceBillingInstrument.findFirst({ where: { id: instrumentId, contract: { userId } } });
    if (!i) fail("BILLING_NOT_FOUND", 404);
    return serviceBillingInstrumentResponseSchema.parse({ instrumentId: i.id, status: i.status, requiresManualReview: i.status === "manual_review" });
  }
  async revokeInstrument(userId: string, instrumentId: string) {
    this.requireReady("cancel");
    const owner = randomUUID();
    const claim = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      const i = await tx.serviceBillingInstrument.findFirst({ where: { id: instrumentId, contractId: c.id } });
      if (!i) fail("BILLING_NOT_FOUND", 404);
      if (i.status === "revoked" || (i.leaseUntil && i.leaseUntil > this.clock())) return null;
      const next = await tx.serviceBillingInstrument.update({ where: { id: i.id }, data: { status: "revocation_pending", version: { increment: 1 },
        leaseOwner: owner, leaseUntil: new Date(this.clock().getTime() + leaseMs) } });
      return { i: next, c };
    });
    if (!claim) return this.instrumentDto(userId, instrumentId);
    let token: string | null = null;
    let verified = this.mode === "mock";
    try {
      if (claim.i.ciphertext && claim.i.nonce && claim.i.authTag && claim.i.keyVersion === this.keyVersion) {
        token = decryptBillingKey({ ciphertext: claim.i.ciphertext, nonce: claim.i.nonce, authTag: claim.i.authTag, keyVersion: claim.i.keyVersion }, this.key!, instrumentAAD(claim.i));
      } else if (!claim.i.ciphertext && this.provider!.recoverInstrument) {
        token = await this.provider!.recoverInstrument({ issuanceId: claim.i.issuanceId, subjectId: claim.c.subjectId });
      }
      if (this.mode !== "mock" && token && this.provider!.revokeInstrument) verified = await this.provider!.revokeInstrument({ billingKey: token,
        issuanceId: claim.i.issuanceId, subjectId: claim.c.subjectId });
    } catch { /* missing key/unsupported ownership proof/provider uncertainty stays blocked */ }
    await this.prisma.$transaction(async tx => {
      await this.lockContract(tx, claim.c.id);
      const current = await tx.serviceBillingInstrument.findUniqueOrThrow({ where: { id: instrumentId } });
      if (current.version !== claim.i.version || current.leaseOwner !== owner) return;
      const data = verified ? { status: "revoked", revokedAt: this.clock(), ciphertext: null, nonce: null, authTag: null, keyVersion: null } :
        { status: "manual_review" };
      await tx.serviceBillingInstrument.update({ where: { id: instrumentId }, data: { ...data, leaseOwner: null, leaseUntil: null } });
    });
    return this.instrumentDto(userId, instrumentId);
  }
  async subscription(userId: string): Promise<ServiceBillingSubscriptionDto> {
    const c = await this.prisma.serviceSubscriptionContract.findUnique({ where: { userId } });
    const period = c ? await this.prisma.servicePaidPeriod.findFirst({ where: { contractId: c.id }, orderBy: { cycle: "desc" }, include: { attempt: { include: { quote: true } } } }) : null;
    const coverage = c ? await this.prisma.servicePaidPeriod.findFirst({ where: { contractId: c.id, environment: "live",
      startsAt: { lte: this.clock() }, accessEndsAt: { gt: this.clock() }, attempt: { status: "paid", reviewRequired: false } },
      include: { attempt: { include: { quote: true } } } }) : null;
    return serviceBillingSubscriptionResponseSchema.parse({ contractId: c?.id ?? null, planId: c?.planId ?? null, status: c?.status ?? "free",
      paidAccess: this.env.SERVICE_PAID_FEATURES_PUBLISHED === "true" && this.mode === "live" && this.enabled && this.readiness().checkoutEnabled && this.config.manifest?.featureScope === "account-subscription-v1" &&
        !!coverage && coverage.attempt.quote.premiumScope === this.config.manifest.featureScope &&
        coverage.attempt.quote.featureScopeVersion === this.config.manifest.featureScopeVersion &&
        coverage.attempt.quote.channelId === this.config.manifest.channelId && coverage.attempt.quote.catalogVersion === this.config.manifest.catalogVersion &&
        coverage.attempt.provider === "portone" && coverage.attempt.storeId === this.config.manifest.storeId && coverage.attempt.environment === "live" &&
        c?.provider === "portone" && c.storeId === this.config.manifest.storeId && c.environment === "live",
      paidThrough: period?.accessEndsAt.toISOString() ?? null,
      nextChargeAt: c && !c.cancelRequested && !c.renewalStopped ? period?.endsAt.toISOString() ?? null : null,
      cancelAtPeriodEnd: c?.cancelRequested ?? false, renewalStopped: c?.renewalStopped ?? false,
      providerCancellationStatus: c?.providerCancellationStatus ?? "none", premiumScope: period?.attempt.quote.premiumScope ?? "provisional", existingFreeAccess: true });
  }
  async cancel(userId: string) {
    this.requireReady("cancel");
    const claim = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      if (c.cancelRequested && c.renewalStopped && c.status === "cancel_at_period_end" && c.providerCancellationStatus === "verified" &&
        c.cancellationVerifiedVersion === c.version) {
        const instruments = await tx.serviceBillingInstrument.count({ where: { contractId: c.id,
          OR: [{ status: { not: "revoked" } }, { ciphertext: { not: null } }, { nonce: { not: null } }, { authTag: { not: null } }, { keyVersion: { not: null } }] } });
        const created = await tx.servicePaymentAttempt.count({ where: { contractId: c.id, status: "created" } });
        if (!instruments && !created) return { c, replay: true };
      }
      await tx.servicePaymentAttempt.updateMany({ where: { contractId: c.id, status: "created", dispatchAt: null },
        data: { status: "canceled_before_dispatch" } });
      const next = await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: {
        cancelRequested: true, renewalStopped: true, providerCancellationStatus: "pending", status: "cancel_at_period_end", version: { increment: 1 }
      } });
      return { c: next, replay: false };
    });
    if (claim.replay) return this.subscription(userId);
    const c = claim.c;
    // Local renewal stop is durable even when remote cancellation is uncertain.
    let stopped = false;
    try { await this.provider!.cancelSchedule(c.subjectId); stopped = (await this.provider!.getSchedule(c.subjectId)).stopped; } catch { /* retain pending */ }
    if (stopped && this.mode !== "mock") {
      const instruments = await this.prisma.serviceBillingInstrument.findMany({ where: { contractId: c.id, status: { not: "revoked" } } });
      for (const i of instruments) await this.revokeInstrument(userId, i.id);
      stopped = (await this.prisma.serviceBillingInstrument.count({ where: { contractId: c.id, status: { not: "revoked" } } })) === 0;
    }
    if (stopped) await this.prisma.$transaction(async tx => {
      const current = await this.lockContract(tx, c.id);
      if (current.version !== c.version || !current.cancelRequested || !current.renewalStopped) return;
      if (this.mode !== "mock" && await tx.serviceBillingInstrument.count({ where: { contractId: c.id, status: { not: "revoked" } } })) return;
      await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: { providerCancellationStatus: "verified", cancellationVerifiedVersion: current.version } });
      await tx.serviceBillingInstrument.updateMany({ where: { contractId: c.id }, data: { status: "revoked", revokedAt: this.clock(),
        ciphertext: null, nonce: null, authTag: null, keyVersion: null } });
    });
    return this.subscription(userId);
  }
  /** Manual local mock renewal only. No timer registration or production loop. */
  async renewMock(userId: string) {
    this.requireMock();
    return this.renew(userId);
  }
  async renew(userId: string) {
    this.requireReady("renew");
    const attempt = await this.prisma.$transaction(async tx => {
      const c = await this.ownedContract(tx, userId);
      if (c.renewalReviewRequired) return { overdue: true as const };
      if (c.cancelRequested || c.renewalStopped || !c.originalAnchor || !c.planId) fail("RENEWAL_STOPPED");
      const previous = await tx.servicePaymentAttempt.findFirst({ where: { contractId: c.id, status: "paid" }, orderBy: { cycle: "desc" }, include: { period: true, quote: true, instrument: true } });
      if (!previous?.period || previous.period.endsAt > this.clock()) fail("RENEWAL_NOT_DUE");
      const existing = await tx.servicePaymentAttempt.findUnique({ where: { contractId_cycle: { contractId: c.id, cycle: c.nextCycle } } });
      if (existing && (existing.dispatchAt || existing.status !== "created")) return existing;
      const planId = c.planId as "monthly" | "annual";
      if (!(planId in serviceBillingCatalog) || previous.totalAmount !== serviceBillingCatalog[planId].totalAmount ||
        previous.billingVersion !== this.config.approvedVersions.billing || previous.autoRenewVersion !== this.config.approvedVersions.autoRenew ||
        previous.instrument.status !== "verified") fail("RENEWAL_RECONSENT_REQUIRED");
      this.validateCurrentQuote(previous.quote);
      // Never "catch up" missed expired cycles by charging for coverage that
      // would already have ended. No grace/arrears policy has been invented.
      const startsAt = serviceBillingPeriodBoundary(c.originalAnchor, serviceBillingCatalog[planId].periodMonths * c.nextCycle);
      const endsAt = serviceBillingPeriodBoundary(c.originalAnchor, serviceBillingCatalog[planId].periodMonths * (c.nextCycle + 1));
      if (endsAt <= this.clock() || startsAt < this.clock()) {
        if (existing) await tx.servicePaymentAttempt.update({ where: { id: existing.id }, data: { status: "canceled_before_dispatch" } });
        await tx.serviceSubscriptionContract.update({ where: { id: c.id }, data: { renewalReviewRequired: true, renewalStopped: true, version: { increment: 1 } } });
        return { overdue: true as const };
      }
      if (existing) return existing;
      const q = await tx.serviceBillingQuote.create({ data: { ...this.quoteData(c, planId), consumedAt: this.clock() } });
      return tx.servicePaymentAttempt.create({ data: this.attemptData(c, q, previous.instrumentId,
        `renewal_${c.nextCycle}_${c.id}`, `renewal:${previous.id}`, previous.acceptedAt) });
    });
    if ("overdue" in attempt) fail("OVERDUE_RENEWAL_REVIEW");
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
      if (a!.status !== "paid" || a!.reviewRequired) fail("PAYMENT_NOT_REFUNDABLE");
      const prior = await tx.serviceRefundRecord.aggregate({ where: { attemptId, status: { not: "rejected" } }, _sum: { requestAmount: true } });
      const amount = a!.totalAmount - (prior._sum.requestAmount ?? 0);
      if (amount <= 0) fail("REFUND_ALREADY_RESERVED");
      return tx.serviceRefundRecord.create({ data: { attemptId, idempotencyKey, reasonCode, requestAmount: amount,
        provider: a!.provider, storeId: a!.storeId, environment: a!.environment } });
    });
    return serviceBillingRefundResponseSchema.parse({ requestId: refund.id, status: refund.status, requestAmount: refund.requestAmount, currency: "KRW" as const });
  }
  /** Local simulation of full refunds; policy is NOT approved for live dispatch. */
  async executeMockRefund(userId: string, requestId: string) {
    this.requireMock();
    return this.executeRefund(userId, requestId);
  }
  async approveAndExecuteRefund(requestId: string, operationId: string, policyVersion: string) {
    this.requireReady("refund");
    if (this.mode === "mock" || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId) || policyVersion !== this.config.manifest?.policyVersion) fail("REFUND_APPROVAL_REQUIRED");
    const r = await this.prisma.serviceRefundRecord.findUnique({ where: { id: requestId }, include: { attempt: { include: { contract: true, quote: true } } } });
    if (!r?.attempt.contract.userId) fail("BILLING_NOT_FOUND", 404);
    if (r.provider !== this.provider!.scope.provider || r.storeId !== this.provider!.scope.storeId || r.environment !== this.mode ||
      r.attempt.quote.policyVersion !== policyVersion) fail("REFUND_POLICY_SCOPE_MISMATCH");
    await this.prisma.$transaction(async tx => {
      await this.lockContract(tx, r.attempt.contractId);
      const current = await tx.serviceRefundRecord.findUniqueOrThrow({ where: { id: requestId } });
      if (current.approvalOperationId && (current.approvalOperationId !== operationId || current.approvalPolicyVersion !== policyVersion)) fail("REFUND_APPROVAL_CONFLICT");
      if (!current.approvalOperationId) await tx.serviceRefundRecord.update({ where: { id: requestId }, data: {
        approvalOperationId: operationId, approvalPolicyVersion: policyVersion } });
    });
    await this.executeRefund(r.attempt.contract.userId, requestId);
    return this.refundDto(r.attempt.contract.userId, requestId);
  }
  private async executeRefund(userId: string, requestId: string) {
    this.requireReady("refund");
    const r = await this.prisma.serviceRefundRecord.findFirst({ where: { id: requestId, attempt: { contract: { userId } } }, include: { attempt: { include: { contract: true } } } });
    if (!r) fail("BILLING_NOT_FOUND", 404);
    if (r.provider !== this.provider!.scope.provider || r.storeId !== this.provider!.scope.storeId || r.environment !== this.mode) fail("BILLING_SCOPE_MISMATCH");
    if (this.mode !== "mock" && (!r.approvalOperationId || r.approvalPolicyVersion !== this.config.manifest?.policyVersion)) fail("REFUND_APPROVAL_REQUIRED");
    if (r.status === "verified") return this.refundDto(userId, requestId);
    const owner = randomUUID();
    const claim = await this.prisma.$transaction(async tx => {
      await this.lockContract(tx, r.attempt.contractId);
      const current = await tx.serviceRefundRecord.findUniqueOrThrow({ where: { id: requestId } });
      if (!["requested", "dispatch_unknown"].includes(current.status) || current.lookupCount >= lookupLimit ||
        (current.leaseUntil && current.leaseUntil > this.clock()) || (current.nextLookupAt && current.nextLookupAt > this.clock())) return null;
      const a = await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: r.attemptId } });
      if (a.reviewRequired || (current.status === "requested" && a.status !== "paid")) fail("PAYMENT_NOT_REFUNDABLE");
      const next = await tx.serviceRefundRecord.update({ where: { id: requestId }, data: { status: "dispatch_unknown", leaseOwner: owner,
        leaseUntil: new Date(this.clock().getTime() + leaseMs), fence: { increment: 1 }, lookupCount: { increment: 1 } } });
      return { dispatch: current.status === "requested", refund: next };
    });
    if (!claim) return;
    if (claim.dispatch) { try { await this.provider!.refund({ paymentId: r.attempt.paymentId, requestId, amount: r.requestAmount }); } catch { /* lookup only */ } }
    let observed;
    try { observed = this.provider!.lookupCancellation ? await this.provider!.lookupCancellation({ paymentId: r.attempt.paymentId, requestId, amount: r.requestAmount,
      subjectId: r.attempt.contract.subjectId, totalAmount: r.attempt.totalAmount, currency: r.attempt.currency }) :
      await this.provider!.getCancellation(requestId); } catch { /* bounded lookup only */ }
    if (!observed) {
      const exhausted = claim.refund.lookupCount >= lookupLimit;
      await this.prisma.serviceRefundRecord.updateMany({ where: { id: requestId, leaseOwner: owner, fence: claim.refund.fence }, data: {
        leaseOwner: null, leaseUntil: null, status: exhausted ? "manual_review" : "dispatch_unknown",
        nextLookupAt: exhausted ? null : new Date(this.clock().getTime() + 1000 * 2 ** claim.refund.lookupCount) } });
      return;
    }
    if (observed.paymentId !== r!.attempt.paymentId || observed.amount !== r!.requestAmount) fail("REFUND_OBSERVATION_MISMATCH");
    await this.prisma.$transaction(async tx => {
      await this.lockContract(tx, r!.attempt.contractId);
      const current = await tx.serviceRefundRecord.findUniqueOrThrow({ where: { id: requestId } });
      if (current.status === "verified" || current.leaseOwner !== owner || current.fence !== claim.refund.fence) return;
      await tx.serviceRefundRecord.update({ where: { id: requestId }, data: { status: "verified", providerCancelId: observed!.cancelId,
        verifiedAmount: observed!.amount, verifiedAt: this.clock(), leaseOwner: null, leaseUntil: null, nextLookupAt: null } });
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
    return serviceBillingRefundResponseSchema.parse({ requestId: refund.id, status: refund.status, requestAmount: refund.requestAmount, currency: "KRW" as const });
  }
  /** Bounded durable reconciliation; never charges or creates cycles. */
  async reconcileOnce(limit = 25) {
    this.requireReady();
    const due = await this.prisma.servicePaymentAttempt.findMany({ where: {
      environment: this.mode, provider: this.provider!.scope.provider, storeId: this.provider!.scope.storeId,
       status: { in: ["dispatch_unknown", "paid", "refunded"] }, nextLookupAt: { lte: this.clock() }, reviewRequired: false,
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: this.clock() } }]
    }, take: Math.min(100, Math.max(1, limit)), orderBy: { nextLookupAt: "asc" } });
    for (const a of due) await this.reconcile(a.id, this.mode !== "mock");
    const events = await this.prisma.serviceBillingEventReceipt.findMany({ where: {
      provider: this.provider!.scope.provider, storeId: this.provider!.scope.storeId, environment: this.mode,
      status: { in: ["pending", "pending_cancelled", "pending_partial_cancelled", "pending_cancel_pending"] }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: this.clock() } }],
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: this.clock() } }] }]
    }, take: Math.min(100, Math.max(1, limit)), orderBy: { receivedAt: "asc" } });
    for (const event of events) await this.processEvent(event.id);
    if (this.mode !== "mock") {
      const pendingCancels = await this.prisma.serviceSubscriptionContract.findMany({ where: { provider: this.provider!.scope.provider,
        storeId: this.provider!.scope.storeId, environment: this.mode, cancelRequested: true, providerCancellationStatus: "pending", userId: { not: null } }, take: Math.min(10, limit) });
      for (const c of pendingCancels) { try { await this.cancel(c.userId!); } catch { /* durable pending */ } }
      if (this.config.capabilities.refund) {
        const refunds = await this.prisma.serviceRefundRecord.findMany({ where: { provider: this.provider!.scope.provider, storeId: this.provider!.scope.storeId,
          environment: this.mode, status: "dispatch_unknown", approvalOperationId: { not: null }, approvalPolicyVersion: this.config.manifest!.policyVersion }, include: { attempt: { include: { contract: true } } }, take: Math.min(10, limit) });
        for (const r of refunds) if (r.attempt.contract.userId) { try { await this.executeRefund(r.attempt.contract.userId, r.id); } catch { /* lookup only */ } }
      }
    }
    return due.length;
  }
  async renewOnce(limit = 10) {
    this.requireReady("renew");
    const take = Math.max(1, Math.min(10, limit));
    const due = await this.prisma.$queryRaw<{ userId: string }[]>`SELECT c."userId" FROM "ServiceSubscriptionContract" c
      JOIN "ServicePaidPeriod" p ON p."contractId" = c."id" AND p."cycle" = c."nextCycle" - 1
      WHERE c."provider" = ${this.provider!.scope.provider} AND c."storeId" = ${this.provider!.scope.storeId} AND c."environment" = ${this.mode}
      AND c."userId" IS NOT NULL AND c."status" = 'active' AND NOT c."cancelRequested" AND NOT c."renewalStopped"
      AND p."endsAt" <= ${this.clock()} ORDER BY p."endsAt" LIMIT ${take}`;
    let visited = 0;
    for (const c of due) { try { await this.renew(c.userId!); visited++; } catch { /* due failures require reconsent/manual review; never re-charge old cycles */ } }
    return visited;
  }

  /** Called ONLY with verified adapter output; not exposed as a client endpoint.
   * Tests use synthetic IDs, not a fabricated PortOne signature fixture. */
  async recordVerifiedEvent(input: { provider: string; storeId: string; environment: string; eventId: string; paymentId: string;
    expectation?: "observation" | "cancelled" | "partial_cancelled" | "cancel_pending" }) {
    this.requireReady();
    if (input.provider !== this.provider!.scope.provider || input.storeId !== this.provider!.scope.storeId ||
      input.environment !== this.mode || !/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId) || !/^[A-Za-z0-9_-]{1,40}$/.test(input.paymentId)) fail("EVENT_SCOPE_MISMATCH", 400);
    const attempt = await this.prisma.servicePaymentAttempt.findUnique({ where: {
      provider_storeId_environment_paymentId: { provider: input.provider, storeId: input.storeId, environment: input.environment, paymentId: input.paymentId }
    } });
    if (!attempt && this.mode !== "mock") return null; // signed but not OUR persisted payment: ACK + no provider lookup
    await this.prisma.serviceBillingEventReceipt.createMany({ data: [{
      provider: input.provider, storeId: input.storeId, environment: input.environment,
      eventId: input.eventId, paymentId: input.paymentId, attemptId: attempt?.id,
      // Minimal durable cancellation intent, no payload/PII/new schema. Preserve
      // it in the internal receipt lifecycle status until observed or reviewed.
      status: !input.expectation || input.expectation === "observation" ? "pending" : `pending_${input.expectation}`
    }], skipDuplicates: true });
    const event = await this.prisma.serviceBillingEventReceipt.findUniqueOrThrow({ where: {
      provider_storeId_environment_eventId: { provider: input.provider, storeId: input.storeId, environment: input.environment, eventId: input.eventId }
    } });
    const expectedSuffix = !input.expectation || input.expectation === "observation" ? "" : `_${input.expectation}`;
    if (event.paymentId !== input.paymentId || event.status.replace(/^(pending|processed|manual_review)/, "") !== expectedSuffix) fail("EVENT_IDEMPOTENCY_CONFLICT");
    return event.id;
  }
  async acceptPortOneWebhook(raw: Buffer, headers: Record<string, string>) {
    this.requireReady();
    if (!(this.provider instanceof PortOneServiceBillingProvider)) fail("WEBHOOK_NOT_CONFIGURED", 404);
    let event;
    try { event = await this.provider.verifyWebhookOrIgnore(raw, headers); }
    catch { fail("INVALID_WEBHOOK_SIGNATURE", 400); }
    if (!event) return { accepted: true, ignored: true };
    const receipt = await this.recordVerifiedEvent(event);
    return { accepted: true, ignored: !receipt }; // durable worker claims before authoritative GET, never webhook entitlement
  }
  async processEvent(eventId: string) {
    this.requireReady();
    const owner = randomUUID();
    const claim = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ServiceBillingEventReceipt" WHERE "id" = ${eventId} FOR UPDATE`;
      const e = await tx.serviceBillingEventReceipt.findUnique({ where: { id: eventId } });
      if (!e || e.provider !== this.provider!.scope.provider || e.storeId !== this.provider!.scope.storeId || e.environment !== this.mode ||
        !["pending", "pending_cancelled", "pending_partial_cancelled", "pending_cancel_pending"].includes(e.status) ||
        (e.leaseUntil && e.leaseUntil > this.clock()) || (e.nextRetryAt && e.nextRetryAt > this.clock())) return null;
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
    let observation: Awaited<ReturnType<ServiceBillingService["reconcile"]>> = { outcome: "skipped" };
    if (attemptId) {
      try {
        // A lease-busy result cannot consume an event using a pre-existing PAID
        // row. This GET starts only after the durable receipt claim above.
        observation = await this.reconcile(attemptId, true);
      } catch { /* bounded retry; no event payload errors leak */ }
    }
    await this.prisma.$transaction(async tx => {
      const a = attemptId ? await tx.servicePaymentAttempt.findUnique({ where: { id: attemptId } }) : null;
      if (a) await this.lockContract(tx, a.contractId);
      const current = a ? await tx.servicePaymentAttempt.findUniqueOrThrow({ where: { id: a.id } }) : null;
      const fresh = observation.outcome === "fresh_authoritative_committed" && current?.fence === observation.fence &&
        !current.leaseOwner && observation.initiatedAt >= claim.receivedAt;
      const expectationMatched = observation.outcome === "fresh_authoritative_committed" &&
        (claim.status === "pending" || (claim.status === "pending_cancelled" ? observation.cancelledAmount === observation.totalAmount : observation.cancelledAmount > 0));
      const processed = fresh && expectationMatched;
      const exhausted = claim.retryCount >= lookupLimit || observation.outcome === "manual_review";
      const suffix = claim.status.slice("pending".length);
      await tx.serviceBillingEventReceipt.updateMany({ where: { id: claim.id, leaseOwner: owner, fence: claim.fence }, data: {
        attemptId, leaseOwner: null, leaseUntil: null, processedAt: processed ? this.clock() : null,
        status: processed ? `processed${suffix}` : exhausted ? `manual_review${suffix}` : claim.status,
        nextRetryAt: processed || exhausted ? null : new Date(this.clock().getTime() + 1000 * 2 ** claim.retryCount)
      } });
    });
  }
}
