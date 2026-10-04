// 중앙 마케팅 집계 — 이벤트 정의·판정·전송 레이어.
//
// 계약 (backend의 apps/api 라우트와 조율됨):
// - POST <NEXT_PUBLIC_API_BASE_URL>/marketing/events
// - 본문은 정확히 { "event": ... } 한 필드뿐. 이벤트 이름은 아래 3종 고정 열거형.
//   임의 문자열·금액·항목명·계정/워크스페이스 id·URL 쿼리·리퍼러는 전송하지 않는다.
// - Authorization 등 어떤 자격 증명 헤더도 붙이지 않는다(credentials: "omit",
//   referrerPolicy: "no-referrer"). 헤더는 content-type 하나.
// - 즉시전송(fire-and-forget): 영속 큐·재시도 없음. 전송 시도 직전에만
//   동의 범위 마커를 기록한다(디스패치 시점 marking — 전달 성공 여부와 무관하게
//   같은 동의 기간 내 재전송 없음. 정확도보다 프라이버시 우선).
//
// 신호 발생 조건 ("only successful new personal saves signal where true context available"):
// - 사용자의 명시적 저장 액션이 이 브라우저 localStorage에 실제로 쓰인 뒤에만
//   큐가 비워진다(useBudgetData의 저장 성공 분기). 낙관적 setter·하이드레이션·
//   import·sync pull·demo(샘플)·shared(서버 워크스페이스 연결)는 신호하지 않는다.
// - 프로필 로드 완료·샘플 아님·서버 프로필 미연결을
//   명백히 판단할 수 있을 때만 전송. 모호하면 전송하지 않는다.

import { getServerApiBaseUrl } from "./serverApi";
import { disableMarketingConsent, hasMarketingSentMarker, markMarketingSent, readMarketingConsent } from "./marketingConsent";
import type { FixedCost } from "./budget";

/** 서버가 수락하는 고정 이벤트 이름 3종. 이 외 값은 원천 차단한다. */
export const MARKETING_EVENT_NAMES = ["personal_cost_saved", "personal_billing_date_saved", "personal_renewal_decision_saved"] as const;
export type MarketingEventName = (typeof MARKETING_EVENT_NAMES)[number];
const ALLOWED_EVENT_NAMES: ReadonlySet<string> = new Set<string>(MARKETING_EVENT_NAMES);

/** 기존 API 베이스(existing API base) 뒤에 붙는 고정 경로. */
export const MARKETING_EVENTS_PATH = "/marketing/events";

/** 갱신 "결정"으로 보는 상태(미검토는 결정이 아니다). */
const RENEWAL_DECISION_STATUSES: ReadonlySet<string> = new Set(["keep", "cancel-planned", "change-review", "completed"]);

/**
 * 전송 컨텍스트: 서버 워크스페이스(공유 가능 영역)에 연결돼 있으면 공유 데이터로
 * 취급해 신호하지 않는다. 컨텍스트 제공 자체가 실패하면(미준비) 모호 = 전송 안 함.
 */
export type MarketingWorkspaceContext = { sharedWorkspace: boolean };

export function isPersonalSaveContext(context: MarketingWorkspaceContext | null | undefined): boolean {
  return context !== null && context !== undefined && context.sharedWorkspace === false;
}

/** 저장 대기열(pending) 항목. 동의 범위·프로필에 결합돼 기간/사용자 전환 시 폐기된다. */
export type PendingMarketingSignal = {
  event: MarketingEventName;
  itemId: string;
  /** billing/renewal은 저장 순간의 기대 값. 저장 결과와 다르면 폐기(오탐 방지). */
  value: string | null;
  /** 큐에 쌓인 시점의 동의 범위 id. 전송 시점 범위와 다르면 폐기. */
  scope: string;
  /** 큐에 쌓인 시점의 프로필 id. 프로필이 바뀌면 폐기. */
  profileId: string;
};

/** pending 큐 상한 — 이상 상황(저장 실패 루프 등)에서 메모리를 묶는다. */
export const MAX_PENDING_MARKETING_SIGNALS = 24;

// 진행 중인 fetch abort 레지스트리(동의 해제 시 폐기). 재시도 수단이 아니라
// "해제하면 아직 안 나간 것을 멈추는" 유일한 메커니즘이다.
const inFlight = new Set<AbortController>();

export function abortInFlightMarketingEvents(): void {
  for (const controller of inFlight) {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }
  inFlight.clear();
}

/** 동의 해제 콤보: 저장 차단 + 미전송/진행 중 폐기. */
export function disableMarketing(): boolean {
  const persisted = disableMarketingConsent();
  abortInFlightMarketingEvents();
  // Fixed browser-local message, no identifiers or network transport. Best
  // effort propagation when shared localStorage itself cannot be changed.
  try {
    if (typeof window !== "undefined" && window.BroadcastChannel) {
      const channel = new window.BroadcastChannel("living-cost-manager:marketing-revocation:v1");
      channel.postMessage("off");
      channel.close();
    }
  } catch { /* UI reports failed shared persistence rather than promising it. */ }
  return persisted;
}

export function subscribeMarketingRevocation(onRevoke: (persisted: boolean) => void): () => void {
  try {
    if (typeof window === "undefined" || !window.BroadcastChannel) return () => undefined;
    const channel = new window.BroadcastChannel("living-cost-manager:marketing-revocation:v1");
    channel.onmessage = (message) => {
      if (message.data !== "off") return;
      const persisted = disableMarketingConsent();
      abortInFlightMarketingEvents();
      onRevoke(persisted);
    };
    return () => channel.close();
  } catch { return () => undefined; }
}

