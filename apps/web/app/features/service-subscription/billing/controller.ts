import type { Attempt, BillingApi, BillingSdk, Intent, Plan, Quote, Readiness, Subscription, InstrumentSnapshot, Refund } from "./types";
import { serviceBillingReadinessResponseSchema, serviceBillingQuoteResponseSchema, serviceBillingAttemptResponseSchema,
  serviceBillingInstrumentResponseSchema, serviceBillingRefundResponseSchema } from "@living-cost-manager/shared";
import { BillingError } from "./api";
import { validSubscription } from "./subscriptionValidation";

export interface BillingState {
  readiness: Readiness | null; subscription: Subscription | null; quote: Quote | null;
  attempt: Attempt | null; intent: Intent | null; busy: boolean;
  billingConsent: boolean; renewalConsent: boolean; message: string; checks: number;
  instrument: InstrumentSnapshot | null; refund: Refund | null;
}
const initial = (): BillingState => ({ readiness: null, subscription: null, quote: null,
  attempt: null, intent: null, busy: false, billingConsent: false, renewalConsent: false,
  message: "결제 준비 상태를 확인하고 있습니다.", checks: 0, instrument: null, refund: null });
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
export function checkoutReady(r: Readiness | null, sdk: BillingSdk): r is Readiness {
  if (!serviceBillingReadinessResponseSchema.safeParse(r).success || !r || !r.checkoutEnabled ||
    !r.capabilities.issueInstrument || !r.capabilities.charge || !r.capabilities.renew ||
    r.consentVersions.billing !== r.approvedVersions.billing || r.consentVersions.autoRenew !== r.approvedVersions.autoRenew) return false;
  if (r.mode === "mock") return sdk.supportsMock === true && r.approvalStatus === "mock_draft" && r.sdkConfig === null &&
    r.approvedMaterial === null && r.blockingCodes.includes("MOCK_ONLY") &&
    r.blockingCodes.every(code => ["MOCK_ONLY", "PAID_PRODUCT_APPROVAL_PENDING", "LEGAL_TAX_APPROVAL_PENDING"].includes(code));
  return r.approvalStatus === "approved" && r.blockingCodes.length === 0 && r.taxTreatment === "inclusive" &&
    !!r.approvedMaterial && Object.values(r.approvedMaterial).every(text) &&
    text(r.sdkConfig?.storeId) && text(r.sdkConfig?.channelId) && text(r.sdkConfig?.channelKey);
}
export function validQuote(q: Quote, r: Readiness, plan: Plan, now: number): boolean {
  const price = r.catalog?.[plan];
  return serviceBillingQuoteResponseSchema.safeParse(q).success && q.planId === plan && q.currency === "KRW" &&
    text(q.quoteId) && q.catalogVersion === r.catalogVersion && !!price &&
    Number.isSafeInteger(q.totalAmount) && q.totalAmount > 0 && q.totalAmount === price.totalAmount &&
    q.periodMonths === price.periodMonths && [1, 12].includes(q.periodMonths) &&
    date(q.expiresAt) && Date.parse(q.expiresAt) > now &&
    q.consentVersions.billing === r.consentVersions.billing && q.consentVersions.autoRenew === r.consentVersions.autoRenew &&
    (Object.keys(r.approvedVersions) as (keyof Readiness["approvedVersions"])[]).every(k => q.approvedVersions[k] === r.approvedVersions[k]) &&
    (q.approvedMaterial === null ? r.mode === "mock" && r.approvedMaterial === null : !!r.approvedMaterial &&
      (Object.keys(q.approvedMaterial) as (keyof NonNullable<Quote["approvedMaterial"]>)[]).every(k => q.approvedMaterial![k] === r.approvedMaterial![k]));
}
export function renewalConfirmed(s: Subscription | null): boolean {
  return s?.renewalStopped === true && s.providerCancellationStatus === "verified";
}
const unresolved = "처리 결과를 확인해야 합니다. 새 결제를 시작하지 마세요. 결제 확인 정보는 유지됩니다.";

