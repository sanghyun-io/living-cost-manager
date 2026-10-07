"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createBillingApi } from "./billing/api";
import { BillingController, renewalConfirmed } from "./billing/controller";
import { browserBillingSdk } from "./billing/sdk";
import { useBillingSession } from "./billing/useBillingSession";
import styles from "./subscription.module.css";

const money = (amount: number) => new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(amount);
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("ko-KR") : "미정";

export function SubscriptionPage() {
  const { session, checked, status, retry } = useBillingSession();
  const [controller, setController] = useState<BillingController | null>(null);
  useEffect(() => {
    if (!checked) { setController(null); return; }
    const api = createBillingApi(session?.token ?? null);
    if (!api) { setController(null); return; }
    // Storage denial must not break the page or permit unrecoverable checkout.
    let storage: Pick<Storage, "getItem" | "setItem">;
    try { storage = window.sessionStorage; }
    catch { storage = { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); } }; }
    const next = new BillingController(api, browserBillingSdk(window.location.hostname), session?.user.id ?? null, storage);
    setController(next);
    void next.load(!!session);
    return () => next.dispose();
  }, [checked, session]);
  return <main className={styles.main}>
    <nav aria-label="생활비관리"><a href="/">생활비 화면으로 돌아가기</a> <a href="/guide/#pricing">가격 준비 안내</a></nav>
    <h1>구독 관리</h1>
    <p>기존 무료 기능은 계속 사용할 수 있습니다. 읽기·내보내기·공유 가계부 이용은 이 화면의 결제 여부로 제한하지 않습니다.</p>
    <p><button type="button" aria-disabled={status !== "unavailable"} onClick={() => { if (status === "unavailable") retry?.(); }}>{status === "loading" ? "로그인 상태 확인 중…" : status === "verified" ? "로그인 상태 확인됨" : "로그인 상태 다시 확인"}</button></p>
    {!checked ? <p role="status">로그인 상태를 확인하고 있습니다.</p> : <>
      {status === "unavailable" ? <p role="status">로그인 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요. 새 로그인이 필요한지 아직 확인되지 않았습니다.</p> : !session && <p>구독 조회는 로그인 후 이용할 수 있습니다. <a href="/">생활비 화면에서 기존 로그인 이용</a></p>}
      {controller ? <BillingPanel key={session?.user.id ?? "guest"} controller={controller} /> : <><p role="status">결제 준비 중 · 현재 결제 신청을 받지 않습니다.</p><PriceProposal /></>}
    </>}
  </main>;
}
function PriceProposal() {
  return <section aria-labelledby="planned-title" className={styles.section}>
      <h2 id="planned-title">준비 중인 가격안</h2>
      <p>월간 990원 · 연간 9,900원. 출시·과세 방식·유료 제공 범위는 확정 전입니다. 현재 판매 조건이나 청구 약속이 아닙니다.</p>
    </section>;
}

