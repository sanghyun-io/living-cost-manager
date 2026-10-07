import type { Attempt, BillingApi, BillingSdk, Intent, Plan, Quote, Readiness, Subscription } from "./types";
import { BillingError } from "./api";
import { validSubscription } from "./subscriptionValidation";

export interface BillingState {
  readiness: Readiness | null; subscription: Subscription | null; quote: Quote | null;
  attempt: Attempt | null; intent: Intent | null; busy: boolean;
  billingConsent: boolean; renewalConsent: boolean; message: string; checks: number;
}
const initial = (): BillingState => ({ readiness: null, subscription: null, quote: null,
  attempt: null, intent: null, busy: false, billingConsent: false, renewalConsent: false,
  message: "결제 준비 상태를 확인하고 있습니다.", checks: 0 });
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
export function checkoutReady(r: Readiness | null, sdk: BillingSdk): r is Readiness {
  return !!r && ["mock", "sandbox", "live"].includes(r.mode) && r.checkoutEnabled === true &&
    Array.isArray(r.blockingCodes) && r.blockingCodes.length === 0 && r.taxTreatment === "inclusive" &&
    r.currency === "KRW" && text(r.catalogVersion) && text(r.consentVersions?.billing) && text(r.consentVersions?.autoRenew) &&
    r.approvals?.merchant === true && r.approvals.commerce === true && r.approvals.legal === true && r.approvals.featureScope === true &&
    r.capabilities?.issueInstrument === true && r.capabilities.charge === true && r.capabilities.renew === true &&
    (r.mode === "mock" ? sdk.synthetic === true : sdk.synthetic !== true && text(r.sdkConfig?.storeId) && text(r.sdkConfig?.channelId));
}
export function validQuote(q: Quote, r: Readiness, plan: Plan, now: number): boolean {
  const price = r.catalog?.[plan];
  const material = (v: { version: string; text: string } | undefined) => !!v && text(v.version) && text(v.text);
  return !!q && q.planId === plan && q.mode === r.mode && q.currency === "KRW" &&
    text(q.quoteId) && q.catalogVersion === r.catalogVersion && !!price &&
    Number.isSafeInteger(q.totalAmount) && q.totalAmount > 0 && q.totalAmount === price.totalAmount &&
    q.periodMonths === price.periodMonths && [1, 12].includes(q.periodMonths) &&
    date(q.expiresAt) && Date.parse(q.expiresAt) > now && date(q.nextChargeAt) &&
    Number.isSafeInteger(q.nextChargeAmount) && q.nextChargeAmount > 0 &&
    material(q.featureScope) && q.featureScope.version === q.featureScopeVersion &&
    material(q.billingConsent) && q.billingConsent.version === r.consentVersions.billing &&
    material(q.autoRenewConsent) && q.autoRenewConsent.version === r.consentVersions.autoRenew &&
    material(q.sellerDisclosure) && material(q.policyDisclosure) && q.policyDisclosure.version === q.policyVersion;
}
export function renewalConfirmed(s: Subscription | null): boolean {
  return s?.renewalStopped === true && s.providerCancellationStatus === "confirmed" &&
    s.cancellationProof?.allChargePathsStopped === true && s.cancellationProof.inFlightResolved === true;
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
        this.update({ subscription: null, attempt: null, quote: null, billingConsent: false, renewalConsent: false,
          message: "로그인 또는 조회 권한을 확인해 주세요. 생활비 화면에서 다시 로그인할 수 있습니다." });
      } else this.update({ message: this.state.intent || this.recoveryBlocked ? unresolved : "결제 준비 중 · 정보를 확인하지 못했습니다. 기존 무료 기능은 계속 사용할 수 있습니다." });
    }
    finally { this.update({ busy: false }); }
  }
  async load(authenticated: boolean) {
    await this.run(async () => {
      const readiness = await this.api.readiness(this.abort.signal);
      if (!this.alive) return;
      this.update({ readiness, message: checkoutReady(readiness, this.sdk) ? "결제 전 금액과 조건을 확인해 주세요." : "결제 준비 중 · 현재 결제 신청을 받지 않습니다." });
      if (!authenticated) return;
      const subscription = await this.api.subscription(this.abort.signal);
      if (!this.alive) return;
      if (readiness.currency !== "KRW" || !validSubscription(subscription, readiness.mode, this.now())) {
        this.update({ subscription: null }); throw new Error("invalid subscription");
      }
      this.update({ subscription: { ...subscription, paidAccess: readiness.mode === "live" && subscription.paidAccess } });
      if (this.state.intent?.attemptId) await this.readAttempt();
      else if (this.state.intent) this.update({ message: unresolved });
    });
  }
  consent(kind: "billing" | "renewal", accepted: boolean) {
    if (!this.state.busy) this.update(kind === "billing" ? { billingConsent: accepted } : { renewalConsent: accepted });
  }
  canQuote() {
    return !this.state.busy && !this.recoveryBlocked && !this.state.intent && !!this.state.subscription &&
      !this.state.subscription.contractId && checkoutReady(this.state.readiness, this.sdk);
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
      const r = await this.api.readiness(this.abort.signal);
      if (!this.alive) return;
      this.update({ readiness: r });
      if (!checkoutReady(r, this.sdk) || !validQuote(q, r, q.planId, this.now())) {
        this.update({ quote: null, billingConsent: false, renewalConsent: false, message: "결제 조건이 바뀌었습니다. 준비 상태와 새 견적을 다시 확인해 주세요." }); return;
      }
      const intent: Intent = { quoteId: q.quoteId, idempotencyKey: this.uuid(), phase: "issuing" };
      this.persist(intent);
      const instrument = await this.api.prepare(q.quoteId, this.abort.signal);
      if (!this.alive) return;
      const request = instrument.sdkRequest;
      if (!text(instrument.instrumentId) || !text(request?.issueId) || !text(request.customer?.customerId) ||
        request.billingKeyMethod !== "CARD" || (r.mode !== "mock" &&
        (request.storeId !== r.sdkConfig?.storeId || request.channelKey !== r.sdkConfig?.channelId))) throw new Error("invalid instrument");
      intent.instrumentId = instrument.instrumentId;
      this.persist({ ...intent });
      // Whitelist official SDK parameters. Never pass arbitrary server scripts/URLs.
      const result = await this.sdk.issue({ storeId: request.storeId, channelKey: request.channelKey,
        billingKeyMethod: "CARD", issueId: request.issueId, customer: { customerId: request.customer.customerId } });
      if (!this.alive) return;
      if (!result || result.code || !text(result.billingKey)) {
        this.update({ message: "카드 등록이 완료되지 않았습니다. 청구를 요청하지 않았습니다. 등록 상태 확인 전 새 신청은 차단됩니다." }); return;
      }
      this.persist({ ...intent, phase: "confirming" });
      try { await this.api.confirm(instrument.instrumentId, result.billingKey, this.abort.signal); }
      finally { result.billingKey = undefined; }
      if (!this.alive) return;
      if (!validQuote(q, r, q.planId, this.now())) { this.update({ message: "카드 등록 중 견적이 만료되었습니다. 청구하지 않았습니다. 등록 상태 확인이 필요합니다." }); return; }
      this.persist({ ...intent, phase: "charging" });
      const response = await this.api.charge({ quoteId: q.quoteId, instrumentId: instrument.instrumentId,
        idempotencyKey: intent.idempotencyKey, consent: { billingVersion: q.billingConsent.version,
          autoRenewVersion: q.autoRenewConsent.version, accepted: true } }, this.abort.signal);
      if (!this.alive) return;
      if (!text(response.attemptId)) throw new Error("missing attempt");
      this.persist({ ...intent, phase: "attempt", attemptId: response.attemptId });
      // The charge response and SDK result are NOT entitlement evidence.
      await this.readAttempt();
    });
  }
  private async readAttempt() {
    const id = this.state.intent?.attemptId;
    if (!id) { this.update({ message: unresolved }); return; }
    const a = await this.api.attempt(id, this.abort.signal);
    if (!this.alive) return;
    if (a.attemptId !== id || !["pending", "paid", "failed"].includes(a.status) ||
      a.mode !== this.state.readiness?.mode || a.currency !== "KRW" || !Number.isSafeInteger(a.totalAmount) || a.totalAmount <= 0 ||
      (a.status === "paid" && !date(a.paidAt)) ||
      (this.state.quote && a.totalAmount !== this.state.quote.totalAmount)) throw new Error("invalid attempt");
    this.update({ attempt: a, message: a.status === "pending" ? "서버에서 결제 결과를 확인 중입니다. 새 결제를 시작하지 마세요." :
      a.status === "failed" ? "서버에서 결제 실패를 확인했습니다. 기존 무료 기능을 계속 사용할 수 있습니다." :
      a.mode === "mock" ? "모의 결제 결과입니다. 실제 청구·유료 권한을 뜻하지 않습니다." :
      a.mode === "sandbox" ? "테스트 결제 결과입니다. 실제 유료 이용 권한은 별도 서버 확인을 따릅니다." : "서버에서 결제 결과를 확인했습니다." });
    const subscription = await this.api.subscription(this.abort.signal);
    if (!this.alive) return;
    if (this.state.readiness?.currency !== "KRW" || !validSubscription(subscription, this.state.readiness.mode, this.now())) {
      this.update({ subscription: null }); throw new Error("invalid subscription");
    }
    // Mock/sandbox must never present live paid access, even with inconsistent data.
    this.update({ subscription: { ...subscription, paidAccess: a.mode === "live" && subscription.paidAccess } });
  }
  async check() {
    if (this.state.checks >= 3) return;
    await this.run(async () => { this.update({ checks: this.state.checks + 1 }); await this.readAttempt(); });
  }
  async cancel() {
    if (this.state.readiness?.mode === "mock" && this.sdk.synthetic !== true) return;
    if (!this.state.subscription?.contractId || this.state.readiness?.capabilities?.cancel !== true || this.state.subscription.cancelAtPeriodEnd) return;
    await this.run(async () => {
      const subscription = await this.api.cancel(this.abort.signal);
      if (!this.alive) return;
      if (this.state.readiness?.currency !== "KRW" || !validSubscription(subscription, this.state.readiness.mode, this.now())) {
        this.update({ subscription: null }); throw new Error("invalid subscription");
      }
      this.update({ subscription: { ...subscription, paidAccess: this.state.readiness?.mode === "live" && subscription.paidAccess }, message: renewalConfirmed(subscription) ? "자동 갱신 중단이 확인되었습니다." : "갱신 중단 요청 상태입니다. 제공자 처리 완료는 아직 확인되지 않았습니다." });
    });
  }
  async refund() {
    if (this.state.readiness?.mode === "mock" && this.sdk.synthetic !== true) return;
    const a = this.state.attempt;
    const i = this.state.intent;
    if (!a || a.status !== "paid" || !i || this.state.readiness?.capabilities?.refund !== true) return;
    await this.run(async () => {
      const key = i.refundIdempotencyKey ?? this.uuid();
      this.persist({ ...i, refundIdempotencyKey: key });
      const result = await this.api.refund(a.attemptId, { idempotencyKey: key, reasonCode: "CUSTOMER_REQUEST" }, this.abort.signal);
      if (!this.alive) return;
      if (!text(result.requestId) || !["requested", "pending"].includes(result.status)) throw new Error("refund status unconfirmed");
      this.update({ message: "환불 검토 요청을 접수했습니다. 환불 완료나 승인 안내가 아닙니다." });
    });
  }
}