/** One account per controller. Dispose on auth change; no old response can repaint. */
export class BillingController {
  state = initial();
  private alive = true;
  private abort = new AbortController();
  private listeners = new Set<() => void>();
  private key: string;
  private recoveryBlocked = false;
  constructor(private api: BillingApi, private sdk: BillingSdk, accountId: string | null,
    private storage: Pick<Storage, "getItem" | "setItem">, private now = Date.now,
    private uuid = () => crypto.randomUUID()) {
    this.key = `living-cost-manager:billing-intent:v1:${accountId ?? "guest"}`;
    if (accountId) {
      try {
        const raw = storage.getItem(this.key);
        if (raw) {
          const i = JSON.parse(raw) as Intent;
          if (text(i.quoteId) && text(i.idempotencyKey) && ["issuing", "confirming", "charging", "attempt"].includes(i.phase)) this.state.intent = i;
          else { this.state.message = unresolved; this.recoveryBlocked = true; }
        }
      } catch { this.state.message = unresolved; this.recoveryBlocked = true; }
    }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  dispose() { this.alive = false; this.abort.abort(); this.listeners.clear(); }
  private update(next: Partial<BillingState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...next };
    this.listeners.forEach(listener => listener());
  }
  private persist(intent: Intent) {
    // Only non-secret IDs. Persist BEFORE a side effect; failure blocks the request.
    this.storage.setItem(this.key, JSON.stringify(intent));
    this.update({ intent });
  }
  private async run(work: () => Promise<void>) {
    if (!this.alive || this.state.busy) return;
    this.update({ busy: true });
    try { await work(); }
    catch (error) {
      if (error instanceof BillingError && [401, 403].includes(error.status)) {
        this.update({ subscription: null, attempt: null, quote: null, instrument: null, refund: null, billingConsent: false, renewalConsent: false,
          message: "로그인 또는 조회 권한을 확인해 주세요. 생활비 화면에서 다시 로그인할 수 있습니다." });
      } else this.update({ subscription: null, message: this.state.intent || this.recoveryBlocked ? unresolved : "결제 준비 중 · 정보를 확인하지 못했습니다. 기존 무료 기능은 계속 사용할 수 있습니다." });
    }
    finally { this.update({ busy: false }); }
  }
  async load(authenticated: boolean) {
    await this.run(async () => {
      const readiness = serviceBillingReadinessResponseSchema.parse(await this.api.readiness(this.abort.signal));
      if (!this.alive) return;
      this.update({ readiness, message: checkoutReady(readiness, this.sdk) ? "결제 전 금액과 조건을 확인해 주세요." : "결제 준비 중 · 현재 결제 신청을 받지 않습니다." });
      if (!authenticated) return;
      const subscription = await this.api.subscription(this.abort.signal);
      if (!this.alive) return;
      if (readiness.currency !== "KRW" || !validSubscription(subscription, readiness.mode, this.now())) {
        this.update({ subscription: null }); throw new Error("invalid subscription");
      }
      this.update({ subscription: { ...subscription, paidAccess: readiness.mode === "live" && readiness.approvalStatus === "approved" && subscription.paidAccess } });
      if (this.state.intent) await this.readAttempt();
    });
  }
  consent(kind: "billing" | "renewal", accepted: boolean) {
    if (!this.state.busy) this.update(kind === "billing" ? { billingConsent: accepted } : { renewalConsent: accepted });
  }
  canQuote() {
    return !this.state.busy && !this.recoveryBlocked && !this.state.intent && !!this.state.subscription &&
      ["free", "idle"].includes(this.state.subscription.status) && !this.state.subscription.paidAccess &&
      !this.state.subscription.cancelAtPeriodEnd && !this.state.subscription.renewalStopped && checkoutReady(this.state.readiness, this.sdk);
  }
  readinessApproved() { return checkoutReady(this.state.readiness, this.sdk); }
  async quote(plan: Plan) {
    if (!this.canQuote()) return;
    this.update({ quote: null, billingConsent: false, renewalConsent: false });
    await this.run(async () => {
      const q = await this.api.quote(plan, this.abort.signal);
      if (!this.alive) return;
      if (!validQuote(q, this.state.readiness!, plan, this.now())) throw new Error("invalid quote");
      this.update({ quote: q, message: "서버 견적을 확인했습니다. 두 동의를 각각 확인해 주세요." });
    });
  }
  canPay() {
    const s = this.state;
    return this.canQuote() && !!s.quote && validQuote(s.quote, s.readiness!, s.quote.planId, this.now()) && s.billingConsent && s.renewalConsent;
  }
  async pay() {
    if (!this.canPay()) {
      if (this.state.quote && Date.parse(this.state.quote.expiresAt) <= this.now()) this.update({ quote: null, billingConsent: false, renewalConsent: false, message: "견적이 만료되었습니다. 새 견적과 조건에 다시 동의해 주세요." });
      return;
    }
    const q = this.state.quote!;
    await this.run(async () => {
      // Refresh gates before loading the SDK or creating a payment instrument.
      const r = serviceBillingReadinessResponseSchema.parse(await this.api.readiness(this.abort.signal));
      if (!this.alive) return;
      this.update({ readiness: r });
      if (!checkoutReady(r, this.sdk) || !validQuote(q, r, q.planId, this.now())) {
        this.update({ quote: null, billingConsent: false, renewalConsent: false, message: "결제 조건이 바뀌었습니다. 준비 상태와 새 견적을 다시 확인해 주세요." }); return;
      }
      const intent: Intent = { quoteId: q.quoteId, idempotencyKey: this.uuid(), phase: "issuing", createdAt: new Date(this.now()).toISOString() };
      this.persist(intent);
      const instrument = await this.api.prepare(q.quoteId, this.abort.signal);
      if (!this.alive) return;
      const request = instrument.sdkRequest;
      if (!text(instrument.instrumentId) || !text(request?.issueId) || !text(request.customer?.id) ||
        request.billingKeyMethod !== "CARD" || (r.mode !== "mock" &&
        (request.storeId !== r.sdkConfig?.storeId || request.channelId !== r.sdkConfig?.channelId || request.channelKey !== r.sdkConfig?.channelKey))) throw new Error("invalid instrument");
      intent.instrumentId = instrument.instrumentId;
      this.persist({ ...intent });
      // Whitelist official SDK parameters. Never pass arbitrary server scripts/URLs.
      const result = await this.sdk.issue({ storeId: request.storeId, channelKey: request.channelKey,
        billingKeyMethod: "CARD", issueId: request.issueId, customer: { customerId: request.customer.id } }, r.mode);
      if (!this.alive) return;
      if (!result || result.code || !text(result.billingKey)) {
        this.update({ message: "카드 등록이 완료되지 않았습니다. 청구를 요청하지 않았습니다. 등록 상태 확인 전 새 신청은 차단됩니다." }); return;
      }
      this.persist({ ...intent, phase: "confirming" });
      try { await this.api.confirm(instrument.instrumentId, result.billingKey, this.abort.signal); }
      finally { result.billingKey = undefined; }
      if (!this.alive) return;
      if (!validQuote(q, r, q.planId, this.now())) { this.update({ message: "카드 등록 중 견적이 만료되었습니다. 청구하지 않았습니다. 등록 상태 확인이 필요합니다." }); return; }
      const chargeInput = { quoteId: q.quoteId, instrumentId: instrument.instrumentId,
        idempotencyKey: intent.idempotencyKey, consent: { billingVersion: q.consentVersions.billing,
          autoRenewVersion: q.consentVersions.autoRenew, accepted: true as const } };
      this.persist({ ...intent, phase: "charging", chargeInput });
      const response = await this.api.charge(chargeInput, this.abort.signal);
      if (!this.alive) return;
      if (!text(response.attemptId)) throw new Error("missing attempt");
      this.persist({ ...intent, phase: "attempt", attemptId: response.attemptId, chargeInput });
      // The charge response and SDK result are NOT entitlement evidence.
      await this.readAttempt();
    });
  }
  private async readAttempt() {
    const intent = this.state.intent;
    if (!intent) return;
    let a: Attempt;
    try { a = serviceBillingAttemptResponseSchema.parse(await (intent.attemptId ?
      this.api.attempt(intent.attemptId, this.abort.signal) : this.api.byIdempotency(intent.idempotencyKey, this.abort.signal))); }
    catch (error) {
      if (!(error instanceof BillingError && error.status === 404)) throw error;
      this.update({ attempt: null, message: "기존 청구를 아직 찾지 못했습니다. 404는 미처리 증거가 아닙니다. 같은 확인 정보를 유지하며 새 청구는 차단됩니다." });
      if (intent.instrumentId) await this.readInstrument(intent.instrumentId);
      return;
    }
    if (!this.alive) return;
    if ((intent.attemptId && a.attemptId !== intent.attemptId) || a.mode !== this.state.readiness?.mode ||
      (a.status === "paid" && (!a.paidAt || !a.paidPeriod)) ||
      (a.paidPeriod && Date.parse(a.paidPeriod.startsAt) >= Date.parse(a.paidPeriod.endsAt))) throw new Error("invalid attempt");
    if (!intent.attemptId) this.persist({ ...intent, phase: "attempt", attemptId: a.attemptId });
    this.update({ attempt: a, message: a.reviewRequired || a.status === "manual_review" ? "운영자 확인이 필요한 결제입니다. 새 청구는 차단됩니다." :
      ["created", "dispatch_unknown"].includes(a.status) ? "서버에서 결제 결과를 확인 중입니다. 새 결제를 시작하지 마세요." :
      a.status === "failed" ? "서버에서 결제 실패를 확인했습니다. 기존 무료 기능을 계속 사용할 수 있습니다." :
      a.mode === "mock" ? "모의 결제 결과입니다. 실제 청구·유료 권한을 뜻하지 않습니다." :
      a.mode === "sandbox" ? "테스트 결제 결과입니다. 실제 유료 이용 권한은 별도 서버 확인을 따릅니다." : "서버에서 결제 결과를 확인했습니다." });
    const subscription = await this.api.subscription(this.abort.signal);
    if (!this.alive) return;
    if (this.state.readiness?.currency !== "KRW" || !validSubscription(subscription, this.state.readiness.mode, this.now())) {
      this.update({ subscription: null }); throw new Error("invalid subscription");
    }
    // Mock/sandbox must never present live paid access, even with inconsistent data.
    this.update({ subscription: { ...subscription, paidAccess: a.mode === "live" && this.state.readiness?.approvalStatus === "approved" && subscription.paidAccess && !a.reviewRequired } });
  }
  private async readInstrument(id: string) {
    const value = serviceBillingInstrumentResponseSchema.parse(await this.api.instrument(id, this.abort.signal));
    if (!this.alive) return;
    if (value.instrumentId !== id) throw new Error("instrument mismatch");
    this.update({ instrument: value });
  }
  async revoke() {
    if (this.state.readiness?.mode === "mock" && this.sdk.supportsMock !== true) return;
    if (this.state.attempt && ["paid", "refunded"].includes(this.state.attempt.status)) return;
    const id = this.state.intent?.instrumentId;
    if (!id || !this.state.readiness?.capabilities.cancel) return;
    await this.run(async () => {
      const value = serviceBillingInstrumentResponseSchema.parse(await this.api.revoke(id, this.abort.signal));
      if (!this.alive) return;
      if (value.instrumentId !== id) throw new Error("instrument mismatch");
      this.update({ instrument: value, message: value.status === "revoked" && !value.requiresManualReview ?
        "등록 수단 해제를 검증했습니다. 기존 청구 확인 정보는 유지되며 새 청구는 시작하지 않습니다." : "등록 수단 해제 확인 대기 중입니다. 새 청구는 차단됩니다." });
    });
  }
  async check() {
    if (this.state.checks >= 3) return;
    await this.run(async () => { this.update({ checks: this.state.checks + 1 }); await this.readAttempt(); });
  }
  async cancel() {
    if (this.state.readiness?.mode === "mock" && this.sdk.supportsMock !== true) return;
    if (!this.state.subscription?.contractId || this.state.readiness?.capabilities?.cancel !== true || this.state.subscription.cancelAtPeriodEnd) return;
    await this.run(async () => {
      const subscription = await this.api.cancel(this.abort.signal);
      if (!this.alive) return;
      if (this.state.readiness?.currency !== "KRW" || !validSubscription(subscription, this.state.readiness.mode, this.now())) {
        this.update({ subscription: null }); throw new Error("invalid subscription");
      }
      this.update({ subscription: { ...subscription, paidAccess: this.state.readiness?.mode === "live" && this.state.readiness.approvalStatus === "approved" && subscription.paidAccess }, message: renewalConfirmed(subscription) ? "자동 갱신 중단이 검증되었습니다. 남은 유료 이용 기간과 환불 요청은 별개입니다." : "갱신 중단 요청 상태입니다. 제공자 처리 완료는 아직 확인되지 않았습니다." });
    });
  }
  async refund() {
    if (this.state.readiness?.mode === "mock" && this.sdk.supportsMock !== true) return;
    const a = this.state.attempt;
    const i = this.state.intent;
    if (!a || a.status !== "paid" || a.reviewRequired || !i || this.state.readiness?.capabilities?.refund !== true) return;
    await this.run(async () => {
      const key = i.refundIdempotencyKey ?? this.uuid();
      this.persist({ ...i, refundIdempotencyKey: key });
      const result = serviceBillingRefundResponseSchema.parse(await this.api.refund(a.attemptId, { idempotencyKey: key, reasonCode: "other" }, this.abort.signal));
      if (!this.alive) return;
      this.update({ refund: result, message: result.status === "verified" ? "서버에서 환불 검증 상태를 확인했습니다." :
        result.status === "rejected" ? "서버에서 환불 요청 거절 상태를 확인했습니다." : result.status === "manual_review" || result.status === "dispatch_unknown" ?
        "환불 처리 결과 확인이 필요합니다. 새 요청을 만들지 않습니다." : "환불 검토 요청을 접수했습니다. 환불 완료나 승인 안내가 아닙니다." });
    });
  }
}