/** Injectable controller for synthetic component tests; production always uses real HTTP/SDK. */
export function BillingPanel({ controller }: { controller: BillingController }) {
  const s = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [refundConfirm, setRefundConfirm] = useState(false);
  // Keep actionable buttons mounted and focusable while busy (aria-disabled).
  const button = (disabled: boolean) => ({ "aria-disabled": disabled });
  const q = s.quote, subscription = s.subscription;
  return <div aria-busy={s.busy}>
    {s.readiness?.mode === "mock" && <p className={styles.notice}>모의 결제 · 실제 청구 없음</p>}
    {s.readiness?.mode === "sandbox" && <p className={styles.notice}>테스트 결제 환경 · 실제 유료 권한과 별개</p>}
    <p role="status" aria-live="polite" aria-atomic="true" className={styles.notice}>{s.message}</p>
    {subscription && <section className={styles.section} aria-labelledby="current-title">
      <h2 id="current-title">현재 이용 상태</h2>
      <dl><dt>유료 이용 권한</dt><dd>{subscription.paidAccess ? "서버에서 확인됨" : "확인된 유료 권한 없음"}</dd>
        <dt>유료 이용 종료일</dt><dd>{date(subscription.paidThrough)}</dd>
        <dt>다음 청구 예정일</dt><dd>{renewalConfirmed(subscription) ? "자동 갱신 중단 확인됨" : date(subscription.nextChargeAt)}</dd>
        <dt>갱신 중단 상태</dt><dd>{renewalConfirmed(subscription) ? "서버·제공자 중단 확인됨" : subscription.cancelAtPeriodEnd || subscription.renewalStopped ? "중단 요청됨 · 제공자 확인 대기" : "확인된 중단 요청 없음"}</dd></dl>
      {subscription.contractId && s.readiness?.capabilities?.cancel && <>
        <label className={styles.check}><input type="checkbox" checked={cancelConfirm} disabled={s.busy} onChange={e => setCancelConfirm(e.target.checked)} /> 자동 갱신 중단을 요청합니다. 환불 신청과는 별개입니다.</label>
        <button type="button" {...button(s.busy || !cancelConfirm || subscription.cancelAtPeriodEnd)} onClick={() => { if (!s.busy && cancelConfirm) void controller.cancel(); }}>자동 갱신 중단 요청</button>
      </>}
    </section>}
    <section className={styles.section} aria-labelledby="checkout-title">
      <h2 id="checkout-title">결제 전 확인</h2>
      <div className={styles.actions}>
        <button type="button" {...button(!controller.canQuote())} onClick={() => { if (controller.canQuote()) void controller.quote("monthly"); }}>월간 견적 확인</button>
        <button type="button" {...button(!controller.canQuote())} onClick={() => { if (controller.canQuote()) void controller.quote("annual"); }}>연간 견적 확인</button>
      </div>
      {q && <>
        <dl><dt>이번 {s.readiness?.mode === "mock" ? "모의 " : ""}결제 총액 {s.readiness?.taxTreatment === "inclusive" ? "(부가세 포함)" : "(과세 방식 미확정)"}</dt><dd>{money(q.totalAmount)}</dd><dt>이용 기간</dt><dd>{q.periodMonths}개월</dd>
          <dt>다음 청구 예정일</dt><dd>{date(subscription?.nextChargeAt ?? null)} · 서버 검증 후 확인</dd><dt>견적 유효 시간</dt><dd>{date(q.expiresAt)}</dd></dl>
        {q.approvedMaterial ? <><h3>유료 제공 범위</h3><p className={styles.material}>{q.approvedMaterial.features}</p>
          <h3>판매자 안내</h3><p className={styles.material}>{q.approvedMaterial.seller}</p>
          <h3>이용·철회·환불 조건</h3><p className={styles.material}>{q.approvedMaterial.policy}</p></> : <p>로컬 모의 흐름입니다. 미승인 초안 버전만 사용하며 실제 판매 조건·약관·자동 갱신 동의가 아닙니다.</p>}
        <label className={styles.check}><input type="checkbox" checked={s.billingConsent} disabled={s.busy || !!s.intent} onChange={e => controller.consent("billing", e.target.checked)} /><span>{q.approvedMaterial?.billing ?? "모의 결제 흐름 확인 (실제 구매 동의 아님)"} (버전 {q.consentVersions.billing})</span></label>
        <label className={styles.check}><input type="checkbox" checked={s.renewalConsent} disabled={s.busy || !!s.intent} onChange={e => controller.consent("renewal", e.target.checked)} /><span>{q.approvedMaterial?.autoRenew ?? "모의 자동 갱신 흐름 확인 (실제 갱신 동의 아님)"} (버전 {q.consentVersions.autoRenew})</span></label>
        <p>동의하지 않아도 기존 무료 기능은 이용할 수 있습니다. 마케팅 동의와 별개입니다. {s.readiness?.mode === "mock" ? "로컬 모의 수단만 확인합니다. 카드 정보는 입력하거나 전송하지 않습니다." : "카드 정보는 결제 제공자의 등록 창에서 입력합니다."}</p>
      </>}
      <p><button type="button" {...button(!controller.canPay())} onClick={() => void controller.pay()}>{s.busy ? "처리 중…" : q ? `${money(q.totalAmount)} · ${s.readiness?.mode === "mock" ? "모의 등록·청구 흐름 실행 (실제 청구 없음)" : "카드 등록 후 청구 요청"}` : "카드 등록·청구 요청 (견적 확인 후 이용)"}</button></p>
    </section>
    {!controller.readinessApproved() && <PriceProposal />}
    {s.intent && <section className={styles.section} aria-labelledby="attempt-title">
      <h2 id="attempt-title">이 화면에서 시작한 결제</h2>
      <p>전체 결제 내역이 아닙니다. 브라우저 결제창 완료만으로 결제·이용 권한이 확정되지 않습니다.</p>
      {s.attempt && <p>{s.attempt.status === "paid" ? "서버 결제 확인" : s.attempt.status === "failed" ? "서버 결제 실패 확인" : s.attempt.status === "refunded" ? "서버 환불 검증 상태" : s.attempt.status === "canceled_before_dispatch" ? "청구 전 취소 확인" : "결과 확인 대기"}{s.attempt.reviewRequired ? " · 운영자 확인 필요" : ""}</p>}
      <button type="button" {...button(s.busy || s.checks >= 3)} onClick={() => { if (!s.busy) void controller.check(); }}>기존 결제 결과 확인 ({s.checks}/3)</button>
      {!s.intent.attemptId && <p>원래 요청의 동일 확인 정보로만 조회합니다. 미조회·404여도 새 청구는 차단됩니다.</p>}
      {s.intent.instrumentId && !["paid", "refunded"].includes(s.attempt?.status ?? "") && <><p>등록 수단: {s.instrument?.status === "revoked" && !s.instrument.requiresManualReview ? "해제 검증됨" : s.instrument?.requiresManualReview ? "운영자 확인 필요" : "확인 대기"} · 수단 해제는 기존 청구 취소나 환불 완료가 아닙니다.</p><button type="button" {...button(s.busy || !s.readiness?.capabilities.cancel || s.instrument?.status === "revoked")} onClick={() => { if (!s.busy) void controller.revoke(); }}>등록 수단 해제·상태 확인 요청</button></>}
      {s.checks >= 3 && <p>자동 반복 조회하지 않습니다. 서버 처리 상태를 다시 확인하려면 나중에 이 화면을 다시 열어 주세요.</p>}
      {s.refund && <p>서버 환불 요청 금액: {money(s.refund.requestAmount)} · {s.refund.status === "verified" ? "검증됨" : s.refund.status === "rejected" ? "거절됨" : "처리 확인 대기"}</p>}
      {s.attempt?.status === "paid" && !s.attempt.reviewRequired && s.readiness?.capabilities?.refund && <>
        <label className={styles.check}><input type="checkbox" checked={refundConfirm} disabled={s.busy} onChange={e => setRefundConfirm(e.target.checked)} /> 위 결제에 대한 환불 검토를 요청합니다. 환불 확정을 뜻하지 않습니다.</label>
        <button type="button" {...button(s.busy || !refundConfirm)} onClick={() => { if (!s.busy && refundConfirm) void controller.refund(); }}>환불 검토 요청</button>
      </>}
    </section>}
  </div>;
}