/**
 * 현재 전송 가능한 동의 상태라면 범위 id를, 아니면 null을 반환한다.
 * (큐 등록 시점의 동의 기간 스냅샷 용도.)
 */
export function currentMarketingScope(): string | null {
  const consent = readMarketingConsent();
  return consent.enabled ? consent.scope : null;
}

/**
 * 이벤트 전송의 단일 게이트웨이. 어떤 예외도 호출자(저장 흐름)로 던지지 않는다.
 * 반환값은 디스패치 여부(테스트·진단용).
 */
export function sendMarketingEvent(event: unknown, context: { workspace: MarketingWorkspaceContext | null | undefined }): boolean {
  try {
    // 1) 고정 열거형만. 임의 문자열·비문자열·공백 변형은 여기서 죽는다.
    if (typeof event !== "string" || !ALLOWED_EVENT_NAMES.has(event)) return false;
    // 2) 개인 로컬 저장 컨텍스트가 명확해야 한다.
    if (!isPersonalSaveContext(context.workspace)) return false;
    // 3) 동의(enabled + 범위) + GPC/DNT 거부 + 메모리 차단 해제.
    const consent = readMarketingConsent();
    if (!consent.enabled || !consent.scope) return false;
    // 4) 전송지(existing API base). 스킴 없는 상대 URL로는 전송하지 않는다(모호).
    const baseUrl = getServerApiBaseUrl();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return false;
    const endpoint = new URL(baseUrl + MARKETING_EVENTS_PATH);
    if (endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return false;
    // 5) first-value dedup: 이 동의 기간에 이미 표시된 이벤트는 절대 재전송 없음.
    if (hasMarketingSentMarker(consent.scope, event)) return false;
    // 6) 디스패치 시점 marking — 기록(읽기 재검증 포함) 실패 시 전송하지 않는다.
    if (!markMarketingSent(consent.scope, event)) return false;
    // 7) 즉시 전송. 응답/오류를 무시하고 큐·재시도 없음. 실패해도 마커가 남아
    //    이 동의 기간에는 다시 시도하지 않는다(privacy over exactness).
    const controller = new AbortController();
    inFlight.add(controller);
    const finish = () => inFlight.delete(controller);
    void Promise.resolve()
      .then(() => {
        // Recheck immediately before transport: revoke/GPC can occur after the
        // action but before this microtask. Aborted work is never dispatched.
        if (controller.signal.aborted || currentMarketingScope() !== consent.scope) return;
        return fetch(endpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal
        });
      })
      .then(() => undefined, () => undefined)
      .finally(finish);
    return true;
  } catch {
    return false;
  }
}

/**
 * handleItemChange patch에서 마케팅 마일스톤 의도를 판별한다(순수 함수).
 * - 기준 납부일(billingAnchorDate)이 유효한 YYYY-MM-DD 값으로 저장될 때만 billing.
 *   (해지 완료 확인처럼 null로 지우는 동작은 제외.)
 * - renewalStatus가 실제 결정(keep/cancel-planned/change-review/completed)으로
 *   바뀔 때만 renewal. 미검토(unreviewed)는 결정이 아니다.
 * 고정비(cost)는 이름과 명시한 금액이 검증된 handleQuickAdd만 담당한다.
 */
export function classifyItemChangeSignals(
  patch: Partial<Pick<FixedCost, "billingAnchorDate" | "renewalStatus">>
): Array<{ event: MarketingEventName; value: string }> {
  const signals: Array<{ event: MarketingEventName; value: string }> = [];
  if (typeof patch.billingAnchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.billingAnchorDate)
    && Number.isFinite(Date.parse(patch.billingAnchorDate + "T00:00:00.000Z"))
    && new Date(patch.billingAnchorDate + "T00:00:00.000Z").toISOString().slice(0, 10) === patch.billingAnchorDate) {
    signals.push({ event: "personal_billing_date_saved", value: patch.billingAnchorDate });
  }
  if (typeof patch.renewalStatus === "string" && RENEWAL_DECISION_STATUSES.has(patch.renewalStatus)) {
    signals.push({ event: "personal_renewal_decision_saved", value: patch.renewalStatus });
  }
  return signals;
}

/**
 * 저장 성공 스냅샷 대비 pending 신호가 실제로 반영됐는지 검증한다(순수 함수).
 * - 항목이 (삭제/되돌리기로) 사라졌으면 폐기.
 * - billing/renewal은 저장된 값이 큐에 쌓인 기대 값과 일치해야 전송.
 *   그사이에 다른 값으로 바뀌었다면 "그 저장은 실패/교체"이므로 폐기.
 */
export function isPendingSignalSatisfied(
  entry: PendingMarketingSignal,
  savedCosts: ReadonlyArray<Pick<FixedCost, "id" | "billingAnchorDate" | "renewalStatus">>
): boolean {
  const item = savedCosts.find((cost) => cost.id === entry.itemId);
  if (!item) return false;
  if (entry.event === "personal_cost_saved") return true;
  if (entry.event === "personal_billing_date_saved") return item.billingAnchorDate === entry.value;
  return item.renewalStatus === entry.value;
}
